"""
Decisions come from a person in the app.

Approve, deny, release, "looks normal" and "not needed" are decisions a
person makes in the local web UI. This module holds the two checks every
decision route runs on top of the per-run UI token, and the one audit row
every decision writes.

Who may decide:

1. A request that identifies as a Guard hook or a harness (it carries the
   terminal task or terminal hook header a governed task's Guard sends) is
   refused.
2. While any governed task runs, the request's peer on this machine is
   resolved from the TCP peer port to a pid (lsof on macOS, /proc on Linux,
   the TCP owner table on Windows)
   and matched against each running task's pid by session id, process group
   and parent chain. A match is refused. When the peer cannot be confirmed
   (no lookup, a timeout, an error, no process holding the port) the
   decision is refused with 503 and the person tries again; the web page and
   the desktop shell keep their connection open, so they resolve.
   On Linux a browser that a task itself opened (xdg-open) runs inside the
   task's session and is refused. On macOS `open` hands the URL to the
   already running browser, which is outside the task's tree, so it is NOT
   refused there.
3. The UI token itself is never placed in a governed task's environment
   (see `terminals.executors.build_child_env`), and the token route runs the
   same check, so a governed task cannot fetch it.

Windows: the peer lookup is written with ctypes and needs no new
dependency (GetExtendedTcpTable gives the owning pid of the client port, a
Toolhelp32 snapshot gives the parent chain). Its table parsing is unit tested
with fixtures, but it has not been run on a Windows machine yet, so the peer
check is behind a flag: `SV_DECISION_PEER_CHECK` (1/0) turns it on or off,
and it defaults to ON on macOS and Linux and OFF on Windows. With it off a
decision route keeps the token-only behaviour (the UI token, which never
reaches a governed task, plus the harness header check). Windows has no
sessions or process groups, and a parent pid there can outlive its process,
so only the parent chain is followed.

Linux: the peer is found by matching the socket inode from /proc/net/tcp and
/proc/net/tcp6 against /proc/<pid>/fd. When no readable fd directory holds
it, the same-user processes whose fd directory could not be read are the
candidates; if none of them is inside a governed task's tree the asker is a
person, otherwise the decision is refused.

What this is and is not. The peer check raises the bar for an agent that
stays inside its own process tree: its shell, its tools and their children
are refused. It is not a hard boundary. A process can leave the task's tree
by re-parenting (a setsid double fork; on macOS also osascript or `open`
handing work to another app), and from outside the tree it can obtain the
UI token the same way the page does and decide. On Windows, with the flag
off (the default), the token is obtainable the same way and only the token
and the harness header check apply. A peer whose address is neither
loopback nor the address the request arrived on is another machine and is
not looked up. Sessions linked from the person's own terminal have no pid
here and are not covered by the peer check. A same-user process can also
read the app's memory or files. The boundary that closes this is an
approval the operating system asks the person for: `require_person` ends
with a confirmation the person answers on this computer
(services/confirmations.py).
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
import shutil
import struct
import subprocess
import sys
from typing import Any, Iterable, Mapping, Optional

logger = logging.getLogger(__name__)

AUDIT_TOOL_ID = "sv.decision"

# Headers a governed task's Guard sends on its own calls to the app.
HARNESS_HEADERS = ("x-sv-terminal-task", "x-sv-terminal-hook")

BY_PERSON = "person via UI"
BY_TIMEOUT = "hold limit"

REFUSED = "Decisions come from a person in the app, not from a running task."

_MAX_DEPTH = 64


# --- who is asking ----------------------------------------------------------------------


def _headers(request: Any) -> Mapping[str, str]:
    h = getattr(request, "headers", None) or {}
    return h


def identifies_as_harness(request: Any) -> bool:
    h = _headers(request)
    try:
        return any(h.get(name) for name in HARNESS_HEADERS)
    except Exception:  # noqa: BLE001 - an odd headers object is not a harness
        return False


def governed_pids(manager: Any) -> set:
    """Pids of the tasks this app launched that still run."""
    host = getattr(manager, "host", None)
    lister = getattr(host, "list", None)
    if not callable(lister):
        return set()
    try:
        return {int(i.pid) for i in lister() if getattr(i, "alive", False) and getattr(i, "pid", None)}
    except Exception:  # noqa: BLE001
        logger.debug("governed pid list failed", exc_info=True)
        return set()


class _Unconfirmed(Exception):
    """The peer of a request could not be resolved to a process."""


UNCONFIRMED = "Could not confirm who asked; try again."

# Stands for a peer owned by another OS user (Linux): never a task's pid.
OTHER_USER = 0

# At most two lookups run at once; each spawns lsof or ps.
_LOOKUPS = asyncio.Semaphore(2)


def _lsof_peer_pids(host: str, peer_port: int) -> Optional[set]:
    exe = shutil.which("lsof") or ("/usr/sbin/lsof" if os.path.exists("/usr/sbin/lsof") else None)
    if not exe:
        return None
    addr = f"[{host}]" if ":" in host else host
    # Any TCP state: a client that half-closes after sending still holds
    # its end of the connection.
    try:
        out = subprocess.run(
            [exe, "-nP", "-t", f"-iTCP@{addr}:{int(peer_port)}"],
            capture_output=True, text=True, timeout=2,
        ).stdout
    except Exception:  # noqa: BLE001
        return None
    return {int(x) for x in out.split() if x.strip().isdigit()}


def _proc_peer_pids(peer_port: int, server_port: Optional[int]) -> Optional[set]:
    """Linux. A browser the task opened (xdg-open) runs in the task's session
    and is refused by design: a person decides from a page they opened."""
    inodes: set = set()
    uids: set = set()
    seen_table = False
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(table, encoding="ascii") as fh:
                lines = fh.read().splitlines()[1:]
        except OSError:
            continue
        seen_table = True
        for line in lines:
            parts = line.split()
            if len(parts) < 10:
                continue
            try:
                lport = int(parts[1].rsplit(":", 1)[1], 16)
                rport = int(parts[2].rsplit(":", 1)[1], 16)
            except (IndexError, ValueError):
                continue
            if lport == peer_port and (server_port is None or rport == server_port) and parts[9] != "0":
                inodes.add(parts[9])
                uids.add(parts[7])
    if not seen_table:
        return None
    if not inodes:
        return set()
    wanted = {f"socket:[{i}]" for i in inodes}
    pids: set = set()
    unreadable: set = set()
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        fd_dir = f"/proc/{name}/fd"
        try:
            fds = os.listdir(fd_dir)
        except OSError:
            unreadable.add(int(name))
            continue
        for fd in fds:
            try:
                if os.readlink(f"{fd_dir}/{fd}") in wanted:
                    pids.add(int(name))
                    break
            except OSError:
                continue
    if pids:
        return pids
    if uids and str(os.getuid()) not in uids:
        # The socket's owner is another user, whose /proc/<pid>/fd this app
        # cannot read. Governed tasks run as this user and are always
        # readable, so this asker is not one of them.
        return {OTHER_USER}
    # The socket is this user's but no readable fd directory holds it: the
    # asker is one of this user's processes whose fd directory could not be
    # read. All of them are returned; the caller refuses if any one is inside
    # a governed task, and otherwise the asker is a person.
    return _owned_by(unreadable, uids)


def _owned_by(pids: set, uids: set) -> set:
    out: set = set()
    for pid in pids:
        try:
            if str(os.stat(f"/proc/{pid}").st_uid) in uids:
                out.add(pid)
        except OSError:
            continue
    out.discard(os.getpid())
    return out


# --- Windows ------------------------------------------------------------------------------

_AF_INET, _AF_INET6 = 2, 23
_TCP_TABLE_OWNER_PID_ALL = 5
_ROW4 = struct.Struct("<6I")          # state, laddr, lport, raddr, rport, pid
_ROW6 = struct.Struct("<16sII16sIIII")  # laddr, scope, lport, raddr, scope, rport, state, pid


def _win_port(dword: int) -> int:
    """A port in a TCP owner row: network byte order in the low 16 bits."""
    return ((dword & 0xFF) << 8) | ((dword >> 8) & 0xFF)


def parse_tcp_owner_table(buf: bytes, v6: bool, peer_port: int, server_port: Optional[int]) -> set:
    """Owning pids of rows whose local port is `peer_port` (and, when given,
    whose remote port is `server_port`), from a MIB_TCP(6)TABLE_OWNER_PID."""
    if len(buf) < 4:
        return set()
    (count,) = struct.unpack_from("<I", buf, 0)
    row = _ROW6 if v6 else _ROW4
    pids: set = set()
    for i in range(count):
        off = 4 + i * row.size
        if off + row.size > len(buf):
            break
        f = row.unpack_from(buf, off)
        lport, rport, pid = (f[2], f[5], f[7]) if v6 else (f[2], f[4], f[5])
        if _win_port(lport) == peer_port and (server_port is None or _win_port(rport) == server_port) and pid:
            pids.add(int(pid))
    return pids


def _win_peer_pids(peer_port: int, server_port: Optional[int], iphlpapi: Any = None) -> Optional[set]:
    import ctypes

    try:
        iphlpapi = iphlpapi or ctypes.WinDLL("iphlpapi")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        return None
    pids: set = set()
    for af, v6 in ((_AF_INET, False), (_AF_INET6, True)):
        size = ctypes.c_uint32(0)
        iphlpapi.GetExtendedTcpTable(None, ctypes.byref(size), False, af, _TCP_TABLE_OWNER_PID_ALL, 0)
        for _ in range(3):  # the table can grow between the two calls
            buf = ctypes.create_string_buffer(max(int(size.value), 4))
            rc = iphlpapi.GetExtendedTcpTable(buf, ctypes.byref(size), False, af,
                                              _TCP_TABLE_OWNER_PID_ALL, 0)
            if rc == 0:
                pids |= parse_tcp_owner_table(buf.raw, v6, peer_port, server_port)
                break
            if rc != 122:  # ERROR_INSUFFICIENT_BUFFER
                return None
        else:
            return None
    return pids


def _win_ppid_map(kernel32: Any = None) -> Optional[dict]:
    """pid -> parent pid from a Toolhelp32 process snapshot."""
    import ctypes

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [("dwSize", ctypes.c_uint32), ("cntUsage", ctypes.c_uint32),
                    ("th32ProcessID", ctypes.c_uint32), ("th32DefaultHeapID", ctypes.c_size_t),
                    ("th32ModuleID", ctypes.c_uint32), ("cntThreads", ctypes.c_uint32),
                    ("th32ParentProcessID", ctypes.c_uint32), ("pcPriClassBase", ctypes.c_int32),
                    ("dwFlags", ctypes.c_uint32), ("szExeFile", ctypes.c_wchar * 260)]

    if kernel32 is None:
        try:
            kernel32 = ctypes.WinDLL("kernel32")  # type: ignore[attr-defined]
            kernel32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
            kernel32.Process32FirstW.argtypes = kernel32.Process32NextW.argtypes = (
                ctypes.c_void_p, ctypes.c_void_p)
            kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
        except Exception:  # noqa: BLE001
            return None
    snap = kernel32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if not snap or snap in (-1, ctypes.c_void_p(-1).value):  # INVALID_HANDLE_VALUE
        return None
    out: dict = {}
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            out[int(entry.th32ProcessID)] = int(entry.th32ParentProcessID)
            ok = kernel32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    return out or None


def warn_if_peer_check_off() -> None:
    """Called once at startup: a POSIX install with the check turned off
    says so in the log."""
    if sys.platform != "win32" and not peer_check_enabled():
        logger.warning("SV_DECISION_PEER_CHECK is off: decisions are checked by the UI token only, "
                       "not by who is asking.")


def peer_check_enabled() -> bool:
    """The peer check runs unless SV_DECISION_PEER_CHECK turns it off; it is
    off by default on Windows (see the module docstring)."""
    raw = os.environ.get("SV_DECISION_PEER_CHECK", "").strip().lower()
    if raw in ("1", "true", "on", "yes"):
        return True
    if raw in ("0", "false", "off", "no"):
        return False
    return sys.platform != "win32"


def peer_pids(host: str, peer_port: int, server_port: Optional[int]) -> Optional[set]:
    """Pids holding the client end of a local connection, or None when the
    platform gives no way to tell. The app's own pid is left out."""
    if sys.platform == "win32":
        pids = _win_peer_pids(peer_port, server_port)
    elif sys.platform.startswith("linux"):
        pids = _proc_peer_pids(peer_port, server_port)
    else:
        pids = _lsof_peer_pids(host, peer_port)
    if pids is None:
        return None
    pids.discard(os.getpid())
    return pids


