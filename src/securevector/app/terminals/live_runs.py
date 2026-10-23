"""Metadata-only Live Runs emitter for Agent Terminals.

Story The cloud half of Agent Terminals: task lifecycle events feed a cloud
Live Runs view so an admin sees every run live, METADATA ONLY.

"Metadata only" is a privacy boundary, not a size budget. The cloud may
learn that a run exists and what shape it has. Two short labels also leave,
owner-approved so an admin can tell runs apart: the task `title` the user
typed (sanitised, at most 80 characters) and `workspace_name`, the final
component of the workspace folder (sanitised, at most 64 characters, never
a path). Nothing else that a human typed and nothing else that names
anything on this machine leaves here: no prompts, no tool arguments, no
file paths, no parent folders, no command lines, no terminal output, no
transcripts, no `detail` text.

Three rules hold that line, in this order:

1. **Allowlist, never denylist.** `TASK_FIELD_ALLOWLIST` names the row
   columns that may leave. A column added to `terminal_tasks` later is
   dropped by default; someone has to come here and argue for it. A
   denylist would export every future column until someone noticed.
2. **Closed vocabularies.** Every field that leaves is an enum value, a
   timestamp, a small integer, or a keyed digest, except the two
   sanitised labels above (`_clean_label`, `workspace_name`). A field carrying an
   unexpected value is emitted as None rather than passed through, so a
   column that quietly changes meaning cannot smuggle text out.
3. **No `detail`.** `TerminalStore.add_event` takes a `detail` string that
   routinely contains a folder ("claude-code in /Users/.../secret-client")
   or an exception message. `emit()` deliberately has no parameter for it.
   The emitter takes the task row and the event kind, and nothing else.

Transport: `set_sink()` is the seam. With no sink installed, `emit()` is a
no-op. At app startup the fleet sink (services/fleet_task_events.py) is
installed; it queues each payload for the enrolled fleet destination only,
through the same outbox as tool activity, and does nothing on a device that
is not enrolled.
"""

from __future__ import annotations

import asyncio
import errno
import hmac
import inspect
import logging
import os
import secrets
import types
import unicodedata
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
#   id               app-local random hex (uuid4().hex[:12]). Sent only as a
#                    keyed digest (domain "task"): stable across one run's
#                    events, so the cloud can follow it, but not the local id.
#   executor_id      closed set of four harness ids; a product fact.
#   status           closed set from the table's own CHECK constraint.
#   origin           'launch' or 'linked'; says how the run reached the board.
#   exit_code        a small integer from the OS, no content.
#   title            user-typed label, owner-approved (2026-09-30) so the
#                    Live Runs view can name a run. Sent only through
#                    _clean_label: control characters removed, whitespace
#                    collapsed, at most TITLE_MAX_CHARS.
#   created_at,      timestamps; shape, not content.
#   last_activity_at
#   ended_at
#   archived_at
#
# Deliberately NOT here:
#
#   workspace        a FILE PATH. Parent folders leak client names and the
#                    user's account name. Exported only as a keyed digest
#                    (see workspace_digest) plus the final folder name
#                    (see workspace_name, owner-approved 2026-09-30), never
#                    the path.
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
        "title",
        "exit_code",
        "created_at",
        "last_activity_at",
        "ended_at",
        "archived_at",
        # Session Drift Score, defined here for the heartbeat and exit
        # payloads; the cloud half ships them. Both come from the
        # session_drift row through drift_fields() only: an integer and up to
        # three ids from DRIFT_FEATURE_IDS. Never labels, hosts, tool names,
        # paths or argument text.
        "drift_score",
        "drift_top",
    }
)

# The fixed feature-id enum (services/session_drift.FEATURE_IDS). A test
# keeps the two in step.
DRIFT_FEATURE_IDS = frozenset(
    {
        "tool_novelty",
        "errors_after_block",
        "enumeration",
        "secrets_reach",
        "new_hosts",
        "persistence",
    }
)
DRIFT_TOP_MAX = 3

