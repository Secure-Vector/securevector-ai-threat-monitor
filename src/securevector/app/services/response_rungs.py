"""
Response rungs 1 to 3 for one governed session: observe, flag, step-up.

A rung only ever adds an approval. This module computes and records a rung
per session. Only rung 3 in active mode changes anything: calls in the
step-up class (see `step_up_kind`) wait for a human approval in that one
session. Nothing here allows a call, stops a session or touches another
session. Mode is per harness, `shadow` by default; active mode can be set
only after a completed shadow period (or an explicit early end).

`step()` is pure (state, signals, now -> state) so the same logic replays
offline over recorded sessions. `evaluate()` gathers the signals from the
drift row, the setup checks and the pre-flight decisions, then records the
transition and one audit row. Nothing here logs request or hook values.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional

from securevector.app.services import session_drift as drift

logger = logging.getLogger(__name__)

TOOL_ID = "sv.response_rung"

OBSERVE, FLAG, STEP_UP = 1, 2, 3
RUNG_WORDS = {OBSERVE: "observe", FLAG: "flag", STEP_UP: "step-up"}

MODE_SHADOW = "shadow"
MODE_ACTIVE = "active"
MODES = (MODE_SHADOW, MODE_ACTIVE)

SIG_DRIFT = "drift"
SIG_CONFIG = "config"
SIG_DENY = "deny"

CONSECUTIVE = 2             # computes in the band before a rung is earned
DENY_WINDOW_MIN = 10
DENY_STEP_UP = 3
DOWN_FROM_3_BELOW = 60
DOWN_FROM_2_BELOW = 30
QUIET_MINUTES = 5           # no signal of the higher rung before stepping down
COOLDOWN_MINUTES = 10

SHADOW_MIN_SESSIONS = 10
SHADOW_MIN_DAYS = 7

FEEDBACK_NOT_NEEDED = "not_needed"
_UNINTENDED_FEEDBACK = (FEEDBACK_NOT_NEEDED, drift.FEEDBACK_NORMAL)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def _parse(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00").replace(" ", "T"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def config_signature() -> str:
    """Changes when the drift weights or bands change; shadow restarts then."""
    raw = json.dumps([sorted(drift.WEIGHTS.items()), drift.WATCH_FROM, drift.HIGH_FROM])
    return hashlib.sha256(raw.encode()).hexdigest()[:12]


@dataclass(frozen=True)
class Signals:
    """What one evaluation sees. Counts and states only, no names."""

    band: Optional[str] = None
    score: Optional[int] = None
    computed_at: str = ""            # identifies one drift compute
    config_moved: bool = False       # setup changed or is unapproved mid-session
    config_red: bool = False         # a red-class change (hooks, mcp, permissions, plugins)
    deny_attempts: int = 0           # attempts after deny in the last 10 minutes


@dataclass
class RungState:
    rung: int = OBSERVE
    reasons: list = field(default_factory=list)
    since: str = ""
    last_drift_at: str = ""
    streak_watch: int = 0
    streak_high: int = 0
    last_r2_at: str = ""
    last_r3_at: str = ""
    cooldown_until: str = ""
    cooldown_kinds: list = field(default_factory=list)
    pinned: bool = False
    peak_rung: int = OBSERVE


def _above_watch(band: Optional[str]) -> bool:
    return band in (drift.BAND_WATCH, drift.BAND_HIGH)


def target_for(state: RungState, sig: Signals) -> tuple:
    """(rung, {signal kinds per rung}) the signals call for right now."""
    kinds = {OBSERVE: set(), FLAG: set(), STEP_UP: set()}
    if state.streak_high >= CONSECUTIVE:
        kinds[STEP_UP].add(SIG_DRIFT)
    elif state.streak_watch >= CONSECUTIVE:
        kinds[FLAG].add(SIG_DRIFT)
    if sig.config_moved:
        if sig.config_red and _above_watch(sig.band):
            kinds[STEP_UP].add(SIG_CONFIG)
        else:
            kinds[FLAG].add(SIG_CONFIG)
    if sig.deny_attempts >= DENY_STEP_UP or (sig.deny_attempts >= 1 and _above_watch(sig.band)):
        kinds[STEP_UP].add(SIG_DENY)
    elif sig.deny_attempts >= 1:
        kinds[FLAG].add(SIG_DENY)
    rung = STEP_UP if kinds[STEP_UP] else FLAG if kinds[FLAG] else OBSERVE
    return rung, kinds


def step(state: RungState, sig: Signals, now: datetime) -> RungState:
    """One evaluation. Returns a new state; never touches the verdict."""
    s = RungState(**vars(state))
    s.reasons = list(state.reasons)
    s.cooldown_kinds = list(state.cooldown_kinds)
    if s.pinned:
        return s
    stamp = _iso(now)
    # A drift compute counts once, however often it is read.
    if sig.computed_at and sig.computed_at != s.last_drift_at:
        s.last_drift_at = sig.computed_at
        s.streak_watch = s.streak_watch + 1 if _above_watch(sig.band) else 0
        s.streak_high = s.streak_high + 1 if sig.band == drift.BAND_HIGH else 0
    target, kinds = target_for(s, sig)
    if kinds[STEP_UP]:
        s.last_r3_at = stamp
    if kinds[STEP_UP] or kinds[FLAG]:
        s.last_r2_at = stamp
    cooling = bool(s.cooldown_until) and stamp < s.cooldown_until
    if target > s.rung:
        fired = kinds[target] | (kinds[FLAG] if target == STEP_UP else set())
        # During cooldown only a different signal kind may step up again.
        if cooling and fired and fired <= set(s.cooldown_kinds):
            return s
        s.rung = target
        s.reasons = sorted(kinds[target])
        s.since = stamp
    elif target < s.rung:
        score = sig.score if sig.score is not None else 0
        quiet = timedelta(minutes=QUIET_MINUTES)
        if s.rung == STEP_UP and score < DOWN_FROM_3_BELOW and _quiet(s.last_r3_at, now, quiet):
            _step_down(s, STEP_UP - 1, kinds, now)
        elif s.rung == FLAG and score < DOWN_FROM_2_BELOW and _quiet(s.last_r2_at, now, quiet):
            _step_down(s, FLAG - 1, kinds, now)
    else:
        if target > OBSERVE:
            s.reasons = sorted(kinds[target])
    s.peak_rung = max(s.peak_rung, s.rung)
    return s


def _quiet(last: str, now: datetime, quiet: timedelta) -> bool:
    prev = _parse(last)
    return prev is None or now - prev >= quiet


def _step_down(s: RungState, to: int, kinds: Mapping, now: datetime) -> None:
    live = set(s.cooldown_kinds) if s.cooldown_until and _iso(now) < s.cooldown_until else set()
    s.cooldown_kinds = sorted(live | set(s.reasons))
    s.cooldown_until = _iso(now + timedelta(minutes=COOLDOWN_MINUTES))
    s.rung = to
    s.reasons = sorted(kinds[to]) if to > OBSERVE else []
    s.since = _iso(now)


def release(state: RungState, now: datetime) -> RungState:
    """Back to observe: pin the session to rung 1 and start a cooldown."""
    s = RungState(**vars(state))
    s.cooldown_kinds = sorted(set(state.reasons))
    s.cooldown_until = _iso(now + timedelta(minutes=COOLDOWN_MINUTES))
    s.rung, s.reasons, s.pinned, s.since = OBSERVE, [], True, _iso(now)
    return s


def function_for(old: int, new: int, mode: str) -> str:
    if new == STEP_UP:
        return "rung.stepup" if mode == MODE_ACTIVE else "rung.shadow_stepup"
    return "rung.flag" if new == FLAG else "rung.observe"


# --- shadow progress ------------------------------------------------------------------


def progress_of(mode_row: Mapping[str, Any], sessions: int, unintended: int, now: datetime) -> dict:
    started = _parse(mode_row.get("shadow_started_at")) or now
    days = max(0, (now - started).days)
    complete = sessions >= SHADOW_MIN_SESSIONS and days >= SHADOW_MIN_DAYS and unintended == 0
    early = bool(mode_row.get("early_ended"))
    return {
        "harness": mode_row.get("harness"),
        "mode": mode_row.get("mode") or MODE_SHADOW,
        "sessions": sessions, "sessions_needed": SHADOW_MIN_SESSIONS,
        "days": days, "days_needed": SHADOW_MIN_DAYS,
        "unintended": unintended,
        "complete": complete, "early_ended": early,
        "can_activate": complete or early,
    }


class ModeError(ValueError):
    """Active mode asked for before shadow is complete."""


async def set_mode(db, harness: str, mode: str, now: Optional[datetime] = None) -> dict:
    """Switch one harness. Back to shadow is always allowed; active needs a
    completed shadow period or an explicit early end."""
    from securevector.app.database.repositories.response_rungs import ResponseRungsRepository

    if mode not in MODES:
        raise ModeError("Unknown mode")
    now = now or datetime.now(timezone.utc)
    repo = ResponseRungsRepository(db)
    prog = await shadow_progress(db, harness, now)
    if mode == MODE_ACTIVE and not prog["can_activate"]:
        raise ModeError("Shadow period is not complete")
    old = prog["mode"]
    await repo.set_mode(harness, mode, _iso(now))
    if old != mode:
        await _audit(db, "rung.mode", harness, None, f"from={old} to={mode}")
        await _harness_event(db, harness, f"mode: {mode}")
    return await shadow_progress(db, harness, now)


async def _peek_row(db, harness: str, now: datetime) -> dict:
    """Stored mode row without writing; defaults when the harness is unseen
    or its config signature is stale (shadow would restart on next write)."""
    from securevector.app.database.repositories.response_rungs import ResponseRungsRepository

    row = await ResponseRungsRepository(db).mode_peek(harness)
    if row is None or row.get("config_sig") != config_signature():
        return {"harness": harness, "mode": MODE_SHADOW, "shadow_started_at": _iso(now), "early_ended": 0}
    return row


async def end_shadow_early(db, harness: str, now: Optional[datetime] = None) -> dict:
    """Flag a low-volume harness as allowed to go active early. The caller
    (a later UI) shows what shadow would have stepped up before this."""
    from securevector.app.database.repositories.response_rungs import ResponseRungsRepository

    now = now or datetime.now(timezone.utc)
    repo = ResponseRungsRepository(db)
    await repo.mode_row(harness, _iso(now), config_signature())  # row and signature first
    await repo.set_early_end(harness, True, _iso(now))
    return await shadow_progress(db, harness, now)


async def shadow_progress(db, harness: str, now: Optional[datetime] = None, read_only: bool = False) -> dict:
    from securevector.app.database.repositories.response_rungs import ResponseRungsRepository

    now = now or datetime.now(timezone.utc)
    repo = ResponseRungsRepository(db)
    if read_only:
        row = await _peek_row(db, harness, now)
    else:
        row = await repo.mode_row(harness, _iso(now), config_signature())
    sessions, unintended = await repo.shadow_counts(harness, row["shadow_started_at"])
    return progress_of(row, sessions, unintended, now)


async def shadow_would_have(db, harness: str, now: Optional[datetime] = None, read_only: bool = False) -> dict:
    """What shadow would have stepped up so far (count and top reasons),
    for the early-end confirm."""
    from securevector.app.database.repositories.response_rungs import ResponseRungsRepository

    now = now or datetime.now(timezone.utc)
    if read_only:
        row = await _peek_row(db, harness, now)
    else:
        row = await ResponseRungsRepository(db).mode_row(harness, _iso(now), config_signature())
    rows = await ResponseRungsRepository(db).shadow_stepups(harness, row["shadow_started_at"])
    tally: dict = {}
    for r in rows:
        for reason in json.loads(r.get("reasons_json") or "[]"):
            tally[reason] = tally.get(reason, 0) + 1
    top = sorted(tally.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    asks = sum(int(r.get("would_ask") or 0) for r in rows)
    return {"count": len(rows), "top_reasons": [{"signal": k, "sessions": v} for k, v in top],
            "would_need_approval": asks}


# --- gathering and recording ----------------------------------------------------------


async def _audit(db, function_name: str, harness: str, session_id: Optional[str], preview: str) -> None:
    from securevector.app.database.repositories.custom_tools import CustomToolsRepository

    try:
        await CustomToolsRepository(db).log_tool_call_audit(
            TOOL_ID, function_name, "log_only", reason="Response rung", args_preview=preview[:500],
            runtime_kind=harness, session_id=session_id,
        )
    except Exception:  # noqa: BLE001 - the audit write must never break an evaluation
        logger.debug("response rung audit write failed", exc_info=True)


async def gather(db, session_id: str, task: Mapping[str, Any], result, now: datetime) -> Signals:
    from securevector.app.database.repositories.config_trust import ConfigTrustRepository
    from securevector.app.database.repositories.policy_decisions import PolicyDecisionsRepository

    moved = red = False
    checks = await ConfigTrustRepository(db).checks_for(task.get("id"), session_id)
    if checks:
        first, last = checks[0], checks[-1]
        moved = first["setup_hash"] != last["setup_hash"] and last["state"] in ("changed", "new")
        red = moved and any(c.get("severity") == "red" for c in last.get("diff") or [])
    since = _iso(now - timedelta(minutes=DENY_WINDOW_MIN))
    deny = await PolicyDecisionsRepository(db).recent_attempts_after_deny(session_id, task.get("id"), since)
    return Signals(result.band, result.score, result.computed_at, moved, red, deny)


# One evaluation per session at a time: the warm loop and the exit pass can
# reach the same session together, and each reads, steps and writes its row.
_SESSION_LOCKS: dict[str, list] = {}


async def _locked(session_id: str, fn, *args, **kwargs):
    """Run one read-step-write on a session's row, serialised per session."""
    entry = _SESSION_LOCKS.setdefault(session_id, [asyncio.Lock(), 0])
    entry[1] += 1
    try:
        async with entry[0]:
            return await fn(*args, **kwargs)
    finally:
        entry[1] -= 1
        if entry[1] == 0:
            _SESSION_LOCKS.pop(session_id, None)


