"""Observed web egress for Codex, read back from the local transcript.

Codex's built-in web tool never reaches a hook: the search and the page fetch
happen inside the harness, so the Guard is not consulted and Egress shows
nothing for a task that spent its whole run reading the internet. The rollout
transcript on disk does record them, after the fact.

This module reads that record and turns it into `observed` egress rows. An
observed row is not a verdict and must never be presented as one: nothing was
evaluated, nothing could have been blocked, and the row exists only so the
operator can see where the task went.

Scope, deliberately narrow:

* Only the web tool's action is read (`search` query, `openPage` url). No
  prompt text, no model output, no file paths, nothing else from the
  transcript is parsed or retained.
* It runs only while the Cost Optimizer's local-transcript consent is on.
  That consent is the one the user already granted for reading these same
  files; without it this module reads nothing at all.
* Offsets live in memory only. A session first seen after a restart starts at
  the end of its file, so restarting the app never backfills history the
  operator has already moved past.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Mapping, Optional
from urllib.parse import urlparse

from securevector.app.database.repositories.egress import OBSERVED_PSEUDO_HOST

logger = logging.getLogger(__name__)

# One pass reads at most this much of a transcript. A rollout file grows without
# bound; an unbounded read would put the whole of one on the event loop.
MAX_READ_BYTES = 8 * 1024 * 1024
# `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` is three levels; the fourth is
# slack for a layout change, and the bound is what stops a walk of $HOME.
MAX_WALK_DEPTH = 4
MAX_EVIDENCE_CHARS = 500
# A task whose transcript has not been written yet is the normal case for the
# first few ticks after a launch. Re-walking the sessions tree every ten
# seconds for it would put a directory scan of the whole tree on a timer, so a
# miss is remembered for a while before it is looked for again.
MISS_TTL_SECONDS = 30.0

# Searches have no host. They still reached the internet, so they are recorded
# against a fixed pseudo-host rather than dropped or guessed at. The repository
# owns the name because it is the side that must keep it out of host counts.
SEARCH_HOST = OBSERVED_PSEUDO_HOST
DETECTOR = "codex-transcript"
TOOL_NAME = "web_search"
RUNTIME_KIND = "codex"
OBSERVED_ACTION = "observed"
OBSERVED_REASON = (
    "Observed in the Codex transcript after the fact; no hook fired, "
    "so the call was not governed"
)

OBSERVE_INTERVAL_SECONDS = 10.0

_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

# session id -> transcript path, and session id -> byte offset already read.
# Both are process-local by design: see the module docstring.
_transcripts: dict = {}
_offsets: dict = {}
# session id -> monotonic time of the last lookup that found nothing.
_misses: dict = {}


def reset_state() -> None:
    """Drop the cached paths and offsets. Used by tests and by nothing else."""
    _transcripts.clear()
    _offsets.clear()
    _misses.clear()


def sessions_root() -> Path:
    return Path.home() / ".codex" / "sessions"


def consent_granted() -> bool:
    """The Cost Optimizer's local-transcript consent, which gates this module.

    Imported lazily so the egress route and the terminals manager do not pull
    the optimizer in at import time.
    """
    try:
        from securevector.app.services.cost_optimizer import (
            get_cost_optimizer_service,
        )

        return bool(get_cost_optimizer_service().consented())
    except Exception as e:  # noqa: BLE001 - absent consent is the safe answer
        logger.debug("Could not read transcript consent: %s", e)
        return False


def find_transcript(session_id: str) -> Optional[Path]:
    """The rollout file for one session id, or None.

    Codex names the file `rollout-<timestamp>-<session id>.jsonl`, so the id is
    matched against the suffix rather than by reading any file.
    """
    if not _SESSION_ID_RE.match(session_id or ""):
        return None
    cached = _transcripts.get(session_id)
    if cached is not None:
        if cached.exists():
            return cached
        _transcripts.pop(session_id, None)
    missed_at = _misses.get(session_id)
    if missed_at is not None and (time.monotonic() - missed_at) < MISS_TTL_SECONDS:
        return None
    root = sessions_root()
    if not root.is_dir():
        _misses[session_id] = time.monotonic()
        return None
    suffix = f"-{session_id}.jsonl"
    root_str = str(root)
    try:
        for dirpath, dirnames, filenames in os.walk(root_str):
            depth = dirpath[len(root_str):].count(os.sep)
            if depth >= MAX_WALK_DEPTH:
                dirnames[:] = []
            for name in filenames:
                if name.startswith("rollout-") and name.endswith(suffix):
                    path = Path(dirpath) / name
                    _transcripts[session_id] = path
                    _misses.pop(session_id, None)
                    return path
    except OSError as e:
        logger.debug("Could not scan Codex sessions: %s", e)
    _misses[session_id] = time.monotonic()
    return None


def _web_action(record: Mapping) -> Optional[Mapping]:
    """The web tool's action out of one transcript record, in either shape.

    Codex has written this two ways: a `response_item` carrying a
    `web_search_call` payload, and an `event_msg` carrying a completed item of
    kind `web.search`. Both end in the same `action` object.
    """
    payload = record.get("payload")
    if not isinstance(payload, dict):
        return None
    payload_type = payload.get("type")
    if payload_type == "web_search_call":
        action = payload.get("action")
        return action if isinstance(action, dict) else None
    if payload_type == "item_completed":
        item = payload.get("item")
        if isinstance(item, dict) and item.get("kind") == "web.search":
            action = item.get("action")
            return action if isinstance(action, dict) else None
    return None


def _event(action: Mapping) -> Optional[dict]:
    """One `{kind, ...}` event, or None for an action with nothing to record.

    Codex also emits `{"type": "other"}` for web activity it does not describe.
    That is recorded as nothing rather than as a destination nobody can check.
    """
    kind = action.get("type")
    if kind == "search":
        query = action.get("query")
        if isinstance(query, str) and query.strip():
            return {"kind": "search", "query": query[:MAX_EVIDENCE_CHARS]}
        return None
    if kind == "openPage":
        url = action.get("url")
        if not isinstance(url, str) or not url.strip():
            return None
        try:
            host = (urlparse(url).hostname or "").lower()
        except ValueError:
            return None
        if not host:
            return None
        return {"kind": "open", "url": url[:MAX_EVIDENCE_CHARS], "host": host}
    return None


def file_size(session_id: str) -> int:
    """Current length of a session's transcript, 0 when there is not one yet."""
    path = find_transcript(session_id)
    if path is None:
        return 0
    try:
        return path.stat().st_size
    except OSError:
        return 0


