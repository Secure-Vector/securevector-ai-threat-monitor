"""
Session Drift Score: how far one governed session moved from what this
harness normally does in this folder. Observe only.

The number is 0 to 100 per session, computed from rows the app already owns
(tool_call_audit, egress_audit, terminal_tasks, JIT requests). No model
calls, no network, no transcript parsing, and no new collection. It says
"this session is not behaving like the sessions before it", never "attack".

**Observe only.** Nothing here blocks, stops, prompts or changes a verdict.
The score is written to `session_drift` and shown; the response rungs that
may one day read the band live elsewhere and are not part of this module.

**Baseline.** The last 30 days of ended sessions with the same harness and
the same folder, at least 5 sessions and 200 tool calls. While a folder has
no baseline yet, the harness on its own (every folder) stands in for it. A
session never counts toward its own baseline. Sessions marked "looks normal"
join the baseline. Host features (enumeration, new hosts) also need the
device host set `egress_scope` uses, and are skipped, not zeroed, until it
has one.

**Score.** Each feature yields a value in [0, 1]; the score is the weighted
sum over the features that have a baseline, renormalised to the weights
available, times 100. Bands: calm below 40, watch 40 to 69, high 70 and up.
The band names and cut-offs are a contract for the response rungs and change
only with a migration note.

The pure part (`compute`, `choose_baseline`, `locations_in`, `band_for`)
takes plain rows so tests can drive it; `score_for` loads the rows, scores
and stores one row per session.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Optional

from securevector.app.services import egress_scope, run_health
from securevector.app.services.policy_defaults import (
    ENV_VAR_PERMISSIONS,
    FILE_PATH_PERMISSIONS,
)

logger = logging.getLogger(__name__)

# --- the contract ------------------------------------------------------------

BAND_CALM = "calm"
BAND_WATCH = "watch"
BAND_HIGH = "high"
BANDS = (BAND_CALM, BAND_WATCH, BAND_HIGH)
WATCH_FROM = 40
HIGH_FROM = 70

STATUS_SCORED = "scored"
STATUS_PARTIAL = "partial"
STATUS_BUILDING = "building_baseline"
STATUS_NO_SESSION = "no_session"

FEEDBACK_NORMAL = "normal"

# --- baseline ------------------------------------------------------------------

BASELINE_DAYS = 30
# Mirrors run_health.RUNAWAY_MIN_BASELINE_RUNS: five runs is where a median
# stops being one unusual session.
MIN_BASELINE_SESSIONS = run_health.RUNAWAY_MIN_BASELINE_RUNS
MIN_BASELINE_CALLS = 200
BASELINE_CACHE_SECONDS = 60.0
SCOPE_FOLDER = "folder"
SCOPE_HARNESS = "harness"

# --- features ------------------------------------------------------------------
#
# (id, plain-words label, weight). Ids are a fixed enum: they are the only
# feature text that may ever leave the device (see live_runs.drift_fields).

F_TOOLS = "tool_novelty"
F_ERRORS = "errors_after_block"
F_ENUM = "enumeration"
F_SECRETS = "secrets_reach"
F_HOSTS = "new_hosts"
F_PERSIST = "persistence"

FEATURES = (
    (F_TOOLS, "tools this session has not used here before", 25),
    (F_ERRORS, "errors right after a blocked call", 20),
    (F_ENUM, "many hosts or the same call in a loop", 15),
    (F_SECRETS, "reached credential locations", 15),
    (F_HOSTS, "hosts new for this folder", 15),
    (F_PERSIST, "kept asking after a denial", 10),
)
FEATURE_IDS = tuple(f[0] for f in FEATURES)
LABELS = {f[0]: f[1] for f in FEATURES}
WEIGHTS = {f[0]: f[2] for f in FEATURES}
HOST_FEATURES = (F_ENUM, F_HOSTS)
TOP_N = 3

TOOL_SHARE_FULL = 0.30       # novel share of calls that saturates feature 1
ERROR_WINDOW_SECONDS = 120   # an error this soon after a block counts
ERRORS_FULL = 3
SECRETS_FULL = 2
NEW_HOSTS_FULL = 5
PERSIST_MIN_BLOCKS = 3       # same tool blocked this often is persistence
PERSIST_FULL = 3
# A credential location reached in this many baseline sessions is routine
# for the folder (a deploy folder that always reads ~/.aws/) and scores 0.
ROUTINE_LOCATION_SESSIONS = 2


def band_for(score: Optional[int]) -> Optional[str]:
    if score is None:
        return None
    if score >= HIGH_FROM:
        return BAND_HIGH
    if score >= WATCH_FROM:
        return BAND_WATCH
    return BAND_CALM


@dataclass(frozen=True)
class DriftResult:
    """The whole contract the response rungs consume.

    `features` is a list of {id, label, weight, value, skipped, counts};
    `baseline` carries the counts behind it (sessions, calls, hosts, since,
    scope, needed). `score` and `band` are None until a baseline exists.
    """

    score: Optional[int]
    band: Optional[str]
    status: str
    features: list
    baseline_ok: bool
    computed_at: str
    baseline: dict = field(default_factory=dict)

    def top(self, n: int = TOP_N) -> list:
        """The highest weight x value features, with a counts-only detail."""
        live = [f for f in self.features if not f.get("skipped") and f.get("value", 0) > 0]
        live.sort(key=lambda f: (-f["weight"] * f["value"], FEATURE_IDS.index(f["id"])))
        return [
            {"id": f["id"], "label": f["label"], "value": round(f["value"], 3),
             "weight": f["weight"], "detail": detail_of(f)}
            for f in live[:n]
        ]


def detail_of(feature: Mapping[str, Any]) -> str:
    """Counts only, never names: '4 of 31 calls', '3', '2 locations'."""
    c = feature.get("counts") or {}
    fid = feature.get("id")
    if fid == F_TOOLS:
        return f"{c.get('unseen_calls', 0)} of {c.get('calls', 0)} calls"
    if fid == F_ENUM:
        parts = []
        if c.get("distinct_hosts"):
            parts.append(f"{c['distinct_hosts']} hosts")
        if c.get("loop_calls"):
            parts.append(f"{c['loop_calls']} repeated calls")
        return ", ".join(parts) or "0"
    if fid == F_SECRETS:
        n = c.get("locations", 0)
        return f"{n} location" if n == 1 else f"{n} locations"
    key = {F_ERRORS: "errors", F_HOSTS: "hosts", F_PERSIST: "repeats"}.get(fid)
    return str(c.get(key, 0)) if key else ""


# --- credential locations ---------------------------------------------------------


def _path_fragments(pattern: str) -> tuple:
    """Lower-case fragments that identify a credential path in a preview,
    whether the home folder is written as ~ or expanded, and whether a
    Windows path is raw or JSON-escaped."""
    p = pattern
    if p.startswith("~"):
        p = p[1:]
    elif p.startswith("%") and "%" in p[1:]:
        p = p[p.index("%", 1) + 1:]
    p = p.lower()
    frags = {p}
    if "\\" in p:
        frags.add(p.replace("\\", "\\\\"))
        frags.add(p.replace("\\", "/"))
    return tuple(sorted(frags))


def _location_key(pattern: str) -> str:
    """One key per place, whatever the platform spelling: ~/.ssh/ and
    %USERPROFILE%\\.ssh\\ are the same location."""
    return _path_fragments(pattern)[0].replace("\\\\", "/").replace("\\", "/")


def _build_locations() -> tuple:
    paths: dict = {}
    for pat, cls, _ in FILE_PATH_PERMISSIONS:
        if cls == "dangerous":
            paths.setdefault(_location_key(pat), set()).update(_path_fragments(pat))
    out = [(key, "path", tuple(sorted(frags))) for key, frags in sorted(paths.items())]
    out += [(f"${name}", "env", (name,)) for name, cls, _ in ENV_VAR_PERMISSIONS if cls == "dangerous"]
    return tuple(out)


# (location key, kind, fragments). Built once from the policy defaults; the
# key is counted, never stored.
_LOCATIONS: tuple = _build_locations()
_ENV_RE = {
    key: re.compile(r"(?<![A-Za-z0-9_])" + re.escape(frags[0]) + r"(?![A-Za-z0-9_])")
    for key, kind, frags in _LOCATIONS if kind == "env"
}


def location_matches(preview: Optional[str]) -> set:
    """Credential locations named in one argument preview. Matched in memory
    only; the preview is never copied anywhere."""
    if not preview:
        return set()
    text = str(preview)
    low = text.lower()
    found = set()
    for key, kind, frags in _LOCATIONS:
        if kind == "path":
            if any(f in low for f in frags):
                found.add(key)
        elif frags[0] in text and _ENV_RE[key].search(text):
            found.add(key)
    return found


def location_probe(key: str) -> tuple:
    """(kind, fragments) for one location key, for the baseline lookup."""
    for k, kind, frags in _LOCATIONS:
        if k == key:
            return kind, frags
    return "", ()


def locations_in(calls: Iterable[Mapping[str, Any]]) -> set:
    """Credential locations reached by allowed calls (a blocked call reached
    nothing)."""
    out: set = set()
    for c in calls or []:
        if c.get("action") == "block":
            continue
        out |= location_matches(c.get("args_preview"))
    return out


# --- baseline choice ----------------------------------------------------------------


@dataclass(frozen=True)
class Baseline:
    sessions: int = 0
    calls: int = 0
    tools: frozenset = frozenset()
    hosts: frozenset = frozenset()
    session_ids: tuple = ()
    since: Optional[str] = None
    scope: Optional[str] = None


def _meets(sessions: int, calls: int) -> bool:
    return sessions >= MIN_BASELINE_SESSIONS and calls >= MIN_BASELINE_CALLS


def _view(per_session: Mapping[str, Mapping[str, Any]], ids: list, scope: str) -> Baseline:
    tools: set = set()
    hosts: set = set()
    calls = 0
    since = None
    for sid in ids:
        s = per_session[sid]
        tools |= set(s.get("tools") or ())
        hosts |= set(s.get("hosts") or ())
        calls += int(s.get("calls") or 0)
        ended = s.get("ended_at")
        if ended and (since is None or str(ended) < since):
            since = str(ended)
    return Baseline(len(ids), calls, frozenset(tools), frozenset(hosts), tuple(ids), since, scope)


def choose_baseline(per_session: Mapping[str, Mapping[str, Any]], *, session_id: str,
                    workspace: Optional[str]) -> tuple:
    """(baseline or None, progress). Folder first; the harness across every
    folder while the folder has no baseline. Only sessions with tool calls
    count, and the scored session never counts toward its own baseline."""
    usable = [sid for sid, s in per_session.items() if sid != session_id and int(s.get("calls") or 0) > 0]
    folder = [sid for sid in usable if workspace and per_session[sid].get("workspace") == workspace]
    for ids, scope in ((folder, SCOPE_FOLDER), (usable, SCOPE_HARNESS)):
        view = _view(per_session, sorted(ids), scope)
        if _meets(view.sessions, view.calls):
            return view, {"sessions": view.sessions, "calls": view.calls}
    harness = _view(per_session, sorted(usable), SCOPE_HARNESS)
    return None, {"sessions": harness.sessions, "calls": harness.calls}


# --- features -------------------------------------------------------------------------


def _feature(fid: str, value: float, counts: dict, skipped: bool = False) -> dict:
    return {
        "id": fid,
        "label": LABELS[fid],
        "weight": WEIGHTS[fid],
        "value": 0.0 if skipped else max(0.0, min(1.0, float(value))),
        "skipped": skipped,
        "counts": counts,
    }


def _governed(calls: Iterable[Mapping[str, Any]]) -> list:
    return [
        dict(c) for c in calls or []
        if (c.get("function_name") or c.get("tool_id"))
        and not run_health._is_boundary(c.get("function_name"))
        and not run_health._is_boundary(c.get("tool_id"))
    ]


def _ts(value: Any) -> Optional[datetime]:
    from securevector.app.terminals.store import parse_ts

    return parse_ts(value)


def feature_tool_novelty(rows: list, baseline: Baseline) -> dict:
    names = [str(r.get("function_name") or r.get("tool_id")) for r in rows]
    unseen = [n for n in names if n not in baseline.tools]
    share = (len(unseen) / len(names)) if names else 0.0
    return _feature(F_TOOLS, share / TOOL_SHARE_FULL, {
        "unseen_calls": len(unseen), "calls": len(names), "unseen_tools": len(set(unseen)),
    })


def feature_errors_after_block(rows: list) -> dict:
    # span_id carries the row position (1-based: calls_from_spans drops a
    # falsy ref) so each call maps back to its timestamp.
    spans = [dict(r, span_id=i + 1) for i, r in enumerate(rows)]
    calls = run_health.calls_from_spans(spans)
    last_block: Optional[datetime] = None
    n = 0
    for c in calls:
        t = _ts(rows[c["ref"] - 1].get("called_at"))
        if c.get("action") == "block":
            last_block = t or last_block
            continue
        if c.get("error") and t and last_block:
            gap = (t - last_block).total_seconds()
            if 0 <= gap <= ERROR_WINDOW_SECONDS:
                n += 1
    return _feature(F_ERRORS, n / ERRORS_FULL, {"errors": n})


def feature_enumeration(rows: list, egress: Mapping[str, Any], known_host_count: int) -> dict:
    distinct = int(egress.get("distinct_hosts") or 0)
    if known_host_count < egress_scope.MIN_BASELINE_HOSTS:
        return _feature(F_ENUM, 0, {"distinct_hosts": distinct}, skipped=True)
    verdict = egress_scope.assess(dict(egress), known_host_count)
    value = {egress_scope.STATUS_EXPANDING: 1.0, egress_scope.STATUS_ELEVATED: 0.5}.get(verdict["status"], 0.0)
    calls = run_health.calls_from_spans([dict(r, span_id=i + 1) for i, r in enumerate(rows)])
    loops = run_health.detect_same_call(calls) + run_health.detect_cycle(calls)
    loop_calls = 0
    for f in loops:
        value = max(value, 1.0 if f["severity"] == "high" else 0.5)
        counts = f["evidence"]["counts"]
        loop_calls = max(loop_calls, int(counts.get("calls") or counts.get("repeats", 0) * counts.get("length", 1)))
    return _feature(F_ENUM, value, {"distinct_hosts": distinct, "loop_calls": loop_calls})


def feature_secrets_reach(locations: set, routine: Mapping[str, int]) -> dict:
    fresh = [loc for loc in locations if int(routine.get(loc, 0)) < ROUTINE_LOCATION_SESSIONS]
    return _feature(F_SECRETS, len(fresh) / SECRETS_FULL, {"locations": len(fresh)})


def feature_new_hosts(egress: Mapping[str, Any], baseline: Baseline, known_host_count: int) -> dict:
    hosts = {str(h).lower() for h in (egress.get("hosts") or ()) if h}
    if known_host_count < egress_scope.MIN_BASELINE_HOSTS:
        return _feature(F_HOSTS, 0, {"hosts": 0}, skipped=True)
    folder_new = len(hosts - {h.lower() for h in baseline.hosts})
    # The device's own first-seen count is the floor: a host this device had
    # never contacted is new for every folder.
    n = max(folder_new, int(egress.get("novel_hosts") or 0))
    return _feature(F_HOSTS, n / NEW_HOSTS_FULL, {"hosts": n})


def feature_persistence(rows: list, jit: Iterable[Mapping[str, Any]]) -> dict:
    blocks: dict = {}
    for r in rows:
        if r.get("action") == "block":
            name = str(r.get("function_name") or r.get("tool_id"))
            blocks[name] = blocks.get(name, 0) + 1
    repeats = sum(n - 1 for n in blocks.values() if n >= PERSIST_MIN_BLOCKS)
    # A JIT request filed again for a tool after a denial of the same tool.
    denied_at: dict = {}
    for req in sorted(jit or [], key=lambda q: str(q.get("requested_at") or "")):
        tool = str(req.get("tool_id") or req.get("function_name") or "")
        if not tool:
            continue
        if tool in denied_at:
            repeats += 1
        if req.get("status") == "denied":
            denied_at.setdefault(tool, req.get("requested_at"))
    return _feature(F_PERSIST, repeats / PERSIST_FULL, {"repeats": repeats})


def _now_iso(now: Optional[datetime] = None) -> str:
    return (now or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat(timespec="seconds")


def compute(calls: list, egress: Mapping[str, Any], known_host_count: int, jit: list,
            baseline: Optional[Baseline], routine_locations: Mapping[str, int], *,
            progress: Optional[Mapping[str, int]] = None,
            now: Optional[datetime] = None) -> DriftResult:
    """Score one session from its rows. Pure: no I/O, no clock unless `now`
    is omitted. Returns `building_baseline` with no number below the
    minimums, `partial` when a feature had to be skipped."""
    computed_at = _now_iso(now)
    prog = dict(progress or {})
    base_info = {
        "sessions": baseline.sessions if baseline else int(prog.get("sessions", 0)),
        "calls": baseline.calls if baseline else int(prog.get("calls", 0)),
        "hosts": int(known_host_count),
        "since": baseline.since if baseline else None,
        "scope": baseline.scope if baseline else None,
        "needed_sessions": MIN_BASELINE_SESSIONS,
        "needed_calls": MIN_BASELINE_CALLS,
    }
    if baseline is None:
        return DriftResult(None, None, STATUS_BUILDING, [], False, computed_at, base_info)
    rows = _governed(calls)
    feats = [
        feature_tool_novelty(rows, baseline),
        feature_errors_after_block(rows),
        feature_enumeration(rows, egress, known_host_count),
        feature_secrets_reach(locations_in(rows), routine_locations),
        feature_new_hosts(egress, baseline, known_host_count),
        feature_persistence(rows, jit),
    ]
    live = [f for f in feats if not f["skipped"]]
    total = sum(f["weight"] for f in live)
    score = int(round(100 * sum(f["weight"] * f["value"] for f in live) / total)) if total else 0
    status = STATUS_PARTIAL if len(live) < len(feats) else STATUS_SCORED
    return DriftResult(score, band_for(score), status, feats, True, computed_at, base_info)


# --- loading, caching and storing ---------------------------------------------------------

_baseline_cache: dict = {}


def clear_cache() -> None:
    _baseline_cache.clear()


async def _harness_sessions(repo, harness: str) -> dict:
    """Per-session aggregates for one harness, cached 60 s. The scored
    session is excluded later, so one cached read serves every session."""
    # Keyed by database file and harness, so two databases in one process
    # (tests, a re-pointed data dir) never share a baseline.
    key = (str(getattr(repo.db, "db_path", id(repo.db))), harness)
    hit = _baseline_cache.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < BASELINE_CACHE_SECONDS:
        return hit[1]
    since = datetime.now(timezone.utc) - timedelta(days=BASELINE_DAYS)
    data = await repo.baseline_sessions(harness, since)
    _baseline_cache[key] = (now, data)
    return data


async def score_for(session_id: str, *, db=None, task: Optional[Mapping[str, Any]] = None,
                    store: bool = True) -> DriftResult:
    """Load one session's rows, score it and (by default) store the row.

    Observe only: the result is returned and written to `session_drift`,
    nothing else. Never raises for a missing session; returns no_session.
    """
    from securevector.app.database.repositories.session_drift import SessionDriftRepository

    if db is None:
        from securevector.app.database.connection import get_database

        db = get_database()
    repo = SessionDriftRepository(db)
    if not session_id:
        return DriftResult(None, None, STATUS_NO_SESSION, [], False, _now_iso())
    task = dict(task) if task else (await repo.task_for_session(session_id) or {})
    calls = await repo.session_calls(session_id)
    harness = await repo.session_harness(session_id) or task.get("executor_id") or ""
    workspace = task.get("workspace")
    per_session = await _harness_sessions(repo, harness)
    baseline, progress = choose_baseline(per_session, session_id=session_id, workspace=workspace)
    egress: dict = {}
    known = 0
    jit: list = []
    routine: dict = {}
    if baseline is not None:
        egress = await repo.session_egress(session_id)
        known = await repo.known_host_count()
        jit = await repo.session_jit(session_id)
        locs = locations_in(_governed(calls))
        if locs:
            routine = await repo.location_sessions(locs, list(baseline.session_ids))
    result = compute(calls, egress, known, jit, baseline, routine, progress=progress)
    if store:
        await repo.upsert(session_id, task.get("id"), harness, workspace, result)
    return result


def payload(result: DriftResult, feedback: Optional[str] = None) -> dict:
    """The per-task route body: counts only, no names and no paths."""
    b = result.baseline or {}
    return {
        "score": result.score,
        "band": result.band,
        "status": result.status,
        "top": result.top(),
        "baseline": {
            "sessions": b.get("sessions", 0),
            "calls": b.get("calls", 0),
            "hosts": b.get("hosts", 0),
            "since": b.get("since"),
            "scope": b.get("scope"),
            "needed_sessions": b.get("needed_sessions", MIN_BASELINE_SESSIONS),
        },
        "computed_at": result.computed_at,
        "feedback": feedback,
    }


def features_json(result: DriftResult) -> str:
    """What `session_drift.features_json` holds: ids, values, weights and
    counts. Labels are derived from the id; nothing else is stored."""
    return json.dumps([
        {"id": f["id"], "value": round(f["value"], 4), "weight": f["weight"],
         "skipped": bool(f["skipped"]), "counts": f["counts"]}
        for f in result.features
    ], separators=(",", ":"))


def result_from_row(row: Mapping[str, Any]) -> DriftResult:
    """Rebuild a DriftResult from a stored row (labels from the fixed enum)."""
    try:
        feats = json.loads(row.get("features_json") or "[]")
    except (TypeError, ValueError):
        feats = []
    out = []
    for f in feats if isinstance(feats, list) else []:
        fid = f.get("id") if isinstance(f, dict) else None
        if fid in LABELS:
            out.append({"id": fid, "label": LABELS[fid], "weight": WEIGHTS[fid],
                        "value": float(f.get("value") or 0), "skipped": bool(f.get("skipped")),
                        "counts": f.get("counts") or {}})
    score = row.get("score")
    return DriftResult(
        int(score) if score is not None else None, row.get("band"), row.get("status") or STATUS_BUILDING,
        out, score is not None, row.get("computed_at") or "",
        {"sessions": int(row.get("baseline_sessions") or 0), "calls": int(row.get("baseline_calls") or 0)},
    )


# --- cadence: summary open (the route), the warm loop, and exit ------------------------------

WARM_MAX_SESSIONS = 20
_pending: set = set()


async def warm_once(db=None) -> list:
    """Rescore running sessions. Rides the run-health warm loop (every 60 s).
    One bad session never stops the pass. Returns the session ids scored."""
    from securevector.app.database.repositories.session_drift import SessionDriftRepository

    if db is None:
        from securevector.app.database.connection import get_database

        db = get_database()
    done = []
    for task in await SessionDriftRepository(db).running_tasks(WARM_MAX_SESSIONS):
        try:
            await score_for(task["session_id"], db=db, task=task)
            done.append(task["session_id"])
        except Exception:  # noqa: BLE001 - observe only; never break the loop
            logger.debug("drift warm-up failed for %s", task.get("session_id"), exc_info=True)
    return done


def schedule_for_task(db, task_id: str) -> None:
    """Score a task's session once at its exit event, in the background.
    Never raises and never delays the exit path."""

    async def _run() -> None:
        try:
            from securevector.app.database.repositories.session_drift import SessionDriftRepository

            task = await SessionDriftRepository(db).task(task_id)
            if task and task.get("session_id"):
                await score_for(task["session_id"], db=db, task=task)
        except Exception:  # noqa: BLE001
            logger.debug("drift at exit failed for %s", task_id, exc_info=True)

    try:
        t = asyncio.get_running_loop().create_task(_run())
    except RuntimeError:
        return
    _pending.add(t)
    t.add_done_callback(_pending.discard)
