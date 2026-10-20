"""
Two named call-time rules, decided from the order of a session's calls:

- "Credential, then network" (`cred_then_net`): once a session has read a
  credential location, its next network-capable call is held for approval.
- "Outside content, then credential or network" (`outside_then_reach`):
  once a session has read content from outside its task (a web fetch or
  search, an MCP tool result, or a file outside the task folder), its next
  credential read or network-capable call is held for approval.

Both stand on their own: they never read the drift score, the rung ladder
or threat findings. The mode is the agent tool's automatic actions mode
(response rungs): no mode row is Off (the event is recorded as evidence
only), test mode records what would have been held, On holds. A held call
is the usual requestable deny: denied for this call, one approval request
filed. An approval clears the rule for that session; the next credential
or outside read arms it again. Off and test mode record one event per
arming. Nothing here stores a path, a host or argument text.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional

from securevector.app.services import response_rungs as rr
from securevector.app.services import session_drift as drift

logger = logging.getLogger(__name__)

TOOL_ID = "sv.call_rule"

RULE_CRED_NET = "cred_then_net"
RULE_OUTSIDE = "outside_then_reach"
RULE_IDS = (RULE_CRED_NET, RULE_OUTSIDE)

RULE_NAMES = {
    RULE_CRED_NET: "Credential, then network",
    RULE_OUTSIDE: "Outside content, then credential or network",
}
# The plain sentence a session's Why shows first.
RULE_WHY = {
    RULE_CRED_NET: "Read a credential file, then made a network call",
    RULE_OUTSIDE: "Read outside content, then reached for a credential or the network",
}
HOLD_NETWORK = {
    RULE_CRED_NET: ("Held: this session read a credential file, then made a network call. "
                    "Approve it in Approvals to continue."),
    RULE_OUTSIDE: ("Held: this session read outside content, then made a network call. "
                   "Approve it in Approvals to continue."),
}
HOLD_CREDENTIAL = ("Held: this session read outside content, then reached for a credential. "
                   "Approve it in Approvals to continue.")

MODE_OFF = "off"

# Mirrors NETWORK_CAPABLE_BUILTINS in core/egress/destinations.py and the
# Guard hook's set; any `mcp__*` tool counts too (never the app's own).
_OUTSIDE_FETCH = frozenset({"webfetch", "websearch"})
_FILE_READS = frozenset({"read", "grep"})
_PATH_KEYS = ("file_path", "path", "notebook_path")
_PATH_RE = re.compile(r'"(?:file_path|path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"')


def _network_names() -> frozenset:
    from securevector.core.egress.destinations import NETWORK_CAPABLE_BUILTINS

    return frozenset(NETWORK_CAPABLE_BUILTINS)


_OWN_PREFIX = "mcp__securevector__"
_OWN_TTL_S = 60.0
_own_cache: dict = {}


def _own_server(harness: Optional[str]) -> bool:
    """True when the `securevector` MCP server this harness runs is the
    entry the app registered. Cached briefly; a read error is not ours."""
    import time

    if not harness:
        return False
    hit = _own_cache.get(harness)
    now = time.monotonic()
    if hit and now - hit[0] < _OWN_TTL_S:
        return hit[1]
    try:
        from securevector.app.services import mcp_registration

        ours = mcp_registration.state(harness) == mcp_registration.REGISTERED
    except Exception:  # noqa: BLE001 - unknown means not the app's own
        ours = False
    _own_cache[harness] = (now, ours)
    return ours


def _skip(tool_name: Any, harness: Optional[str]) -> bool:
    """Names the rules never look at: empty, run-wide, host ids, the app's
    internal ids, and `mcp__securevector__*` only when that server is the
    one the app registered for this harness."""
    if not isinstance(tool_name, str):
        return True
    low = tool_name.strip().lower()
    if low.startswith(_OWN_PREFIX):
        return _own_server(harness)
    return rr._ineligible(tool_name)


def network_capable(tool_name: Any, harness: Optional[str] = None) -> bool:
    if _skip(tool_name, harness):
        return False
    low = tool_name.strip().lower()
    return low in _network_names() or low.startswith("mcp__")


def _is_shell(tool_name: Any) -> bool:
    low = str(tool_name or "").strip().lower()
    return low in _network_names() and low not in _OUTSIDE_FETCH


def _command_of(tool_input: Any) -> str:
    if isinstance(tool_input, str):
        try:
            tool_input = json.loads(tool_input)
        except (TypeError, ValueError):
            return tool_input
    if isinstance(tool_input, Mapping):
        for key in ("command", "cmd", "script"):
            value = tool_input.get(key)
            if isinstance(value, str):
                return value
    return ""


_UNPARSED_SEND = re.compile(
    r"\b(?:python[0-9.]*|node|perl|ruby|php)\s+-(?:c|e)\b"
    r"|\b(?:ssh|nc|ncat|socat|telnet|ftp|sftp|rsync)\b|\beval\b"
)


def shell_sends(tool_input: Any) -> bool:
    """True when a shell command has at least one network attempt that can
    send: any http or raw socket attempt, or a write (git push, scp to a
    remote). Package installs, git reads and commands with no attempt do
    not count. Commands the shell parser cannot read as network attempts
    (inline interpreters, remote shells, eval) count as able to send.
    In On mode a credential read through the shell is held by the
    synced-overrides marker; if that fetch times out the call is allowed."""
    from securevector.core.egress.destinations import WRITE, extract_from_bash

    command = _command_of(tool_input)
    if not command:
        return False
    if _UNPARSED_SEND.search(command):
        return True
    try:
        attempts = extract_from_bash(command).attempts or []
    except Exception:  # noqa: BLE001 - an unreadable command is not counted as sending
        return False
    for a in attempts:
        kind = getattr(a, "kind", None)
        if kind in ("http", "raw_socket"):
            return True
        if kind != "package" and getattr(a, "operation", None) == WRITE:
            return True
    return False


def sends(tool_name: Any, tool_input: Any, harness: Optional[str] = None) -> bool:
    """A network call that can send: a shell call only by what its command
    does; other network-capable tools by name, as before."""
    if not network_capable(tool_name, harness):
        return False
    return shell_sends(tool_input) if _is_shell(tool_name) else True


# The outside rule's network half: shell-family calls and MCP tools whose
# name carries a write verb. Read-only fetches arm the rule but do not
# trigger it.
WRITE_VERBS = frozenset({"create", "send", "post", "push", "upload", "comment", "update", "delete",
                         "write", "publish"})


def _write_verb(tool_part: str) -> bool:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", tool_part)
    for tok in re.split(r"[^a-z0-9]+", spaced.lower()):
        if tok and (tok in WRITE_VERBS or tok[:-1] in WRITE_VERBS or tok[:-2] in WRITE_VERBS):
            return True
    return False


def triggers_outside(tool_name: Any, harness: Optional[str] = None) -> bool:
    """A network-capable call that triggers the outside rule."""
    if not network_capable(tool_name, harness):
        return False
    low = tool_name.strip().lower()
    if low in _network_names():
        return low not in _OUTSIDE_FETCH
    rest = tool_name.strip()[5:]
    idx = rest.find("__")
    return _write_verb(rest[idx + 2:] if idx > 0 else rest)


def _stamp(now: datetime) -> str:
    return now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")


def _after(armed_at: Optional[str], cleared_at: Optional[str]) -> bool:
    return bool(armed_at) and (not cleared_at or str(armed_at) > str(cleared_at))


def armed(row: Optional[Mapping[str, Any]]) -> list:
    """Rule ids armed for a session row, in a fixed order."""
    if not row:
        return []
    out = []
    if _after(row.get("cred_read_at"), row.get("cleared_cred_at")):
        out.append(RULE_CRED_NET)
    if _after(row.get("outside_read_at"), row.get("cleared_outside_at")):
        out.append(RULE_OUTSIDE)
    return out


def justification(rules) -> str:
    return "Held by rule: " + "; ".join(RULE_NAMES[r] for r in rules if r in RULE_NAMES)


def rules_in(text: Optional[str]) -> list:
    """Rule ids named in a request's justification."""
    if not text or not str(text).startswith("Held by rule: "):
        return []
    return [rid for rid, name in RULE_NAMES.items() if name in text]


