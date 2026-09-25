"""GET /api/governance/gaps: governance from gaps in real activity.

Answers "what went unchecked on this device in the last N days, and what
closes it", from signals the app already records:

- coverage: model-issued tool calls from every Claude Code and Codex
  transcript written in the window (listed by mtime, so sessions SecureVector
  never saw count too) against governed tool_call_audit rows, matched by
  tool name and count; only calls made after recording began count;
- gaps: unrecorded calls per harness, Guard plugins staged but not active,
  untrusted Codex hooks, egress hosts no rule decided, pending approvals and
  runs with loop or failing findings.

Cheap by construction: one directory listing per request builds the session
index, transcripts are read off the event loop through a counts-only cache
keyed by (path, mtime, size) (a warm trace parse is reused), parsing stops at
a 1.5 s budget and returns ``partial: true`` while a background thread keeps
filling the cache, and the whole response is memoised for 60 s (5 s when
partial).

``tools_without_rule`` is not reported: tool_call_audit does not store which
rule (if any) produced a verdict, and ``reason`` is empty both for a default
allow and for a rule without a reason, so the distinction would be a guess.
"""

from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Query

from securevector.app.database.connection import get_database
from securevector.app.services import governance_gaps as G

logger = logging.getLogger(__name__)

router = APIRouter()

MEMO_SECONDS = 60.0
PARTIAL_MEMO_SECONDS = 5.0
BUDGET_SECONDS = 1.5
RUN_CAP = 200
_TRANSCRIPT_RUNTIMES = ("claude-code", "codex")
_HARNESS_MODULES = {
    "claude-code": "hooks_claude_code",
    "codex": "hooks_codex",
    "copilot-cli": "hooks_copilot_cli",
    "cursor": "hooks_cursor",
    "opencode": "hooks_opencode",
    "antigravity": "hooks_antigravity",
}

_memo: dict = {}
_memo_lock: Optional[asyncio.Lock] = None
_warm_thread: Optional[threading.Thread] = None
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_CODEX_ID_RE = re.compile(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$")


def _lock() -> asyncio.Lock:
    """Created on first use, inside a running loop."""
    global _memo_lock
    if _memo_lock is None:
        _memo_lock = asyncio.Lock()
    return _memo_lock

# Counts-only transcript cache: (path, mtime_ns, size) -> [(datetime, [names])].
_CALLS_CACHE_MAX = 400
_calls_cache: "OrderedDict[tuple, list]" = OrderedDict()
_calls_lock = threading.Lock()


def clear_memo() -> None:
    _memo.clear()
    with _calls_lock:
        _calls_cache.clear()


# --- coverage ----------------------------------------------------------------------

def transcript_index(since: datetime, now: datetime) -> dict:
    """{session_id: (runtime, path, mtime)} for every transcript written at
    or after ``since``: ``CLAUDE_HOME/projects/*/*.jsonl`` and the Codex
    date dirs ``CODEX_HOME/sessions/Y/M/D`` from a week before ``since`` to
    today (a rollout is filed by its start day). Never walks the whole tree."""
    from securevector.app.server.routes.transcript_generations import (
        _claude_projects_dir,
        _codex_sessions_dir,
    )

    cutoff = since.timestamp()
    out: dict = {}
    root = _claude_projects_dir()
    if root.is_dir():
        for slug in root.iterdir():
            if not slug.is_dir():
                continue
            for f in slug.glob("*.jsonl"):
                # Session transcripts are named by their UUID; anything else
                # (old agent-*.jsonl subagent files) is not a session.
                if not _UUID_RE.match(f.stem):
                    continue
                try:
                    m = f.stat().st_mtime
                except OSError:
                    continue
                if m >= cutoff:
                    out[f.stem] = ("claude-code", f, m)
    croot = _codex_sessions_dir()
    if croot.is_dir():
        day = (since - timedelta(days=7)).date()
        last = (now + timedelta(days=1)).date()
        while day <= last:
            d = croot / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}"
            if d.is_dir():
                for f in d.glob("rollout-*.jsonl"):
                    hit = _CODEX_ID_RE.search(f.name)
                    try:
                        m = f.stat().st_mtime
                    except OSError:
                        continue
                    if hit and m >= cutoff:
                        out[hit.group(1)] = ("codex", f, m)
            day += timedelta(days=1)
    return out


