"""Remote access mode (6.1.0, phase 1). Off by default.

While the mode is on, a browser on another machine that presents the access
token may approve, deny and revoke approvals, list agent sessions with their
status and stop a session. Launching, linking and typing into a session,
settings changes and turning the mode on or off answer only on this machine.

- The token is created on this machine, shown once and stored only as a
  salted SHA-256 hash. Signing in with it returns a remote session id the
  browser sends in its own header, `X-SV-Remote-Session: <id>` (never a
  cookie); Authorization stays with the ingress token.
- Remote sessions live in memory: 12 hours at most, 30 idle minutes.
  Turning the mode off or rotating the token bumps a generation counter and
  signs every remote browser out at once.
- 5 wrong tokens a minute from one address lock that address for 15 minutes.
- Approve and revoke need the token entered again within 10 minutes; deny
  does not. A remote approval follows the cloud approval rules
  (services/cloud_approvals.py): the device's allowance (Allow once by
  default) and its device-only rules, which are approved only here.
- While the mode is on, every /api and /ws request must name this machine
  or the allowed address in its Host header, and a request that is not
  from this machine must arrive over HTTPS through a listed proxy.

With the mode off nothing here changes how a request is handled.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import logging
import secrets
import time
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import urlsplit

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from securevector.app.server.loopback import (
    asked_on_this_machine,
    loopback_host_header,
    loopback_ip,
    on_this_machine,
)

logger = logging.getLogger(__name__)

router = APIRouter()

AUDIT_TOOL_ID = "sv.remote_access"
SESSION_HEADER = "x-sv-remote-session"
TOKEN_PREFIX = "svra_"
SESSION_TTL_S = 12 * 3600
SESSION_IDLE_S = 30 * 60
REAUTH_S = 10 * 60
FAIL_WINDOW_S = 60
FAIL_LIMIT = 5
LOCK_S = 15 * 60
MAX_PROXIES = 16

HOST_DETAIL = "Host not allowed"
PROXY_HOST_DETAIL = ("Your proxy must pass the original Host header "
                     "(nginx: proxy_set_header Host $host)")
LOOPBACK_PROXY_DETAIL = ("List the proxy by a non-loopback address. If the proxy runs on this "
                         "machine, point it at this machine's private IP (for example 10.0.0.5:8742) "
                         "instead of 127.0.0.1.")
LOCAL_SESSION_DETAIL = "On this machine, use the app directly: remote sign-in is for other machines"
MAX_TRACKED = 1000
# Paths outside /api and /ws that the Host and HTTPS rules also cover while
# the mode is on: the analyze and OTLP ingest routes.
COVERED_EXTRA = ("/analyze", "/v1/")
HTTPS_DETAIL = "Remote access needs HTTPS through the listed proxy"
OFF_DETAIL = "Remote access is off"
SIGN_IN_DETAIL = "Sign in for remote access"
REAUTH_DETAIL = "Enter the access token again to continue"
DEVICE_ONLY_DETAIL = "Approve this on the machine itself"
LOCAL_ONLY_DETAIL = "Change this on the machine itself"
NOT_NEEDED_DETAIL = "Not needed: the app listens only on this machine"
WRONG_TOKEN_DETAIL = "That access token is not right"
LOCKED_DETAIL = "Too many tries from this address. Try again in 15 minutes."
DURATION_DETAIL = ("From another machine you can allow once or deny. "
                   "Longer approvals are made on the machine itself.")

_DEFAULT_STATE = {
    "remote_access_enabled": False,
    "remote_allowed_address": None,
    "remote_proxy_address": [],
    "remote_token_hash": None,
    "remote_token_salt": None,
    "remote_token_created_at": None,
    "remote_token_rotated_at": None,
    "remote_generation": 0,
}

# In-memory state. The settings cache is keyed by the database object, so a
# different database (a test, a restart) reloads it.
_cache: dict = {"db": None, "state": None}
_sessions: dict = {}
_failures: dict = {}
_locks: dict = {}


def _now() -> float:
    return time.time()


def _iso(ts: Optional[float]) -> Optional[str]:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def reset() -> None:
    """Forget the cached settings, every remote session and every lock."""
    _cache["db"] = None
    _cache["state"] = None
    _sessions.clear()
    _failures.clear()
    _locks.clear()


# --- settings -------------------------------------------------------------------------


def cached_state() -> dict:
    """The cached state for the current database, without a read; off when
    it was not loaded yet (the middleware loads it on every covered path)."""
    db = _current_db()
    if db is not None and _cache["db"] is db and _cache["state"] is not None:
        return _cache["state"]
    return dict(_DEFAULT_STATE)


def normalize_state(raw: Any) -> dict:
    state = dict(_DEFAULT_STATE)
    if isinstance(raw, dict):
        for key in _DEFAULT_STATE:
            if key in raw:
                state[key] = raw[key]
    state["remote_access_enabled"] = state["remote_access_enabled"] is True
    proxies = state.get("remote_proxy_address")
    clean_proxies = []
    for p in proxies if isinstance(proxies, list) else []:
        try:
            net = ipaddress.ip_network(str(p), strict=False)
        except ValueError:
            continue
        # A proxy is never a loopback address (loopback is always local).
        if not _net_is_loopback(net):
            clean_proxies.append(str(net))
    state["remote_proxy_address"] = clean_proxies
    try:
        state["remote_generation"] = max(0, int(state.get("remote_generation") or 0))
    except (TypeError, ValueError):
        state["remote_generation"] = 0
    # Recovery on the machine itself: SECUREVECTOR_REMOTE_ACCESS=off at
    # start keeps the mode off whatever is stored.
    import os

    if os.environ.get("SECUREVECTOR_REMOTE_ACCESS", "").strip().lower() in ("off", "0", "false"):
        state["remote_access_enabled"] = False
    # On needs everything enabling checked; anything missing reads as off.
    if state["remote_access_enabled"] and not (
        state.get("remote_allowed_address") and state["remote_proxy_address"]
        and state.get("remote_token_hash") and state.get("remote_token_salt")
    ):
        state["remote_access_enabled"] = False
    return state


def _current_db():
    from securevector.app.database import connection as dbc

    return dbc._db


async def get_state() -> dict:
    """The stored state (cached). Off when no database is open yet."""
    db = _current_db()
    if db is None:
        return dict(_DEFAULT_STATE)
    if _cache["db"] is db and _cache["state"] is not None:
        return _cache["state"]
    from securevector.app.database.repositories.settings import SettingsRepository

    try:
        raw = await SettingsRepository(db).get_remote_access()
    except Exception:  # noqa: BLE001 - unreadable reads as off
        logger.debug("remote access state unreadable", exc_info=True)
        raw = {}
    state = normalize_state(raw)
    _cache["db"], _cache["state"] = db, state
    return state


async def _save_state(state: dict) -> dict:
    from securevector.app.database.connection import get_database
    from securevector.app.database.repositories.settings import SettingsRepository

    db = get_database()
    clean = normalize_state(state)
    await SettingsRepository(db).set_remote_access(clean)
    _cache["db"], _cache["state"] = db, clean
    return clean


def parse_allowed_address(value: Any) -> str:
    """`https://host[:port]`, normalized. Raises ValueError with a plain message."""
    text = str(value or "").strip()
    if not text.lower().startswith("https://"):
        raise ValueError("The allowed address must start with https://")
    try:
        parts = urlsplit(text)
        port = parts.port
    except ValueError:
        raise ValueError("The allowed address is not a valid address") from None
    host = (parts.hostname or "").lower()
    if not host or parts.username or parts.password or parts.query or parts.fragment \
            or parts.path not in ("", "/") or any(c in host for c in " /\\"):
        raise ValueError("Enter only https:// and the host name, with a port if it has one")
    shown = f"[{host}]" if ":" in host else host
    return f"https://{shown}" + (f":{port}" if port else "")


_LOOPBACK_NETS = tuple(ipaddress.ip_network(n) for n in ("127.0.0.0/8", "::1/128", "::ffff:127.0.0.0/104"))


def _net_is_loopback(net) -> bool:
    """Any overlap with 127.0.0.0/8, ::1 or IPv4-mapped 127.x."""
    return any(net.version == lb.version and net.overlaps(lb) for lb in _LOOPBACK_NETS)


def parse_proxy_address(value: Any) -> list:
    """IP addresses or CIDR ranges, a list or a comma or space separated text."""
    items = value if isinstance(value, (list, tuple)) else str(value or "").replace(",", " ").split()
    out: list = []
    for item in items:
        text = str(item or "").strip()
        if not text:
            continue
        try:
            net = ipaddress.ip_network(text, strict=False)
        except ValueError:
            raise ValueError(f"Not an IP address or range: {text[:60]}") from None
        if _net_is_loopback(net):
            raise ValueError(LOOPBACK_PROXY_DETAIL)
        if str(net) not in out:
            out.append(str(net))
    if len(out) > MAX_PROXIES:
        raise ValueError(f"List at most {MAX_PROXIES} proxy addresses")
    return out


def _allowed_host_port(state: dict) -> tuple:
    try:
        parts = urlsplit(str(state.get("remote_allowed_address") or ""))
        return (parts.hostname or "").lower(), parts.port
    except ValueError:
        return "", None


def _split_host(value: Optional[str]) -> tuple:
    v = str(value or "").strip().lower()
    if v.startswith("["):
        end = v.find("]")
        if end < 0:
            return None, None
        name, rest = v[1:end], v[end + 1:]
    else:
        name, _, port = v.partition(":")
        rest = ":" + port if port else ""
    port = rest[1:] if rest.startswith(":") else ""
    if rest and not (port.isascii() and port.isdigit()):
        return None, None
    return name, (int(port) if port else None)


def host_allowed(host_header: Optional[str], state: dict) -> bool:
    """A loopback Host, or the allowed address host (and its port, when the
    allowed address names one)."""
    if loopback_host_header(host_header):
        return True
    name, port = _split_host(host_header)
    want_host, want_port = _allowed_host_port(state)
    if not name or not want_host or name != want_host:
        return False
    if want_port is None:
        return port in (None, 443)
    return port == want_port


def _ip(value: Optional[str]):
    try:
        ip = ipaddress.ip_address(str(value or "").strip())
    except ValueError:
        return None
    return getattr(ip, "ipv4_mapped", None) or ip


def peer_is_proxy(peer: Optional[str], state: dict) -> bool:
    ip = _ip(peer)
    if ip is None:
        return False
    for net in state.get("remote_proxy_address") or ():
        try:
            if ip in ipaddress.ip_network(net, strict=False):
                return True
        except (ValueError, TypeError):
            continue
    return False


def https_ok(peer: Optional[str], headers: Any, state: dict) -> bool:
    proto = str(headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    return proto == "https" and peer_is_proxy(peer, state)


def remote_address(peer: Optional[str], headers: Any, state: dict) -> str:
    """The browser's address. X-Forwarded-For is trusted only when the peer
    is a listed proxy: walked from the right, skipping listed proxies, the
    first other address is the client. Otherwise the peer itself."""
    if peer_is_proxy(peer, state):
        for item in reversed(str(headers.get("x-forwarded-for") or "").split(",")):
            fwd = item.strip()
            if _ip(fwd) is None:
                break  # a malformed entry: stop trusting the chain here
            if not peer_is_proxy(fwd, state):
                return fwd
    return str(peer or "unknown")[:64]


def bound_loopback_only(app: Any) -> bool:
    host = str(getattr(getattr(app, "state", None), "bind_host", "127.0.0.1") or "").strip().lower()
    if host in ("localhost", "[::1]"):
        return True
    return loopback_ip(host.strip("[]"))


def _peer(request: Any) -> Optional[str]:
    client = getattr(request, "client", None)
    return getattr(client, "host", None)


# --- the middleware -------------------------------------------------------------------


class RemoteAccessMiddleware:
    """Host allowlist and the HTTPS-through-a-listed-proxy rule, for /api and
    /ws, only while the mode is on. /health is never checked."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        kind = scope.get("type")
        path = scope.get("path") or ""
        if kind not in ("http", "websocket") or path == "/health" or not (
            path.startswith("/api") or path.startswith("/ws")
            or path == COVERED_EXTRA[0] or path.startswith(COVERED_EXTRA[1])
        ):
            return await self.app(scope, receive, send)
        state = await get_state()
        if not state["remote_access_enabled"]:
            return await self.app(scope, receive, send)
        from starlette.datastructures import Headers

        headers = Headers(scope=scope)
        host = headers.get("host")
        client = scope.get("client")
        peer = client[0] if client else None
        refusal = None
        local = on_this_machine(peer, host, headers)
        if not host_allowed(host, state):
            refusal = {"detail": HOST_DETAIL}
        elif loopback_host_header(host) and not local:
            # A loopback Host on a request that is not from this machine: a
            # proxy rewriting Host, or a spoofed one. Never treated as local.
            refusal = {"detail": PROXY_HOST_DETAIL}
        elif not local and not https_ok(peer, headers, state):
            refusal = {"detail": HTTPS_DETAIL}
        if refusal is None:
            return await self.app(scope, receive, send)
        if kind == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        from starlette.responses import JSONResponse

        await JSONResponse(refusal, status_code=403)(scope, receive, send)


