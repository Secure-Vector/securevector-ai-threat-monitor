"""
Pre-flight policy checks: `check_policy` and `session_burn`.

The app decides; a decision token records a decision. Enforcement in the
Guard's egress check re-evaluates every call. In this release the token is
consumed for metrics only: a matching token never skips evaluation
(`DECISION_TOKEN_FAST_PATH` is off).

**Decision.** Most restrictive wins across the tool-permission tiers (the
same merged view the Guard hooks read, then the essential registry), the
egress engine (control API first) and active session grants. `prompt`
maps to `needs_approval`. Every failure is `indeterminate`, never `allow`.

**Response.** A fixed shape with every field present. No rule id, rule
text, tier, grant state or target existence ever appears in it, so a
denied target and an absent one answer with the same bytes.

**Token.** `svd1.<jti>.<tag>`: `jti` is 16 hex, `tag` is the first 16 bytes
of HMAC-SHA256 (base64url, unpadded) over
`jti|session|action_hash|target_hash|policy_version|decision|exp`. The key
is 32 random bytes held in memory, rotated every 24 h with the previous key
honoured for 120 s; a restart invalidates every outstanding token. Minted on
`allow` and `needs_approval` only, valid 120 s, single use. The stored row
is the authority; the tag rejects a forged string before any lookup.
"""

from __future__ import annotations

import asyncio
import base64
import calendar
import hashlib
import hmac
import json
import logging
import re
import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

from securevector.app.database.repositories.policy_decisions import PolicyDecisionsRepository, iso
from securevector.core.egress.canonical import OTHER, CanonicalAction, UnsupportedAction, canonical_action

logger = logging.getLogger(__name__)

ALLOW = "allow"
DENY = "deny"
NEEDS_APPROVAL = "needs_approval"
INDETERMINATE = "indeterminate"

R_ALLOWED = "allowed"
R_BLOCKED = "blocked_by_policy"
R_APPROVAL = "approval_required"
R_UNAVAILABLE = "unavailable"
R_UNSUPPORTED = "unsupported_action"
REASON_FOR = {ALLOW: R_ALLOWED, DENY: R_BLOCKED, NEEDS_APPROVAL: R_APPROVAL}

TOKEN_TTL_S = 120
KEY_ROTATE_S = 24 * 3600
PREVIOUS_KEY_GRACE_S = 120
ATTEMPT_AFTER_DENY_S = 600
OBSERVED_LINK_WINDOW_S = 600
SESSION_IDLE_S = 24 * 3600
RESPONSE_CAP = 1024
BURN_LAG_S = 30

# Off in 6.1.0: a matched token is recorded, enforcement still runs in full.
DECISION_TOKEN_FAST_PATH = False

HANDLE_RE = re.compile(r"^svs_[0-9a-f]{16}$")
TOKEN_RE = re.compile(r"^svd1\.([0-9a-f]{16})\.([A-Za-z0-9_-]{22})$")
_HARNESS_SESSION_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_ENDED_STATUSES = ("exited", "stopped", "interrupted", "failed")

# Harness-native PreToolUse names the Guard's tool-permission rules key off.
# Mirrors lib/normalize.js in the Claude Code plugin.
_BUILTIN_TOOLS = frozenset({
    "Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "NotebookRead", "Glob", "Grep",
    "LS", "LSP", "Bash", "PowerShell", "WebFetch", "WebSearch", "Task", "Agent",
    "ExitPlanMode", "EnterPlanMode", "EnterWorktree", "ExitWorktree", "Skill", "Monitor",
    "TodoWrite", "TodoRead",
})
_EFFECT_TO_DECISION = {"allow": ALLOW, "deny": DENY, "prompt": NEEDS_APPROVAL}
_STRICTNESS = {ALLOW: 0, NEEDS_APPROVAL: 1, DENY: 2}


# --- key ring and tokens ------------------------------------------------------------


class KeyRing:
    """HMAC keys in process memory only. Never written anywhere."""

    def __init__(self, clock: Callable[[], float] = time.time):
        self.clock = clock
        self.started_at = clock()
        self._current = (secrets.token_bytes(32), self.started_at)
        self._previous: Optional[tuple] = None

    def _rotate_if_due(self) -> None:
        now = self.clock()
        if now - self._current[1] >= KEY_ROTATE_S:
            self._previous = (self._current[0], now)
            self._current = (secrets.token_bytes(32), now)

    def current(self) -> bytes:
        self._rotate_if_due()
        return self._current[0]

    def valid_keys(self) -> list:
        self._rotate_if_due()
        keys = [self._current[0]]
        if self._previous and self.clock() - self._previous[1] <= PREVIOUS_KEY_GRACE_S:
            keys.append(self._previous[0])
        return keys


KEYRING = KeyRing()


def _token_message(jti: str, session: str, action_hash: str, target_hash: str,
                   policy_version: str, decision: str, exp: int) -> bytes:
    return "|".join([jti, session, action_hash, target_hash, policy_version or "",
                     decision, str(int(exp))]).encode("utf-8")