# --- what arms a rule ---------------------------------------------------------------


def _paths_in(preview: Optional[str]) -> list:
    if not preview:
        return []
    try:
        data = json.loads(preview)
    except (TypeError, ValueError):
        data = None
    if isinstance(data, dict):
        return [v for v in (data.get(k) for k in _PATH_KEYS) if isinstance(v, str) and v]
    return [m.group(1) for m in _PATH_RE.finditer(str(preview))]


def _canon(path: str) -> str:
    import sys

    out = os.path.normcase(os.path.realpath(path))
    return out.casefold() if sys.platform == "darwin" else out


def _outside_folder(path: str, workspace: str) -> bool:
    """Relative paths resolve against the folder; both sides are resolved
    through links, so `..` that leaves the folder counts as outside and a
    linked alias of the folder does not."""
    root_raw = os.path.expanduser(workspace)
    p = os.path.expanduser(path)
    if not os.path.isabs(p):
        p = os.path.join(root_raw, p)
    norm, root = _canon(p), _canon(root_raw)
    return not (norm == root or norm.startswith(root.rstrip(os.sep) + os.sep))


def outside_content(tool_name: Any, preview: Optional[str], workspace: Optional[str],
                    harness: Optional[str] = None) -> bool:
    """True for a call whose result is content from outside the task: a web
    fetch or search, any MCP tool (never the app's own), or a Read or Grep
    of a path outside the task folder. No folder: a Read never counts."""
    if _skip(tool_name, harness):
        return False
    low = tool_name.strip().lower()
    if low in _OUTSIDE_FETCH or low.startswith("mcp__"):
        return True
    if low in _FILE_READS and workspace:
        return any(_outside_folder(p, workspace) for p in _paths_in(preview))
    return False