async def evaluate(db, session_id: str, *args, **kwargs) -> Optional[dict]:
    """Evaluate one session's rung, serialised per session."""
    return await _locked(session_id, _evaluate, db, session_id, *args, **kwargs)


async def _evaluate(db, session_id: str, task: Optional[Mapping[str, Any]] = None, result=None,
                   now: Optional[datetime] = None, ended: Optional[bool] = None) -> Optional[dict]:
    """Compute and record this session's rung. Observe only: returns the
    stored row and applies nothing. Never raises for a missing session."""
    from securevector.app.database.repositories.response_rungs import ResponseRungsRepository
    from securevector.app.database.repositories.session_drift import SessionDriftRepository

    if not session_id:
        return None
    now = now or datetime.now(timezone.utc)
    task = dict(task) if task else (await SessionDriftRepository(db).task_for_session(session_id) or {})
    if result is None:
        row = await SessionDriftRepository(db).get(session_id)
        if row is None:
            return None
        result = drift.result_from_row(row)
    repo = ResponseRungsRepository(db)
    harness = (task.get("executor_id") or await SessionDriftRepository(db).session_harness(session_id) or "")
    prev_row = await repo.get(session_id)
    if prev_row is not None:
        mode = prev_row["mode"]   # a session keeps the mode it started under
    elif harness:
        mode = (await repo.mode_row(harness, _iso(now), config_signature()))["mode"]
    else:
        mode = MODE_SHADOW
    prev = _state_of(prev_row)
    sig = await gather(db, session_id, task, result, now)
    new = step(prev, sig, now)
    ended = bool(task.get("ended_at")) if ended is None else ended
    await repo.upsert(session_id, task.get("id"), harness, mode, new, _iso(now), ended)
    if new.rung != prev.rung or (prev_row is None and new.rung != OBSERVE):
        kinds = ",".join(new.reasons) or "none"
        await _audit(db, function_for(prev.rung, new.rung, mode), harness, session_id,
                     f"from={prev.rung} to={new.rung} mode={mode} signals={kinds}")
        await _task_event(db, task.get("id"), "rung", event_detail(new.rung, new.reasons, mode, sig.band))
    return await repo.get(session_id)