def _tag(key: bytes, msg: bytes) -> str:
    return base64.urlsafe_b64encode(hmac.new(key, msg, hashlib.sha256).digest()[:16]).rstrip(b"=").decode()


def mint_token(jti: str, session: str, action_hash: str, target_hash: str,
               policy_version: str, decision: str, exp: int, ring: Optional[KeyRing] = None) -> str:
    ring = ring or KEYRING
    msg = _token_message(jti, session, action_hash, target_hash, policy_version, decision, exp)
    return f"svd1.{jti}.{_tag(ring.current(), msg)}"


def parse_token(token: Any) -> Optional[tuple]:
    """(jti, tag) for a well-formed token string, else None."""
    if not isinstance(token, str):
        return None
    m = TOKEN_RE.match(token)
    return (m.group(1), m.group(2)) if m else None


def _epoch(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    try:
        return calendar.timegm(time.strptime(value, "%Y-%m-%dT%H:%M:%S"))
    except (ValueError, TypeError):
        return None


def token_matches_row(token: str, row: dict, ring: Optional[KeyRing] = None) -> bool:
    """True when `token` carries a valid tag for this stored row under a key
    this process still honours."""
    ring = ring or KEYRING
    parsed = parse_token(token)
    if not parsed or parsed[0] != row.get("jti"):
        return False
    exp = _epoch(row.get("expires_at"))
    if exp is None:
        return False
    msg = _token_message(row["jti"], row["session"], row["action_hash"], row["target_hash"],
                         row.get("policy_version") or "", row["decision"], exp)
    given = parsed[1].encode()
    return any(hmac.compare_digest(_tag(k, msg).encode(), given) for k in ring.valid_keys())


# --- rate limit -----------------------------------------------------------------------


class RateLimiter:
    """Per session 60 a minute with a burst of 10 in 10 s; per device 300 a
    minute. Same sliding-window shape as the MCP server's limiter."""

    def __init__(self, per_minute: int = 60, burst: int = 10, device_per_minute: int = 300,
                 clock: Callable[[], float] = time.monotonic):
        self.per_minute, self.burst, self.device_per_minute = per_minute, burst, device_per_minute
        self.clock = clock
        self._by_key: dict = defaultdict(deque)
        self._device: deque = deque()

    def allow(self, key: str) -> bool:
        now = self.clock()
        q = self._by_key[key or "-"]
        for dq in (q, self._device):
            while dq and dq[0] <= now - 60:
                dq.popleft()
        if len(self._device) >= self.device_per_minute or len(q) >= self.per_minute:
            return False
        if sum(1 for t in q if t > now - 10) >= self.burst:
            return False
        q.append(now)
        self._device.append(now)
        if len(self._by_key) > 4096:
            for k in [k for k, v in self._by_key.items() if not v]:
                self._by_key.pop(k, None)
        return True


CHECK_LIMITER = RateLimiter()
BURN_LIMITER = RateLimiter()
_trip_audited: dict = {}


# --- caller identity ---------------------------------------------------------------------


@dataclass
class Caller:
    """Who is asking. `verified` only when the request carried a launched
    task's own hook token; `refused` when a token was sent and did not match."""

    task_id: Optional[str] = None
    verified: bool = False
    refused: bool = False
    harness: Optional[str] = None
    harness_session_id: Optional[str] = None
    task_ended: bool = False
    cwd: Optional[str] = None


async def caller_from_headers(manager, headers, harness: Optional[str], cwd: Optional[str]) -> Caller:
    """Verify X-SV-Terminal-Task / X-SV-Terminal-Hook against the terminal
    manager the same way the egress session binding does."""
    caller = Caller(harness=_clean_harness(harness), cwd=_clean_cwd(cwd))
    task_id = (headers.get("x-sv-terminal-task") or "") if headers is not None else ""
    token = (headers.get("x-sv-terminal-hook") or "") if headers is not None else ""
    if not task_id and not token:
        return caller
    if manager is None:
        caller.refused = True
        return caller
    try:
        expected = manager.hook_token(task_id) if task_id else None
        if expected and token and secrets.compare_digest(
            token.encode("utf-8", "surrogateescape"), expected.encode("utf-8")
        ):
            task = await manager.store.get_task(task_id)
            if task:
                caller.task_id = task_id
                caller.verified = True
                caller.harness = task.get("executor_id") or caller.harness
                caller.harness_session_id = task.get("session_id")
                caller.task_ended = bool(task.get("ended_at")) or task.get("status") in _ENDED_STATUSES
                return caller
    except Exception as e:  # noqa: BLE001 - refused is the safe answer
        logger.warning("Pre-flight caller check failed: %s", type(e).__name__)
    caller.refused = True
    return caller


def _clean_harness(value: Optional[str]) -> Optional[str]:
    if isinstance(value, str) and re.match(r"^[a-z0-9-]{1,32}$", value):
        return value
    return None


def _clean_cwd(value: Optional[str]) -> Optional[str]:
    if isinstance(value, str) and value.startswith("/") and len(value) <= 4096 and "\x00" not in value:
        return value.rstrip("/") or "/"
    return None


def _cwd_hash(cwd: Optional[str]) -> Optional[str]:
    return hashlib.sha256(cwd.encode("utf-8", "surrogateescape")).hexdigest()[:16] if cwd else None


# --- logical sessions -------------------------------------------------------------------


def _session_usable(row: dict, caller: Caller, now: float) -> bool:
    if not row or row.get("closed_at"):
        return False
    last = _epoch(row.get("last_seen_at"))
    if last is not None and now - last > SESSION_IDLE_S:
        return False
    if row.get("binding") == "verified":
        return caller.verified and caller.task_id == row.get("task_id")
    return not caller.verified and not caller.refused


async def _observed_link(db, repo: PolicyDecisionsRepository, caller: Caller, now: float) -> Optional[str]:
    """The newest unclaimed Guard-reported session of the same harness in the
    same folder, active within the last ten minutes."""
    if not caller.harness or not caller.cwd:
        return None
    try:
        from securevector.app.terminals.store import TerminalStore

        offers = await TerminalStore(db).unlinked_sessions(window_hours=1, limit=20)
        claimed = await repo.claimed_harness_sessions()
    except Exception as e:  # noqa: BLE001 - unlinked is the safe answer
        logger.debug("Observed session link failed: %s", type(e).__name__)
        return None
    cutoff = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(now - OBSERVED_LINK_WINDOW_S))
    for offer in offers:
        if offer.get("runtime_kind") != caller.harness or offer.get("session_id") in claimed:
            continue
        if str(offer.get("last_at") or "") < cutoff:
            continue
        ws = (offer.get("workspace") or "").rstrip("/") or None
        if ws and ws == caller.cwd:
            return offer["session_id"]
    return None