# --- remote sessions ------------------------------------------------------------------


def _hash_token(token: str, salt: str) -> str:
    return hmac.new(bytes.fromhex(salt), token.encode("utf-8", "surrogateescape"), hashlib.sha256).hexdigest()


def _token_ok(token: Any, state: dict) -> bool:
    salt, stored = state.get("remote_token_salt"), state.get("remote_token_hash")
    if not isinstance(token, str) or not token or not salt or not stored:
        return False
    try:
        digest = _hash_token(token.strip(), salt)
    except ValueError:
        return False
    return hmac.compare_digest(digest, str(stored))


def _bearer(request: Any) -> Optional[str]:
    """The remote session id from its own header. Authorization and
    X-Api-Key stay with the ingress token, so both work together."""
    value = str(request.headers.get(SESSION_HEADER) or "").strip()
    return value or None


def presents_session(request: Any) -> bool:
    return _bearer(request) is not None


def _live_session(sid: Optional[str], state: dict, touch: bool = False) -> Optional[dict]:
    """A live session, or None. Idle time counts from the last request the
    person made: background polls (X-SV-Poll: 1) do not keep it alive."""
    if not sid:
        return None
    sess = _sessions.get(sid)
    if sess is None:
        return None
    now = _now()
    if (sess["generation"] != state["remote_generation"] or now - sess["created"] >= SESSION_TTL_S
            or now - sess["last_seen"] >= SESSION_IDLE_S):
        _sessions.pop(sid, None)
        return None
    if touch:
        sess["last_seen"] = now
    return sess