def _cache_key(path) -> Optional[tuple]:
    try:
        st = path.stat()
    except OSError:
        return None
    return (str(path), st.st_mtime_ns, st.st_size)


def _cached_calls(path) -> Optional[list]:
    key = _cache_key(path)
    if key is None:
        return None
    with _calls_lock:
        hit = _calls_cache.get(key)
        if hit is not None:
            _calls_cache.move_to_end(key)
        return hit


def _session_calls(runtime_kind: str, session_id: str, path) -> Optional[list]:
    """Blocking: one session's transcript as [(called_at, tool_use names)],
    or None when there is no transcript to read. An active session is
    re-read only when its mtime or size changes."""
    from securevector.app.server.routes import traces as T

    if path is None:
        return None
    key = _cache_key(path)
    if key is None:
        return None
    hit = _cached_calls(path)
    if hit is not None:
        return hit
    gens = None
    # A trace open or the health warm-up may already hold this parse.
    with T._parse_lock:
        for k, v in T._parse_cache.items():
            if k[:3] == key:
                gens = v
                break
    if gens is None:
        gens = (T.build_generations_codex(session_id, store_text=False, path=path)
                if runtime_kind == "codex"
                else T.build_generations(session_id, store_text=False, path=path)) or []
    compact = [(T._ts_key(g.get("called_at")), list(g.get("tool_use_names") or [])) for g in gens]
    with _calls_lock:
        _calls_cache[key] = compact
        while len(_calls_cache) > _CALLS_CACHE_MAX:
            _calls_cache.popitem(last=False)
    return compact


def read_calls(entries: list, budget: float = BUDGET_SECONDS) -> tuple[dict, list]:
    """Blocking: {sid: calls} for [(runtime, sid, path)], newest first.
    Cached sessions always answer; parsing stops once ``budget`` seconds
    are spent, and the sessions left over come back as the second value."""
    deadline = time.monotonic() + budget
    out: dict = {}
    pending: list = []
    for rt, sid, path in entries:
        hit = _cached_calls(path)
        if hit is not None:
            out[sid] = hit
            continue
        if time.monotonic() >= deadline:
            pending.append((rt, sid, path))
            continue
        try:
            out[sid] = _session_calls(rt, sid, path)
        except Exception:  # noqa: BLE001 - one bad transcript never sinks the page
            out[sid] = None
    return out, pending


def _warm_rest(pending: list) -> None:
    """Keep filling the cache after a partial answer, one thread at a time."""
    global _warm_thread
    if not pending or (_warm_thread is not None and _warm_thread.is_alive()):
        return

    def run():
        for rt, sid, path in pending:
            try:
                _session_calls(rt, sid, path)
            except Exception:  # noqa: BLE001
                logger.debug("governance warm parse failed for %s", sid, exc_info=True)

    _warm_thread = threading.Thread(target=run, name="sv-governance-warm", daemon=True)
    _warm_thread.start()


async def _audit_rows(db, session_ids: list, since_days: int) -> dict:
    """Governed rows per session, newer than ``since_days``."""
    out: dict = {}
    ids = [s for s in session_ids if s]
    for i in range(0, len(ids), 200):
        chunk = ids[i:i + 200]
        marks = ",".join("?" for _ in chunk)
        rows = await db.fetch_all(
            "SELECT session_id, function_name, tool_id, called_at FROM tool_call_audit "
            f"WHERE called_at >= datetime('now', ?) AND session_id IN ({marks})",
            (f"-{int(since_days)} days", *chunk),
        )
        for r in rows or []:
            out.setdefault(r["session_id"], []).append(dict(r))
    return out


async def recording_since(db) -> Optional[datetime]:
    """When SecureVector started recording on this device: the earliest of
    the app DB's creation (the first schema_version row; migrations stamp
    ``applied_at``) and the first tool_call_audit row. None when neither
    exists. Transcript calls from before it are not counted as ungoverned:
    nothing was recording then (a wiped DB, or history from before install)."""
    from securevector.app.server.routes.traces import _ts_key

    found = []
    for sql in ("SELECT applied_at AS t FROM schema_version",
                "SELECT MIN(called_at) AS t FROM tool_call_audit"):
        try:
            rows = await db.fetch_all(sql)
        except Exception:  # noqa: BLE001
            rows = []
        for r in rows or []:
            if r["t"]:
                found.append(_ts_key(str(r["t"])))
    found = [t for t in found if t.year > 1]
    return min(found) if found else None


