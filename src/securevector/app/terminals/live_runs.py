"""Metadata-only Live Runs emitter for Agent Terminals.

Story The cloud half of Agent Terminals: task lifecycle events feed a cloud
Live Runs view so an admin sees every run live, METADATA ONLY.

"Metadata only" is a privacy boundary, not a size budget. The cloud may
learn that a run exists and what shape it has. It may never learn what the
run is about. Nothing that a human typed and nothing that names anything on
this machine leaves here: no prompts, no tool arguments, no file paths, no
folder names, no command lines, no titles, no transcripts, no free text of
any kind.

Three rules hold that line, in this order:

1. **Allowlist, never denylist.** `TASK_FIELD_ALLOWLIST` names the row
   columns that may leave. A column added to `terminal_tasks` later is
   dropped by default; someone has to come here and argue for it. A
   denylist would export every future column until someone noticed.
2. **Closed vocabularies.** Every field that leaves is an enum value, a
   timestamp, a small integer, or a keyed digest. A field carrying an
   unexpected value is emitted as None rather than passed through, so a
   column that quietly changes meaning cannot smuggle text out.
3. **No `detail`.** `TerminalStore.add_event` takes a `detail` string that
   routinely contains a folder ("claude-code in /Users/.../secret-client")
   or an exception message. `emit()` deliberately has no parameter for it.
   The emitter takes the task row and the event kind, and nothing else.

Transport: there is no cloud endpoint for this yet (a separate cloud story owns it), so this
module ships the payload builder, the no-op gate, and a pluggable sink.
`set_sink()` is the seam. With no sink installed, `emit()` is a no-op.
Inventing a URL here would be worse than leaving an honest seam.
"""

from __future__ import annotations

import asyncio
import errno
import hmac
import inspect
import logging
import os
import re
import secrets
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping, Optional, Set, Union

logger = logging.getLogger(__name__)

# Bump when the payload's meaning changes so the cloud can tell versions
# apart without guessing from which keys happen to be present.
SCHEMA = "securevector.live_run/1"


# -- what may leave this machine ------------------------------------------

# Row columns from `terminal_tasks` that are safe to export, and why:
#
#   id               app-local random hex (uuid4().hex[:12]); names nothing
#                    outside SecureVector and is the only handle the cloud
#                    needs to follow one run across its events.
#   executor_id      closed set of four harness ids; a product fact.
#   status           closed set from the table's own CHECK constraint.
#   origin           'launch' or 'linked'; says how the run reached the board.
#   exit_code        a small integer from the OS, no content.
#   created_at,      timestamps; shape, not content.
#   last_activity_at
#   ended_at
#   archived_at
#
# Deliberately NOT here:
#
#   workspace        a FILE PATH. Folder names leak client names, project
#                    codenames, and the user's account name. Exported only
#                    as a keyed digest (see workspace_digest).
#   title            user-typed. The single most likely place for the thing
#                    the user is actually working on to appear.
#   activity         derived from harness tool traffic; free text.
#   pid              an OS identifier for a process on the user's machine.
#                    Not content, but a Live Runs view cannot act on it and
#                    it is a host fingerprint, so it stays home.
#   session_id       see SESSION_ID below.
TASK_FIELD_ALLOWLIST = frozenset(
    {
        "id",
        "executor_id",
        "status",
        "origin",
        "exit_code",
        "created_at",
        "last_activity_at",
        "ended_at",
        "archived_at",
    }
)

# SESSION_ID: a judgement call, decided as "digest, never raw".
#
# It is not user-typed, so it is not content in the way a title is. But it
# is the harness's own handle for the conversation, and the harnesses name
# their on-disk transcripts after it (Claude Code stores
# ~/.claude/projects/<slug>/<session_id>.jsonl). Handing the cloud the raw
# value therefore hands it a pointer straight at the transcript for anyone
# who also reaches the disk, and a correlation key into a third party's
# telemetry that the user never agreed to share.
#
# The Live Runs view needs less than that. It needs to tell two runs apart
# (`id` already does that) and to recognise that a linked row and the row
# that resumed it are the same harness session. A per-install keyed digest
# does exactly that and nothing more. So: `session_digest` plus a boolean,
# never `session_id`.
SESSION_ID_POLICY = "digest"