def _sign_out_everyone() -> None:
    _sessions.clear()


async def require_remote_or_local(request: Request) -> Optional[dict]:
    """The remote session a request presents, or None when it presents none.

    None means the route's own checks for this machine apply unchanged (the
    UI token, the terminals lock). A request that presents a remote session
    passes only while the mode is on, from this machine or over HTTPS
    through a listed proxy, with a live session; otherwise it is refused."""
    sid = _bearer(request)
    if sid is None:
        return None
    state = await get_state()
    if not state["remote_access_enabled"]:
        raise HTTPException(status_code=403, detail=OFF_DETAIL)
    if asked_on_this_machine(request):
        raise HTTPException(status_code=403, detail=LOCAL_SESSION_DETAIL)
    peer = _peer(request)
    if not https_ok(peer, request.headers, state):
        raise HTTPException(status_code=403, detail=HTTPS_DETAIL)
    # Any request the person makes refreshes idle time; a background poll
    # (X-SV-Poll: 1) never does.
    sess = _live_session(sid, state, touch=str(request.headers.get("x-sv-poll") or "").strip() != "1")
    if sess is None:
        raise HTTPException(status_code=401, detail=SIGN_IN_DETAIL)
    sess["address"] = remote_address(peer, request.headers, state)
    try:
        request.state.remote_session = sess
    except Exception:  # noqa: BLE001 - a bare scope without state
        pass
    return sess