# Caps on the two sanitised labels that leave (title, workspace folder name).
TITLE_MAX_CHARS = 80
WORKSPACE_NAME_MAX_CHARS = 64

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
# GovRun, Hermes and OpenClaw are deliberately absent until the cloud's Live
# Runs vocabulary knows them: an unknown value could fail the upload batch, so
# they travel as None.
EXECUTOR_IDS = frozenset({"claude-code", "codex", "copilot-cli", "opencode"})
STATUSES = frozenset(
    {"starting", "working", "blocked", "idle", "done", "failed", "interrupted"}
)
# Local statuses the cloud's task_event enum (STATUSES above) does not know,
# mapped onto the nearest one it does. An unknown status fails the whole
# upload batch, and None would hide how the task ended: a task the user
# stopped ended normally, at their request, so it travels as "done".
STATUS_FOR_CLOUD = types.MappingProxyType({"stopped": "done"})
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
        # Periodic "still running" beat for a launched task, so the fleet
        # view's freshness window holds while nothing else changes.
        "heartbeat",
        # Governed delegation: the delegated prompt was delivered (hash and
        # length only), a parent's stop reached its child, and delegation
        # lifecycle notes on the parent and child trails.
        "delegate_prompt",
        "parent_stopped",
        "delegation",
        # Worktree isolation: created or reused at launch, kept at exit,
        # removed on the person's request.
        "worktree",
        "worktree_kept",
        "worktree_removed",
    }
)
# `shutdown` (server/app.py's stop_all on a clean web shutdown) and `quit`
# (main.py's stop_all on the desktop app's own quit) are the two origins
# stop_all actually passes; both were missing, so the two most common ways a
# task ever gets stopped -- the app closing -- exported a null event_origin.
EVENT_ORIGINS = frozenset(
    {"ui", "cli", "rung", "delegate", "policy", "api", "hook", "linked", "process", "startup", "shutdown", "quit"}
)



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


def _clean_label(value: Any, limit: int) -> Optional[str]:
    """Sanitise a short user-visible label, or None.

    Strings only. Whitespace of any kind becomes a space, every other
    Unicode control/format/unassigned character (category C*) is dropped,
    runs of spaces collapse to one, then the result is stripped and cut to
    `limit` characters. Empty after all that means None.
    """
    if not isinstance(value, str):
        return None
    try:
        chars = []
        for ch in unicodedata.normalize("NFC", value):
            if ch.isspace():
                chars.append(" ")
            elif unicodedata.category(ch).startswith("C"):
                continue
            else:
                chars.append(ch)
        text = " ".join("".join(chars).split())
        text = text[:limit].rstrip()
    except Exception:
        return None
    return text or None