def _ppid_map() -> Optional[dict]:
    """pid -> parent pid for every process, or None when unreadable."""
    if sys.platform == "win32":
        return _win_ppid_map()
    out: dict = {}
    try:
        text = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True,
                              timeout=2).stdout
    except Exception:  # noqa: BLE001
        text = ""
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            out[int(parts[0])] = int(parts[1])
    if not out and not os.path.isdir("/proc/self"):
        return None
    return out


def _ppid(pid: int, table: dict) -> Optional[int]:
    if pid in table:
        return table[pid]
    try:
        with open(f"/proc/{pid}/stat", encoding="ascii", errors="replace") as fh:
            stat = fh.read()
        return int(stat.rsplit(")", 1)[1].split()[1])
    except (OSError, ValueError, IndexError):
        return None


def in_tree(pid: int, roots: Iterable[int], ppids: Optional[dict] = None) -> bool:
    """True when `pid` is one of `roots` or inside one's session, process
    group or parent chain."""
    roots = {int(r) for r in roots if r}
    if not roots or not pid:
        return False
    for getter in (getattr(os, "getsid", None), getattr(os, "getpgid", None)):
        if getter is None:
            continue
        try:
            if getter(pid) in roots:
                return True
        except OSError:
            pass
    table = ppids if ppids is not None else (_ppid_map() or {})
    cur: Optional[int] = pid
    for _ in range(_MAX_DEPTH):
        if cur is None or cur <= 1:
            return False
        if cur in roots:
            return True
        cur = _ppid(cur, table)
    return False


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        addr = ipaddress.ip_address(host.split("%", 1)[0])
    except ValueError:
        return False
    mapped = getattr(addr, "ipv4_mapped", None)
    return (mapped or addr).is_loopback