async def resolve_session(db, caller: Caller, handle: Optional[str], *, now: Optional[float] = None) -> dict:
    """Reuse the caller's handle when it is still theirs, otherwise mint a
    new one. A handle is bound to how it was first verified and never moves
    between tasks."""
    now = time.time() if now is None else now
    repo = PolicyDecisionsRepository(db)
    stamp = iso(now)
    if isinstance(handle, str) and HANDLE_RE.match(handle):
        row = await repo.get_session(handle)
        if row and not row.get("closed_at") and row.get("binding") == "verified" and caller.task_ended \
                and caller.task_id == row.get("task_id"):
            await repo.close_session(handle, stamp)
            row = None
        if row and _session_usable(row, caller, now):
            sid, binding = None, None
            if row["binding"] == "verified" and caller.harness_session_id:
                sid = caller.harness_session_id
            elif row["binding"] == "unlinked":
                sid = await _observed_link(db, repo, caller, now)
                binding = "observed" if sid else None
            await repo.touch_session(handle, stamp, harness_session_id=sid, binding=binding)
            return await repo.get_session(handle) or row
    if caller.verified:
        binding, sid = "verified", caller.harness_session_id
    elif caller.refused:
        binding, sid = "unlinked", None
    else:
        sid = await _observed_link(db, repo, caller, now)
        binding = "observed" if sid else "unlinked"
    return await repo.create_session(
        handle="svs_" + secrets.token_hex(8), harness=caller.harness, cwd_hash=_cwd_hash(caller.cwd),
        task_id=caller.task_id if caller.verified else None, harness_session_id=sid,
        binding=binding, now=stamp,
    )


# --- the decision -------------------------------------------------------------------------


def tool_candidates(tool_name: str) -> list:
    """Port of the Guard's normalize(): `mcp__server__tool` gives
    [`server:tool`, `tool`]; a built-in gives itself; anything else none."""
    if not isinstance(tool_name, str) or not tool_name:
        return []
    if tool_name.startswith("mcp__"):
        rest = tool_name[5:]
        idx = rest.find("__")
        if idx <= 0 or idx + 2 >= len(rest):
            return []
        return [f"{rest[:idx]}:{rest[idx + 2:]}", rest[idx + 2:]]
    return [tool_name] if tool_name in _BUILTIN_TOOLS else []


def decide_from_overrides(candidates: list, rows: list, session_id: Optional[str]) -> tuple:
    """(decision, explicit) from the merged tool-permission rows, first seen
    wins per lower-cased tool id, as the Guard hooks decide."""
    if not candidates or not rows:
        return ALLOW, False
    by_id: dict = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("tool_id"), str):
            continue
        if row.get("source") == "jit_grant" and row.get("session_id") and row.get("session_id") != session_id:
            continue
        if row.get("source") == "rung_marker":  # read by its own check, never a rule
            continue
        by_id.setdefault(row["tool_id"].lower(), row)
    run_row = by_id.get("*")
    if run_row:
        mapped = _EFFECT_TO_DECISION.get(run_row.get("effect"))
        if mapped and mapped != ALLOW:
            return mapped, True
    for cand in candidates:
        match = by_id.get(cand.lower())
        if not match:
            continue
        # A response rung row holds an allowed call for approval. Not
        # explicit, so the registry tier below still applies to the tool.
        if match.get("source") == "rung":
            return NEEDS_APPROVAL, False
        mapped = _EFFECT_TO_DECISION.get(match.get("effect"))
        if not mapped:
            return ALLOW, True
        return mapped, True
    return ALLOW, False


