"""Agent Detection & Response summary: one read of stored rows for the page.

Detect, Harden and Pre-flight counts plus the list of sessions to review.
Reads only what other features already stored (drift rows, setup checks,
pre-flight decisions); it scores nothing and writes nothing. Each part fails
on its own, so one missing table leaves the rest of the page intact.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional

from securevector.app.services import session_drift

logger = logging.getLogger(__name__)

WINDOW_DAYS = 7
MAX_ROWS = 100
REVIEW_BANDS = (session_drift.BAND_WATCH, session_drift.BAND_HIGH)


def _parse(value: Any) -> Optional[datetime]:
    if not value:
        return None
    text = str(value).strip().replace(" ", "T")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _folder(workspace: Optional[str]) -> str:
    parts = [p for p in str(workspace or "").replace("\\", "/").split("/") if p]
    return parts[-1] if parts else ""


def _setup_harness(executor_id: Optional[str]) -> Optional[str]:
    try:
        from securevector.app.services.config_trust import harness_for
        return harness_for(executor_id)
    except Exception:  # noqa: BLE001 - no setup harness, no approve action
        return None


def _label(executor_id: Optional[str]) -> str:
    try:
        from securevector.app.services.config_trust_scan import HARNESS_LABELS
        key = _setup_harness(executor_id) or executor_id
        return HARNESS_LABELS.get(key, executor_id or "")
    except Exception:  # noqa: BLE001 - fall back to the id
        return executor_id or ""


def _drift_reason(row: Mapping[str, Any]) -> str:
    top = session_drift.result_from_row(row).top(1)
    if not top:
        return ""
    f = top[0]
    return f"{f['label']}: {f['detail']}" if f.get("detail") else str(f["label"])


def _setup_reason(check: Mapping[str, Any]) -> str:
    diff = check.get("diff") or []
    red = [c for c in diff if isinstance(c, dict) and c.get("severity") == "red"]
    first = (red or diff or [None])[0]
    if isinstance(first, dict) and first.get("text"):
        return str(first["text"])
    return "Agent config changed since it was approved."


def _rung_flag(row: Mapping[str, Any], drift_normal: bool) -> bool:
    """Rung 2 or above lists a session, unless the person answered it: the
    rung row's own feedback, or "Looks normal" on the drift score when drift
    is the rung's only signal. Config and deny rungs stay listed."""
    if int(row.get("rung") or 1) < 2:
        return False
    from securevector.app.services import response_rungs
    if row.get("feedback") in (response_rungs.FEEDBACK_NOT_NEEDED, session_drift.FEEDBACK_NORMAL):
        return False
    try:
        reasons = set(json.loads(row.get("reasons_json") or "[]"))
    except (TypeError, ValueError):
        reasons = set()
    if drift_normal and reasons <= {response_rungs.SIG_DRIFT}:
        return False
    return True


async def _tasks(db, since: datetime) -> list:
    rows = await db.fetch_all(
        "SELECT id, executor_id, workspace, session_id, created_at, ended_at FROM terminal_tasks "
        "WHERE archived_at IS NULL AND session_id IS NOT NULL "
        "ORDER BY COALESCE(ended_at, created_at) DESC, rowid DESC LIMIT 2000"
    )
    out, seen = [], set()
    for r in rows:
        t = dict(r)
        at = _parse(t.get("ended_at")) or _parse(t.get("created_at"))
        if at is None or at < since or t["session_id"] in seen:
            continue
        seen.add(t["session_id"])
        t["_at"] = at
        out.append(t)
    return out


def _red_change(check: Mapping[str, Any]) -> bool:
    return any(isinstance(c, dict) and c.get("severity") == "red" for c in check.get("diff") or [])


async def _latest_checks(repo, task_ids: list, size: int = 400) -> dict:
    """The latest setup check per task, read in batches of `size` ids (the
    repository reads at most 400 ids per call)."""
    out: dict = {}
    for i in range(0, len(task_ids), size):
        out.update(await repo.latest_for_tasks(task_ids[i:i + size]))
    return out


async def _drift_rows(db, session_ids: list) -> dict:
    out: dict = {}
    for i in range(0, len(session_ids), 400):
        batch = session_ids[i:i + 400]
        marks = ",".join("?" for _ in batch)
        for r in await db.fetch_all(
            f"SELECT * FROM session_drift WHERE session_id IN ({marks})", tuple(batch)
        ):
            out[r["session_id"]] = dict(r)
    return out


SIGNAL_NAMES = {
    session_drift.F_TOOLS: "Novelty", session_drift.F_ERRORS: "Errors after a block",
    session_drift.F_ENUM: "Repeat calls", session_drift.F_SECRETS: "Credential reach",
    session_drift.F_HOSTS: "New hosts", session_drift.F_PERSIST: "Persistence",
}
SPOTLIGHT_SCORES = 20