async def release_session(db, session_id: str, now: Optional[datetime] = None,
                          origin: str = "ui") -> Optional[dict]:
    """Back to observe for one session: pin it to rung 1, revoke the
    session's rung grants and cancel its pending rung requests. Shares the
    per-session lock with evaluate, so the two never interleave."""
    return await _locked(session_id, _release_session, db, session_id, now, origin)


async def _release_session(db, session_id: str, now: Optional[datetime], origin: str) -> Optional[dict]:
    from securevector.app.database.repositories.jit_access import JitAccessRepository
    from securevector.app.database.repositories.response_rungs import ResponseRungsRepository

    now = now or datetime.now(timezone.utc)
    repo = ResponseRungsRepository(db)
    row = await repo.get(session_id)
    if row is None:
        return None
    new = release(_state_of(row), now)
    await repo.upsert(session_id, row.get("task_id"), row["harness"], row["mode"], new, _iso(now),
                      bool(row.get("counted_at")), released=True)
    jit = JitAccessRepository(db)
    revoked = 0
    for gid in await repo.active_grant_ids(session_id):
        revoked += int(await jit.revoke_grant(gid))
    cancelled = await repo.cancel_pending(session_id)
    await _audit(db, "rung.release", row["harness"], session_id,
                 f"from={row['rung']} to={OBSERVE} mode={row['mode']} grants={revoked} requests={cancelled}")
    await _task_event(db, row.get("task_id"), "rung", "observe: released", origin=origin)
    return await repo.get(session_id)