def credential_read(preview: Optional[str]) -> bool:
    return bool(drift.location_matches(preview))


# --- mode -------------------------------------------------------------------------


async def session_mode(db, session_id: str, harness: Optional[str] = None) -> Optional[str]:
    """The mode the session started under (its rung row), else the agent
    tool's current mode; None when the tool has no mode row (Off)."""
    from securevector.app.database.repositories.response_rungs import ResponseRungsRepository
    from securevector.app.database.repositories.session_drift import SessionDriftRepository

    repo = ResponseRungsRepository(db)
    row = await repo.get(session_id)
    if row:
        return row.get("mode") or rr.MODE_SHADOW
    if not harness:
        drepo = SessionDriftRepository(db)
        task = await drepo.task_for_session(session_id) or {}
        harness = task.get("executor_id") or await drepo.session_harness(session_id)
    if not harness:
        return None
    mrow = await repo.mode_peek(harness)
    if mrow is None:
        return None
    if mrow.get("config_sig") != rr.config_signature():
        return rr.MODE_SHADOW
    return mrow.get("mode") or rr.MODE_SHADOW


async def _harness(db, session_id: str, hint: Optional[str]) -> str:
    from securevector.app.database.repositories.response_rungs import ResponseRungsRepository

    row = await ResponseRungsRepository(db).get(session_id)
    return (row or {}).get("harness") or hint or ""


# --- recording an event ---------------------------------------------------------------

OUTCOME_HELD = "held"
OUTCOME_WOULD = "would"
OUTCOME_OFF = "off"
OUTCOME_UNVERIFIED = "unverified"
_OUTCOME_TEXT = {
    OUTCOME_HELD: ("held", "block"),
    OUTCOME_WOULD: ("would have held", "log_only"),
    OUTCOME_OFF: ("recorded", "log_only"),
    OUTCOME_UNVERIFIED: ("not held, unverified session", "log_only"),
}


def _outcome(mode: Optional[str], hold: bool) -> str:
    if hold:
        return OUTCOME_HELD
    if mode == rr.MODE_ACTIVE:
        return OUTCOME_UNVERIFIED
    return OUTCOME_OFF if mode is None else OUTCOME_WOULD


async def _record(db, session_id: str, harness_hint: Optional[str], rules: list, mode: Optional[str],
                  outcome: str, now: datetime) -> None:
    """One rule event: the fired ids and one audit row. A hold row for held
    (On) and would-have (test mode) events only. Off and test mode clear
    what fired (one event per arming); an unverified session in On mode
    stays armed."""
    from securevector.app.database.repositories.call_rules import CallRulesRepository
    from securevector.app.database.repositories.custom_tools import CustomToolsRepository
    from securevector.app.database.repositories.response_rungs import ResponseRungsRepository

    repo = CallRulesRepository(db)
    stamp = _stamp(now)
    primary = rules[0]
    harness = await _harness(db, session_id, harness_hint)
    await repo.add_fired(session_id, rules, stamp)
    word, action = _OUTCOME_TEXT[outcome]
    preview = f"rule={primary} mode={mode or MODE_OFF}"
    if outcome == OUTCOME_UNVERIFIED:
        preview += " outcome=not_held_unverified"
    try:
        await CustomToolsRepository(db).log_tool_call_audit(
            TOOL_ID, primary, action,
            reason=f"{RULE_NAMES[primary]}: {word}. {RULE_WHY[primary]}.",
            args_preview=preview, runtime_kind=harness or None, session_id=session_id,
        )
    except Exception:  # noqa: BLE001 - the audit write never changes the decision
        logger.debug("call rule audit write failed", exc_info=True)
    if outcome in (OUTCOME_HELD, OUTCOME_WOULD):
        await ResponseRungsRepository(db).record_hold(
            session_id, harness, rr.MODE_ACTIVE if outcome == OUTCOME_HELD else rr.MODE_SHADOW,
            primary, rr._iso(now))
        # The agent tool's "stop the session and alert" switch, when on:
        # On mode stops the session, test mode records what it would do.
        from securevector.app.services import stop_switch

        await stop_switch.on_rule(db, session_id, harness, primary, now=now)
    if outcome in (OUTCOME_OFF, OUTCOME_WOULD):
        await repo.clear(session_id, stamp, cred=RULE_CRED_NET in rules, outside=RULE_OUTSIDE in rules)