def _is_local_peer(request: Any, host: str) -> bool:
    """Loopback (any 127/8 or ::1, IPv4-mapped included), or the same address
    the request arrived on (a process on this machine calling the app through
    one of its own addresses)."""
    if _is_loopback(host):
        return True
    scope = getattr(request, "scope", None)
    server = scope.get("server") if isinstance(scope, dict) else None
    return bool(server) and str(server[0]) == host


def _peer_in_governed_tree(request: Any, roots: set) -> bool:
    """True when the peer is inside a governed task's tree; raises
    _Unconfirmed when that cannot be decided."""
    client = getattr(request, "client", None)
    host = getattr(client, "host", None)
    port = getattr(client, "port", None)
    if not host or not port:
        raise _Unconfirmed()
    if not _is_local_peer(request, str(host)):
        return False
    url = getattr(request, "url", None)
    server_port = getattr(url, "port", None)
    pids = peer_pids(str(host), int(port), int(server_port) if server_port else None)
    if not pids:
        raise _Unconfirmed()
    table = _ppid_map()
    if table is None:
        raise _Unconfirmed()
    return any(in_tree(p, roots, table) for p in pids)


async def refuse_governed_caller(request: Any, manager: Any = None) -> None:
    """Raise 403 when the request comes from a governed task, and 503 when,
    with a governed task running, the asker cannot be confirmed."""
    from fastapi import HTTPException

    from securevector.app.services import confirmations

    # The in-process replay of a request the person already confirmed: its
    # caller was checked when the confirmation was created.
    if confirmations.is_replay(request):
        return
    if identifies_as_harness(request):
        raise HTTPException(status_code=403, detail=REFUSED)
    if manager is None:
        manager = getattr(getattr(getattr(request, "app", None), "state", None), "terminal_manager", None)
    if not peer_check_enabled():
        return
    roots = governed_pids(manager)
    if not roots:
        return
    import anyio

    try:
        async with _LOOKUPS:
            hit = await anyio.to_thread.run_sync(_peer_in_governed_tree, request, roots)
    except Exception:  # noqa: BLE001 - unconfirmed, a timeout or an error all refuse
        logger.debug("decision peer check unconfirmed", exc_info=True)
        raise HTTPException(status_code=503, detail=UNCONFIRMED) from None
    if hit:
        raise HTTPException(status_code=403, detail=REFUSED)


