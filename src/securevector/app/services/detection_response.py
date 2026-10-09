"""Agent Detection & Response summary: one read of stored rows for the page.

Detect, Harden and Pre-flight counts plus the list of sessions to review.
Reads only what other features already stored (drift rows, setup checks,
pre-flight decisions); it scores nothing and writes nothing. Each part fails
on its own, so one missing table leaves the rest of the page intact.
"""

from __future__ import annotations

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
    return "Agent setup changed since it was approved."


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
    checks: dict = {}
    try:
        from securevector.app.database.repositories.config_trust import ConfigTrustRepository
        checks = await _latest_checks(ConfigTrustRepository(db), [t["id"] for t in tasks])
    except Exception:  # noqa: BLE001 - setup state is optional
        logger.debug("detection response: could not read setup checks", exc_info=True)

    rows = []
    for t in tasks:
        d = drift.get(t["session_id"]) or {}
        if d.get("score") is not None:
            out["scored"] += 1
        c = checks.get(t["id"]) or {}
        band = d.get("band") if d.get("score") is not None else None
        setup_state = c.get("state")
        flagged_drift = band in REVIEW_BANDS
        # Only a red-class setup change puts a session on the list.
        flagged_setup = setup_state == "changed" and _red_change(c)
        if not (flagged_drift or flagged_setup):
            continue
        # "Looks normal" answers the drift flag only; a red setup change
        # stays listed until the setup is approved.
        if d.get("feedback") == session_drift.FEEDBACK_NORMAL and not flagged_setup:
            out["marked_normal"] += 1
            continue
        reason = _drift_reason(d) if flagged_drift else ""
        if not reason and flagged_setup:
            reason = _setup_reason(c)
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
            "setup_changes": len(c.get("diff") or []),
            "reason": reason or "Drift above the usual range for this harness.",
            "ended": bool(t.get("ended_at")),
            "at": t["_at"].isoformat(timespec="seconds"),
        })
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
        state = ("scored" if status == session_drift.STATUS_SCORED
                 else "partial" if status == session_drift.STATUS_PARTIAL else "building")
        out["baseline"] = {"ended_sessions": n, "needed": session_drift.MIN_BASELINE_SESSIONS, "state": state}
    except Exception:  # noqa: BLE001 - baseline facts are optional
        logger.debug("detection response: could not read baseline facts", exc_info=True)
    return out


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


async def summary(db, *, setup: Optional[Mapping[str, Any]] = None,
                  registered: Optional[bool] = None, now: Optional[datetime] = None) -> dict:
    """The page body. `setup` is the config-trust status already read by the
    caller; `registered` says whether any harness has the MCP tools."""
    now = now or datetime.now(timezone.utc)
    detect = await _detect(db, now)
    pre = await _preflight(db, now)
    pre["registered"] = registered
    return {
        "window_days": WINDOW_DAYS,
        "detect": {k: v for k, v in detect.items() if k != "rows"},
        "harden": _harden(setup),
        "preflight": pre,
        "sessions": detect["rows"],
        "generated_at": now.isoformat(timespec="seconds"),
    }