def workspace_name(workspace: Any) -> Optional[str]:
    """The workspace folder's own name, never the path, or None.

    "/Users/alice/work/acme-weather/" becomes "acme-weather". None for:
    anything not a string; root, "~", "~user" and the home directory
    itself; a folder sitting directly under a users/home root (it would be
    an account name: /Users/<x>, /home/<x>, C:/Users/<x>); a bare UNC host;
    a bare drive; and anything that cleans down to "", "~", "." or "..".
    Pure: splits the string, never touches disk. The result never contains
    "/" or "\\".
    """
    if not isinstance(workspace, str):
        return None
    try:
        if not workspace.strip():
            return None
        # Only separators are stripped below, never whitespace, so a
        # whitespace-only last component cleans to None instead of falling
        # back to its parent folder.
        text = workspace.replace("\\", "/")
        if text.startswith("//?/"):
            text = text[4:]
        if text.startswith("~"):
            if text.split("/", 1)[0] != "~":
                return None  # "~alice", "~nobody": another user's home
            text = os.path.expanduser(text)
            if text.startswith("~"):
                return None
        unc = text.startswith("//")
        stripped = text.rstrip("/")
        parts = [p for p in stripped.split("/") if p]
        if not parts or (unc and len(parts) < 2):
            return None
        home = os.path.normcase(os.path.expanduser("~")).replace("\\", "/").rstrip("/")
        here = os.path.normcase(stripped)
        if home and home != "~" and here.casefold() == home.casefold():
            return None
        parents = [p.casefold() for p in parts[:-1]]
        if parents in (["users"], ["home"]) or (
            len(parents) == 2 and parents[0].endswith(":") and parents[1] == "users"
        ):
            return None
        base = parts[-1]
        if base.endswith(":"):
            return None
        name = _clean_label(base, WORKSPACE_NAME_MAX_CHARS)
    except Exception:
        return None
    if name is None or name in ("~", ".", "..") or "/" in name or "\\" in name:
        return None
    return name


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
    adr: Optional[Mapping[str, Any]] = None,
) -> dict:
    """Turn a `terminal_tasks` row plus an event kind into a Live Runs payload.

    Pure, and never raises: a malformed row yields a payload full of None
    rather than an exception on the spawn path. Note the absent parameter:
    there is no `detail`, by design (see the module docstring). `title` and
    `workspace_name` are sanitised labels; the workspace path never leaves.
    """
    row: Mapping[str, Any] = task if isinstance(task, Mapping) else {}
    stamp = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    session = row.get("session_id")
    out = {
        "schema": SCHEMA,
        "event": _enum(kind, EVENT_KINDS),
        "event_origin": _enum(origin, EVENT_ORIGINS),
        "emitted_at": stamp.isoformat(timespec="milliseconds"),
        "task_id": _digest(row.get("id"), domain="task", key=key),
        "executor_id": _enum(row.get("executor_id"), EXECUTOR_IDS),
        "status": _enum(
            STATUS_FOR_CLOUD.get(row.get("status"), row.get("status")), STATUSES
        ),
        "task_origin": _enum(row.get("origin"), TASK_ORIGINS),
        "workspace_digest": workspace_digest(row.get("workspace"), key=key),
        "workspace_name": workspace_name(row.get("workspace")),
        "title": _clean_label(row.get("title"), TITLE_MAX_CHARS),
        "has_session": bool(str(session or "").strip()),
        "session_digest": _digest(session, domain="session", key=key),
        "exit_code": _int(row.get("exit_code")),
        "created_at": _timestamp(row.get("created_at")),
        "last_activity_at": _timestamp(row.get("last_activity_at")),
        "ended_at": _timestamp(row.get("ended_at")),
        "archived_at": _timestamp(row.get("archived_at")),
    }
    # Detection and response metadata rides on heartbeat and exit only, and
    # only the fields that pass adr_fields(); a field it drops is absent.
    if adr and out["event"] in ADR_EVENT_KINDS:
        out.update(adr_fields(adr, out["event"]))
    return out


def drift_fields(score: Any, top: Any) -> dict:
    """The two drift fields as they may leave: `drift_score` an int 0 to 100
    or None, `drift_top` up to three feature ids from the closed enum joined
    by commas (the outbox takes scalars only), or None. Anything else is
    dropped, never passed through. adr_fields() applies it."""
    value = _int(score)
    if value is not None and not 0 <= value <= 100:
        value = None
    ids = []
    for item in top if isinstance(top, (list, tuple)) else []:
        fid = item.get("id") if isinstance(item, Mapping) else item
        if isinstance(fid, str) and fid in DRIFT_FEATURE_IDS and fid not in ids:
            ids.append(fid)
    return {"drift_score": value, "drift_top": ",".join(ids[:DRIFT_TOP_MAX]) or None}