async def require_person(http_request: Any, token: Optional[str], manager: Any = None,
                         summary: Optional[str] = None) -> None:
    """The per-run UI token, then the check above. For routes that change
    what agents may do."""
    from securevector.app.server.routes.jit_access import _require_ui_token
    from securevector.app.services import confirmations

    if confirmations.is_replay(http_request):
        return
    _require_ui_token(token)
    await refuse_governed_caller(http_request, manager)
    # Nothing is applied on the page's request alone: the person confirms
    # on this computer first (services/confirmations.py).
    await confirmations.gate(http_request, summary=summary)


def decision_secrets() -> tuple:
    """Values that must never reach a governed task's environment."""
    try:
        from securevector.app.server.routes import jit_access
    except Exception:  # noqa: BLE001
        return ()
    return tuple(v for v in (getattr(jit_access, "_UI_TOKEN", None),
                             getattr(jit_access, "_UI_PAGE_SECRET", None)) if v)


# --- the audit row ----------------------------------------------------------------------


def call_class(request_row: Optional[Mapping[str, Any]]) -> str:
    """The class of call a request decides: the step-up kind for a rung
    hold, otherwise the source of the rule that held it."""
    if not request_row:
        return "unknown"
    source = str(request_row.get("rule_source") or "unknown")
    if source == "rung":
        from securevector.app.services import response_rungs

        return f"step_up:{response_rungs.step_up_kind(request_row.get('tool_id')) or 'held'}"
    return source