def require_fresh_reauth(sess: dict) -> None:
    if _now() - float(sess.get("reauth_at") or 0) > REAUTH_S:
        raise HTTPException(status_code=401, detail=REAUTH_DETAIL)


# --- audit ----------------------------------------------------------------------------


async def audit(function_name: str, outcome: str, *, address: str, path: str,
                reason: str, session_id: Optional[str] = None) -> None:
    """One row per remote action: source, remote address, path and outcome."""
    try:
        from securevector.app.database.connection import get_database
        from securevector.app.database.repositories.custom_tools import CustomToolsRepository

        action = "allow" if outcome == "ok" else ("block" if outcome != "info" else "log_only")
        await CustomToolsRepository(get_database()).log_tool_call_audit(
            AUDIT_TOOL_ID, function_name, action, reason=reason[:300],
            args_preview=(f"source=remote address={str(address)[:64]} path={str(path)[:200]} "
                          f"outcome={outcome}")[:500],
            session_id=session_id,
        )
    except Exception:  # noqa: BLE001 - the audit is best effort
        logger.warning("remote access audit write failed", exc_info=True)


def _path(request: Any) -> str:
    url = getattr(request, "url", None)
    return getattr(url, "path", "") or ""


# --- token entry limits ---------------------------------------------------------------