def _median(values: list) -> Optional[float]:
    vals = sorted(values)
    if not vals:
        return None
    mid = len(vals) // 2
    return float(vals[mid]) if len(vals) % 2 else (vals[mid - 1] + vals[mid]) / 2.0


async def _spotlight(db, candidates: list, scored_all: Optional[list] = None) -> Optional[dict]:
    """The one session that most needs a look: highest drift score among the
    sessions to review, newest on a tie. Reads stored rows only; a piece with
    no data is left out rather than guessed."""
    pool = candidates or scored_all or []
    if not pool:
        return None
    score, _at, t, d = sorted(pool, key=lambda c: (c[0], c[1]), reverse=True)[0]
    result = session_drift.result_from_row(d)
    live = [f for f in result.features if not f.get("skipped") and f.get("value", 0) > 0]
    live.sort(key=lambda f: (-f["weight"] * f["value"], session_drift.FEATURE_IDS.index(f["id"])))
    points = dict(session_drift.contribution_points(result))
    features = [{"id": f["id"], "signal": SIGNAL_NAMES.get(f["id"], ""), "label": f["label"],
                 "value": round(f["value"], 3), "weight": f["weight"],
                 "points": points.get(f["id"], 0), "counts": f.get("counts") or {},
                 "detail": session_drift.detail_of(f)} for f in live][:5]
    recent: list = []
    workspace = d.get("workspace") or t.get("workspace")
    if workspace:
        try:
            rows = await db.fetch_all(
                "SELECT session_id, score, computed_at FROM session_drift "
                "WHERE workspace = ? AND score IS NOT NULL ORDER BY computed_at DESC LIMIT ?",
                (workspace, SPOTLIGHT_SCORES))
            recent = [{"score": int(r["score"]), "at": r["computed_at"],
                       "current": r["session_id"] == d.get("session_id")} for r in reversed(rows)]
        except Exception:  # noqa: BLE001 - no sparkline without history
            logger.debug("detection response: could not read folder history", exc_info=True)
    others = [r["score"] for r in recent if not r["current"]]
    had_blocks: Optional[bool] = None
    try:
        row = await db.fetch_one(
            "SELECT COUNT(*) AS n FROM tool_call_audit WHERE session_id = ? AND action = 'block'",
            (d.get("session_id"),))
        had_blocks = bool(row and int(row["n"] or 0) > 0)
    except Exception:  # noqa: BLE001 - unknown, so the page drops the sentence
        logger.debug("detection response: could not count blocked calls", exc_info=True)
    return {
        "task_id": t["id"],
        "to_review": bool(candidates),
        "harness_label": _label(t.get("executor_id")),
        "folder": _folder(t.get("workspace")),
        "score": score,
        "band": d.get("band"),
        "computed_at": d.get("computed_at"),
        "crossed_at": None,
        "started_at": t.get("created_at"),
        "ended_at": t.get("ended_at"),
        "had_blocks": had_blocks,
        "features": features,
        "baseline": {"sessions": int(d.get("baseline_sessions") or 0), "median": _median(others),
                     "confidence": round(_confidence(d), 2)},
        "recent_scores": recent,
    }