def _strictest(*decisions: str) -> str:
    return max(decisions, key=lambda d: _STRICTNESS.get(d, 2))


async def _tool_rows(harness: Optional[str], harness_session_id: Optional[str]) -> list:
    from securevector.app.server.routes import tool_permissions as tp

    data = await tp.get_synced_overrides(runtime=harness, session_id=harness_session_id)
    return list((data or {}).get("synced") or [])


async def _enforcement_on(db) -> bool:
    from securevector.app.database.repositories.settings import SettingsRepository

    try:
        return bool((await SettingsRepository(db).get()).tool_permissions_enabled)
    except Exception:  # noqa: BLE001 - enforcement-on is the restrictive default
        return True


def _essential_decision(tool_name: str, candidates: list) -> str:
    """The essential registry tier, below synced and local rules. It applies
    to MCP tools only, matched exactly: a harness built-in keeps its own
    default (allow), as on the Tool Permissions page, even where a registry
    id for another runtime shares its name."""
    from securevector.app.server.routes import tool_permissions as tp

    if not tool_name.startswith("mcp__"):
        return ALLOW
    registry = tp._get_registry() or {}
    for cand in candidates:
        meta = registry.get(cand)
        if meta and str(meta.get("default_permission", "allow")).lower() == "block":
            return DENY
    return ALLOW


def _last_resort(candidates: list) -> bool:
    from securevector.app.rules.last_resort import matches_last_resort

    return any(matches_last_resort(c) is not None for c in candidates)


async def policy_version(db, harness: Optional[str], harness_session_id: Optional[str],
                         egress_policy=None, tool_rows: Optional[list] = None) -> str:
    """Hash of the loaded egress policy and the tool-permission rows in force
    for this harness and session. Any change invalidates outstanding tokens."""
    from securevector.app.database.repositories.egress import EgressRepository
    from securevector.app.server.routes.egress import _load_policy

    if egress_policy is None:
        egress_policy = await _load_policy(EgressRepository(db))
    if tool_rows is None:
        tool_rows = await _tool_rows(harness, harness_session_id)
    material = {
        "egress": {
            "preset": egress_policy.preset, "allowlist": sorted(egress_policy.allowlist or []),
            "denylist": sorted(egress_policy.denylist or []), "fail_closed": bool(egress_policy.fail_closed),
            "baseline": bool(egress_policy.baseline_enabled), "version": egress_policy.policy_version,
            "source": egress_policy.source,
        },
        "tools": sorted(json.dumps(r, sort_keys=True, default=str) for r in tool_rows),
    }
    digest = hashlib.sha256(json.dumps(material, sort_keys=True, default=str).encode()).hexdigest()
    return "pv_" + digest[:16]


class Unknowable(Exception):
    """A fact enforcement would use cannot be known before the call."""


_MCP_NAME_RE = re.compile(r"[^A-Za-z0-9_-]")


def _resolve_mcp_endpoint(harness: Optional[str], cwd: Optional[str], tool_name: str) -> Optional[str]:
    """The network endpoint of the MCP server a `mcp__server__tool` call
    goes to, from the harness's own config (project scope first, then user
    scope). None for a local (stdio) server. Raises Unknowable when the
    server is not found, so the answer is never a guess."""
    from securevector.app.services import config_trust_scan as scan

    server = tool_candidates(tool_name)[0].split(":", 1)[0]
    if scan.OWN_MARKER in server.lower():
        return None
    if not harness:
        raise Unknowable("harness")
    want = _MCP_NAME_RE.sub("_", server)
    for workspace in ([cwd] if cwd else []) + [None]:
        try:
            found = scan.scan_scope(harness, workspace)
        except Exception as e:  # noqa: BLE001
            raise Unknowable("scan") from e
        for srv in found.servers:
            if _MCP_NAME_RE.sub("_", srv.name) == want:
                return srv.url if srv.transport in ("http", "sse") else None
    raise Unknowable("server")


def _git_host(value: Any) -> Optional[str]:
    from securevector.app.server.routes.egress import _normalize_host

    return _normalize_host(value) if isinstance(value, str) else None