def _cap_failures() -> None:
    while len(_failures) > MAX_TRACKED:
        _failures.pop(next(iter(_failures)))

def _cap_locks() -> None:
    while len(_locks) > MAX_TRACKED:
        _locks.pop(next(iter(_locks)))


def _locked(address: str) -> bool:
    until = _locks.get(address)
    if until is None:
        return False
    if _now() >= until:
        _locks.pop(address, None)
        return False
    return True


async def _check_token(request: Request, token: Any, state: dict, address: str, what: str) -> None:
    """Raise 429 while the address is locked and 401 on a wrong token; a
    fifth wrong token within a minute locks the address for 15 minutes."""
    path = _path(request)
    if _locked(address):
        await audit(f"remote.{what}", "locked", address=address, path=path,
                    reason="Access token entry refused: address locked")
        raise HTTPException(status_code=429, detail=LOCKED_DETAIL)
    if _token_ok(token, state):
        _failures.pop(address, None)
        return
    now = _now()
    recent = [t for t in _failures.get(address, []) if now - t < FAIL_WINDOW_S]
    recent.append(now)
    _failures.pop(address, None)
    _failures[address] = recent
    _cap_failures()
    await audit(f"remote.{what}", "wrong_token", address=address, path=path,
                reason="Access token entry did not match")
    if len(recent) >= FAIL_LIMIT:
        _locks[address] = now + LOCK_S
        _cap_locks()
        _failures.pop(address, None)
        await audit("remote.lock", "locked", address=address, path=path,
                    reason=f"{FAIL_LIMIT} wrong access tokens in a minute: address locked for 15 minutes")
    raise HTTPException(status_code=401, detail=WRONG_TOKEN_DETAIL)


# --- remote decisions -----------------------------------------------------------------


def decided_by(sess: dict) -> str:
    return f"remote:{str(sess.get('address') or 'unknown')[:64]}"


async def remote_approve(request: Request, sess: dict, request_id: str, duration: str) -> dict:
    from securevector.app.database.connection import get_database
    from securevector.app.database.repositories.jit_access import JitAccessRepository
    from securevector.app.services import cloud_approvals, decisions, response_rungs

    address, path = sess.get("address") or "unknown", _path(request)

    async def refuse(status: int, detail: str, outcome: str):
        await audit("remote.approve", outcome, address=address, path=path,
                    reason=f"Approval from another machine refused: {detail}")
        raise HTTPException(status_code=status, detail=detail)

    if _now() - float(sess.get("reauth_at") or 0) > REAUTH_S:
        await refuse(401, REAUTH_DETAIL, "reauth_required")
    await decisions.refuse_governed_caller(request)
    db = get_database()
    repo = JitAccessRepository(db)
    await response_rungs.expire_holds(db)
    req = await repo.get_request(request_id)
    if not req or req.get("status") != "pending":
        await refuse(404, "No such pending request", "not_found")
    req = dict(req)
    # A delegation approval launches a task: that stays on this machine.
    if req.get("rule_source") == "delegate":
        await refuse(403, DEVICE_ONLY_DETAIL, "device_only")
    settings = await cloud_approvals.get_settings(db)
    if cloud_approvals.is_device_only(req, settings):
        await refuse(403, DEVICE_ONLY_DETAIL, "device_only")
    allowance = set(settings.get("allowance") or ())
    if duration not in allowance or (
        req.get("rule_source") == "rung" and duration != "once" and "session" not in allowance
    ):
        await refuse(422, DURATION_DETAIL, "duration_not_allowed")
    if duration == "once" and not req.get("call_fingerprint"):
        await refuse(422, "Allow once is not available: the held call's arguments were not recorded",
                     "fingerprint_required")
    by = decided_by(sess)
    try:
        grant, changed = await repo.approve_request(
            request_id, duration, with_change=True, decided_by=by, decision_source="remote",
            max_age_s=cloud_approvals._max_age_s(req))
    except ValueError as ve:
        await refuse(422, str(ve), "not_grantable")
    if grant is None or not changed:
        await refuse(409, "This request was already answered or has expired", "already_decided")
    await decisions.audit(
        db, "allow", session_id=req.get("session_id"), klass=decisions.call_class(req),
        tool_id=req.get("tool_id"), request_id=request_id, by=by, harness=req.get("runtime_kind"),
        reason=f"Approved from another machine by {address}",
    )
    try:
        from securevector.app.services import call_rules

        await call_rules.on_approved(db, req, duration=grant.get("duration"))
    except Exception:  # noqa: BLE001 - never raises by contract
        logger.debug("call_rules.on_approved failed", exc_info=True)
    await audit("remote.approve", "ok", address=address, path=path,
                reason=f"Approved from another machine by {address}: {grant.get('duration')}",
                session_id=req.get("session_id"))
    return {"grant": grant}