async def _file(db, key: str, tool_name: Optional[str], runtime_kind: Optional[str], session_id: str,
                rules: list, now: datetime) -> tuple:
    """File (or join) the hold's request. Returns (request, new): new only
    when this call created it, so a merged retry writes no second event."""
    from securevector.app.database.repositories.call_rules import CallRulesRepository

    before = {r["id"] for r in await db.fetch_all(
        "SELECT id FROM jit_access_requests WHERE status = 'pending' AND session_id = ?", (session_id,)) or []}
    req = await rr.file_request(db, key, tool_name, runtime_kind, session_id, justification=justification(rules))
    await CallRulesRepository(db).touch_held(session_id, _stamp(now))
    return req, bool(req) and req.get("id") not in before


# --- decision points --------------------------------------------------------------------


async def check_network(db, tool_name: str, runtime_kind: Optional[str], session_id: Optional[str],
                        tool_input: Any = None, *, verified: bool, file: bool,
                        now: Optional[datetime] = None) -> Optional[str]:
    """A network-capable call the Guard allows. Returns the rule id when the
    call is held (On mode, verified session), else None. `file` is the
    Guard path: it files the request and records the event; without it
    (check_policy) nothing is written.

    The credential rule also reads this call's own input, so a single call
    that reads a credential location and sends it counts. Known limit: the
    rules see a call's audit row only after it ran, so two calls the agent
    issues together (a read and a fetch in one turn) can both pass before
    the first one arms anything."""
    from securevector.app.database.repositories.call_rules import CallRulesRepository
    from securevector.app.services.policy_check import tool_candidates

    if not session_id or not sends(tool_name, tool_input, runtime_kind):
        return None
    stored = armed(await CallRulesRepository(db).get(session_id))
    in_call = bool(tool_input) and credential_read(rr._input_text(tool_input))
    if RULE_OUTSIDE in stored and not (triggers_outside(tool_name, runtime_kind) or in_call):
        stored.remove(RULE_OUTSIDE)
    rules = list(stored)
    if in_call and RULE_CRED_NET not in rules:
        rules.insert(0, RULE_CRED_NET)
    if not rules:
        return None
    mode = await session_mode(db, session_id, runtime_kind)
    hold = mode == rr.MODE_ACTIVE and verified
    cands = tool_candidates(tool_name)
    key = (cands[0] if cands else tool_name).lower()
    # A session grant for the tool never lets one call read a credential
    # location and send it: the same-call check holds regardless.
    if not file:
        return rules[0] if hold else None
    now = now or datetime.now(timezone.utc)
    if hold:
        _req, new = await _file(db, key, tool_name, runtime_kind, session_id, rules, now)
        if new:
            await _record(db, session_id, runtime_kind, rules, mode, OUTCOME_HELD, now)
        return rules[0]
    await _record(db, session_id, runtime_kind, rules, mode, _outcome(mode, False), now)
    return None


async def note_call(db, tool_name: Optional[str], session_id: Optional[str], action: Optional[str],
                    args_preview: Optional[str] = None, runtime_kind: Optional[str] = None,
                    now: Optional[datetime] = None) -> None:
    """At the call's audit row: arm the rules, and record a credential read
    that came while the outside rule was armed and was not held. Never
    raises."""
    from securevector.app.database.repositories.call_rules import CallRulesRepository
    from securevector.app.database.repositories.session_drift import SessionDriftRepository

    if not tool_name or not session_id or action == "block" or _skip(tool_name, runtime_kind):
        return
    try:
        cred = credential_read(args_preview)
        low = tool_name.strip().lower()
        workspace = None
        if low in _FILE_READS and _paths_in(args_preview):
            task = await SessionDriftRepository(db).task_for_session(session_id) or {}
            workspace = task.get("workspace")
        outside = outside_content(tool_name, args_preview, workspace, runtime_kind)
        if not (cred or outside):
            return
        now = now or datetime.now(timezone.utc)
        repo = CallRulesRepository(db)
        # A network-capable call was decided at the egress check.
        if cred and not sends(tool_name, args_preview, runtime_kind) \
                and RULE_OUTSIDE in armed(await repo.get(session_id)):
            mode = await session_mode(db, session_id, runtime_kind)
            await _record(db, session_id, runtime_kind, [RULE_OUTSIDE], mode, _outcome(mode, False), now)
        await repo.mark(session_id, _stamp(now + timedelta(microseconds=1)), cred=cred, outside=outside)
    except Exception:  # noqa: BLE001 - the rule state never breaks the audit write
        logger.debug("call rule note failed", exc_info=True)


