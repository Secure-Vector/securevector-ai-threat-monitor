"""
Suspicious egress: the few network destinations worth an alert even when the
Guardian is muted (owner, 6.1: "Security alerts break mute").

Read from egress_audit over a short window, never from the page that is open.
A destination is suspicious when it is:

  a. a host this device has never reached before (its first egress_audit
     row falls inside the window, and the device has at least a day of
     egress history, so a fresh install does not alert on everything);
  b. a paste, file-sharing, tunnel or request-capture host, matched by
     domain suffix from a small built-in list;
  c. a raw public IP address (never localhost or a private range);
  d. reached within two minutes after the same session read a credential
     (a credential location or secret-like file named in a call's
     arguments, or a `cred_then_net` rule event);
  e. blocked by the egress policy.

One alert per (session, host). Every alert names the session, the host,
the reasons in plain words and the time. Nothing here stores argument text:
only the credential file name (".env", "id_rsa") is carried, never a value.
"""

from __future__ import annotations

import ipaddress
import logging
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional

logger = logging.getLogger(__name__)

WINDOW_S = 1800                 # alerts cover the last 30 minutes
CRED_GAP_S = 120                # rule d: network within 2 minutes of a credential read
NEW_HOST_HISTORY_S = 86400      # rule a: the device needs a day of egress history
MAX_EGRESS_ROWS = 3000
MAX_CALL_ROWS = 6000
MAX_ALERTS = 50
MAX_SINCE_S = 86400             # a catch-up read after the tab was hidden looks back at most a day
SHARED_TTL_S = 5.0              # the Live grid and the alerts route share one result per interval
KNOWN_TTL_S = 3600.0            # how long a host's first-seen time stays cached in memory

R_NEW, R_SHARE, R_RAW_IP, R_CRED, R_BLOCKED = "new_host", "share_host", "raw_ip", "cred_then_net", "blocked"

# Suffix -> plain kind. Matched on the host or any parent domain.
SHARE_HOSTS: dict = {}
for _kind, _hosts in (
    ("a paste site", ("pastebin.com", "paste.ee", "hastebin.com", "ghostbin.com", "dpaste.com", "dpaste.org",
                      "rentry.co", "paste.rs", "termbin.com", "controlc.com", "privatebin.net", "justpaste.it",
                      "ix.io", "sprunge.us", "gist.github.com", "gist.githubusercontent.com")),
    ("a file-sharing site", ("transfer.sh", "file.io", "0x0.st", "gofile.io", "catbox.moe", "wetransfer.com",
                             "anonfiles.com", "bashupload.com", "tmpfiles.org", "temp.sh", "oshi.at",
                             "filebin.net", "send.vis.ee")),
    ("a tunnel host", ("ngrok.io", "ngrok.app", "ngrok.dev", "ngrok-free.app", "ngrok-free.dev",
                       "trycloudflare.com", "loca.lt", "serveo.net", "localhost.run", "pinggy.io")),
    ("a request capture site", ("webhook.site", "requestbin.com", "requestbin.net", "pipedream.net",
                                "beeceptor.com", "hookbin.com", "interactsh.com", "oast.fun", "oast.pro",
                                "oast.me", "oast.site", "oast.live", "oast.online", "burpcollaborator.net",
                                "canarytokens.com", "requestcatcher.com")),
):
    for _h in _hosts:
        SHARE_HOSTS[_h] = _kind

HARNESS_WORDS = {
    "claude-code": "Claude Code", "codex": "Codex", "copilot-cli": "Copilot CLI", "opencode": "OpenCode",
    "cursor": "Cursor", "antigravity": "Antigravity", "openclaw": "OpenClaw", "govrun": "GovRun", "hermes": "Hermes",
}