async def remote_deny(request: Request, sess: dict, request_id: str, reason: Optional[str]) -> dict:
    from securevector.app.database.connection import get_database
    from securevector.app.database.repositories.jit_access import JitAccessRepository
    from securevector.app.services import cloud_approvals, decisions

    address, path = sess.get("address") or "unknown", _path(request)
    await decisions.refuse_governed_caller(request)
    db = get_database()
    repo = JitAccessRepository(db)
    req = await repo.get_request(request_id)
    if not req or req.get("status") != "pending":
        await audit("remote.deny", "not_found", address=address, path=path,
                    reason="Deny from another machine: no such pending request")
        raise HTTPException(status_code=404, detail="No such pending request")
    req = dict(req)
    by = decided_by(sess)
    if req.get("rule_source") == "delegate":
        from securevector.app.services import delegation

        manager = getattr(getattr(request.app, "state", None), "terminal_manager", None)
        out = await delegation.deny(db, manager, request_id, reason)
        if out is None:
            raise HTTPException(status_code=404, detail="No such pending request")
        await audit("remote.deny", "ok", address=address, path=path,
                    reason=f"Denied from another machine by {address}", session_id=req.get("session_id"))
        return {"denied": True, "delegation": out}
    ok = await repo.deny_request(request_id, reason or f"Denied from another machine by {address}",
                                 decided_by=by, decision_source="remote",
                                 max_age_s=cloud_approvals._max_age_s(req))
    if not ok:
        await audit("remote.deny", "already_decided", address=address, path=path,
                    reason="Deny from another machine: already answered or expired")
        raise HTTPException(status_code=409, detail="This request was already answered or has expired")
    await decisions.audit(
        db, "deny", session_id=req.get("session_id"), klass=decisions.call_class(req),
        tool_id=req.get("tool_id"), request_id=request_id, by=by, harness=req.get("runtime_kind"),
        reason=f"Denied from another machine by {address}",
    )
    await audit("remote.deny", "ok", address=address, path=path,
                reason=f"Denied from another machine by {address}", session_id=req.get("session_id"))
    return {"denied": True}


async def remote_revoke(request: Request, sess: dict, grant_id: str) -> dict:
    from securevector.app.database.connection import get_database
    from securevector.app.database.repositories.jit_access import JitAccessRepository
    from securevector.app.services import decisions

    address, path = sess.get("address") or "unknown", _path(request)
    if _now() - float(sess.get("reauth_at") or 0) > REAUTH_S:
        await audit("remote.revoke", "reauth_required", address=address, path=path,
                    reason=f"Revoke from another machine refused: {REAUTH_DETAIL}")
        raise HTTPException(status_code=401, detail=REAUTH_DETAIL)
    await decisions.refuse_governed_caller(request)
    db = get_database()
    grant = await db.fetch_one("SELECT * FROM jit_access_grants WHERE id = ?", (grant_id,))
    grant = dict(grant) if grant else {}
    ok = await JitAccessRepository(db).revoke_grant(grant_id)
    if not ok:
        await audit("remote.revoke", "not_found", address=address, path=path,
                    reason="Revoke from another machine: no such active approval")
        raise HTTPException(status_code=404, detail="No such active grant")
    await decisions.audit(
        db, "revoke", session_id=grant.get("session_id"), tool_id=grant.get("tool_id"),
        request_id=grant.get("request_id"), by=decided_by(sess), harness=grant.get("runtime_kind"),
        reason=f"Approval revoked from another machine by {address}",
    )
    await audit("remote.revoke", "ok", address=address, path=path,
                reason=f"Approval revoked from another machine by {address}")
    return {"revoked": True}


async def audit_stop(request: Request, sess: dict, task_id: str, outcome: str) -> None:
    await audit("remote.stop", outcome, address=sess.get("address") or "unknown", path=_path(request),
                reason=f"Session {str(task_id)[:64]} stopped from another machine"
                if outcome == "ok" else "Stop from another machine did not apply")