# -- detection and response metadata ----------------------------------------
#
# Optional fields on heartbeat and exit payloads only. Integers and closed
# vocabularies, nothing else: no paths, folders, hosts, tool names, labels or
# reason text. adr_fields() is the one validator; the outbox builder and the
# fleet encoder run it again, so a value outside the contract never leaves.
ADR_EVENT_KINDS = frozenset({"heartbeat", "exit"})
ADR_FIELDS = (
    "drift_score",
    "drift_band",
    "drift_top",
    "drift_top_points",
    "drift_top_counts",
    "config_state",
    "config_changed_count",
    "mcp_changed_count",
    "mods_unmanaged_count",
    "rung",
    "rung_mode",
    "rung_reason_ids",
    "preflight_checked",
    "preflight_avoided",
    "rule_ids",
    "held_count",
    "would_hold_count",
    "response_action",
)
DRIFT_BANDS = frozenset({"calm", "watch", "high"})
CONFIG_STATES = frozenset({"approved", "changed", "new", "unknown"})
RUNG_MODES = frozenset({"shadow", "active"})
RUNG_MAX = 3
# The response-rungs signal ids (services/response_rungs SIG_*). A test
# keeps the two in step; any other id is dropped, never sent.
RUNG_REASON_IDS = frozenset({"drift", "config", "deny"})
RUNG_REASON_MAX = 3
# The named call-time rule ids (services/call_rules RULE_IDS). A test keeps
# the two in step; any other id is dropped, never sent.
CALL_RULE_IDS = frozenset({"cred_then_net", "outside_then_reach"})
CALL_RULE_MAX = 2
HOLD_COUNT_MAX = 100000
# What the "stop the session and alert" switch did to the session.
RESPONSE_ACTIONS = frozenset({"stopped"})
DRIFT_POINTS_MAX = 100
DRIFT_COUNT_MAX = 100000
SETUP_COUNT_MAX = 10000
PREFLIGHT_COUNT_MAX = 100000
# Config Trust's per-task setup state, mapped onto the wire vocabulary.
_CONFIG_STATE_FOR_CLOUD = {
    "pinned": "approved",
    "approved": "approved",
    "changed": "changed",
    "new": "new",
    "unapproved": "new",
}


def _ids(value: Any) -> list:
    if isinstance(value, str):
        return [v.strip() for v in value.split(",")]
    if isinstance(value, (list, tuple)):
        return list(value)
    return []


def _count(value: Any, cap: int) -> Optional[int]:
    number = _int(value) if not isinstance(value, float) else None
    if number is None or number < 0:
        return None
    return min(number, cap)


def _int_list(value: Any) -> Optional[list]:
    """A comma-joined string or a list of ints, or None if any item is not one."""
    items = _ids(value)
    out = []
    for item in items:
        if isinstance(item, float) or isinstance(item, bool):
            return None
        number = _int(item)
        if number is None:
            return None
        out.append(number)
    return out


def _drift_top_fields(src: Mapping[str, Any]) -> dict:
    """drift_top plus drift_top_points and drift_top_counts, kept aligned.

    The points and counts lists must have exactly one entry per drift_top
    id (as given), else that list is dropped. Ids outside the enum or
    repeated are dropped together with their entries; points are clamped
    to 0..100, counts to 0..100000, at most three of each. Neither list
    leaves without drift_top.
    """
    ids = _ids(src.get("drift_top"))
    extra = {}
    for name in ("drift_top_points", "drift_top_counts"):
        if src.get(name) is None:
            continue
        values = _int_list(src.get(name))
        if values is not None and len(values) == len(ids):
            extra[name] = values
    keep: list = []
    for i, item in enumerate(ids):
        fid = item.get("id") if isinstance(item, Mapping) else item
        if isinstance(fid, str) and fid in DRIFT_FEATURE_IDS and fid not in {k for _, k in keep}:
            keep.append((i, fid))
    keep = keep[:DRIFT_TOP_MAX]
    if not keep:
        return {}
    out = {"drift_top": ",".join(fid for _, fid in keep)}
    caps = {"drift_top_points": DRIFT_POINTS_MAX, "drift_top_counts": DRIFT_COUNT_MAX}
    for name, values in extra.items():
        picked = [values[i] for i, _ in keep]
        if any(v < 0 for v in picked):
            continue
        out[name] = ",".join(str(min(v, caps[name])) for v in picked)
    return out