async def retention_floor(db, now: datetime) -> datetime:
    """Audit rows older than retention_days are deleted
    (CustomToolsRepository.cleanup_old_audit_records), so calls from before
    this point would look unrecorded. Manual deletes of single audit rows
    record no timestamp, so they cannot be clamped to."""
    days = 30
    try:
        row = await db.fetch_one("SELECT retention_days FROM app_settings WHERE id = 1")
        if row and row["retention_days"]:
            days = max(1, int(row["retention_days"]))
    except Exception:  # noqa: BLE001
        pass
    return now - timedelta(days=days)


def compute_coverage(sessions: list, calls_by_session: dict, rows_by_session: dict,
                     start: datetime, end: datetime, since: Optional[datetime] = None) -> dict:
    """Coverage for one window. ``sessions`` = [(runtime, session_id)];
    ``calls_by_session[sid]`` is the transcript's [(dt, names)] or None.
    Calls before ``since`` (recording start) are left out on both sides; a
    session with no audit rows still counts, all its calls unrecorded."""
    from securevector.app.server.routes.traces import _ts_key

    if since is not None and since > start:
        start = since

    total = governed = 0
    with_transcript = 0
    unrecorded: dict = {}
    for runtime, sid in sessions:
        calls = calls_by_session.get(sid)
        if calls is None:
            continue
        with_transcript += 1
        names = [n for dt, ns in calls if start <= dt < end for n in ns]
        rows = [r for r in rows_by_session.get(sid) or []
                if start <= _ts_key(r.get("called_at")) < end]
        t, g, miss = G.match_calls(names, rows)
        total += t
        governed += g
        if miss:
            per = unrecorded.setdefault(runtime, {})
            for name, n in miss.items():
                per[name] = per.get(name, 0) + n
    return {"governed_calls": governed, "total_calls": total, "pct": G.pct(governed, total),
            "sessions_with_transcript": with_transcript, "unrecorded": unrecorded}


async def _coverage(window_days: int, now: datetime) -> tuple[dict, dict]:
    from securevector.app.server.routes import traces as T

    db = get_database()
    span = timedelta(days=window_days)
    since = await recording_since(db)
    floor = await retention_floor(db, now)
    if since is None or since < floor:
        since = floor
    runs = await T._collect_runs(window_days * 2, RUN_CAP)
    scan_from = max(now - 2 * span, since)
    index = await asyncio.to_thread(transcript_index, scan_from, now)
    # Known runs and on-disk transcripts merge by session id: a session
    # SecureVector never saw still has a transcript, and every call in it
    # is unrecorded.
    known = {r.get("session_id") for r in runs if r.get("runtime_kind") in _TRANSCRIPT_RUNTIMES}
    entries = sorted(((rt, sid, path, m) for sid, (rt, path, m) in index.items()),
                     key=lambda e: (e[1] not in known, -e[3]))
    calls, pending = await asyncio.to_thread(read_calls, [(rt, sid, p) for rt, sid, p, _ in entries])
    if pending:
        _warm_rest(pending)
    sessions = [(rt, sid) for rt, sid, _, _ in entries]
    rows = await _audit_rows(db, [s for _, s in sessions], window_days * 2 + 1)
    cur = compute_coverage(sessions, calls, rows, now - span, now + timedelta(minutes=5), since)
    prev_open = since < now - span
    prev = (compute_coverage(sessions, calls, rows, now - 2 * span, now - span, since)
            if prev_open else {"pct": None, "total_calls": 0})
    coverage = {
        "governed_calls": cur["governed_calls"],
        "total_calls": cur["total_calls"],
        "pct": cur["pct"],
        "prev_pct": prev["pct"],
        "prev_total_calls": prev["total_calls"],
        # The previous window is partial when recording began inside it or
        # the parse budget left sessions unread.
        "prev_partial": prev["pct"] is not None and (since > now - 2 * span or bool(pending)),
        # Set only when recording began inside the current window, so the UI
        # can say "since <date>".
        "recording_since": since.isoformat() if since > now - span else None,
        "sessions": cur["sessions_with_transcript"],
        "partial": bool(pending),
        "note": None,
    }
    if cur["pct"] is None:
        coverage["note"] = (
            "No Claude Code or Codex transcripts were written in this window, so the "
            "calls the agents made cannot be counted."
            if not cur["sessions_with_transcript"] else
            "The transcripts in this window hold no tool calls to check."
        )
    return coverage, cur["unrecorded"]