async def decide(db, tool_name: str, tool_input: dict, *, harness: Optional[str],
                 harness_session_id: Optional[str], verified: bool,
                 app_port: Optional[int] = None, origin_git_host: Optional[str] = None,
                 mcp_endpoint: Optional[str] = None, cwd: Optional[str] = None) -> tuple:
    """(decision, policy_version). Raises on any failure, and Unknowable
    when a fact enforcement uses cannot be known; the caller turns both into
    `indeterminate`."""
    from securevector.app.database.repositories.egress import EgressRepository
    from securevector.app.database.repositories.jit_access import JitAccessRepository
    from securevector.app.server.routes.egress import _grantable_session, _load_policy, _pack
    from securevector.core.egress import BLOCK, EgressContext, evaluate_tool_call

    repo = EgressRepository(db)
    egress_policy = await _load_policy(repo)
    rows = await _tool_rows(harness, harness_session_id)
    version = await policy_version(db, harness, harness_session_id, egress_policy, rows)

    candidates = tool_candidates(tool_name)
    tool_decision, explicit = decide_from_overrides(candidates, rows, harness_session_id)
    # Response rung 3, active mode: the per-call marker check the Guard hook
    # runs on an allowed call (dangerous path or key in the input, a tool the
    # baseline has not seen that no row names). Same function, same rows.
    if candidates and tool_decision == ALLOW:
        from securevector.app.services import response_rungs

        marker = response_rungs.find_marker(rows, harness_session_id)
        if marker and response_rungs.marker_kind(tool_name, tool_input, marker, explicit):
            tool_decision = NEEDS_APPROVAL
    if await _enforcement_on(db):
        if _last_resort(candidates):
            tool_decision = DENY
        elif not explicit:
            tool_decision = _strictest(tool_decision, _essential_decision(tool_name, candidates))

    if tool_name.startswith("mcp__") and not mcp_endpoint and tool_decision != DENY:
        mcp_endpoint = await asyncio.to_thread(_resolve_mcp_endpoint, harness, cwd, tool_name)
    ctx = EgressContext(runtime_kind=harness, session_id=harness_session_id, local_app_port=app_port,
                        origin_git_host=_git_host(origin_git_host))
    if egress_policy.preset == "hardened":
        ctx.known_hosts = await repo.known_hosts()
    if verified and _grantable_session(egress_policy, harness_session_id):
        grants = await JitAccessRepository(db).active_host_grants(harness_session_id, harness)
        ctx.host_grants = {h: g["id"] for h, g in grants.items()}
    endpoint = mcp_endpoint if isinstance(mcp_endpoint, str) and len(mcp_endpoint) <= 2048 else None
    evaluation = evaluate_tool_call(tool_name, tool_input or {}, egress_policy, ctx,
                                    mcp_endpoint=endpoint, pack=_pack())
    egress_decision = DENY if evaluation.action == BLOCK else ALLOW
    # Response rung 3, active mode: the same step-up check the Guard's
    # egress path runs, without filing a request (a check is a question).
    if tool_decision == ALLOW and egress_decision == ALLOW and evaluation.network_capable:
        from securevector.app.services import response_rungs

        if await response_rungs.check_call(
            db, tool_name, tool_input or {}, harness, harness_session_id,
            [v.attempt.host for v in evaluation.verdicts], file=False,
        ):
            egress_decision = NEEDS_APPROVAL
    return _strictest(tool_decision, egress_decision), version


def response(decision: str, reason: str, *, session: Optional[str], policy_version: Optional[str] = None,
             token: Optional[str] = None, expires_at: Optional[str] = None) -> dict:
    """The one response shape. Every field always present."""
    body = {
        "decision": decision,
        "reason": reason,
        "policy_version": policy_version,
        "token": token,
        "expires_at": expires_at,
        "session": session,
        "advisory": False,
    }
    if len(json.dumps(body, separators=(",", ":"))) > RESPONSE_CAP:
        body.update(token=None, expires_at=None, policy_version=None)
    return body


async def _audit(db, handle: Optional[str], decision: str, reason: str, tool_name: Any, tool_input: Any) -> None:
    from securevector.app.database.repositories.custom_tools import CustomToolsRepository

    action = {ALLOW: "allow", DENY: "block"}.get(decision, "log_only")
    try:
        preview = json.dumps({"tool_name": tool_name, "tool_input": tool_input}, default=str)[:8192]
    except (TypeError, ValueError):
        preview = None
    try:
        await CustomToolsRepository(db).log_tool_call_audit(
            tool_id="check_policy", function_name="check_policy", action=action,
            reason=f"check_policy: {decision} ({reason})", args_preview=preview,
            runtime_kind="mcp", session_id=handle,
        )
    except Exception as e:  # noqa: BLE001 - the answer stands; the audit is best effort
        logger.warning("Pre-flight audit write failed: %s", type(e).__name__)