# Mirrors RunTrace.dataNames (the span panel's file-name part): secret-like
# file names in a call's arguments. A bare word "credentials" is not a read:
# it needs a path ("~/.aws/credentials") or an extension ("credentials.json").
_CRED_FILE_RE = re.compile(
    r"(?:^|[\s@'\"=/\\])(\.env[\w.-]*|id_rsa|id_ed25519|id_ecdsa|\.npmrc|\.pypirc|\.netrc|\.git-credentials|"
    r"credentials\.json|[\w.-]+\.pem|[\w.-]+\.key)\b"
    r"|[/\\](credentials)\b"
)
# The span panel's env-name pattern (run-trace.js), without URL and PASS,
# and only where the name is read: after $, printenv, getenv, os.environ or
# process.env. "API_KEY" alone in prose is not a read.
_CRED_ENV_RE = re.compile(
    r"(?:\$\{?|\bprintenv\s+|\bgetenv\(\s*['\"]?|\bos\.environ(?:\.get)?\s*[\[(]\s*['\"]|\bprocess\.env\.)"
    r"([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\b"
)
_LOCAL_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home.arpa", ".localdomain", ".intranet",
                   ".corp", ".home")
_LOCAL_NAMES = frozenset({"localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback", "broadcasthost"})


def _norm_host(host: Any) -> str:
    h = str(host or "").strip().lower().rstrip(".")
    if h.startswith("[") and "]" in h:
        h = h[1:h.index("]")]
    return h


def share_kind(host: Any) -> Optional[str]:
    """Rule b: the plain kind of a paste or file-sharing host, by suffix."""
    h = _norm_host(host)
    if not h:
        return None
    parts = h.split(".")
    for i in range(len(parts) - 1):
        kind = SHARE_HOSTS.get(".".join(parts[i:]))
        if kind:
            return kind
    return None


def raw_public_ip(host: Any) -> bool:
    """Rule c: a literal IP that is not loopback, private, link-local or
    otherwise reserved."""
    h = _norm_host(host)
    try:
        ip = ipaddress.ip_address(h)
    except ValueError:
        return False
    return bool(ip.is_global) and not ip.is_multicast


def _local_host(host: Any) -> bool:
    """Loopback, private and link-local addresses, localhost aliases,
    single-label names and local-only suffixes (.internal, .lan, .local,
    .home.arpa, host.docker.internal) never count as outside hosts."""
    h = _norm_host(host)
    if not h or h in _LOCAL_NAMES or h.endswith(_LOCAL_SUFFIXES):
        return True
    try:
        ip = ipaddress.ip_address(h)
    except ValueError:
        return "." not in h
    return not ip.is_global


def credential_name(preview: Any) -> Optional[str]:
    """Rule d: the credential a call's arguments name (a file name or a
    location key), never the argument text itself."""
    if not preview:
        return None
    text = str(preview)
    m = _CRED_FILE_RE.search(text)
    if m:
        return m.group(1) or m.group(2)
    m = _CRED_ENV_RE.search(text)
    if m:
        return m.group(1)
    try:
        from securevector.app.services import session_drift

        found = sorted(session_drift.location_matches(text))
    except Exception:  # noqa: BLE001 - a missing policy table means no match
        found = []
    if found:
        key = found[0]
        return key.rstrip("/").rsplit("/", 1)[-1] or key
    return None


def who(harness: Optional[str], session_id: Any) -> str:
    name = HARNESS_WORDS.get(harness or "", harness or "A session")
    return f"{name} {str(session_id or '')[:8]}".strip()


def _parse(ts: Any) -> Optional[datetime]:
    from securevector.app.services.observability import parse_ts

    return parse_ts(ts)


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if dt else None


def describe(a: dict) -> tuple:
    """(short label for a tile, plain sentence for the Guardian)."""
    reasons = a["reasons"]
    kind = a.get("kind") or ("a raw IP address" if R_RAW_IP in reasons else None)
    descs = []
    if kind:
        descs.append(kind)
    elif R_NEW in reasons:
        descs.append("a host this device has never reached before")
    cred = a.get("cred_name")
    tail = f", right after reading {cred}" if R_CRED in reasons and cred else (
        ", right after reading a credential" if R_CRED in reasons else "")
    host = a["host"]
    lead = ", ".join([host] + descs)
    if R_BLOCKED in reasons:
        text = f"{a['who']} tried to reach {lead}{tail}. Your policy blocked it."
    else:
        verb = "sent data to" if (a.get("write") or R_CRED in reasons) else "reached"
        text = f"{a['who']} {verb} {lead}{tail}."
    short = []
    if R_BLOCKED in reasons:
        short.append("blocked")
    if kind:
        short.append(kind.replace("a ", "", 1))
    if R_NEW in reasons:
        short.append("new host")
    if R_CRED in reasons:
        short.append(f"after reading {cred}" if cred else "after a credential read")
    return ", ".join(short), text