def adr_fields(values: Any, event: Any = None) -> dict:
    """The detection and response fields that may leave, from `values`.

    `event` is the payload's event kind and is required: anything other than
    heartbeat or exit (a missing kind included) yields nothing.
    Every field is optional and each one is checked on its own: a value
    outside the contract is dropped (never passed through), counts are
    clamped to their cap, and an absent or empty field is simply missing
    from the result, never None or "". Never raises.
    """
    if event not in ADR_EVENT_KINDS:
        return {}
    src: Mapping[str, Any] = values if isinstance(values, Mapping) else {}
    out: dict = {}
    try:
        drift = drift_fields(src.get("drift_score"), None)
        if drift["drift_score"] is not None:
            out["drift_score"] = drift["drift_score"]
        out.update(_drift_top_fields(src))
        band = src.get("drift_band")
        if isinstance(band, str) and band in DRIFT_BANDS:
            out["drift_band"] = band
        state = src.get("config_state")
        if isinstance(state, str) and state in CONFIG_STATES:
            out["config_state"] = state
        for name in ("config_changed_count", "mcp_changed_count", "mods_unmanaged_count"):
            number = _count(src.get(name), SETUP_COUNT_MAX)
            if number is not None:
                out[name] = number
        rung = _int(src.get("rung")) if not isinstance(src.get("rung"), float) else None
        if rung is not None and 0 <= rung <= RUNG_MAX:
            out["rung"] = rung
        mode = src.get("rung_mode")
        if isinstance(mode, str) and mode in RUNG_MODES:
            out["rung_mode"] = mode
        reasons: list = []
        for rid in _ids(src.get("rung_reason_ids")):
            if isinstance(rid, str) and rid in RUNG_REASON_IDS and rid not in reasons:
                reasons.append(rid)
        if reasons:
            out["rung_reason_ids"] = ",".join(reasons[:RUNG_REASON_MAX])
        for name in ("preflight_checked", "preflight_avoided"):
            number = _count(src.get(name), PREFLIGHT_COUNT_MAX)
            if number is not None:
                out[name] = number
        rules: list = []
        for rid in _ids(src.get("rule_ids")):
            if isinstance(rid, str) and rid in CALL_RULE_IDS and rid not in rules:
                rules.append(rid)
        if rules:
            out["rule_ids"] = ",".join(rules[:CALL_RULE_MAX])
        for name in ("held_count", "would_hold_count"):
            number = _count(src.get(name), HOLD_COUNT_MAX)
            if number is not None:
                out[name] = number
        action = src.get("response_action")
        if isinstance(action, str) and action in RESPONSE_ACTIONS:
            out["response_action"] = action
    except Exception:
        logger.debug("live_runs: adr fields dropped", exc_info=True)
        return {}
    return out


# The count each drift feature's sentence names on the local page.
_PRIMARY_COUNT = {
    "tool_novelty": "unseen_tools",
    "errors_after_block": "errors",
    "secrets_reach": "locations",
    "new_hosts": "hosts",
    "persistence": "repeats",
}


def _primary_count(fid: Any, counts: Any) -> int:
    c = counts if isinstance(counts, Mapping) else {}
    if fid == "enumeration":
        loops = _int(c.get("loop_calls")) or 0
        return loops if loops > 0 else (_int(c.get("distinct_hosts")) or 0)
    return _int(c.get(_PRIMARY_COUNT.get(fid, ""))) or 0


ADR_COLLECT_TIMEOUT_SECONDS = 2.0
_UNSET: Any = object()