async def check(db, caller: Caller, tool_name: Any, tool_input: Any, handle: Optional[str], *,
                app_port: Optional[int] = None, limiter: Optional[RateLimiter] = None,
                ring: Optional[KeyRing] = None, now: Optional[float] = None,
                origin_git_host: Optional[str] = None, mcp_endpoint: Optional[str] = None) -> dict:
    """Answer one check_policy call. Never raises."""
    limiter = limiter or CHECK_LIMITER
    ring = ring or KEYRING
    now = time.time() if now is None else now
    # Keyed on the task (verified) or harness and folder, so leaving the
    # handle out does not start a fresh allowance.
    key = caller.task_id if caller.verified else f"u:{caller.harness}:{_cwd_hash(caller.cwd)}"
    if not limiter.allow(key):
        given = handle if isinstance(handle, str) and HANDLE_RE.match(handle) else None
        # One audit row per key per minute while the limit holds.
        last = _trip_audited.get(key)
        if last is None or now - last >= 60:
            _trip_audited[key] = now
            if len(_trip_audited) > 4096:
                _trip_audited.clear()
            await _audit(db, given, INDETERMINATE, R_UNAVAILABLE, tool_name, tool_input)
        return response(INDETERMINATE, R_UNAVAILABLE, session=given)
    try:
        session = await resolve_session(db, caller, handle, now=now)
    except Exception as e:  # noqa: BLE001
        logger.warning("Pre-flight session lookup failed: %s", type(e).__name__)
        return response(INDETERMINATE, R_UNAVAILABLE, session=None)
    sh = session.get("handle")
    repo = PolicyDecisionsRepository(db)

    async def record(decision: str, reason: str, action: Optional[CanonicalAction], version=None,
                     exp: Optional[int] = None) -> str:
        jti = secrets.token_hex(8)
        try:
            await repo.insert_decision({
                "jti": jti, "session": sh, "task_id": session.get("task_id"),
                "action_kind": action.kind if action else OTHER,
                "tool_name": tool_name[:256] if isinstance(tool_name, str) else None,
                "action_hash": action.action_hash if action else "",
                "target_hash": action.target_hash if action else "",
                "decision": decision, "reason": reason, "policy_version": version,
                "issued_at": iso(now), "expires_at": iso(exp) if exp else None,
            })
        except Exception as e:  # noqa: BLE001
            logger.warning("Pre-flight decision row failed: %s", type(e).__name__)
        await _audit(db, sh, decision, reason, tool_name, tool_input)
        return jti

    try:
        action = canonical_action(tool_name, tool_input)
    except UnsupportedAction:
        await record(INDETERMINATE, R_UNSUPPORTED, None)
        return response(INDETERMINATE, R_UNSUPPORTED, session=sh)
    try:
        decision, version = await decide(
            db, tool_name, tool_input or {}, harness=session.get("harness") or caller.harness,
            harness_session_id=session.get("harness_session_id"),
            verified=session.get("binding") == "verified", app_port=app_port,
            origin_git_host=origin_git_host, mcp_endpoint=mcp_endpoint, cwd=caller.cwd,
        )
    except Unknowable:
        await record(INDETERMINATE, R_UNAVAILABLE, action)
        return response(INDETERMINATE, R_UNAVAILABLE, session=sh)
    except Exception as e:  # noqa: BLE001 - unavailable, never allow
        logger.warning("Pre-flight evaluation failed: %s", type(e).__name__)
        await record(INDETERMINATE, R_UNAVAILABLE, action)
        return response(INDETERMINATE, R_UNAVAILABLE, session=sh)
    reason = REASON_FOR[decision]
    if decision == DENY:
        await record(decision, reason, action, version)
        return response(decision, reason, session=sh, policy_version=version)
    exp = int(now) + TOKEN_TTL_S
    jti = await record(decision, reason, action, version, exp)
    token = mint_token(jti, sh, action.action_hash, action.target_hash, version, decision, exp, ring)
    return response(decision, reason, session=sh, policy_version=version, token=token, expires_at=iso(exp))


# --- consumption in the Guard's egress check ---------------------------------------------


async def consume_for_call(db, tool_name: str, tool_input: Any, *, task_id: Optional[str],
                           verified: bool, harness: Optional[str], harness_session_id: Optional[str],
                           ring: Optional[KeyRing] = None, now: Optional[float] = None) -> Optional[dict]:
    """Match a real tool call against recent pre-flight decisions of its
    session. Records the outcome on the row; never changes the verdict.

    Returns None when there is nothing to match, else
    {"result", "decision"}. Results: matched, replayed, expired,
    policy_changed, restarted (issued before this app process started, so its
    key is gone), unverified, unsupported, attempted_after_deny, and
    approved_after_deny (a deny followed by a JIT approval: not counted).
    """
    ring = ring or KEYRING
    now = time.time() if now is None else now
    try:
        action = canonical_action(tool_name, tool_input)
    except UnsupportedAction:
        return None
    repo = PolicyDecisionsRepository(db)
    handles = []
    if verified and task_id:
        handles = await repo.handles_for_task(task_id)
    elif harness_session_id:
        # A call not bound by the task's hook token never touches a verified
        # session's decisions.
        handles = await repo.handles_for_harness_session(harness_session_id, unverified_only=True)
    if not handles:
        return None
    rows = await repo.recent_for_action(handles, action.action_hash, iso(now - ATTEMPT_AFTER_DENY_S))
    if not rows:
        return None
    newest = rows[0]
    if newest["decision"] == DENY:
        if await repo.approved_since(harness_session_id, harness, newest["issued_at"]):
            return {"result": "approved_after_deny", "decision": DENY}
        await repo.mark_attempted_after_deny(newest["jti"])
        return {"result": "attempted_after_deny", "decision": DENY}
    row = next((r for r in rows if r["decision"] in (ALLOW, NEEDS_APPROVAL)), None)
    if row is None:
        return None
    if action.kind == OTHER:
        await repo.set_result(row["jti"], "unsupported")
        return {"result": "unsupported", "decision": row["decision"]}
    if row.get("consumed_at"):
        return {"result": "replayed", "decision": row["decision"]}
    if not verified:
        await repo.set_result(row["jti"], "unverified")
        return {"result": "unverified", "decision": row["decision"]}
    exp = _epoch(row.get("expires_at"))
    if exp is None or now > exp:
        await repo.set_result(row["jti"], "expired")
        return {"result": "expired", "decision": row["decision"]}
    if (_epoch(row.get("issued_at")) or 0) < int(ring.started_at):
        await repo.set_result(row["jti"], "restarted")
        return {"result": "restarted", "decision": row["decision"]}
    if row["target_hash"] != action.target_hash:
        await repo.set_result(row["jti"], "mismatch")
        return {"result": "mismatch", "decision": row["decision"]}
    current = await policy_version(db, harness, harness_session_id)
    if current != row.get("policy_version"):
        await repo.set_result(row["jti"], "policy_changed")
        return {"result": "policy_changed", "decision": row["decision"]}
    if not await repo.consume(row["jti"], iso(now)):
        return {"result": "replayed", "decision": row["decision"]}
    return {"result": "matched", "decision": row["decision"]}