def observe(session_id: str, since_offset: int) -> tuple:
    """Web events appended since `since_offset`, and the new offset.

    Returns `([], since_offset)` unchanged whenever there is nothing to read:
    no consent, no transcript, no new bytes. The file is append-only, so the
    offset is the whole of the resume state.
    """
    if not consent_granted():
        return [], since_offset
    path = find_transcript(session_id)
    if path is None:
        return [], since_offset
    try:
        size = path.stat().st_size
    except OSError:
        return [], since_offset
    if since_offset < 0:
        start = 0
    elif since_offset > size:
        # The file shrank, so it is not the file the offset belonged to:
        # rotated, replaced, or truncated. Resuming at 0 would replay its whole
        # history into the audit with today's timestamps on it. Resume at the
        # end instead and lose the gap, which is the direction that cannot
        # fabricate activity.
        logger.debug("Codex transcript for %s shrank; resuming at its end",
                     session_id)
        start = size
    else:
        start = since_offset
    if start >= size:
        return [], start
    try:
        with open(path, "rb") as fh:
            fh.seek(start)
            chunk = fh.read(MAX_READ_BYTES)
    except OSError as e:
        logger.debug("Could not read Codex transcript: %s", e)
        return [], since_offset
    # Stop at the last complete line. A partial tail is a line the writer is
    # still appending to; re-reading it next pass is how it gets parsed once.
    cut = chunk.rfind(b"\n")
    if cut < 0:
        if size - start > len(chunk):
            # No newline in a full read, and there is more file beyond it: one
            # line is longer than a whole pass. Waiting for it to end would
            # park the reader on this offset for the life of the session, so
            # the oversized line is skipped and reading continues past it.
            logger.warning(
                "Skipping an oversized line in the Codex transcript for %s "
                "(no newline in %d bytes)", session_id, len(chunk))
            return [], start + len(chunk)
        return [], start
    consumed = chunk[:cut + 1]
    events = []
    for line in consumed.split(b"\n"):
        if not line.strip():
            continue
        try:
            record = json.loads(line.decode("utf-8", "replace"))
        except (ValueError, UnicodeDecodeError):
            continue
        if not isinstance(record, dict):
            continue
        action = _web_action(record)
        if action is None:
            continue
        event = _event(action)
        if event is not None:
            events.append(event)
    return events, start + len(consumed)


