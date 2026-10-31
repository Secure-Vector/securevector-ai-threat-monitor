"""
"High: stop the session and alert", a per agent tool switch, off by default.

When the switch is on for an agent tool, a session of that tool is acted on
once, by whichever comes first:

- its score reaches the high band (70 and up, the band the page shows), or
- a named call-time rule fires (services/call_rules).

What happens follows the agent tool's automatic actions mode, the one the
session started under:

- On: a session started from SecureVector is stopped (origin `auto`, the
  task event names the rule or "high score"), its waiting approvals close
  as no longer needed, and a hold row (rule `stop`, mode active) is kept.
- Test mode: nothing is stopped; a hold row (rule `stop`, mode shadow)
  records that it would have been.
- A session started outside SecureVector cannot be stopped from here: it
  is alerted only.

Every case sends one alert: to each SIEM destination as outbox kind
`alert` (a strict allow-list: session id, agent tool, folder name, rule,
outcome, test mode flag, score, held count) and as a desktop notification
when notifications are on. Never a path, a host, arguments or content.

Turning the switch on needs no approval; turning it off does (the route
gates it). A governed agent can never change it.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
import threading
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from securevector.app.services import response_rungs as rr
from securevector.app.services import session_drift as drift

logger = logging.getLogger(__name__)

TOOL_ID = "sv.stop_switch"
RULE_STOP = "stop"
TRIGGER_HIGH = "high_score"
# Stored only: a high score while the comparison is still settling. It never
# stops a session; it records a would-have, and a later real trigger may
# still stop the session once.
TRIGGER_SETTLING = "high_score_settling"

OUTCOME_STOPPED = "stopped"
OUTCOME_WOULD = "would_stop"
OUTCOME_OUTSIDE = "outside"

OUTSIDE_TEXT = "could not stop: started outside SecureVector"
TRIGGER_WORDS = {
    TRIGGER_HIGH: "high score",
    "cred_then_net": "Credential, then network",
    "outside_then_reach": "Outside content, then credential or network",
}

_SAFE_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_SAFE_TOOL = re.compile(r"^[a-z0-9][a-z0-9._-]{0,39}$")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _manager_default():
    try:
        from securevector.app.server.app import get_current_app

        app = get_current_app()
        return getattr(getattr(app, "state", None), "terminal_manager", None)
    except Exception:  # noqa: BLE001 - no app, no manager
        return None


# The terminal manager resolver; tests swap it.
manager_resolver: Callable[[], Any] = _manager_default


def folder_name(workspace: Optional[str]) -> Optional[str]:
    """The workspace folder's own name, never the path. None when the name
    would carry a separator, a drive mark or a control character."""
    parts = [p for p in str(workspace or "").replace("\\", "/").split("/") if p]
    name = parts[-1] if parts else ""
    if (not name or len(name) > 64 or ":" in name or name in (".", "..") or name.startswith("~")
            or any(ord(c) < 32 or ord(c) == 127 for c in name)):
        return None
    return name


# --- the switch ---------------------------------------------------------------------


async def is_on(db, harness: Optional[str]) -> bool:
    from securevector.app.database.repositories.session_stops import SessionStopsRepository

    return await SessionStopsRepository(db).switch_on(harness or "")


async def set_switch(db, harness: str, on: bool, now: Optional[datetime] = None) -> dict:
    """Set the switch for one agent tool. The route decides who may: on is
    open to the person, off needs an approval."""
    from securevector.app.database.repositories.response_rungs import ResponseRungsRepository
    from securevector.app.database.repositories.session_stops import SessionStopsRepository

    now = now or _now()
    await ResponseRungsRepository(db).mode_row(harness, rr._iso(now), rr.config_signature())
    repo = SessionStopsRepository(db)
    old = await repo.switch_on(harness)
    await repo.set_switch(harness, on)
    if old != bool(on):
        await rr._audit(db, "stop_switch.on" if on else "stop_switch.off", harness, None,
                        f"stop_high={'on' if on else 'off'}")
        await rr._harness_event(db, harness, f"stop the session and alert: {'on' if on else 'off'}")
    return {"harness": harness, "stop_high": bool(on)}


# --- triggers -------------------------------------------------------------------------


async def on_evaluated(db, session_id: str, result: Any = None, harness: Optional[str] = None) -> None:
    """After a rung evaluation: act when the session's score is in the high
    band. Never raises."""
    try:
        if not session_id or not await is_on(db, harness):
            return
        band = getattr(result, "band", None) if result is not None else None
        score = getattr(result, "score", None) if result is not None else None
        status = getattr(result, "status", None) if result is not None else None
        if result is None:
            row = await db.fetch_one("SELECT score, band, status FROM session_drift WHERE session_id = ?",
                                     (session_id,))
            band, score, status = (row["band"], row["score"], row["status"]) if row else (None, None, None)
        if band != drift.BAND_HIGH:
            return
        await act(db, session_id, TRIGGER_HIGH, harness_hint=harness, score=score,
                  settling=status == drift.STATUS_PARTIAL)
    except Exception:  # noqa: BLE001 - the stop switch never breaks an evaluation
        logger.debug("stop switch high-score check failed", exc_info=True)


async def on_rule(db, session_id: str, harness: Optional[str], rule: str,
                  now: Optional[datetime] = None) -> None:
    """A named rule was recorded as held (On) or would-have (test mode).
    Never raises."""
    try:
        if not session_id or not rule:
            return
        await act(db, session_id, rule, harness_hint=harness, now=now)
    except Exception:  # noqa: BLE001 - the stop switch never changes the rule decision
        logger.debug("stop switch rule check failed", exc_info=True)


# --- acting ---------------------------------------------------------------------------


async def _held_count(db, session_id: str, mode: str) -> int:
    try:
        row = await db.fetch_one(
            "SELECT COUNT(*) AS n FROM response_holds WHERE session_id = ? AND mode = ? AND rule != ?",
            (session_id, mode, RULE_STOP),
        )
        return int(row["n"] or 0) if row else 0
    except Exception:  # noqa: BLE001
        return 0


async def _score(db, session_id: str) -> Optional[int]:
    try:
        row = await db.fetch_one("SELECT score FROM session_drift WHERE session_id = ?", (session_id,))
        return int(row["score"]) if row and row["score"] is not None else None
    except Exception:  # noqa: BLE001
        return None


async def act(db, session_id: str, trigger: str, *, harness_hint: Optional[str] = None,
              score: Optional[int] = None, now: Optional[datetime] = None,
              settling: bool = False) -> Optional[dict]:
    """Act on one session once. Returns the alert payload, or None when the
    switch is off, the session ended, or the switch already acted. A high
    score that is still settling never stops: it is recorded as a would-have
    and alerted as test mode."""
    from securevector.app.database.repositories.session_drift import SessionDriftRepository
    from securevector.app.database.repositories.session_stops import SessionStopsRepository
    from securevector.app.services import call_rules

    now = now or _now()
    drepo = SessionDriftRepository(db)
    task = await drepo.task_for_session(session_id) or {}
    harness = task.get("executor_id") or harness_hint or await drepo.session_harness(session_id) or ""
    if not harness:
        return None
    srepo = SessionStopsRepository(db)
    if not await srepo.switch_on(harness):
        return None
    if task.get("ended_at"):
        return None
    mode = await call_rules.session_mode(db, session_id, harness) or rr.MODE_SHADOW
    settling = bool(settling) and trigger == TRIGGER_HIGH
    test_mode = mode != rr.MODE_ACTIVE or settling
    task_id = task.get("id")
    stored = TRIGGER_SETTLING if settling else trigger
    upgrade = None if test_mode else TRIGGER_SETTLING
    if not await srepo.claim(session_id, task_id, harness, stored, test_mode, rr._iso(now), upgrade_from=upgrade):
        return None
    try:
        return await _act_claimed(db, srepo, session_id, task, harness, trigger, test_mode, settling,
                                  score, now)
    except Exception:
        # Never leave a claim stranded: a stop that already ran is recorded,
        # anything earlier is released for a later trigger.
        done = _OUTCOMES.pop(session_id, None)
        if done:
            await srepo.finish(session_id, done, 0)
        else:
            await srepo.release(session_id)
        raise
    finally:
        _OUTCOMES.pop(session_id, None)


# The outcome reached so far per session while act() runs, so a failure
# after the stop still records it.
_OUTCOMES: dict = {}


async def _act_claimed(db, srepo, session_id: str, task: dict, harness: str, trigger: str, test_mode: bool,
                       settling: bool, score: Optional[int], now: datetime) -> Optional[dict]:
    from securevector.app.database.repositories.response_rungs import ResponseRungsRepository

    task_id = task.get("id")
    words = TRIGGER_WORDS.get(trigger, "rule")
    test_words = "score still settling" if settling else "test mode"
    outside = not task or task.get("origin") == "linked"
    if outside:
        outcome = OUTCOME_OUTSIDE
    elif test_mode:
        outcome = OUTCOME_WOULD
    else:
        outcome = await _stop(task_id, words)
        if outcome is None:
            # Nothing is running here to stop: leave the session for a later trigger.
            await srepo.release(session_id)
            return None
    _OUTCOMES[session_id] = outcome

    rrepo = ResponseRungsRepository(db)
    if outcome == OUTCOME_STOPPED:
        await rrepo.record_hold(session_id, harness, rr.MODE_ACTIVE, RULE_STOP, rr._iso(now))
        await rr.close_pending_for_task(db, task, reason="stopped")
    elif outcome == OUTCOME_WOULD:
        await rrepo.record_hold(session_id, harness, rr.MODE_SHADOW, RULE_STOP, rr._iso(now))
        await rr._task_event(db, task_id, "rung", f"would have stopped ({test_words}): {words}", origin="auto")
    else:
        await rr._task_event(db, task_id, "rung", f"{OUTSIDE_TEXT}: {words}", origin="auto")
    await _audit(db, harness, session_id, trigger, outcome, test_mode, settling)

    if score is None:
        score = await _score(db, session_id)
    payload = alert_payload(
        session_id=session_id, harness=harness, workspace=task.get("workspace"), trigger=trigger,
        outcome=outcome, test_mode=test_mode, score=score,
        held=await _held_count(db, session_id, rr.MODE_SHADOW if test_mode else rr.MODE_ACTIVE), now=now,
    )
    sent = await _send(db, payload)
    if await _notifications_on(db):
        _desktop(payload)
    await srepo.finish(session_id, outcome, sent)
    return payload


async def _stop(task_id: Optional[str], words: str) -> Optional[str]:
    """Stop an app-owned task. Returns the outcome, or None when nothing is
    running to stop."""
    from securevector.app.terminals.manager import NotLinkable

    manager = manager_resolver()
    if manager is None or not task_id:
        return None
    try:
        await manager.stop(task_id, origin="auto", detail=f"stopped automatically: {words}")
    except NotLinkable:
        return OUTCOME_OUTSIDE
    except KeyError:
        return None
    except Exception:  # noqa: BLE001 - a failed stop leaves the session for a later trigger
        logger.warning("stop switch could not stop a task", exc_info=True)
        return None
    return OUTCOME_STOPPED


async def _audit(db, harness: str, session_id: str, trigger: str, outcome: str, test_mode: bool,
                 settling: bool = False) -> None:
    from securevector.app.database.repositories.custom_tools import CustomToolsRepository

    words = TRIGGER_WORDS.get(trigger, "rule")
    would = "would have stopped (score still settling)" if settling else "would have stopped (test mode)"
    text = {OUTCOME_STOPPED: "stopped", OUTCOME_WOULD: would,
            OUTCOME_OUTSIDE: OUTSIDE_TEXT}[outcome]
    try:
        await CustomToolsRepository(db).log_tool_call_audit(
            TOOL_ID, "stop", "block" if outcome == OUTCOME_STOPPED else "log_only",
            reason=f"Stop the session and alert: {text}. {words}.",
            args_preview=f"trigger={trigger} outcome={outcome} test_mode={int(test_mode)}",
            runtime_kind=harness or None, session_id=session_id,
        )
    except Exception:  # noqa: BLE001 - the audit write never undoes the stop
        logger.debug("stop switch audit write failed", exc_info=True)


# --- the alert ------------------------------------------------------------------------


def alert_payload(*, session_id: str, harness: str, workspace: Optional[str], trigger: str, outcome: str,
                  test_mode: bool, score: Optional[int], held: Optional[int], now: datetime) -> dict:
    """The alert, metadata only. Values that do not fit the contract are
    left out rather than sent."""
    out: dict = {
        "emitted_at": _iso(now),
        "rule": trigger,
        "outcome": outcome,
        "test_mode": bool(test_mode),
    }
    if session_id and _SAFE_ID.match(session_id):
        out["session_id"] = session_id
    if harness and _SAFE_TOOL.match(harness):
        out["agent_tool"] = harness
    folder = folder_name(workspace)
    if folder:
        out["folder_name"] = folder
    if isinstance(score, int) and not isinstance(score, bool) and 0 <= score <= 100:
        out["score"] = score
    if isinstance(held, int) and held >= 0:
        out["held_count"] = min(held, 100000)
    return out


async def _send(db, payload: dict) -> int:
    """Queue the alert for every SIEM destination. Returns the count."""
    try:
        from securevector.app.database.repositories.external_forwarders import (
            ExternalForwardersRepository,
            ExternalForwardOutboxRepository,
            build_alert_payload,
        )

        fwds = await ExternalForwardersRepository(db).list_active()
        if not fwds:
            return 0
        return await ExternalForwardOutboxRepository(db).enqueue_fanout(
            "alert", build_alert_payload(payload), forwarders=fwds)
    except Exception:  # noqa: BLE001 - the page still shows the mark
        logger.debug("stop switch alert enqueue failed", exc_info=True)
        return 0


async def _notifications_on(db) -> bool:
    try:
        row = await db.fetch_one("SELECT notifications_enabled FROM app_settings WHERE id = 1")
        return bool(row["notifications_enabled"]) if row else True
    except Exception:  # noqa: BLE001 - no settings row reads as the default, on
        return True


def alert_text(payload: dict) -> str:
    """The desktop notification line: agent tool, folder and what happened."""
    from securevector.app.services.config_trust_scan import HARNESS_LABELS

    who = HARNESS_LABELS.get(payload.get("agent_tool") or "", "Agent")
    where = f" in {payload['folder_name']}" if payload.get("folder_name") else ""
    words = TRIGGER_WORDS.get(payload.get("rule") or "", "rule")
    head = {OUTCOME_STOPPED: "session stopped", OUTCOME_WOULD: "session would have been stopped (test mode)",
            OUTCOME_OUTSIDE: f"session {OUTSIDE_TEXT}"}.get(payload.get("outcome"), "session alert")
    return f"{who}{where}: {head}, {words}."


def _desktop(payload: dict) -> None:
    """A desktop notification, best effort, off under tests."""
    if os.environ.get("PYTEST_CURRENT_TEST") or "pytest" in sys.modules:
        return
    try:
        text = alert_text(payload)
    except Exception:  # noqa: BLE001
        return
    threading.Thread(target=_notify, args=(text,), daemon=True).start()


def notify_argv(text: str) -> Optional[list]:
    """The notification command, with the text passed as data: an argument
    to an AppleScript run handler on macOS, never script source; after
    `--` and with markup escaped for notify-send on Linux."""
    if sys.platform == "darwin":
        return ["osascript", "-e", "on run argv", "-e",
                'display notification (item 1 of argv) with title "SecureVector"', "-e", "end run", "--", text]
    if sys.platform.startswith("linux"):
        safe = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        return ["notify-send", "--", "SecureVector", safe]
    return None


def _notify(text: str) -> None:
    try:
        argv = notify_argv(text)
        if argv and shutil.which(argv[0]):
            subprocess.run(argv, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    except Exception:  # noqa: BLE001 - the page still shows the mark
        logger.debug("stop switch notification failed")