async def set_feedback(db, session_id: str, feedback: Optional[str]) -> None:
    from securevector.app.database.repositories.response_rungs import ResponseRungsRepository

    await ResponseRungsRepository(db).set_feedback(session_id, feedback)


# --- task events ----------------------------------------------------------------------

SIGNAL_WORDS = {SIG_DRIFT: "drift", SIG_CONFIG: "setup change", SIG_DENY: "retry after deny"}


def event_detail(rung: int, reasons, mode: str, band: Optional[str] = None) -> str:
    """Short trail text: rung word and signal words. Never arguments or names."""
    words = []
    for r in reasons or []:
        w = SIGNAL_WORDS.get(r, "signal")
        if r == SIG_DRIFT and band:
            w = f"drift {band}"
        words.append(w)
    head = RUNG_WORDS.get(rung, "observe")
    if rung == STEP_UP and mode != MODE_ACTIVE:
        head += " (shadow)"
    return f"{head}: {', '.join(words)}" if words else head


async def _task_event(db, task_id: Optional[str], kind: str, detail: str, origin: str = "rung") -> None:
    if not task_id:
        return
    from securevector.app.terminals.store import TerminalStore

    try:
        await TerminalStore(db).add_event(task_id, kind=kind, origin=origin, detail=detail[:200])
    except Exception:  # noqa: BLE001 - the trail write never breaks an evaluation
        logger.debug("response rung task event failed", exc_info=True)