async def consume_token(db, token: Any, tool_name: str, tool_input: Any, *, session: str,
                        ring: Optional[KeyRing] = None, now: Optional[float] = None) -> str:
    """The reference check of the token contract for a presented token
    string: the tag is checked before the row is read, then the row's
    session, action, target, expiry, binding and policy version, then single
    use. No request path presents a token in this release (the Guard hooks
    match by session and action hash in `consume_for_call`); this is kept
    so the contract has one tested implementation. Returns the result."""
    ring = ring or KEYRING
    now = time.time() if now is None else now
    parsed = parse_token(token)
    if parsed is None:
        return "forged"
    repo = PolicyDecisionsRepository(db)
    row = await repo.get_decision(parsed[0])
    if row is None or not token_matches_row(token, row, ring):
        return "forged"
    try:
        action = canonical_action(tool_name, tool_input)
    except UnsupportedAction:
        return "unsupported"
    if row.get("consumed_at"):
        return "replayed"
    if row["session"] != session:
        return "other_session"
    if row["action_hash"] != action.action_hash or row["target_hash"] != action.target_hash:
        return "mismatch"
    exp = _epoch(row.get("expires_at"))
    if exp is None or now > exp:
        return "expired"
    ls = await repo.get_session(session) or {}
    if ls.get("binding") != "verified":
        return "unverified"
    current = await policy_version(db, ls.get("harness"), ls.get("harness_session_id"))
    if current != row.get("policy_version"):
        return "policy_changed"
    return "matched" if await repo.consume(row["jti"], iso(now)) else "replayed"


# --- session views -------------------------------------------------------------------------


async def preflight_summary(db, task: dict, *, now: Optional[float] = None) -> dict:
    """Counts for one task's Pre-flight checks section: kind, decision and
    age only, never a target."""
    now = time.time() if now is None else now
    repo = PolicyDecisionsRepository(db)
    handles = await repo.handles_for_view(task.get("id"), task.get("session_id"))
    rows = await repo.decisions_for(handles)
    grantable = [r for r in rows if r["decision"] in (ALLOW, NEEDS_APPROVAL)]
    matched = sum(1 for r in grantable if r.get("consume_result") == "matched")
    stale = sum(1 for r in grantable if not r.get("consumed_at")
                and (r.get("consume_result") == "expired"
                     or ((_epoch(r.get("expires_at")) or now) < now and not r.get("consume_result"))))
    denies = [r for r in rows if r["decision"] == DENY]
    attempted = sum(1 for r in denies if r.get("attempted_after_deny"))
    return {
        "checked": len(rows),
        "avoided_denials": len(denies) - attempted,
        "attempted_after_deny": attempted,
        "matched": matched,
        "match_rate": round(matched / len(grantable), 3) if grantable else None,
        "stale": stale,
        "recent": [
            {"kind": r["action_kind"], "decision": r["decision"],
             "age_s": max(0, int(now - (_epoch(r["issued_at"]) or now)))}
            for r in rows[:10]
        ],
    }


# --- session_burn -----------------------------------------------------------------------------

_burn_cache: dict = {}


def _burn_unavailable(handle: Optional[str]) -> dict:
    return {
        "session": handle, "available": False,
        "tokens": {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0},
        "calls": 0, "cost_usd": None, "cost_basis": None, "by_model": [], "since": None, "lag_s": None,
    }


def _transcript_usage(harness_session_id: str) -> Optional[dict]:
    """Claude Code's own transcript for this session, summed with the same
    reader the statusline uses. None when no transcript exists."""
    from securevector.app.server.routes import hooks_claude_code as cc

    root = Path(cc.CLAUDE_PROJECTS_DIR)
    if not root.is_dir():
        return None
    path = next((p for p in root.glob(f"*/{harness_session_id}.jsonl") if p.is_file()), None)
    if path is None:
        return None
    turns, inp, out, cache_create, cache_read, _last, per_model, _per_day = cc._aggregate_session_usage(path)
    since = None
    try:
        with path.open("r", encoding="utf-8") as fh:
            for _ in range(200):
                line = fh.readline()
                if not line:
                    break
                try:
                    ts = json.loads(line).get("timestamp")
                except (ValueError, AttributeError):
                    continue
                if isinstance(ts, str):
                    since = ts
                    break
    except OSError:
        pass
    return {"turns": turns, "input": inp, "output": out, "cache_write": cache_create,
            "cache_read": cache_read, "per_model": per_model, "since": since}