async def unmanaged_mod_count(db: Any = None) -> Optional[int]:
    """Unmanaged Claude Code mods on this device, or None. Never raises.
    Device-wide, so a heartbeat tick reads it once for all its tasks."""
    try:
        if db is None:
            from securevector.app.database.connection import get_database

            db = get_database()
        row = await db.fetch_one("SELECT COUNT(*) AS n FROM mod_inventory WHERE managed = 0")
        return int(row["n"] or 0) if row is not None else None
    except Exception:
        logger.debug("live_runs: mod inventory unavailable", exc_info=True)
        return None


async def collect_adr(task: Mapping[str, Any], db: Any = None, *, mods_unmanaged: Any = _UNSET,
                      timeout: Optional[float] = None) -> dict:
    """The detection and response metadata for one task, within `timeout`
    seconds. On timeout or any failure it returns {} and the event goes out
    without the fields. Values reflect local state at send time. Never raises.
    `mods_unmanaged` lets a caller pass a count it already read."""
    try:
        limit = ADR_COLLECT_TIMEOUT_SECONDS if timeout is None else timeout
        return await asyncio.wait_for(_collect_adr(task, db, mods_unmanaged), limit)
    except Exception:
        logger.debug("live_runs: adr collection timed out or failed", exc_info=True)
        return {}