async def _harness_event(db, harness: str, detail: str) -> None:
    """A mode change lands on every running task of that harness."""
    try:
        rows = await db.fetch_all(
            "SELECT id FROM terminal_tasks WHERE executor_id = ? AND ended_at IS NULL LIMIT 50", (harness,)
        )
    except Exception:  # noqa: BLE001
        return
    for r in rows or []:
        await _task_event(db, r["id"], "rung", detail, origin="ui")


# --- step-up class (rung 3, active mode) ------------------------------------------------
#
# One definition, read by the Guard's per-call path (tool rows from
# /synced-overrides and the egress check) and by check_policy, so the two
# always answer alike. A call is in the class only when the Guard would
# allow it; a rung adds an approval and never turns a block into anything.

RUNG_SOURCE = "rung"
REQUESTS_PER_HOUR = 20

KIND_SHELL = "shell"
KIND_NEW_TOOL = "new_tool"
KIND_PATH = "sensitive_path"
KIND_ENV = "sensitive_env"
KIND_HOST = "new_host"

SHELL_TOOLS = frozenset({
    "bash", "powershell", "shell", "exec", "exec_command", "execute", "run_command",
    "terminal", "run_terminal_cmd", "local_shell",
})


def _self_tool(name: str) -> bool:
    low = name.lower()
    return low.startswith(("sv.", "securevector:", "mcp__securevector__"))


def _ineligible(name: Any) -> bool:
    """Ids a rung never holds or files for: empty, the run-wide `*`, egress
    host ids and the app's own tools."""
    if not isinstance(name, str):
        return True
    low = name.strip().lower()
    return not low or "*" in low or low.startswith("egress:") or _self_tool(low)


def _name_forms(name: str) -> set:
    """The spellings that name one tool exactly: the full id, lower case,
    and for `mcp__s__t` also `s:t`. Never the bare `t`: a tool on another
    server with the same short name is a different tool."""
    low = name.strip().lower()
    forms = {low}
    if low.startswith("mcp__"):
        rest = low[5:]
        idx = rest.find("__")
        if idx > 0 and rest[idx + 2:]:
            forms.add(f"{rest[:idx]}:{rest[idx + 2:]}")
    return forms


def _dangerous(kind_list) -> tuple:
    return tuple(p for p, level, _d in kind_list if level == "dangerous")


def marker_patterns() -> dict:
    """The dangerous path fragments (lower case, home prefix dropped) and
    environment keys from the policy defaults. One list for the server and
    the Guard hook, which receives it in the step-up marker row."""
    from securevector.app.services.policy_defaults import ENV_VAR_PERMISSIONS, FILE_PATH_PERMISSIONS

    paths = []
    for pattern in _dangerous(FILE_PATH_PERMISSIONS):
        frag = pattern
        for prefix in ("~", "%USERPROFILE%", "%APPDATA%"):
            if frag.startswith(prefix):
                frag = frag[len(prefix):]
        if frag:
            paths.append(frag.lower())
    env = [k for k in _dangerous(ENV_VAR_PERMISSIONS) if "*" not in k]
    return {"paths": paths, "env_keys": env}


def _strings(value: Any, out: list, depth: int = 0) -> None:
    if depth > 8 or len(out) > 2000:
        return
    if isinstance(value, str):
        out.append(value)
    elif isinstance(value, dict):
        for k, v in value.items():
            out.append(str(k))
            _strings(v, out, depth + 1)
    elif isinstance(value, (list, tuple)):
        for v in value:
            _strings(v, out, depth + 1)


def _input_text(tool_input: Any) -> str:
    """Every string in the input (keys included), one per line."""
    out: list = []
    _strings(tool_input, out)
    return "\n".join(out)[:65536]


def _path_hit(text: str, paths=None) -> bool:
    low = text.lower()
    return any(frag in low for frag in (paths if paths is not None else marker_patterns()["paths"]))