async def _estimate_cost(db, per_model: dict) -> tuple:
    from securevector.app.database.repositories.costs import CostsRepository
    from securevector.app.services.cost_optimizer import CACHE_WRITE_PREMIUM

    repo = CostsRepository(db)
    total, by_model = 0.0, []
    read_rate = CostsRepository.CACHE_DISCOUNT.get("anthropic", 1.0)
    write_rate = CACHE_WRITE_PREMIUM.get("anthropic", 1.0)
    for model, mu in sorted(per_model.items()):
        rin, rout = await repo.resolve_rates("anthropic", model)
        cost = None
        if rin is not None and rout is not None:
            cost = (mu["input"] * rin + mu["output"] * rout + mu["cache_read"] * rin * read_rate
                    + mu["cache_create"] * rin * write_rate) / 1_000_000
            total += cost
        by_model.append({
            "model": str(model)[:80], "calls": mu["turns"], "input": mu["input"], "output": mu["output"],
            "cache_read": mu["cache_read"], "cache_write": mu["cache_create"],
            "cost_usd": round(cost, 6) if cost is not None else None,
        })
    return round(total, 6), by_model


async def _recorded_usage(db, harness_session_id: str) -> Optional[dict]:
    rows = await db.fetch_all(
        "SELECT model_id, COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input, "
        "COALESCE(SUM(output_tokens), 0) AS output, COALESCE(SUM(input_cached_tokens), 0) AS cached, "
        "COALESCE(SUM(total_cost_usd), 0.0) AS cost, MIN(recorded_at) AS since "
        "FROM llm_cost_records WHERE session_id = ? GROUP BY model_id",
        (harness_session_id,),
    )
    if not rows:
        return None
    by_model = [{
        "model": str(r["model_id"] or "unknown")[:80], "calls": int(r["calls"] or 0),
        "input": int(r["input"] or 0), "output": int(r["output"] or 0), "cache_read": int(r["cached"] or 0),
        "cache_write": 0, "cost_usd": round(float(r["cost"] or 0.0), 6),
    } for r in rows]
    return {
        "tokens": {k: sum(m[k] for m in by_model) for k in ("input", "output", "cache_read", "cache_write")},
        "calls": sum(m["calls"] for m in by_model),
        "cost_usd": round(sum(m["cost_usd"] for m in by_model), 6),
        "by_model": by_model,
        "since": min(str(r["since"]) for r in rows if r["since"]) if any(r["since"] for r in rows) else None,
    }


async def burn(db, caller: Caller, handle: Optional[str], *, limiter: Optional[RateLimiter] = None,
               now: Optional[float] = None) -> dict:
    """Tokens and cost so far for the caller's own session. Never raises."""
    limiter = limiter or BURN_LIMITER
    now = time.time() if now is None else now
    try:
        if handle is None:
            # First call from this process: mint its handle, as a check would.
            handle = (await resolve_session(db, caller, None, now=now)).get("handle")
        if not isinstance(handle, str) or not HANDLE_RE.match(handle):
            return _burn_unavailable(None)
        repo = PolicyDecisionsRepository(db)
        row = await repo.get_session(handle)
        if not row or not _session_usable(row, caller, now) or not limiter.allow(handle):
            return _burn_unavailable(handle)
        sid = row.get("harness_session_id")
        if row.get("binding") == "verified" and caller.harness_session_id:
            sid = caller.harness_session_id
        if row.get("binding") == "unlinked" or not sid or not _HARNESS_SESSION_RE.match(sid) or ".." in sid:
            return _burn_unavailable(handle)
        cached = _burn_cache.get(sid)
        if cached and now - cached[0] < BURN_LAG_S:
            return dict(cached[1], session=handle, lag_s=int(now - cached[0]))
        body = None
        if (row.get("harness") or "claude-code") == "claude-code":
            usage = await asyncio.to_thread(_transcript_usage, sid)
            if usage is not None:
                cost, by_model = await _estimate_cost(db, usage["per_model"])
                body = {
                    "available": True,
                    "tokens": {"input": usage["input"], "output": usage["output"],
                               "cache_read": usage["cache_read"], "cache_write": usage["cache_write"]},
                    "calls": usage["turns"], "cost_usd": cost, "cost_basis": "estimate",
                    "by_model": by_model, "since": usage["since"],
                }
        if body is None:
            rec = await _recorded_usage(db, sid)
            if rec is not None:
                body = dict(rec, available=True, cost_basis="recorded")
        if body is None:
            return _burn_unavailable(handle)
        if len(_burn_cache) > 256:
            _burn_cache.clear()
        _burn_cache[sid] = (now, body)
        return dict(body, session=handle, lag_s=0)
    except Exception as e:  # noqa: BLE001
        logger.warning("Session burn failed: %s", type(e).__name__)
        return _burn_unavailable(handle if isinstance(handle, str) and HANDLE_RE.match(handle) else None)