# --- other gap sources ----------------------------------------------------------

async def _plugin_statuses() -> dict:
    import importlib

    out = {}
    for harness, mod_name in _HARNESS_MODULES.items():
        try:
            mod = importlib.import_module(f"securevector.app.server.routes.{mod_name}")
            st = await mod.plugin_status()
            out[harness] = st.model_dump() if hasattr(st, "model_dump") else dict(st)
        except Exception:  # noqa: BLE001
            logger.debug("plugin status failed for %s", harness, exc_info=True)
    return out


def _codex_trust_blocking() -> dict:
    from securevector.app.server.routes import hooks_codex as C

    installed = C._current_codex_install_path()
    hooks_json = (installed / "hooks" / "hooks.json") if installed else None
    if hooks_json is None or not hooks_json.is_file():
        hooks_json = C.BUNDLED_PLUGIN_DIR / "hooks" / "hooks.json"
    return G.codex_hooks_trust(C.CODEX_CONFIG_TOML, hooks_json, C.INSTALL_KEY)


async def _egress_uncovered(window_days: int) -> list:
    from securevector.app.database.repositories.egress import EgressRepository

    rows = await EgressRepository(get_database()).destination_inventory(days=window_days)
    return [r["host"] for r in rows if r.get("observed_only") and r.get("host")]


async def _pending_approvals() -> int:
    from securevector.app.database.repositories.jit_access import JitAccessRepository

    return await JitAccessRepository(get_database()).pending_count()


async def _agent_health(window_days: int) -> dict:
    from securevector.app.server.routes import traces as T

    runs, by_trace = await T._runs_with_health(window_days, RUN_CAP)
    flagged = 0
    failing = 0
    for r in runs:
        fs = [f for f in by_trace.get(r.get("trace_id")) or [] if f.get("category") in ("loop", "failing")]
        if fs:
            flagged += 1
            failing += sum(1 for f in fs if f.get("category") == "failing")
    return {"runs": flagged, "failing": failing}


# --- assembly -----------------------------------------------------------------------

def _active(statuses: dict, harness: str) -> bool:
    st = (statuses or {}).get(harness) or {}
    return bool(st.get("auto_installed") and st.get("enabled"))