async def _detect(db, now: datetime) -> dict:
    since = now - timedelta(days=WINDOW_DAYS)
    out: dict = {"rows": [], "to_review": 0, "marked_normal": 0, "flagged": 0, "scored": 0,
                 "last_scored_at": None, "first_task_at": None, "first_scored_at": None,
                 "baseline": {"ended_sessions": 0, "needed": session_drift.MIN_BASELINE_SESSIONS,
                              "state": "building"}}
    try:
        tasks = await _tasks(db, since)
        drift = await _drift_rows(db, [t["session_id"] for t in tasks])
    except Exception:  # noqa: BLE001 - the page renders without detect
        logger.debug("detection response: could not read sessions", exc_info=True)
        return out
    rungs: dict = {}
    try:
        from securevector.app.database.repositories.response_rungs import ResponseRungsRepository
        rungs = await ResponseRungsRepository(db).for_sessions([t["session_id"] for t in tasks])
    except Exception:  # noqa: BLE001 - rung state is optional
        logger.debug("detection response: could not read rung rows", exc_info=True)
    fired: dict = {}
    try:
        from securevector.app.database.repositories.call_rules import CallRulesRepository
        fired = await CallRulesRepository(db).fired_for([t["session_id"] for t in tasks])
    except Exception:  # noqa: BLE001 - rule state is optional
        logger.debug("detection response: could not read call rule state", exc_info=True)
    checks: dict = {}
    try:
        from securevector.app.database.repositories.config_trust import ConfigTrustRepository
        checks = await _latest_checks(ConfigTrustRepository(db), [t["id"] for t in tasks])
    except Exception:  # noqa: BLE001 - setup state is optional
        logger.debug("detection response: could not read setup checks", exc_info=True)

    rows = []
    candidates = []
    scored_all = []
    for t in tasks:
        d = drift.get(t["session_id"]) or {}
        if d.get("score") is not None:
            out["scored"] += 1
        if d.get("score") is not None and d.get("feedback") != session_drift.FEEDBACK_NORMAL:
            scored_all.append((int(d["score"]), t["_at"], t, d))
        c = checks.get(t["id"]) or {}
        band = d.get("band") if d.get("score") is not None else None
        setup_state = c.get("state")
        flagged_drift = band in REVIEW_BANDS
        # Only a red-class setup change puts a session on the list.
        flagged_setup = setup_state == "changed" and _red_change(c)
        # One rule for every count: watch or high, an automatic action at
        # rung 2 or above, or a red config change.
        r = rungs.get(t["session_id"]) or {}
        flagged_rung = _rung_flag(r, d.get("feedback") == session_drift.FEEDBACK_NORMAL)
        rules = fired.get(t["session_id"]) or []
        if not (flagged_drift or flagged_setup or flagged_rung or rules):
            continue
        # "Looks normal" answers the drift flag only; a red setup change
        # stays listed until the setup is approved.
        if d.get("feedback") == session_drift.FEEDBACK_NORMAL and not flagged_setup and not flagged_rung:
            out["marked_normal"] += 1
            continue
        if flagged_drift and d.get("score") is not None:
            candidates.append((int(d["score"]), t["_at"], t, d))
        reason = _drift_reason(d) if flagged_drift else ""
        if not reason and flagged_setup:
            reason = _setup_reason(c)
        if not reason and flagged_rung:
            reason = "Automatic actions flagged this session."
        # A named rule that fired leads the Why with its plain name.
        if rules:
            from securevector.app.services import call_rules
            lead = call_rules.why(rules) + "."
            reason = f"{lead} {reason}" if reason else lead

        rows.append({
            "task_id": t["id"],
            "harness": t.get("executor_id"),
            "harness_label": _label(t.get("executor_id")),
            "setup_harness": _setup_harness(t.get("executor_id")),
            "folder": _folder(t.get("workspace")),
            "score": int(d["score"]) if d.get("score") is not None else None,
            "band": band,
            "status": d.get("status"),
            "setup_state": setup_state,
            "rung": int(r.get("rung") or 1) if r else None,
            "setup_changes": len(c.get("diff") or []),
            "setup_texts": [str(x["text"]) for x in (c.get("diff") or []) if isinstance(x, dict) and x.get("text")][:30],
            "reason": reason or "Score above the usual range for this agent tool.",
            "ended": bool(t.get("ended_at")),
            "at": t["_at"].isoformat(timespec="seconds"),
        })
    out["spotlight"] = await _spotlight(db, candidates, scored_all)
    out["to_review"] = len(rows)
    # Flagged = still listed plus marked normal; the false-flag rate reads
    # marked_normal out of flagged.
    out["flagged"] = len(rows) + out["marked_normal"]
    out["rows"] = rows[:MAX_ROWS]

    try:
        row = await db.fetch_one("SELECT MAX(computed_at) AS at FROM session_drift")
        out["last_scored_at"] = row["at"] if row else None
        first = await db.fetch_one(
            "SELECT (SELECT MIN(created_at) FROM terminal_tasks) AS task_at, "
            "(SELECT MIN(computed_at) FROM session_drift WHERE score IS NOT NULL) AS scored_at"
        )
        if first:
            out["first_task_at"] = first["task_at"]
            out["first_scored_at"] = first["scored_at"]
        latest = await db.fetch_one(
            "SELECT status, baseline_sessions FROM session_drift ORDER BY computed_at DESC LIMIT 1"
        )
        cutoff = now - timedelta(days=session_drift.BASELINE_DAYS)
        ended = await db.fetch_all(
            "SELECT session_id, ended_at FROM terminal_tasks "
            "WHERE session_id IS NOT NULL AND ended_at IS NOT NULL"
        )
        n = len({r["session_id"] for r in ended if (_parse(r["ended_at"]) or cutoff) > cutoff})
        status = latest["status"] if latest else None
        # Every session is scored from the first one, so "building" means
        # only that no session has a score yet.
        if not (first and first["scored_at"]):
            state = "building"
        elif status == session_drift.STATUS_SCORED:
            state = "scored"
        else:
            state = "partial"
        out["baseline"] = {"ended_sessions": n, "needed": session_drift.MIN_BASELINE_SESSIONS, "state": state}
    except Exception:  # noqa: BLE001 - baseline facts are optional
        logger.debug("detection response: could not read baseline facts", exc_info=True)
    return out