# Closed vocabularies. A value outside these is emitted as None rather than
# passed through: unknown means untrusted here, not "probably fine".
EXECUTOR_IDS = frozenset({"claude-code", "codex", "copilot-cli", "opencode"})
STATUSES = frozenset(
    {"starting", "working", "blocked", "idle", "done", "failed", "interrupted"}
)
TASK_ORIGINS = frozenset({"launch", "linked"})
# Every value `TerminalStore.add_event(kind=...)` is actually called with,
# across manager.py, store.py, guardrail.py and routes.py. `spawn`, `stop`
# and the other Live Runs kinds below were here from the start; `interrupted`
# (app restart while a task was running), `exit` (process exit) and `hook`
# (a hook posted while unattached) were missed the first time, and
# `attach`/`detach` (routes.py, the WebSocket lifecycle) were never added at
# all -- so those five degraded to a null `event` on export instead of the
# real one. `guard_removed` predates this list and stays; it is a Live Runs
# kind in its own right, not one of the ones added here.
EVENT_KINDS = frozenset(
    {
        "spawn",
        "spawn_failed",
        "stop",
        "linked",
        "adopted",
        "archived",
        "input",
        "guard_missing",
        "guard_removed",
        "interrupted",
        "exit",
        "hook",
        "attach",
        "detach",
    }
)
# `shutdown` (server/app.py's stop_all on a clean web shutdown) and `quit`
# (main.py's stop_all on the desktop app's own quit) are the two origins
# stop_all actually passes; both were missing, so the two most common ways a
# task ever gets stopped -- the app closing -- exported a null event_origin.
EVENT_ORIGINS = frozenset(
    {"ui", "cli", "api", "hook", "linked", "process", "startup", "shutdown", "quit"}
)

# An app-local opaque id: uuid4 hex today. Anything outside this shape did
# not come from our own id generator, so it is digested instead of sent.
_OPAQUE_ID = re.compile(r"\A[A-Za-z0-9_-]{1,64}\Z")


# -- keyed digests ---------------------------------------------------------

# 128 bits of a keyed hash. Long enough that a fleet will not collide,
# short enough to read in a console.
DIGEST_CHARS = 32

_SALT_FILENAME = "live-runs-salt"
_SALT_BYTES = 32

_salt: Optional[bytes] = None


def salt_from_data_dir(data_dir: Union[str, Path]) -> bytes:
    """Read (or create) the per-install digest key under `data_dir`.

    The key never leaves the machine. That is the whole point: a path
    namespace is small and guessable, so an unkeyed SHA-256 of a folder is
    reversible by anyone willing to try a dictionary of plausible paths.
    Keying it with a secret the cloud does not hold makes the digest a
    grouping token instead of an obfuscated path.

    Deliberately not the device id: that IS sent to the cloud on every sync
    request, so keying with it would hand the cloud both halves.

    Written the same way `auth.load_or_create_token` writes the UI token:
    `os.open(..., O_CREAT | O_NOFOLLOW, 0o600)` rather than
    `write_text()` then `chmod()` after. `write_text()` creates the file at
    the umask's mode and only THEN narrows it, which is a window where a
    local reader can catch it wide open, and it follows a symlink someone
    planted at this path instead of refusing it. The key is exactly as
    sensitive as the token: either one lets an attacker build the same
    digests this install would and de-anonymise what Live Runs exports.
    """
    path = Path(data_dir) / "terminals" / _SALT_FILENAME
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.exists():
        existing = path.read_text().strip()
        if len(existing) >= 32:
            owned_by_us = True
            if os.name == "posix":
                owned_by_us = os.stat(path).st_uid == os.getuid()
            if owned_by_us:
                if os.name == "posix":
                    os.chmod(path, 0o600)
                return existing.encode("utf-8")
            # Belongs to another OS user: not a secret only we hold. We own
            # the 0700 parent, so removing it succeeds even though we could
            # not open it for writing; fall through and rotate.
            path.unlink()
    value = secrets.token_hex(_SALT_BYTES)
    open_flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    if os.name == "posix":
        # Refuse to write through a symlink planted at this path.
        open_flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, open_flags, 0o600)
    except OSError as exc:
        if os.name == "posix" and exc.errno == errno.ELOOP:
            raise RuntimeError(
                f"Refusing to write the live-runs digest salt through a symlink: {path}"
            ) from exc
        raise
    with os.fdopen(fd, "w") as fh:
        fh.write(value)
    if os.name == "posix":
        os.chmod(path, 0o600)
    return value.encode("utf-8")