def _row(event: Mapping, session_id: str) -> dict:
    if event.get("kind") == "search":
        host, evidence = SEARCH_HOST, event.get("query") or ""
    else:
        host, evidence = event.get("host") or "", event.get("url") or ""
    return {
        "host": host,
        "port": 443,
        "operation": "read",
        "kind": "web",
        "action": OBSERVED_ACTION,
        "rule_id": None,
        "detector": DETECTOR,
        "tool_name": TOOL_NAME,
        "runtime_kind": RUNTIME_KIND,
        "session_id": session_id,
        "evidence": evidence,
        "reason": OBSERVED_REASON,
    }


def _codex_sessions(tasks) -> list:
    """Session ids of the Codex tasks on the board, launched or linked.

    A linked session is a Codex process the app did not start; its web calls
    are exactly as ungoverned as a launched one's, so both are observed.
    """
    out = []
    for task in tasks or []:
        if (task.get("executor_id") or "") != "codex":
            continue
        session_id = task.get("session_id")
        if session_id and session_id not in out:
            out.append(session_id)
    return out


async def observe_once(manager, repo) -> int:
    """One pass over the running Codex tasks. Returns rows recorded.

    A session seen for the first time is only marked at its current end. The
    task in front of the operator is the one this exists for; replaying a
    transcript's whole history into the audit on every restart would be noise
    with today's timestamps on it.
    """
    if not consent_granted():
        # Consent can be withdrawn mid-session. Dropping the offsets is what
        # makes re-granting it safe: the next pass re-seeds at the end of each
        # file, so the window while consent was off is never read afterwards.
        _offsets.clear()
        return 0
    try:
        tasks = await manager.store.list_tasks(running_only=True)
    except Exception as e:  # noqa: BLE001 - the loop keeps running
        logger.debug("Could not list tasks for Codex web observation: %s", e)
        return 0
    written = 0
    for session_id in _codex_sessions(tasks):
        if session_id not in _offsets:
            _offsets[session_id] = file_size(session_id)
            continue
        events, offset = observe(session_id, _offsets[session_id])
        _offsets[session_id] = offset
        for event in events:
            try:
                await repo.record(**_row(event, session_id))
                written += 1
            except Exception as e:  # noqa: BLE001 - one bad row is not fatal
                logger.debug("Could not record observed egress: %s", e)
    return written


async def run_observer(manager, repo,
                       interval: float = OBSERVE_INTERVAL_SECONDS) -> None:
    """Poll the running Codex tasks forever. Cancelled at shutdown."""
    while True:
        try:
            await observe_once(manager, repo)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - never let the loop die
            logger.debug("Codex web observation pass failed: %s", e)
        await asyncio.sleep(interval)