async def _rows(db, sql: str, args: tuple = ()) -> list:
    from securevector.app.services.observability import _safe_all

    return await _safe_all(db, sql, args)


_known: dict = {}      # db path -> {host: (first seen, cached-until monotonic)}
_history: dict = {}    # db path -> (checked-until monotonic, True)
_shared: dict = {}     # db path -> (expires monotonic, alerts)


def _db_key(db) -> str:
    return str(getattr(db, "db_path", id(db)))


def _known_for(db) -> dict:
    return _known.setdefault(_db_key(db), {})


def reset_cache() -> None:
    """Forget cached known hosts and shared results (tests, retention)."""
    _known.clear()
    _history.clear()
    _shared.clear()


async def _has_history(db, start: datetime) -> bool:
    """Rule a's guard: the device reached something at least a day before
    the window. Once true it stays true for KNOWN_TTL_S."""
    key = _db_key(db)
    hit = _history.get(key)
    if hit and hit[0] > time.monotonic():
        return True
    cut = (start - timedelta(seconds=NEW_HOST_HISTORY_S)).strftime("%Y-%m-%d %H:%M:%S")
    rows = await _rows(db, "SELECT 1 AS x FROM egress_audit WHERE timestamp < ? LIMIT 1", (cut,))
    if rows:
        _history[key] = (time.monotonic() + KNOWN_TTL_S, True)
        return True
    return False


async def shared_alerts(db) -> list:
    """The default 30-minute alerts, computed once per SHARED_TTL_S and
    shared by the Live grid and the alerts route."""
    key = _db_key(db)
    hit = _shared.get(key)
    mono = time.monotonic()
    if hit and hit[0] > mono:
        return hit[1]
    alerts = await suspicious_egress(db)
    _shared[key] = (time.monotonic() + SHARED_TTL_S, alerts)
    return alerts