def set_salt(value: Optional[bytes]) -> None:
    """Install the digest key, or clear it so the next call re-derives.

    Callers that already own the app data directory (the manager does) can
    hand the key over at startup; tests pass a fixed one.
    """
    global _salt
    _salt = value


def _current_salt() -> bytes:
    """The digest key, derived lazily from the app data directory.

    If the data directory cannot be read or written, fall back to a random
    key held only in this process. That degrades grouping (digests change
    when the app restarts) and never degrades privacy, which is the right
    way round for a fail-safe on a privacy boundary.
    """
    global _salt
    if _salt is not None:
        return _salt
    try:
        from securevector.app.utils.platform import get_app_data_dir

        _salt = salt_from_data_dir(get_app_data_dir())
    except Exception:
        _salt = secrets.token_bytes(_SALT_BYTES)
        logger.debug(
            "live_runs: no persistent digest key available, using a process-local one"
        )
    return _salt


def _digest(value: Any, *, domain: str, key: Optional[bytes] = None) -> Optional[str]:
    """Keyed, domain-separated digest of one value, or None when empty.

    Domain separation stops the same string digesting to the same token in
    two different fields, so the cloud cannot join a workspace digest to a
    session digest by equality.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    message = f"{domain}\x00{text}".encode("utf-8")
    mac = hmac.new(key if key is not None else _current_salt(), message, sha256)
    return mac.hexdigest()[:DIGEST_CHARS]


def workspace_digest(workspace: Any, *, key: Optional[bytes] = None) -> Optional[str]:
    """A stable token for a folder that is not the folder.

    Lets the cloud say "these nine runs share a workspace" without learning
    that the workspace is ~/clients/acme/pricing-model. Normalised so the
    same folder spelled two ways groups together; never resolved on disk,
    because this runs on the spawn path and must not touch the filesystem.
    """
    if workspace is None:
        return None
    text = str(workspace).strip()
    if not text:
        return None
    try:
        normalised = os.path.normcase(os.path.normpath(os.path.expanduser(text)))
    except Exception:
        normalised = text
    return _digest(normalised, domain="workspace", key=key)


# -- payload ---------------------------------------------------------------


def _enum(value: Any, allowed: frozenset) -> Optional[str]:
    return value if isinstance(value, str) and value in allowed else None


def _opaque_id(value: Any, *, key: Optional[bytes] = None) -> Optional[str]:
    """Pass an app-generated id through; digest anything else.

    `id` is ours (uuid4 hex), so it carries nothing. This guard exists so
    that if a row ever arrives whose id was built from something else, a
    path or a label say, the odd value is digested instead of exported.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if _OPAQUE_ID.match(text):
        return text
    return _digest(text, domain="task-id", key=key)


def _timestamp(value: Any) -> Optional[str]:
    """Re-serialise a stored timestamp to ISO UTC.

    Parsing and re-emitting means a timestamp column can only ever leave
    here as a timestamp. Free text parked in one is dropped, not forwarded.
    """
    if value is None:
        return None
    try:
        from securevector.app.terminals.store import parse_ts

        parsed = parse_ts(value)
    except Exception:
        parsed = None
    if parsed is None:
        return None
    return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds")


def _int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def build_payload(
    task: Mapping[str, Any],
    kind: Any,
    *,
    origin: Any = None,
    now: Optional[datetime] = None,
    key: Optional[bytes] = None,
) -> dict:
    """Turn a `terminal_tasks` row plus an event kind into a Live Runs payload.

    Pure, and never raises: a malformed row yields a payload full of None
    rather than an exception on the spawn path. Note the absent parameter:
    there is no `detail`, by design (see the module docstring).
    """
    row: Mapping[str, Any] = task if isinstance(task, Mapping) else {}
    stamp = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    session = row.get("session_id")
    return {
        "schema": SCHEMA,
        "event": _enum(kind, EVENT_KINDS),
        "event_origin": _enum(origin, EVENT_ORIGINS),
        "emitted_at": stamp.isoformat(timespec="milliseconds"),
        "task_id": _opaque_id(row.get("id"), key=key),
        "executor_id": _enum(row.get("executor_id"), EXECUTOR_IDS),
        "status": _enum(row.get("status"), STATUSES),
        "task_origin": _enum(row.get("origin"), TASK_ORIGINS),
        "workspace_digest": workspace_digest(row.get("workspace"), key=key),
        "has_session": bool(str(session or "").strip()),
        "session_digest": _digest(session, domain="session", key=key),
        "exit_code": _int(row.get("exit_code")),
        "created_at": _timestamp(row.get("created_at")),
        "last_activity_at": _timestamp(row.get("last_activity_at")),
        "ended_at": _timestamp(row.get("ended_at")),
        "archived_at": _timestamp(row.get("archived_at")),
    }