def _env_hit(text: str, keys=None) -> bool:
    import re

    keys = keys if keys is not None else marker_patterns()["env_keys"]
    return any(re.search(rf"(?<![A-Za-z0-9_]){re.escape(k)}(?![A-Za-z0-9_])", text) for k in keys)


def step_up_kind(tool_name: Any, tool_input: Any = None, *, baseline_tools=None,
                 hosts=None, baseline_hosts=None) -> Optional[str]:
    """Why this call is in the step-up class, or None. Pure.

    By name: a shell or exec tool, or a tool the session's Drift baseline
    has not seen (only when a baseline exists). By arguments, when given: a
    dangerous path or environment key, or a host new for the folder."""
    if _ineligible(tool_name):
        return None
    forms = _name_forms(tool_name)
    if forms & SHELL_TOOLS:
        return KIND_SHELL
    if baseline_tools is not None:
        known = set()
        for t in baseline_tools:
            known |= _name_forms(str(t))
        if not forms & known:
            return KIND_NEW_TOOL
    text = _input_text(tool_input)
    if text and _path_hit(text):
        return KIND_PATH
    if text and _env_hit(text):
        return KIND_ENV
    if hosts and baseline_hosts is not None:
        seen = {str(h).lower() for h in baseline_hosts}
        if any(h and str(h).lower() not in seen for h in hosts):
            return KIND_HOST
    return None


async def _rung_view(db, session_id: Optional[str]) -> Optional[dict]:
    """The session's rung row and baseline when it is at rung 3, else None."""
    from securevector.app.database.repositories.response_rungs import ResponseRungsRepository
    from securevector.app.database.repositories.session_drift import SessionDriftRepository

    if not session_id:
        return None
    try:
        row = await ResponseRungsRepository(db).get(session_id)
    except Exception:  # noqa: BLE001 - no rung table, no rung
        return None
    if not row or int(row.get("rung") or OBSERVE) != STEP_UP:
        return None
    drepo = SessionDriftRepository(db)
    task = await drepo.task_for_session(session_id) or {}
    harness = row.get("harness") or task.get("executor_id") or ""
    baseline = None
    if harness:
        per = await drift._harness_sessions(drepo, harness)
        baseline, _ = drift.choose_baseline(per, session_id=session_id, workspace=task.get("workspace"))
    return {"row": row, "applied": active_rung(row) == STEP_UP, "baseline": baseline}


def _verdict_allows(key: str, rows: list, session_id: Optional[str]) -> bool:
    """First-seen-wins over `key` then its bare suffix, as the hooks read."""
    by_id: dict = {}
    for r in rows:
        if not isinstance(r, dict) or not isinstance(r.get("tool_id"), str):
            continue
        if r.get("source") == MARKER_SOURCE:
            continue
        if r.get("source") == "jit_grant" and r.get("session_id") and r.get("session_id") != session_id:
            continue
        by_id.setdefault(r["tool_id"].lower(), r)
    run_row = by_id.get("*")
    if run_row and run_row.get("effect") != "allow":
        return False
    cands = [key] + ([key.split(":", 1)[1]] if ":" in key else [])
    for c in cands:
        hit = by_id.get(c)
        if hit:
            return hit.get("effect") == "allow"
    return True


async def step_up_rows(db, session_id: Optional[str], rows: list) -> list:
    """Tool rows for a session at active rung 3: one requestable deny per
    tool name in the step-up class that the rows in force would allow and
    that has no rung grant. Empty in shadow mode and for every other session."""
    from securevector.app.database.repositories.response_rungs import ResponseRungsRepository
    from securevector.app.database.repositories.session_drift import SessionDriftRepository

    view = await _rung_view(db, session_id)
    if view is None or not view["applied"]:
        return []
    baseline = view["baseline"]
    names: set = set(SHELL_TOOLS)
    if baseline is not None:
        from securevector.app.server.routes import tool_permissions as tp
        from securevector.app.services.policy_check import _BUILTIN_TOOLS, tool_candidates

        names |= {n.lower() for n in _BUILTIN_TOOLS}
        names |= {str(k).lower() for k in (tp._get_registry() or {})}
        # Namespaced rule ids only: a bare id in the rows is the short alias
        # of a `server:tool` rule, and is held through its full form.
        names |= {str(r["tool_id"]).lower() for r in rows if isinstance(r, dict)
                  and isinstance(r.get("tool_id"), str) and ":" in r["tool_id"]
                  and r.get("source") != MARKER_SOURCE}
        for c in await SessionDriftRepository(db).session_calls(session_id, limit=5000):
            raw = str(c.get("function_name") or c.get("tool_id") or "")
            cands = tool_candidates(raw)
            names.add((cands[0] if cands else raw).lower())
    granted = await ResponseRungsRepository(db).granted_tools(session_id)
    out = []
    for key in sorted(n for n in names if n and n != "*"):
        if key in granted or _self_tool(key) or key.startswith("egress:"):
            continue
        kind = step_up_kind(key, baseline_tools=baseline.tools if baseline else None)
        if kind is None or not _verdict_allows(key, rows, session_id):
            continue
        out.append({
            "tool_id": key, "effect": "deny", "priority": 140, "policy_id": "_rung",
            "policy_name": "Response rung", "policy_version": 0, "org_name": "Local",
            "reason": "This session is at step-up: this call needs a human approval",
            "source": RUNG_SOURCE, "requestable": True, "session_id": session_id,
        })
    out.append(marker_row(session_id, baseline, granted))
    return out