async def suspicious_egress(db, now: Optional[datetime] = None, window_s: int = WINDOW_S,
                            session_ids: Optional[Iterable[str]] = None) -> list:
    """Alerts for the window, newest first, one per (session, host)."""
    now = now or datetime.now(timezone.utc)
    start = now - timedelta(seconds=window_s)
    stamp = start.strftime("%Y-%m-%d %H:%M:%S")
    only = set(session_ids) if session_ids is not None else None
    egress = await _rows(
        db,
        "SELECT session_id, host, action, operation, runtime_kind, timestamp FROM egress_audit "
        "WHERE timestamp >= ? AND session_id IS NOT NULL AND host IS NOT NULL "
        "ORDER BY timestamp DESC LIMIT ?",
        (stamp, MAX_EGRESS_ROWS),
    )
    if only is not None:
        egress = [r for r in egress if r["session_id"] in only]
    if not egress:
        return []
    hosts = sorted({_norm_host(r["host"]) for r in egress if not _local_host(r["host"])})
    sids = sorted({r["session_id"] for r in egress})

    # Rule a: hosts first reached inside the window, on a device with a day
    # of history. Each host's first-seen time is one index seek
    # (idx_egress_audit_host_time) and is cached: it does not depend on the
    # window, so a 30 minute poll and a 24 hour catch-up decide alike.
    new_hosts: set = set()
    if hosts and await _has_history(db, start):
        raw_by_host: dict = {}
        for r in egress:
            if not _local_host(r["host"]):
                raw_by_host.setdefault(_norm_host(r["host"]), set()).add(r["host"])
        first_seen = _known_for(db)
        mono = time.monotonic()
        for h in hosts:
            hit = first_seen.get(h)
            if hit and hit[1] > mono:
                first = hit[0]
            else:
                first = None
                for raw in raw_by_host.get(h, {h}):
                    row = await _rows(db, "SELECT timestamp AS t FROM egress_audit WHERE host = ? "
                                          "ORDER BY timestamp LIMIT 1", (raw,))
                    t = _parse(row[0]["t"]) if row else None
                    if t and (first is None or t < first):
                        first = t
                if first is None:
                    continue
                first_seen[h] = (first, mono + KNOWN_TTL_S)
            if first >= start:
                new_hosts.add(h)

    # Rule d: credential reads per session, from the window minus the gap.
    reads: dict = {}
    if sids:
        from securevector.app.services.observability import _marks

        cstamp = (start - timedelta(seconds=CRED_GAP_S)).strftime("%Y-%m-%d %H:%M:%S")
        for r in await _rows(
            db,
            "SELECT session_id, tool_id, function_name, args_preview, called_at FROM tool_call_audit "
            f"WHERE session_id IN ({_marks(sids)}) AND called_at >= ? ORDER BY id DESC LIMIT ?",
            (*sids, cstamp, MAX_CALL_ROWS),
        ):
            name = None
            if r.get("tool_id") == "sv.call_rule" and r.get("function_name") == "cred_then_net":
                name = ""
            else:
                name = credential_name(r.get("args_preview"))
            if name is None:
                continue
            t = _parse(r.get("called_at"))
            if t:
                reads.setdefault(r["session_id"], []).append((t, name))

    alerts: dict = {}
    for r in reversed(egress):  # oldest first, so `at` is the first sighting
        host = _norm_host(r["host"])
        sid = r["session_id"]
        t = _parse(r.get("timestamp"))
        reasons = []
        if host in new_hosts:
            reasons.append(R_NEW)
        kind = share_kind(host)
        if kind:
            reasons.append(R_SHARE)
        if raw_public_ip(host):
            reasons.append(R_RAW_IP)
        cred = None
        if t and not _local_host(host):
            hits = [(rt, n) for rt, n in reads.get(sid, ()) if t - timedelta(seconds=CRED_GAP_S) <= rt <= t]
            if hits:
                hits.sort(key=lambda x: x[0])
                reasons.append(R_CRED)
                named = [n for _, n in hits if n]
                cred = named[-1] if named else None
        if r.get("action") == "block":
            reasons.append(R_BLOCKED)
        if not reasons:
            continue
        key = f"{sid}|{host}"
        a = alerts.get(key)
        if a is None:
            a = alerts[key] = {
                "id": key, "session_id": sid, "harness": r.get("runtime_kind"), "host": host,
                "reasons": [], "kind": kind, "cred_name": None, "write": False, "at": _iso(t),
                "last_at": _iso(t),
            }
        for x in reasons:
            if x not in a["reasons"]:
                a["reasons"].append(x)
        a["cred_name"] = cred or a["cred_name"]
        a["write"] = a["write"] or r.get("operation") == "write"
        a["harness"] = a["harness"] or r.get("runtime_kind")
        a["last_at"] = _iso(t) or a["last_at"]
    out = []
    order = [R_BLOCKED, R_CRED, R_SHARE, R_RAW_IP, R_NEW]
    for a in alerts.values():
        a["reasons"].sort(key=order.index)
        a["short_id"] = str(a["session_id"])[:8]
        a["who"] = who(a["harness"], a["session_id"])
        a["label"], a["text"] = describe(a)
        a.pop("write", None)
        out.append(a)
    out.sort(key=lambda a: a["last_at"] or "", reverse=True)
    return out[:MAX_ALERTS]


def latest_by_session(alerts: list) -> dict:
    """The newest alert per session, for the Live grid tile."""
    out: dict = {}
    for a in alerts:  # newest first
        out.setdefault(a["session_id"], {k: a[k] for k in ("id", "host", "reasons", "label", "text", "at")})
    return out