async def _task_id(db, session_id: Optional[str]) -> Optional[str]:
    if not session_id:
        return None
    try:
        from securevector.app.database.repositories.session_drift import SessionDriftRepository

        task = await SessionDriftRepository(db).task_for_session(session_id)
    except Exception:  # noqa: BLE001
        return None
    return (task or {}).get("id")


async def audit(db, decision: str, *, session_id: Optional[str], task_id: Optional[str] = None,
                klass: str = "", tool_id: Optional[str] = None, request_id: Optional[str] = None,
                by: str = BY_PERSON, harness: Optional[str] = None, reason: Optional[str] = None,
                method: Optional[str] = None) -> None:
    """One chained audit row per decision: what, who, the call class and the
    task. When is the row's own timestamp. Never arguments or hook values."""
    from securevector.app.database.repositories.custom_tools import CustomToolsRepository

    if task_id is None:
        task_id = await _task_id(db, session_id)
    action = "allow" if decision in ("allow", "looks_normal", "release", "resume") else (
        "block" if decision in ("deny", "timeout_deny") else "log_only")
    preview = (f"decision={decision} by={by} class={klass or 'none'} task={task_id or 'none'}"
               f" tool={tool_id or 'none'} request={request_id or 'none'}")
    from securevector.app.services import confirmations

    method = method or confirmations.current_method.get()
    if method:
        preview += f" method={method}"
    try:
        await CustomToolsRepository(db).log_tool_call_audit(
            AUDIT_TOOL_ID, f"decision.{decision}", action,
            reason=(reason or ("Decision by a person in the app" if by == BY_PERSON else "Hold limit")),
            args_preview=preview[:500], runtime_kind=harness, session_id=session_id,
        )
    except Exception:  # noqa: BLE001 - the decision stands; the audit is best effort
        logger.warning("Decision audit write failed", exc_info=True)


async def audit_request(db, decision: str, request_row: Optional[Mapping[str, Any]], *,
                        by: str = BY_PERSON, reason: Optional[str] = None) -> None:
    row = request_row or {}
    await audit(db, decision, session_id=row.get("session_id"), klass=call_class(row),
                tool_id=row.get("tool_id"), request_id=row.get("id"), by=by,
                harness=row.get("runtime_kind"), reason=reason)