# The id has a space, which no tool name normalises to, so no candidate
# ever matches it; the effect is not one any consumer maps to a verdict.
MARKER_ID = "rung step-up marker"
MARKER_SOURCE = "rung_marker"
MARKER_EFFECT = "marker"


def marker_row(session_id: str, baseline, granted) -> dict:
    """One row the Guard hook reads for per-call checks it can only make with
    the call in hand: dangerous paths and environment keys in the input, and
    a tool the baseline has not seen that no rule row names. It names no
    real tool, so a consumer that does not know it never matches it."""
    known = None
    if baseline is not None:
        forms: set = set()
        for t in baseline.tools:
            forms |= _name_forms(str(t))
        known = sorted(forms)
    return {
        "tool_id": MARKER_ID, "effect": MARKER_EFFECT, "priority": 0, "policy_id": "_rung",
        "policy_name": "Response rung", "policy_version": 0, "org_name": "Local",
        "reason": "This session is at step-up: this call needs a human approval",
        "source": MARKER_SOURCE, "session_id": session_id,
        "step_up": {**marker_patterns(), "known_tools": known, "granted": sorted(granted)},
    }


def find_marker(rows, session_id: Optional[str]) -> Optional[dict]:
    for r in rows or []:
        if isinstance(r, dict) and r.get("source") == MARKER_SOURCE and r.get("session_id") == session_id:
            return r
    return None


def marker_kind(tool_name: Any, tool_input: Any, marker: Optional[Mapping[str, Any]],
                matched_row: bool) -> Optional[str]:
    """The hook's marker check, for check_policy. Mirrors stepUpFromMarker in
    the Claude Code Guard's pre-tool-use hook; keep the two in step."""
    if not isinstance(marker, Mapping) or _ineligible(tool_name):
        return None
    sp = marker.get("step_up")
    if not isinstance(sp, Mapping):
        return None

    def strs(key):
        v = sp.get(key)
        return [x for x in v if isinstance(x, str) and x] if isinstance(v, list) else None

    forms = _name_forms(tool_name)
    granted = set()
    for g in strs("granted") or []:
        granted |= _name_forms(g)
    if forms & granted:
        return None
    text = _input_text(tool_input)
    if text and _path_hit(text, [p.lower() for p in strs("paths") or []]):
        return KIND_PATH
    if text and _env_hit(text, strs("env_keys") or []):
        return KIND_ENV
    known = strs("known_tools")
    if known is not None and not matched_row:
        known_forms = set()
        for k in known:
            known_forms |= _name_forms(k)
        if not forms & known_forms:
            return KIND_NEW_TOOL
    return None


async def file_request(db, tool_id: str, function_name: Optional[str], runtime_kind: Optional[str],
                       session_id: str) -> Optional[dict]:
    """File one rung approval request, deduped per tool, runtime and session.
    Past 20 in an hour for one session, new asks collapse into the pending
    request (None when there is none)."""
    from securevector.app.database.repositories.jit_access import JitAccessRepository
    from securevector.app.database.repositories.response_rungs import ResponseRungsRepository

    if _ineligible(tool_id) or not session_id:
        return None
    repo = ResponseRungsRepository(db)
    jit = JitAccessRepository(db)
    dup = await db.fetch_one(
        "SELECT * FROM jit_access_requests WHERE status = 'pending' AND rule_source = 'rung' "
        "AND tool_id = ? AND COALESCE(runtime_kind,'') = COALESCE(?,'') AND session_id = ?",
        (tool_id, runtime_kind, session_id),
    )
    if dup:
        return dict(dup)
    if await repo.requests_in_last_hour(session_id) >= REQUESTS_PER_HOUR:
        return await repo.latest_pending(session_id)
    return await jit.create_request(tool_id=tool_id, rule_source=RUNG_SOURCE, function_name=function_name,
                                    runtime_kind=runtime_kind, session_id=session_id,
                                    justification="Session at step-up")