async def _collect_adr(task: Mapping[str, Any], db: Any, mods_unmanaged: Any) -> dict:
    """Read the detection and response metadata for one task. Never raises.

    Raw values from the local services, keyed by the wire names; the caller
    runs them through adr_fields(). A source that has nothing for this task
    (no drift row, no setup check, no rung row, no pre-flight session) adds
    nothing, so the field is omitted rather than sent empty. Database reads
    are async; each source fails on its own.
    """
    row: Mapping[str, Any] = task if isinstance(task, Mapping) else {}
    task_id = str(row.get("id") or "").strip() or None
    session_id = str(row.get("session_id") or "").strip() or None
    out: dict = {}
    try:
        if db is None:
            from securevector.app.database.connection import get_database

            db = get_database()
    except Exception:
        return out

    if session_id:
        try:
            from securevector.app.services import session_drift

            drow = await db.fetch_one("SELECT * FROM session_drift WHERE session_id = ?", (session_id,))
            drow = dict(drow) if drow else None
            if drow and drow.get("score") is not None:
                result = session_drift.result_from_row(drow)
                out["drift_score"] = result.score
                out["drift_band"] = session_drift.band_for(result.score)
                top = result.top()
                feats = {f["id"]: f for f in result.features}
                out["drift_top"] = [f["id"] for f in top]
                # Each row's share of the score (as the local page shows it),
                # and the count its sentence names.
                points = dict(session_drift.contribution_points(result))
                out["drift_top_points"] = [points.get(f["id"], 0) for f in top]
                out["drift_top_counts"] = [
                    _primary_count(f["id"], (feats.get(f["id"]) or {}).get("counts")) for f in top
                ]
        except Exception:
            logger.debug("live_runs: drift metadata unavailable", exc_info=True)

    if task_id:
        try:
            from securevector.app.database.repositories.config_trust import ConfigTrustRepository

            check = (await ConfigTrustRepository(db).latest_for_tasks([task_id])).get(task_id)
            if check:
                diff = [c for c in check.get("diff") or [] if isinstance(c, Mapping)]
                out["config_state"] = _CONFIG_STATE_FOR_CLOUD.get(check.get("state"), "unknown")
                out["config_changed_count"] = len(diff)
                out["mcp_changed_count"] = sum(
                    1 for c in diff if c.get("type") == "mcp" or c.get("target") == "server"
                )
                # Mod inventory is Claude Code's user scope only.
                if row.get("executor_id") == "claude-code":
                    if mods_unmanaged is _UNSET:
                        mods_unmanaged = await unmanaged_mod_count(db)
                    if mods_unmanaged is not None:
                        out["mods_unmanaged_count"] = mods_unmanaged
            else:
                out["config_state"] = "unknown"
        except Exception:
            logger.debug("live_runs: setup metadata unavailable", exc_info=True)

    if session_id or task_id:
        try:
            from securevector.app.database.repositories.response_rungs import ResponseRungsRepository

            rrepo = ResponseRungsRepository(db)
            rrow = await rrepo.get(session_id) if session_id else None
            if rrow is None and task_id:
                rrow = await rrepo.get_for_task(task_id)
            if rrow:
                import json

                out["rung"] = rrow.get("rung")
                out["rung_mode"] = rrow.get("mode")
                reasons = json.loads(rrow.get("reasons_json") or "[]")
                out["rung_reason_ids"] = reasons if isinstance(reasons, list) else []
        except Exception:
            logger.debug("live_runs: rung metadata unavailable", exc_info=True)

        # Named call-time rules: the ids that fired (Off mode included), and
        # this session's hold events by mode, only when there is something.
        if session_id:
            try:
                from securevector.app.database.repositories.call_rules import CallRulesRepository

                crepo = CallRulesRepository(db)
                fired = (await crepo.fired_for([session_id])).get(session_id) or []
                from securevector.app.services.call_rules import RULE_IDS

                holds = await crepo.holds_by_mode(session_id, RULE_IDS)
                if fired:
                    out["rule_ids"] = fired
                if fired or any(holds.values()):
                    out["held_count"] = holds.get("active", 0)
                    out["would_hold_count"] = holds.get("shadow", 0)
            except Exception:
                logger.debug("live_runs: call rule metadata unavailable", exc_info=True)

            try:
                from securevector.app.database.repositories.session_stops import SessionStopsRepository

                stop = await SessionStopsRepository(db).get(session_id)
                if stop and stop.get("outcome") == "stopped":
                    out["response_action"] = "stopped"
            except Exception:
                logger.debug("live_runs: stop metadata unavailable", exc_info=True)

        try:
            from securevector.app.database.repositories.policy_decisions import PolicyDecisionsRepository

            handles = await PolicyDecisionsRepository(db).handles_for_view(task_id, session_id)
            handles = [h for h in dict.fromkeys(handles) if h][:400]
            if handles:
                marks = ",".join("?" for _ in handles)
                pre = await db.fetch_one(
                    "SELECT COUNT(*) AS n, "
                    "SUM(CASE WHEN decision = 'deny' AND attempted_after_deny = 0 THEN 1 ELSE 0 END) "
                    f"AS avoided FROM policy_decisions WHERE session IN ({marks})",
                    tuple(handles),
                )
                if pre is not None:
                    out["preflight_checked"] = int(pre["n"] or 0)
                    out["preflight_avoided"] = int(pre["avoided"] or 0)
        except Exception:
            logger.debug("live_runs: pre-flight metadata unavailable", exc_info=True)
    return out


# -- transport seam --------------------------------------------------------

Sink = Callable[[dict], Union[None, Awaitable[None]]]

_sink: Optional[Sink] = None
_pending: Set["asyncio.Task"] = set()

# How often a running task re-announces itself while a sink is installed.
HEARTBEAT_SECONDS = 60.0

# A sink that hangs must not hold a stop open. A cloud outage is allowed to
# lose a Live Runs event; it is not allowed to slow a local agent down.
EMIT_TIMEOUT_SECONDS = 5.0


async def drain_pending(timeout: float = 2.0) -> None:
    """Wait briefly for scheduled emits to finish (used at shutdown)."""
    pending = [t for t in _pending if not t.done()]
    if not pending:
        return
    try:
        await asyncio.wait(pending, timeout=timeout)
    except Exception:
        logger.debug("live_runs: drain failed", exc_info=True)