# -- transport seam --------------------------------------------------------

Sink = Callable[[dict], Union[None, Awaitable[None]]]

_sink: Optional[Sink] = None
_pending: Set["asyncio.Task"] = set()

# A sink that hangs must not hold a stop open. A cloud outage is allowed to
# lose a Live Runs event; it is not allowed to slow a local agent down.
EMIT_TIMEOUT_SECONDS = 5.0


def set_sink(sink: Optional[Sink]) -> None:
    """Install the transport, or clear it so `emit()` is inert.

    The cloud story owns the endpoint. Until it exists there is no sink and every
    `emit()` returns False without touching the network.

    A sink must be non-blocking: return a coroutine and do its I/O with an
    async client. A sink that blocks the loop defeats the point of this
    whole module.
    """
    global _sink
    _sink = sink


def get_sink() -> Optional[Sink]:
    return _sink


def has_sink() -> bool:
    """True once the cloud side installs a real transport; False on every install today.

    A cheap, allocation-free check a hot-path caller can use to skip
    `emit_nowait()` entirely rather than pay for it. Without a sink, `emit()`
    returns False as its very first check, but by then `emit_nowait()` has
    already snapshotted the row, scheduled an asyncio Task, and held a
    strong reference to it -- real work spent to run code whose only
    possible outcome is a no-op. Every spawn and stop pays that on every
    install that has never called `set_sink()`, which as of 6.0.0 is all of
    them.
    """
    return _sink is not None


async def cloud_connected() -> bool:
    """True only when Cloud Connect is configured and switched on.

    Imported lazily so this module stays cheap to import from the spawn
    path and cannot form an import cycle with the database layer. Any
    failure reading settings counts as "not connected": the gate fails
    closed, so a broken settings read cannot start exporting.
    """
    try:
        from securevector.app.database.connection import get_database
        from securevector.app.database.repositories.settings import SettingsRepository

        settings = await SettingsRepository(get_database()).get()
        return bool(getattr(settings, "cloud_mode_enabled", False))
    except Exception:
        return False


async def emit(
    task: Mapping[str, Any],
    kind: Any,
    *,
    origin: Any = None,
    timeout: float = EMIT_TIMEOUT_SECONDS,
) -> bool:
    """Best effort: send one lifecycle event outward. Never raises.

    No-ops when no sink is installed or Cloud Connect is off, and swallows
    anything the sink does, so a cloud outage can never stop someone
    launching or stopping an agent locally. Returns True only when a sink
    actually accepted the payload, which is what tests assert on.
    """
    try:
        sink = _sink
        if sink is None:
            return False
        if not await cloud_connected():
            return False
        payload = build_payload(task, kind, origin=origin)
        result = sink(payload)
        if inspect.isawaitable(result):
            await asyncio.wait_for(result, timeout)
        return True
    except Exception:
        logger.debug("live_runs: emit failed, dropping event", exc_info=True)
        return False


def emit_nowait(
    task: Mapping[str, Any], kind: Any, *, origin: Any = None
) -> Optional["asyncio.Task"]:
    """Schedule `emit()` without awaiting it. Never raises.

    For call sites that must not wait even the length of a settings read,
    such as the spawn path. The row is snapshotted now so a later mutation
    cannot change what gets sent. Returns None when there is no running
    loop, which is also how this behaves under sync callers.
    """
    if task is None:
        # `store.get_task()` returns None when the row is gone (already
        # archived, or read during the narrow window before create_task()
        # commits). Building a payload anyway would still carry a real
        # `event` kind on an otherwise all-None row: a Live Runs consumer
        # cannot tell that apart from a task about which nothing at all was
        # known, so there is nothing honest to send. Skip it.
        return None
    try:
        snapshot = dict(task) if isinstance(task, Mapping) else {}
        loop = asyncio.get_running_loop()
    except Exception:
        return None
    try:
        handle = loop.create_task(
            emit(snapshot, kind, origin=origin), name="live-runs-emit"
        )
    except Exception:
        return None
    # Hold a strong reference: asyncio only keeps a weak one, so an
    # un-referenced task can be collected mid-flight.
    _pending.add(handle)
    handle.add_done_callback(_pending.discard)
    return handle