# --- routes ---------------------------------------------------------------------------


class TokenBody(BaseModel):
    token: str = Field(..., min_length=1, max_length=200)


class SettingsChange(BaseModel):
    action: str = Field(..., pattern="^(enable|disable|rotate|update)$")
    allowed_address: Optional[str] = Field(None, max_length=300)
    proxy_address: Optional[Any] = None


def _public_view(request: Request, state: dict, sess: Optional[dict], settings: dict) -> dict:
    out = {
        "enabled": state["remote_access_enabled"],
        "signed_in": sess is not None,
        "allowance": list(settings.get("allowance") or ["once"]),
        "device_only_rules": list(settings.get("device_only_rules") or []),
        "local": asked_on_this_machine(request),
    }
    if sess is not None:
        out["expires_at"] = _iso(min(sess["created"] + SESSION_TTL_S, sess["last_seen"] + SESSION_IDLE_S))
        out["reauth_at"] = _iso(sess.get("reauth_at"))
        out["reauth_fresh"] = _now() - float(sess.get("reauth_at") or 0) <= REAUTH_S
    if out["local"]:
        out.update({
            "bound_loopback_only": bound_loopback_only(request.app),
            # The port the proxy forwards to, for the setup help.
            "web_port": getattr(getattr(request.app, "state", None), "port", None),
            "allowed_address": state.get("remote_allowed_address"),
            "proxy_address": list(state.get("remote_proxy_address") or []),
            "has_token": bool(state.get("remote_token_hash")),
            "token_created_at": state.get("remote_token_created_at"),
            "token_rotated_at": state.get("remote_token_rotated_at"),
        })
    return out


@router.get("/remote-access")
async def get_remote_access(request: Request):
    """The mode's state. Never the token. The address settings only to the
    page opened on this machine."""
    from securevector.app.database.connection import get_database
    from securevector.app.services import cloud_approvals

    state = await get_state()
    sess = None
    if state["remote_access_enabled"]:
        sess = _live_session(_bearer(request), state)
    try:
        settings = await cloud_approvals.get_settings(get_database())
    except Exception:  # noqa: BLE001 - defaults
        settings = cloud_approvals.normalize_settings(None)
    return _public_view(request, state, sess, settings)


def _new_token() -> tuple:
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    salt = secrets.token_hex(16)
    return token, salt, _hash_token(token, salt)