def set_sink(sink: Optional[Sink]) -> None:
    """Install the transport, or clear it so `emit()` is inert.

    With no sink installed every `emit()` returns False without touching
    the network.

    A sink must be non-blocking: return a coroutine and do its I/O with an
    async client. A sink that blocks the loop defeats the point of this
    whole module.
    """
    global _sink
    _sink = sink


def get_sink() -> Optional[Sink]:
    return _sink


def has_sink() -> bool:
    """True once a transport is installed (the app installs the fleet sink at startup).

    A cheap, allocation-free check a hot-path caller can use to skip
    `emit_nowait()` entirely rather than pay for it. Without a sink, `emit()`
    returns False as its very first check, but by then `emit_nowait()` has
    already snapshotted the row, scheduled an asyncio Task, and held a
    strong reference to it -- real work spent to run code whose only
    possible outcome is a no-op. Every lifecycle transition would pay that
    in any process that never called `set_sink()`.
    """
    return _sink is not None


async def cloud_connected() -> bool:
    """True only when Cloud Connect is switched on or the device is enrolled.

    Enrolled means an enabled fleet destination (source "enrollment") is
    registered: a device enrolled from the command line has one without
    Cloud Connect mode being toggled in settings, and that is exactly the
    device a fleet view needs to see.

    Imported lazily so this module stays cheap to import from the spawn
    path and cannot form an import cycle with the database layer. Any
    failure reading settings counts as "not connected": the gate fails
    closed, so a broken settings read cannot start exporting.
    """
    try:
        from securevector.app.database.connection import get_database
        from securevector.app.database.repositories.settings import SettingsRepository

        settings = await SettingsRepository(get_database()).get()
        if bool(getattr(settings, "cloud_mode_enabled", False)):
            return True
    except Exception:
        return False
    return await fleet_enrolled()


async def fleet_enrolled() -> bool:
    """True when an enabled enrollment (fleet) destination exists. Fails closed."""
    try:
        from securevector.app.database.connection import get_database
        from securevector.app.database.repositories.external_forwarders import (
            ExternalForwardersRepository,
        )

        active = await ExternalForwardersRepository(get_database()).list_active()
        return any(str(f.get("source") or "") == "enrollment" for f in active)
    except Exception:
        return False


async def emit(
    task: Mapping[str, Any],
    kind: Any,
    *,
    origin: Any = None,
    timeout: float = EMIT_TIMEOUT_SECONDS,
    now: Optional[datetime] = None,
    adr: Optional[Mapping[str, Any]] = None,
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
        # A caller that already collected the metadata passes it in, so the
        # event reaches the sink with no further reads (exit, heartbeat).
        if adr is None and kind in ADR_EVENT_KINDS:
            adr = await collect_adr(task)
        payload = build_payload(task, kind, origin=origin, now=now, adr=adr)
        result = sink(payload)
        if inspect.isawaitable(result):
            await asyncio.wait_for(result, timeout)
        return True
    except Exception:
        logger.debug("live_runs: emit failed, dropping event", exc_info=True)
        return False


def emit_nowait(
    task: Mapping[str, Any],
    kind: Any,
    *,
    origin: Any = None,
    adr: Optional[Mapping[str, Any]] = None,
    now: Optional[datetime] = None,
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
        # Stamped with the snapshot, not when the task happens to run, so
        # emitted_at order follows the real transition order.
        # A caller that read metadata first passes the time it started.
        stamp = now or datetime.now(timezone.utc)
        adr = dict(adr) if isinstance(adr, Mapping) else None
        loop = asyncio.get_running_loop()
    except Exception:
        return None
    try:
        handle = loop.create_task(
            emit(snapshot, kind, origin=origin, now=stamp, adr=adr), name="live-runs-emit"
        )
    except Exception:
        return None
    # Hold a strong reference: asyncio only keeps a weak one, so an
    # un-referenced task can be collected mid-flight.
    _pending.add(handle)
    handle.add_done_callback(_pending.discard)
    return handle