def build_gaps(unrecorded: dict, statuses: dict, codex_trust: Optional[dict],
               egress_hosts: list, pending: int, health: Optional[dict],
               window_days: int) -> list:
    days = f"the last {window_days} days"
    gaps = []
    for runtime, by_tool in sorted((unrecorded or {}).items()):
        n = sum(by_tool.values())
        label = G.harness_label(runtime)
        gaps.append(G.gap(
            "unrecorded_calls", n,
            f"{G.plural(n, 'tool call')} from {label} not recorded",
            f"{label} made {G.plural(n, 'call')} in {days} that SecureVector has no record of, "
            f"so no policy checked them. Most often: {G.top_tools(by_tool)}.",
            {"label": ("How to connect" if _active(statuses, runtime) else f"Connect {label}"),
             "route": G.guide_route(runtime)}, key=runtime))
    for harness, st in sorted((statuses or {}).items()):
        if not st.get("installed") or (st.get("auto_installed") and st.get("enabled")):
            continue
        label = G.harness_label(harness)
        why = ("its files are staged but it is not installed into " + label
               if not st.get("auto_installed") else
               "it is installed but turned off in " + label)
        gaps.append(G.gap(
            "plugin_not_active", 1, f"{label} Guard plugin is not active",
            f"The SecureVector Guard plugin for {label} is not checking calls: {why}.",
            {"label": "Install", "action": f"install_plugin:{harness}"}, key=harness))
    codex = (statuses or {}).get("codex") or {}
    if codex_trust and codex_trust.get("trusted") is False and (codex.get("auto_installed") or codex.get("enabled")):
        n = len(codex_trust.get("missing") or []) or 1
        gaps.append(G.gap(
            "codex_hooks_untrusted", n, "Codex has not trusted the Guard hooks",
            f"Codex skips hooks it has not trusted, so {G.plural(n, 'Guard hook')} will not run "
            "and its tool calls go unchecked.",
            {"label": "In Codex, run /hooks and press t to trust"}))
    hosts = list(egress_hosts or [])
    if hosts:
        shown = ", ".join(hosts[:5]) + (f" and {len(hosts) - 5} more" if len(hosts) > 5 else "")
        gaps.append(G.gap(
            "egress_uncovered_hosts", len(hosts),
            f"{G.plural(len(hosts), 'host')} reached with no egress rule deciding",
            f"Agents reached {shown} in {days}, and no egress policy evaluated those calls.",
            {"label": "Egress Policy", "route": "egress-policy"}))
    gaps.append(G.gap(
        "approvals_pending", pending, f"{G.plural(int(pending or 0), 'approval')} waiting on you",
        "Agents asked for access to a blocked tool and are waiting for a decision.",
        {"label": "Open Agent Sessions", "route": "terminals"}))
    if health:
        n = int(health.get("runs") or 0)
        gaps.append(G.gap(
            "agent_health", n, f"{G.plural(n, 'run')} looping or failing",
            f"Runs in {days} repeated the same calls or hit failing steps, which wastes spend "
            "and can hide a stuck agent.",
            {"label": "Open Health", "route": "run-health"},
            severity="warn" if health.get("failing") else "info"))
    return G.sort_gaps(gaps)


async def _safe(coro, default):
    try:
        return await coro
    except Exception:  # noqa: BLE001 - one missing signal never sinks the page
        logger.debug("governance gap source failed", exc_info=True)
        return default


async def compute_gaps(window_days: int, now: Optional[datetime] = None) -> dict:
    now = now or datetime.now(timezone.utc)
    cov = await _safe(_coverage(window_days, now), None)
    if cov is None:
        coverage = {"governed_calls": 0, "total_calls": 0, "pct": None, "prev_pct": None,
                    "prev_total_calls": 0, "prev_partial": False, "recording_since": None,
                    "sessions": 0, "partial": False, "note": "Coverage could not be computed right now."}
        unrecorded = {}
    else:
        coverage, unrecorded = cov
    statuses = await _safe(_plugin_statuses(), {})
    codex_trust = None
    codex = statuses.get("codex") or {}
    if codex.get("auto_installed") or codex.get("enabled"):
        codex_trust = await _safe(asyncio.to_thread(_codex_trust_blocking), None)
    hosts = await _safe(_egress_uncovered(window_days), [])
    pending = await _safe(_pending_approvals(), 0)
    health = await _safe(_agent_health(window_days), None)
    return {
        "window_days": window_days,
        "coverage": coverage,
        "gaps": build_gaps(unrecorded, statuses, codex_trust, hosts, pending, health, window_days),
        "partial": bool(coverage.get("partial")),
        "generated_at": now.isoformat(),
    }


@router.get("/governance/gaps")
async def governance_gaps(window_days: int = Query(7, ge=1, le=30), refresh: bool = Query(False)):
    """Coverage of model-issued tool calls plus the gaps to close, from real
    activity in the window. Memoised for 60 s per window; ``refresh=true``
    (sent after a Fix, e.g. a plugin install) recomputes."""
    wd = int(window_days)
    fresh = refresh is True  # a direct call sees the Query default object, not a bool

    def live(hit):
        if not hit or fresh:
            return False
        ttl = PARTIAL_MEMO_SECONDS if hit[1].get("partial") else MEMO_SECONDS
        return time.monotonic() - hit[0] < ttl

    if live(_memo.get(wd)):
        return _memo[wd][1]
    async with _lock():
        if live(_memo.get(wd)):
            return _memo[wd][1]
        result = await compute_gaps(wd)
        _memo[wd] = (time.monotonic(), result)
        return result