def _confidence(row: Mapping[str, Any]) -> float:
    """How settled a stored row's comparison is, from its baseline counts
    (same rule as session_drift.baseline_confidence)."""
    sessions = int(row.get("baseline_sessions") or 0)
    calls = int(row.get("baseline_calls") or 0)
    if sessions <= 0:
        return 0.0
    return max(0.0, min(1.0, sessions / session_drift.MIN_BASELINE_SESSIONS,
                        calls / session_drift.MIN_BASELINE_CALLS))


async def _preflight(db, now: datetime) -> dict:
    since = (now - timedelta(days=WINDOW_DAYS)).strftime("%Y-%m-%dT%H:%M:%S")
    try:
        row = await db.fetch_one(
            "SELECT COUNT(*) AS n, "
            "SUM(CASE WHEN decision = 'deny' AND attempted_after_deny = 0 THEN 1 ELSE 0 END) AS avoided "
            "FROM policy_decisions WHERE issued_at >= ?",
            (since,),
        )
    except Exception:  # noqa: BLE001 - no table yet reads as zero
        logger.debug("detection response: could not read pre-flight decisions", exc_info=True)
        row = None
    return {"checked": int(row["n"] or 0) if row else 0,
            "avoided_denials": int(row["avoided"] or 0) if row else 0}


def _harden(setup: Optional[Mapping[str, Any]]) -> dict:
    if not setup:
        return {"available": False, "changes": 0, "unapproved": 0, "risky": 0, "harnesses": 0}
    totals = setup.get("totals") or {}
    changes = int(totals.get("changed") or 0)
    unapproved = int(totals.get("unapproved") or 0)
    return {"available": True, "changes": changes + unapproved, "unapproved": unapproved,
            "risky": int(totals.get("risky") or 0), "harnesses": int(totals.get("harnesses") or 0),
            "checked_at": setup.get("checked_at")}


async def _getting_started(db, now: datetime, guard: Optional[bool]) -> dict:
    """The two first steps and the baseline progress, for the page's
    Getting started list. Reads only."""
    out: dict = {"guard_installed": guard, "governed_session": False, "scored": False, "baseline": None}
    try:
        row = await db.fetch_one("SELECT 1 AS x FROM terminal_tasks WHERE session_id IS NOT NULL LIMIT 1")
        out["governed_session"] = bool(row)
        cutoff = now - timedelta(days=session_drift.BASELINE_DAYS)
        rows = await db.fetch_all(
            "SELECT session_id, executor_id, workspace, ended_at FROM terminal_tasks "
            "WHERE session_id IS NOT NULL AND ended_at IS NOT NULL AND workspace IS NOT NULL "
            "AND ended_at > ? ORDER BY ended_at DESC LIMIT 500",
            (cutoff.isoformat(),),
        )
        groups: dict = {}
        for r in rows:
            at = _parse(r["ended_at"])
            if at is None or at <= cutoff or not _folder(r["workspace"]):
                continue
            groups.setdefault((r["workspace"], r["executor_id"]), set()).add(r["session_id"])
        if groups:
            (ws, ex), ids = max(groups.items(), key=lambda kv: (len(kv[1]), str(kv[0])))
            need = session_drift.MIN_BASELINE_SESSIONS
            out["baseline"] = {"sessions": min(len(ids), need), "needed": need,
                               "folder": _folder(ws), "harness_label": _label(ex)}
    except Exception:  # noqa: BLE001 - the list renders without it
        logger.debug("detection response: could not read getting-started facts", exc_info=True)
    try:
        row = await db.fetch_one("SELECT 1 AS x FROM session_drift WHERE score IS NOT NULL LIMIT 1")
        out["scored"] = bool(row)
    except Exception:  # noqa: BLE001 - no drift table yet means nothing scored
        logger.debug("detection response: could not read scores", exc_info=True)
    return out


async def summary(db, *, setup: Optional[Mapping[str, Any]] = None,
                  registered: Optional[bool] = None, now: Optional[datetime] = None,
                  guard: Optional[bool] = None) -> dict:
    """The page body. `setup` is the config-trust status already read by the
    caller; `registered` says whether any harness has the MCP tools."""
    now = now or datetime.now(timezone.utc)
    detect = await _detect(db, now)
    pre = await _preflight(db, now)
    pre["registered"] = registered
    return {
        "window_days": WINDOW_DAYS,
        "detect": {k: v for k, v in detect.items() if k not in ("rows", "spotlight")},
        "spotlight": detect.get("spotlight"),
        "harden": _harden(setup),
        "preflight": pre,
        "sessions": detect["rows"],
        "setup": await _getting_started(db, now, guard),
        "generated_at": now.isoformat(timespec="seconds"),
    }