async def holds_tool(db, session_id: Optional[str], tool_id: str) -> bool:
    """True when this session is at active rung 3 and `tool_id` is one a
    rung may hold. The Guard decides per call with the input in hand (the
    server sees only the id), so any eligible id is accepted here: a request
    only asks, and its grant only lifts this session's rung hold on it."""
    if _ineligible(tool_id):
        return False
    view = await _rung_view(db, session_id)
    return view is not None and view["applied"]


async def check_call(db, tool_name: str, tool_input: Any, runtime_kind: Optional[str],
                     session_id: Optional[str], hosts=(), *, file: bool = False) -> Optional[str]:
    """Per-call step-up for a call the Guard allows and that can reach the
    network, the one place hooks send arguments. Returns the class kind
    when active mode holds the call for approval, else None. In shadow mode
    it only counts the call; `file` files the request (the Guard path, not
    check_policy)."""
    from securevector.app.database.repositories.response_rungs import ResponseRungsRepository
    from securevector.app.services.policy_check import tool_candidates

    view = await _rung_view(db, session_id)
    if view is None:
        return None
    b = view["baseline"]
    kind = step_up_kind(tool_name, tool_input, baseline_tools=b.tools if b else None,
                        hosts=list(hosts or ()), baseline_hosts=b.hosts if b else None)
    if kind is None:
        return None
    repo = ResponseRungsRepository(db)
    if not view["applied"]:
        # Name-level kinds are counted once, at the call's audit row.
        if file and kind in (KIND_PATH, KIND_ENV, KIND_HOST):
            await repo.add_would_ask(session_id)
        return None
    cands = tool_candidates(tool_name)
    key = (cands[0] if cands else tool_name).lower()
    if key in await repo.granted_tools(session_id):
        return None
    if file:
        await file_request(db, key, tool_name, runtime_kind, session_id)
    return kind


async def note_call(db, tool_name: Optional[str], session_id: Optional[str], action: Optional[str],
                    args_preview: Optional[str] = None) -> None:
    """Shadow mode: count an allowed call active mode would have held."""
    from securevector.app.database.repositories.response_rungs import ResponseRungsRepository

    if not tool_name or not session_id or action != "allow":
        return
    try:
        view = await _rung_view(db, session_id)
        if view is None or view["applied"]:
            return
        b = view["baseline"]
        if step_up_kind(tool_name, args_preview or None, baseline_tools=b.tools if b else None) is not None:
            await ResponseRungsRepository(db).add_would_ask(session_id)
    except Exception:  # noqa: BLE001 - counting never breaks the audit write
        logger.debug("shadow step-up count failed", exc_info=True)


def active_rung(row: Optional[Mapping[str, Any]]) -> int:
    """The rung that may change anything: only in active mode, else observe."""
    if not row or row.get("mode") != MODE_ACTIVE:
        return OBSERVE
    return int(row.get("rung") or OBSERVE)


def _state_of(row: Optional[Mapping[str, Any]]) -> RungState:
    if not row:
        return RungState()
    return RungState(
        rung=int(row["rung"]), reasons=json.loads(row.get("reasons_json") or "[]"), since=row.get("since") or "",
        last_drift_at=row.get("last_drift_at") or "", streak_watch=int(row.get("streak_watch") or 0),
        streak_high=int(row.get("streak_high") or 0), last_r2_at=row.get("last_r2_at") or "",
        last_r3_at=row.get("last_r3_at") or "", cooldown_until=row.get("cooldown_until") or "",
        cooldown_kinds=json.loads(row.get("cooldown_kinds") or "[]"), pinned=bool(row.get("pinned")),
        peak_rung=int(row.get("peak_rung") or OBSERVE),
    )


def payload(row: Optional[Mapping[str, Any]]) -> dict:
    """The per-task route body: rung word, mode and reasons by signal id."""
    if not row:
        return {"rung": OBSERVE, "word": RUNG_WORDS[OBSERVE], "mode": MODE_SHADOW, "reasons": [], "since": None,
                "pinned": False, "applied": False, "feedback": None}
    mode = row.get("mode") or MODE_SHADOW
    return {
        "rung": int(row["rung"]), "word": RUNG_WORDS.get(int(row["rung"]), "observe"), "mode": mode,
        "reasons": json.loads(row.get("reasons_json") or "[]"), "since": row.get("since"),
        "pinned": bool(row.get("pinned")), "applied": active_rung(row) == STEP_UP,
        "peak_rung": int(row.get("peak_rung") or OBSERVE), "feedback": row.get("feedback"),
        "last_eval_at": row.get("last_eval_at"),
        "would_ask": int(row.get("would_ask") or 0),
    }