@router.post("/remote-access")
async def change_remote_access(body: SettingsChange, request: Request,
                               x_sv_ui_token: Optional[str] = Header(None)):
    """Turn the mode on or off, rotate the token, or change the addresses.
    Only on this machine, from the app's own page."""
    from securevector.app.server.routes.jit_access import _require_ui_token
    from securevector.app.services import decisions

    if not asked_on_this_machine(request):
        # A signed-in remote browser may only turn the mode off, with the
        # token entered within 10 minutes: it only reduces access.
        sess = await require_remote_or_local(request) if presents_session(request) else None
        if sess is None or body.action != "disable":
            raise HTTPException(status_code=403, detail=LOCAL_ONLY_DETAIL)
        if _now() - float(sess.get("reauth_at") or 0) > REAUTH_S:
            await audit("settings.remote_access.disable", "reauth_required", address=sess["address"],
                        path=_path(request), reason=f"Turning remote access off refused: {REAUTH_DETAIL}")
            raise HTTPException(status_code=401, detail=REAUTH_DETAIL)
        await decisions.refuse_governed_caller(request)
        state = dict(await get_state())
        state["remote_access_enabled"] = False
        state["remote_generation"] = state["remote_generation"] + 1
        _sign_out_everyone()
        saved = await _save_state(state)
        await audit("settings.remote_access.disable", "ok", address=sess["address"], path=_path(request),
                    reason=f"Remote access turned off from another machine by {sess['address']}")
        return {"enabled": saved["remote_access_enabled"], "signed_in": False, "local": False}
    _require_ui_token(x_sv_ui_token)
    await decisions.refuse_governed_caller(request)
    state = dict(await get_state())
    stamp = _iso(_now())
    token = None
    if body.action == "disable":
        state["remote_access_enabled"] = False
        state["remote_generation"] = state["remote_generation"] + 1
        _sign_out_everyone()
    else:
        if body.action in ("enable", "update"):
            if bound_loopback_only(request.app):
                raise HTTPException(status_code=409, detail=NOT_NEEDED_DETAIL)
            try:
                if body.allowed_address is not None or body.action == "enable":
                    state["remote_allowed_address"] = parse_allowed_address(
                        body.allowed_address if body.allowed_address is not None
                        else state.get("remote_allowed_address"))
                if body.proxy_address is not None or body.action == "enable":
                    proxies = parse_proxy_address(
                        body.proxy_address if body.proxy_address is not None
                        else state.get("remote_proxy_address"))
                    if not proxies:
                        raise ValueError("Enter the proxy address the HTTPS requests come from")
                    state["remote_proxy_address"] = proxies
            except ValueError as ve:
                raise HTTPException(status_code=422, detail=str(ve)) from None
        if body.action == "update" and not state.get("remote_token_hash"):
            raise HTTPException(status_code=409, detail="Turn remote access on first")
        if body.action in ("enable", "rotate"):
            if body.action == "rotate" and not state.get("remote_token_hash"):
                raise HTTPException(status_code=409, detail="Turn remote access on first")
            token, salt, digest = _new_token()
            state["remote_token_salt"], state["remote_token_hash"] = salt, digest
            if body.action == "enable" or not state.get("remote_token_created_at"):
                state["remote_token_created_at"] = stamp
            state["remote_token_rotated_at"] = stamp
            state["remote_generation"] = state["remote_generation"] + 1
            _sign_out_everyone()
        if body.action == "enable":
            state["remote_access_enabled"] = True
    try:
        saved = await _save_state(state)
    except RuntimeError as exc:
        _cache["state"] = None  # re-read what is really stored
        raise HTTPException(status_code=409, detail=str(exc)) from None
    await audit(f"settings.remote_access.{body.action}", "info", address="this machine",
                path=_path(request),
                reason=(f"Remote access {body.action} on this machine: "
                        f"enabled={str(saved['remote_access_enabled']).lower()} "
                        f"address={saved.get('remote_allowed_address') or 'none'} "
                        f"proxy={','.join(saved.get('remote_proxy_address') or []) or 'none'}"))
    from securevector.app.database.connection import get_database
    from securevector.app.services import cloud_approvals

    view = _public_view(request, saved, None, await cloud_approvals.get_settings(get_database()))
    if token:
        view["token"] = token  # shown once; only its salted hash is stored
    return view


@router.post("/remote-access/session")
async def sign_in(body: TokenBody, request: Request):
    state = await get_state()
    peer = _peer(request)
    address = remote_address(peer, request.headers, state)
    if not state["remote_access_enabled"]:
        raise HTTPException(status_code=403, detail=OFF_DETAIL)
    if asked_on_this_machine(request):
        raise HTTPException(status_code=403, detail=LOCAL_SESSION_DETAIL)
    if not https_ok(peer, request.headers, state):
        raise HTTPException(status_code=403, detail=HTTPS_DETAIL)
    await _check_token(request, body.token, state, address, "sign_in")
    now = _now()
    sid = secrets.token_hex(32)
    _sessions[sid] = {"created": now, "last_seen": now, "generation": state["remote_generation"],
                      "address": address, "reauth_at": now}
    await audit("remote.sign_in", "ok", address=address, path=_path(request),
                reason="Signed in for remote access")
    return {"session_id": sid, "expires_at": _iso(now + SESSION_TTL_S), "reauth_at": _iso(now)}


@router.post("/remote-access/reauth")
async def reauth(body: TokenBody, request: Request):
    sess = await require_remote_or_local(request)
    if sess is None:
        raise HTTPException(status_code=401, detail=SIGN_IN_DETAIL)
    state = await get_state()
    await _check_token(request, body.token, state, sess["address"], "reauth")
    sess["reauth_at"] = _now()
    await audit("remote.reauth", "ok", address=sess["address"], path=_path(request),
                reason="Access token entered again")
    return {"reauth_at": _iso(sess["reauth_at"])}


@router.post("/remote-access/session/end")
async def sign_out(request: Request):
    sid = _bearer(request)
    sess = _sessions.pop(sid, None) if sid else None
    if sess is not None:
        state = await get_state()
        await audit("remote.sign_out", "ok",
                    address=remote_address(_peer(request), request.headers, state),
                    path=_path(request), reason="Signed out of remote access")
    return {"signed_out": True}