def marker_for(session_id: str) -> dict:
    """The Guard marker row for a credential read under the outside rule:
    the credential paths and keys, no tool-novelty check, no grants."""
    return {
        "tool_id": rr.MARKER_ID, "effect": rr.MARKER_EFFECT, "priority": 0, "policy_id": "_call_rule",
        "policy_name": "Call rule", "policy_version": 0, "org_name": "Local",
        "reason": HOLD_CREDENTIAL, "source": rr.MARKER_SOURCE, "session_id": session_id,
        "rule": RULE_OUTSIDE,
        "step_up": {**rr.marker_patterns(), "known_tools": None, "granted": []},
    }


async def marker_row(db, session_id: Optional[str], http_request=None, runtime: Optional[str] = None,
                     verified: Optional[bool] = None) -> Optional[dict]:
    """The marker when the outside rule is armed, the session is in On mode
    and verified; else None. One primary-key read when nothing is armed."""
    from securevector.app.database.repositories.call_rules import CallRulesRepository

    if not session_id:
        return None
    if RULE_OUTSIDE not in armed(await CallRulesRepository(db).get(session_id)):
        return None
    if await session_mode(db, session_id, runtime) != rr.MODE_ACTIVE:
        return None
    if verified is None:
        from securevector.app.server.routes.egress import _session_binding

        _sid, verified = await _session_binding(http_request, session_id)
    return marker_for(session_id) if verified else None


async def file_marker_hold(db, session_id: Optional[str], tool_id: str, function_name: Optional[str],
                           runtime_kind: Optional[str], *, verified: bool, now: Optional[datetime] = None):
    """The Guard's request for a call the marker held. Returns (handled,
    request): handled when the session is verified and the outside rule is
    armed in On mode. A request joined by a retry writes no second event."""
    from securevector.app.database.repositories.call_rules import CallRulesRepository

    if not session_id or not verified or _skip(tool_id, runtime_kind):
        return False, None
    if RULE_OUTSIDE not in armed(await CallRulesRepository(db).get(session_id)):
        return False, None
    mode = await session_mode(db, session_id, runtime_kind)
    if mode != rr.MODE_ACTIVE:
        return False, None
    now = now or datetime.now(timezone.utc)
    req, new = await _file(db, tool_id, function_name, runtime_kind, session_id, [RULE_OUTSIDE], now)
    if new:
        await _record(db, session_id, runtime_kind, [RULE_OUTSIDE], mode, OUTCOME_HELD, now)
    return True, req


async def on_approved(db, request: Optional[Mapping[str, Any]], now: Optional[datetime] = None) -> None:
    """An approved request for a session clears every rule that was armed
    before the request was filed or last joined by a held call, whatever
    filed it (a rule, a step-up, a joined retry). A read after that re-arms.
    Never raises."""
    from securevector.app.database.repositories.call_rules import CallRulesRepository

    try:
        # Only holds (step-up and rule requests); a plain tool request's
        # session id is not checked when it is filed.
        if not request or not request.get("session_id") or request.get("rule_source") != rr.RUNG_SOURCE:
            return
        sid = request["session_id"]
        repo = CallRulesRepository(db)
        row = await repo.get(sid)
        rules = armed(row)
        if not rules:
            return
        marks = [t for t in (rr._parse(request.get("requested_at")), rr._parse(row.get("last_held_at"))) if t]
        if not marks:
            return
        cutoff = max(marks) + timedelta(seconds=1)   # requested_at has whole seconds

        def upto(key):
            at = rr._parse(row.get(key))
            return row.get(key) if at and at <= cutoff else None

        await repo.clear_to(
            sid, _stamp(now or datetime.now(timezone.utc)),
            cred_at=upto("cred_read_at") if RULE_CRED_NET in rules else None,
            outside_at=upto("outside_read_at") if RULE_OUTSIDE in rules else None)
    except Exception:  # noqa: BLE001 - the approval stands either way
        logger.debug("call rule clear failed", exc_info=True)


def why(rules) -> str:
    """The session's Why line for fired rules, plain names first."""
    return ". ".join(RULE_WHY[r] for r in rules if r in RULE_WHY)
