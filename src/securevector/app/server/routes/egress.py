"""
Agent egress governance API.

The enforcement path is `POST /api/egress/evaluate`: Guard plugins send a tool
call, this returns allow/block. Destination extraction and policy evaluation
live in Python rather than in each runtime's hook, so there is exactly one
evaluator and five thin clients instead of five divergent implementations of
shell-command parsing.

The evidence path is `POST /api/egress/proof`: run the containment self-test
and return a signed, chained verdict.
"""

import ipaddress
import logging
import re
import secrets
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.egress import EgressRepository
from securevector.app.database.repositories.jit_access import JitAccessRepository
from securevector.app.server.routes.jit_access import _require_ui_token
from securevector.app.services import (
    codex_web_observer,
    egress_attestation,
    egress_scope,
)
from securevector.app.services.containment_drift import diff_proofs
from securevector.app.services.containment_proof import (
    preflight_manifest,
    run_containment_proof,
)
from securevector.core.egress import (
    ALLOW,
    BLOCK,
    VALID_PRESETS,
    EgressContext,
    EgressPolicy,
    evaluate_tool_call,
    load_baseline_pack,
    replay_policy,
    summarize_replay,
)

logger = logging.getLogger(__name__)
router = APIRouter()

# Loaded once. The pack is bundled with the app and never changes at runtime;
# re-reading YAML on every tool call would put file I/O in the enforcement path.
_BASELINE_PACK = None


def _pack():
    global _BASELINE_PACK
    if _BASELINE_PACK is None:
        _BASELINE_PACK = load_baseline_pack()
    return _BASELINE_PACK


async def _load_policy(repo: EgressRepository) -> EgressPolicy:
    row = await repo.get_active_policy()
    if not row:
        # No active policy means Baseline still applies. An install with no
        # policy row must not silently enforce nothing.
        return EgressPolicy()
    return EgressPolicy(
        preset=row["preset"],
        allowlist=row["allowlist"],
        denylist=row["denylist"],
        fail_closed=row["fail_closed"],
        ci_profile=row["ci_profile"],
        baseline_enabled=row["baseline_enabled"],
        policy_name=row["name"],
        policy_version=row["policy_version"],
        source=row["source"],
    )


# ============================================================ enforcement ===


class EvaluateRequest(BaseModel):
    """A tool call to evaluate for network egress."""

    tool_name: str
    tool_input: Optional[dict] = None
    runtime_kind: Optional[str] = None
    session_id: Optional[str] = None
    request_id: Optional[str] = Field(None, max_length=64)
    # Resolved endpoint for remote MCP tools. The caller knows its own MCP
    # config; the app does not.
    mcp_endpoint: Optional[str] = None
    # Host of the repo's `origin`, when the caller can cheaply determine it.
    origin_git_host: Optional[str] = None


@router.post("/egress/evaluate")
async def evaluate_egress(request: EvaluateRequest, http_request: Request = None):
    """Decide a tool call's network destinations.

    Returns `{action, network_capable, verdicts, coverage}`. When
    `network_capable` is false the caller should treat this as a no-op — the
    vast majority of tool calls (Read/Edit/Glob/Grep) never reach here at all
    because the plugin short-circuits before calling.
    """
    try:
        db = get_database()
        repo = EgressRepository(db)
        policy = await _load_policy(repo)

        # The session in the body is a claim. A task the app launched proves
        # it with its own hook token; see _session_binding.
        audit_session, verified = await _session_binding(http_request, request.session_id)
        ctx = EgressContext(
            origin_git_host=request.origin_git_host,
            runtime_kind=request.runtime_kind,
            session_id=audit_session,
            local_app_port=_app_port(http_request),
        )
        # First-seen detection only matters under the hardened preset, and the
        # query is not free, so it is loaded only when it will be read.
        if policy.preset == "hardened":
            ctx.known_hosts = await repo.known_hosts()
        # Session host grants: only for a local policy and a well-formed
        # session id, and scoped to this harness + session by the query.
        jit = JitAccessRepository(db)
        grantable = verified and _grantable_session(policy, audit_session)
        if grantable:
            try:
                grants = await jit.active_host_grants(
                    request.session_id, request.runtime_kind)
                ctx.host_grants = {h: g["id"] for h, g in grants.items()}
            except Exception as e:  # noqa: BLE001 - no grants, never an allow
                logger.warning("Host grant lookup failed; none applied: %s", e)

        evaluation = evaluate_tool_call(
            request.tool_name, request.tool_input or {}, policy, ctx,
            mcp_endpoint=request.mcp_endpoint, pack=_pack(),
        )

        if evaluation.network_capable and evaluation.verdicts:
            await repo.log_attempts(
                evaluation.verdicts,
                tool_name=request.tool_name,
                runtime_kind=request.runtime_kind,
                session_id=audit_session,
                request_id=request.request_id,
                session_verified=verified,
            )

        # A blocked promotable host files a request in that session's
        # Approval inbox, the same queue tool-level denies use. Best effort:
        # the block stands whether or not the request could be filed.
        if grantable and evaluation.blocked:
            await _file_host_requests(jit, evaluation.verdicts, policy, request)

        return {
            "action": evaluation.action,
            "network_capable": evaluation.network_capable,
            "reason": evaluation.reason,
            "coverage": evaluation.coverage,
            "verdicts": [
                {
                    "host": v.attempt.host,
                    "operation": v.attempt.operation,
                    "kind": v.attempt.kind,
                    "action": v.action,
                    "rule_id": v.rule_id,
                    "rule_title": v.rule_title,
                    "severity": v.severity,
                    "reason": v.reason,
                    "remediation": v.remediation,
                    "promotable": v.promotable,
                    "confidence": v.attempt.confidence,
                }
                for v in evaluation.verdicts
            ],
        }
    except Exception as e:
        logger.error("Egress evaluation failed: %s", e)
        # Fail-open on an internal error unless the policy demands otherwise.
        # A crashed evaluator must not wedge every agent on the machine; a
        # policy that opted into fail_closed accepts that trade explicitly.
        try:
            policy = await _load_policy(EgressRepository(get_database()))
            fail_closed = policy.fail_closed
        except Exception:
            fail_closed = False
        return {
            "action": BLOCK if fail_closed else ALLOW,
            "network_capable": True,
            "reason": (
                "Egress evaluation failed; policy is fail-closed."
                if fail_closed else
                "Egress evaluation failed; failing open."
            ),
            "coverage": "This call was not evaluated. Enforcement was unavailable.",
            "verdicts": [],
        }


# ========================================================== host grants ===

# Fixed rule titles for the rules the engine writes itself; baseline titles
# come from the pack. Stored audit rows carry the rule id only.
_FIXED_RULE_TITLES = {
    "policy.denylist": "Explicitly denied destination",
    "preset.contained": "Not on the contained-run allowlist",
    "preset.hardened_write": "Unapproved write destination",
    "grant.session_host": "Approved for this session",
}


def _rule_title(rule_id: Optional[str]) -> Optional[str]:
    if not rule_id:
        return None
    if rule_id in _FIXED_RULE_TITLES:
        return _FIXED_RULE_TITLES[rule_id]
    for rule in _pack():
        if rule.get("id") == rule_id:
            return rule.get("title")
    return None


_HOST_LABEL_RE = re.compile(r"^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$")


def _normalize_host(raw: Optional[str]) -> Optional[str]:
    """A bare host name or IP literal, lowercased, or None when it is not one.

    No scheme, path, port, wildcard or whitespace: a list entry already
    covers its subdomains, and anything else would be matched as a literal
    string that no real host ever equals.
    """
    host = (raw or "").strip().lower().rstrip(".")
    if not host or len(host) > 253:
        return None
    candidate = host[1:-1] if host.startswith("[") and host.endswith("]") else host
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        pass
    labels = host.split(".")
    if all(_HOST_LABEL_RE.match(label) for label in labels):
        return host
    return None


def _app_port(http_request) -> Optional[int]:
    """The port this app is serving on, for the control-API self check."""
    try:
        return int(http_request.url.port) if http_request is not None and http_request.url.port else None
    except Exception:  # noqa: BLE001
        return None


async def _session_binding(http_request, session_id: Optional[str]):
    """(session id to record, verified) for an evaluate call.

    The body's session_id is unauthenticated, so on its own it lets one
    session plant audit rows and inbox requests in another. A task the app
    launched carries SV_TERMINAL_TASK_ID / SV_TERMINAL_HOOK_TOKEN, which the
    Guard hooks send as X-SV-Terminal-Task / X-SV-Terminal-Hook:

    - token valid and that task's session is this session: verified; host
      grants apply and blocks file inbox requests.
    - a token is sent but it is not this session's: the claim is refused
      and the row is recorded with no session binding.
    - no token (a Guard plugin from before 6.1.0, or a linked or external
      session, which has none): the row keeps its session id as in 6.0.0,
      so the per-session counts, Egress list and Tool calls still work, but
      it is unverified: no grant applies, no inbox request is filed, and it
      can never be granted from.
    """
    if not session_id or not _SESSION_ID_RE.match(session_id):
        return None, False
    manager = None
    headers = {}
    if http_request is not None:
        manager = getattr(getattr(http_request.app, "state", None), "terminal_manager", None)
        headers = http_request.headers
    if manager is None:
        return session_id, False
    task_id = headers.get("x-sv-terminal-task") or ""
    token = headers.get("x-sv-terminal-hook") or ""
    if not task_id and not token:
        return session_id, False
    try:
        expected = manager.hook_token(task_id) if task_id else None
        if expected and token and secrets.compare_digest(
            token.encode("utf-8", "surrogateescape"), expected.encode("utf-8")
        ):
            task = await manager.store.get_task(task_id)
            if task and task.get("session_id") == session_id:
                return session_id, True
            if task and not task.get("session_id"):
                # The task's own token, before the hook relay has recorded
                # its session (first PreToolUse racing the start event):
                # keep the claim as unverified rather than drop the binding.
                return session_id, False
    except Exception as e:  # noqa: BLE001 - unverified is the safe answer
        logger.warning("Egress session binding check failed: %s", e)
        return None, False
    logger.warning("Egress call claimed session %s with a token that is not that "
                   "session's; recorded unbound", session_id)
    return None, False


def _grantable_session(policy: EgressPolicy, session_id: Optional[str]) -> bool:
    """Host grants exist only for a local policy and a real session id.

    A synced policy is an organization decision; like a synced tool deny
    without `requestable`, it is not overridable from this device.
    """
    return bool(
        session_id and _SESSION_ID_RE.match(session_id)
        and (policy.source or "local") == "local"
    )


async def _file_host_requests(jit, verdicts, policy, request) -> None:
    seen = set()
    for v in verdicts:
        host = _normalize_host(v.attempt.host) or ""
        if v.action != BLOCK or not v.promotable or not host or host in seen:
            continue
        seen.add(host)
        try:
            await jit.create_host_request(
                host, v.rule_id, v.reason, request.runtime_kind,
                request.session_id, rule_source="local",
            )
        except Exception as e:  # noqa: BLE001 - the block stands regardless
            logger.warning("Could not file host approval request: %s", e)


class HostGrantRequest(BaseModel):
    host: str = Field(..., min_length=1, max_length=253)
    session_id: str = Field(..., min_length=1, max_length=128)
    duration: str = Field(..., pattern="^(15m|1h|session)$")


async def _grant_owner(http_request, session_id: str) -> dict:
    """The launched, non-archived task whose current session this is, or a
    403. A grant is keyed to a session the app can hold its Guard to; a
    linked or external session has no hook token, so a grant for it could
    never apply and must not be minted."""
    manager = None
    if http_request is not None:
        manager = getattr(getattr(http_request.app, "state", None), "terminal_manager", None)
    task = None
    if manager is not None:
        try:
            task = await manager.store.task_for_session(session_id)
        except Exception as e:  # noqa: BLE001 - no owner, no grant
            logger.warning("Grant owner lookup failed: %s", e)
            task = None
    if not task or task.get("origin") == "linked" or task.get("archived_at"):
        raise HTTPException(
            status_code=403,
            detail="A host can be approved only for a session launched from "
                   "this app and still on the board.",
        )
    return task


@router.post("/egress/grants")
async def grant_host(
    body: HostGrantRequest,
    http_request: Request = None,
    x_sv_ui_token: Optional[str] = Header(None),
):
    """Approve a blocked host for one session: 15 min, 1 hour or the rest of
    the session. Never device-wide (that is /egress/promote).

    Human-only (the same per-run UI token as JIT decisions), only for a
    session a launched task owns right now, and only for a host that task's
    Guard actually had blocked by a promotable rule. The harness comes from
    that audit row, not from the client.
    """
    _require_ui_token(x_sv_ui_token)
    host = _normalize_host(body.host)
    if not host:
        raise HTTPException(status_code=400, detail="Invalid host")
    if not _SESSION_ID_RE.match(body.session_id):
        raise HTTPException(status_code=400, detail="Invalid session id")
    await _grant_owner(http_request, body.session_id)
    db = get_database()
    repo = EgressRepository(db)
    policy = await _load_policy(repo)
    if not _grantable_session(policy, body.session_id):
        raise HTTPException(
            status_code=403,
            detail="This egress policy is managed by your organization; "
                   "a host cannot be approved from this device.",
        )
    block = await repo.session_block(body.session_id, host)
    if not block:
        raise HTTPException(
            status_code=404, detail="No blocked call to this host in this session")
    if block.get("rule_id") in EgressRepository.NON_PROMOTABLE_RULES:
        raise HTTPException(
            status_code=403,
            detail=f"{block.get('rule_id')} cannot be approved; it needs a policy edit.",
        )
    try:
        grant = await JitAccessRepository(db).grant_host(
            host, block.get("rule_id"), block.get("reason"),
            block.get("runtime_kind"), body.session_id, body.duration,
        )
    except ValueError as ve:
        raise HTTPException(status_code=422, detail=str(ve))
    if not grant:
        raise HTTPException(status_code=409, detail="Could not create the grant")
    logger.info(
        "Egress host grant %s: %s for session %s (%s, rule %s, by local-user)",
        grant["id"], host, body.session_id, body.duration, block.get("rule_id"),
    )
    return {"grant": grant}


# ================================================================= policy ===


class PolicyPatch(BaseModel):
    preset: Optional[str] = None
    allowlist: Optional[list] = None
    denylist: Optional[list] = None
    fail_closed: Optional[bool] = None
    ci_profile: Optional[bool] = None
    baseline_enabled: Optional[bool] = None


@router.get("/egress/policy")
async def get_policy():
    repo = EgressRepository(get_database())
    row = await repo.get_active_policy()
    if not row:
        raise HTTPException(status_code=404, detail="No active egress policy")
    return row


@router.patch("/egress/policy")
async def patch_policy(patch: PolicyPatch, x_sv_ui_token: Optional[str] = Header(None)):
    # A preset or list change is a person's decision, like a JIT approval.
    _require_ui_token(x_sv_ui_token)
    if patch.preset is not None and patch.preset not in VALID_PRESETS:
        raise HTTPException(
            status_code=400,
            detail=f"preset must be one of {', '.join(VALID_PRESETS)}",
        )
    repo = EgressRepository(get_database())
    row = await repo.get_active_policy()
    if not row:
        raise HTTPException(status_code=404, detail="No active egress policy")
    await repo.update_policy(
        row["id"], preset=patch.preset, allowlist=patch.allowlist,
        denylist=patch.denylist, fail_closed=patch.fail_closed,
        ci_profile=patch.ci_profile, baseline_enabled=patch.baseline_enabled,
    )
    return await repo.get_active_policy()


class DenyHostRequest(BaseModel):
    host: str = Field(..., min_length=1, max_length=253)


@router.post("/egress/denylist")
async def add_denied_host(
    body: DenyHostRequest,
    x_sv_ui_token: Optional[str] = Header(None),
):
    """Add one host to Denied destinations. Validated, then deny-everywhere:
    the next call from any session to it (or a subdomain) is blocked."""
    _require_ui_token(x_sv_ui_token)
    host = _normalize_host(body.host)
    if not host:
        raise HTTPException(status_code=400, detail="Invalid host")
    repo = EgressRepository(get_database())
    row = await repo.get_active_policy()
    if not row:
        raise HTTPException(status_code=404, detail="No active egress policy")
    await repo.add_denied_host(row["id"], host)
    return await repo.get_active_policy()


@router.post("/egress/denylist/remove")
async def remove_denied_host(
    body: DenyHostRequest,
    x_sv_ui_token: Optional[str] = Header(None),
):
    """Remove one host from Denied destinations."""
    _require_ui_token(x_sv_ui_token)
    host = _normalize_host(body.host)
    if not host:
        raise HTTPException(status_code=400, detail="Invalid host")
    repo = EgressRepository(get_database())
    row = await repo.get_active_policy()
    if not row:
        raise HTTPException(status_code=404, detail="No active egress policy")
    if not await repo.remove_denied_host(row["id"], host):
        raise HTTPException(status_code=404, detail="Host is not on the denylist")
    return await repo.get_active_policy()


class PromoteRequest(BaseModel):
    host: str


@router.post("/egress/promote")
async def promote_destination(
    request: PromoteRequest, x_sv_ui_token: Optional[str] = Header(None),
):
    """Allow a previously-blocked destination. The deny-time promotion path.

    This is the mechanism that keeps the policy maintainable. Nobody authors an
    allowlist from a blank page; everybody clicks allow when something they
    recognise gets stopped.

    Device-wide and permanent, so human-only: the same UI token as JIT
    decisions. Without it an agent could allow itself any host.
    """
    _require_ui_token(x_sv_ui_token)
    host = _normalize_host(request.host)
    if not host:
        raise HTTPException(status_code=400, detail="Invalid host")
    repo = EgressRepository(get_database())
    row = await repo.get_active_policy()
    if not row:
        raise HTTPException(status_code=404, detail="No active egress policy")
    if not await repo.promote_host(row["id"], host):
        raise HTTPException(status_code=400, detail="Invalid host")
    return {"ok": True, "policy": await repo.get_active_policy()}


# ================================================================== audit ===


@router.get("/egress/audit")
async def get_audit(limit: int = 100, action: Optional[str] = None):
    repo = EgressRepository(get_database())
    return {"rows": await repo.recent(limit=limit, action=action)}


@router.get("/egress/destinations")
async def get_destinations(days: int = 30):
    """The blast-radius inventory: every external host the agents reached."""
    repo = EgressRepository(get_database())
    rows = await repo.destination_inventory(days=days)
    return {
        "window_days": days,
        "distinct_hosts": len(rows),
        "write_capable": sum(1 for r in rows if (r.get("writes") or 0) > 0),
        "destinations": rows,
    }


_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


@router.get("/egress/sessions/{session_id}/destinations")
async def get_session_destinations(session_id: str, limit: int = 50):
    """The hosts one session reached, blocked ones first.

    Scoped to a single session so an attached terminal can show the reach of
    the task in front of the operator instead of the whole machine's history.
    The id is pattern-checked rather than passed straight through: it arrives
    from a path segment and ends up in a query parameter.
    """
    if not _SESSION_ID_RE.match(session_id or ""):
        raise HTTPException(status_code=400, detail="Invalid session id")
    db = get_database()
    repo = EgressRepository(db)
    rows = await repo.session_destinations(session_id, limit=limit)
    # The rule behind each blocked host, and whether this session may approve
    # it (with any grant already in force). A failed grant read leaves the
    # rows without one rather than failing the panel.
    try:
        grants = await JitAccessRepository(db).active_host_grants(
            session_id, any_runtime=True)
    except Exception:  # noqa: BLE001
        grants = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        if row.get("rule_id"):
            row["rule_title"] = _rule_title(row.get("rule_id"))
        # Grantable only from a block the launched task's Guard wrote with
        # its hook token; a Guard from before 6.1.0 or a linked session is
        # listed, never approved from here.
        row["promotable"] = bool((row.get("blocked") or 0) > 0
                                 and row.get("verified_blocked")
                                 and not row.get("hard_blocked")
                                 and row.get("rule_id") not in EgressRepository.NON_PROMOTABLE_RULES)
        grant = grants.get(str(row.get("host") or "").lower())
        if grant:
            row["grant"] = {k: grant.get(k) for k in ("id", "duration", "expires_at", "granted_at")}
    # `observed` rows were reached without passing the evaluator (a harness's
    # own web tool fires no hook). They are counted separately, and the
    # consent flag travels with them: with transcript reading off the list is
    # not "nothing happened", it is "nothing was read".
    return {
        "session_id": session_id,
        "distinct_hosts": len(rows),
        "blocked_hosts": sum(1 for r in rows if (r.get("blocked") or 0) > 0),
        # Refused calls, one per call however many hosts it named: the same
        # count the traces list folds into a run's `blocked`.
        "blocked_calls": await repo.session_blocked_call_count(session_id),
        "observed_calls": sum((r.get("observed") or 0) for r in rows),
        "transcript_consent": codex_web_observer.consent_granted(),
        "destinations": rows,
    }


@router.get("/egress/blast-radius")
async def get_blast_radius(days: int = 30, new_within_days: int = 7):
    """How far the agents on this machine can reach.

    The headline number. It stays meaningful when the policy is working and
    nothing is being blocked, which a blocked-events counter does not.
    """
    repo = EgressRepository(get_database())
    return await repo.blast_radius(days=days, new_within_days=new_within_days)


@router.get("/egress/scope")
async def get_scope_expansion(days: int = 7):
    """Sessions whose egress *shape* is unusual, regardless of destination.

    Alert-only by design. A rate threshold is a heuristic, and a heuristic that
    halts legitimate work is a heuristic that gets switched off; destination
    policy is what blocks, this only says where to look.
    """
    repo = EgressRepository(get_database())
    sessions = await repo.session_scope(days=days)
    known = len(await repo.known_hosts())
    return {
        "window_days": days,
        **egress_scope.summarize([egress_scope.assess(s, known) for s in sessions]),
    }


class ReplayRequest(BaseModel):
    """A candidate policy to test against recorded history."""

    preset: str
    allowlist: Optional[list] = None
    denylist: Optional[list] = None
    ci_profile: Optional[bool] = None
    baseline_enabled: Optional[bool] = None
    days: int = 30


@router.post("/egress/replay")
async def replay_candidate_policy(request: ReplayRequest):
    """What a stricter policy would have done to this machine's own history.

    This is what makes Hardened and Contained enableable. Switching presets
    blind is an unbounded bet on tomorrow's workflow; replay converts it into a
    number the operator can look at first.
    """
    if request.preset not in VALID_PRESETS:
        raise HTTPException(
            status_code=400,
            detail=f"preset must be one of {', '.join(VALID_PRESETS)}",
        )
    repo = EgressRepository(get_database())
    current = await _load_policy(repo)
    candidate = EgressPolicy(
        preset=request.preset,
        # Default to the live lists so replay answers "switch the preset",
        # which is the question actually being asked, rather than "switch the
        # preset and simultaneously discard every promotion I have made".
        allowlist=request.allowlist if request.allowlist is not None else current.allowlist,
        denylist=request.denylist if request.denylist is not None else current.denylist,
        ci_profile=current.ci_profile if request.ci_profile is None else request.ci_profile,
        baseline_enabled=(
            current.baseline_enabled if request.baseline_enabled is None
            else request.baseline_enabled
        ),
    )
    rows = await repo.attempts_for_replay(days=request.days)
    result = replay_policy(rows, candidate, current=current, pack=_pack())
    return {**result, "window_days": request.days, "summary": summarize_replay(result)}


@router.get("/egress/policy-health")
async def get_policy_health(days: int = 30):
    """Promotion rate. A policy whose denials are all promoted is mis-set.

    Surfacing our own false-positive rate is the alternative to waiting for the
    user to disable the feature.
    """
    repo = EgressRepository(get_database())
    return await repo.promotion_rate(days=days)


# ====================================================== containment proof ===


@router.get("/egress/proof/preflight")
async def get_preflight():
    """Exactly what the proof will do, for a security team to read first."""
    return preflight_manifest()


@router.post("/egress/proof")
async def run_proof(trigger: str = "manual"):
    """Run the containment self-test and persist the chained verdict."""
    if trigger not in ("manual", "scheduled", "policy_change"):
        raise HTTPException(status_code=400, detail="Invalid trigger")
    try:
        repo = EgressRepository(get_database())
        policy = await _load_policy(repo)
        # Captured before the new proof lands, so the diff compares this run to
        # the last one rather than to itself.
        previous = await repo.latest_proof()
        result = await run_containment_proof(policy)
        saved = await repo.save_proof(
            probes=result["probes"],
            verdict=result["verdict"],
            coverage=result["coverage"],
            trigger=trigger,
            policy_preset=result["policy_preset"],
        )
        # Drift is computed on every run rather than on request. A regression
        # nobody asked about is exactly the regression worth surfacing.
        drift = diff_proofs(previous, {**result, **saved})
        return {**result, **saved, "drift": drift}
    except Exception as e:
        logger.error("Containment proof failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Containment proof failed: {e}")


@router.get("/egress/proof/latest")
async def get_latest_proof():
    repo = EgressRepository(get_database())
    proof = await repo.latest_proof()
    if not proof:
        raise HTTPException(status_code=404, detail="No containment proof has been run")
    return proof


@router.get("/egress/proof/history")
async def get_proof_history(limit: int = 20):
    repo = EgressRepository(get_database())
    return {"proofs": await repo.proof_history(limit=limit)}


@router.get("/egress/proof/drift")
async def get_containment_drift():
    """What changed between the last two proofs.

    Reports the regression that is easy to see (a contained path now reaches)
    and the one that is not: a path still contained, but no longer by us. Both
    proofs say "contained" in that case, and the guarantee has still moved to a
    control this policy does not manage.
    """
    repo = EgressRepository(get_database())
    proofs = await repo.recent_proofs_full(limit=2)
    current = proofs[0] if proofs else None
    previous = proofs[1] if len(proofs) > 1 else None
    return diff_proofs(previous, current)


# ============================================================ attestation ===


async def _proof_for_export(proof_id: Optional[str]):
    repo = EgressRepository(get_database())
    if proof_id:
        proof = await repo.get_proof(proof_id)
    else:
        proofs = await repo.recent_proofs_full(limit=2)
        proof = proofs[0] if proofs else None
    if not proof:
        raise HTTPException(status_code=404, detail="No containment proof found")
    proofs = await repo.recent_proofs_full(limit=2)
    previous = next((p for p in proofs if p["id"] != proof["id"]), None)
    return proof, diff_proofs(previous, proof)


@router.get("/egress/proof/export.json")
async def export_proof_json(proof_id: Optional[str] = None):
    proof, drift = await _proof_for_export(proof_id)
    return PlainTextResponse(
        egress_attestation.to_json(proof, drift),
        media_type="application/json",
        headers={
            "Content-Disposition":
                f"attachment; filename=containment-proof-{proof['id'][:8]}.json"
        },
    )


@router.get("/egress/proof/export.csv")
async def export_proof_csv(proof_id: Optional[str] = None):
    proof, drift = await _proof_for_export(proof_id)
    return StreamingResponse(
        iter([egress_attestation.to_csv(proof, drift)]),
        media_type="text/csv",
        headers={
            "Content-Disposition":
                f"attachment; filename=containment-proof-{proof['id'][:8]}.csv"
        },
    )


@router.get("/egress/proof/export.md")
async def export_proof_markdown(proof_id: Optional[str] = None):
    """The attestation a security reviewer reads.

    Ordered verdict, then what was NOT tested, then results. A reviewer who
    stops after the second section has still read the part that stops this
    document being overstated downstream.
    """
    proof, drift = await _proof_for_export(proof_id)
    return PlainTextResponse(
        egress_attestation.to_markdown(proof, drift),
        media_type="text/markdown",
        headers={
            "Content-Disposition":
                f"attachment; filename=containment-proof-{proof['id'][:8]}.md"
        },
    )


def _describe_match(match: dict) -> list:
    """Turn a rule's `match` block into lines an operator can read.

    The YAML is written for the evaluator, not for a person: `is_publish: true`
    and `cidrs: [...]` say nothing to someone deciding whether to switch preset.
    Rendering happens here rather than in JS so the page cannot drift from the
    pack it claims to be describing.
    """
    if not isinstance(match, dict):
        return []
    out = []
    ops = match.get("operation")
    if ops:
        out.append("Applies to: " + ", ".join(ops) + " operations only")
    if match.get("is_publish"):
        out.append("Any package or registry publish (pypi, npm, cargo, docker, gem)")
    for key, label in (("hosts", "Hosts"), ("host_suffixes", "Host suffixes"),
                       ("cidrs", "Address ranges")):
        vals = match.get(key)
        if vals:
            out.append(f"{label}: " + ", ".join(str(v) for v in vals))
    if match.get("kinds"):
        out.append("Command kinds: " + ", ".join(match["kinds"]))
    if match.get("inline_remote"):
        out.append("Remote given as a literal URL on the command line")
    if match.get("foreign_git_remote"):
        out.append("Target host differs from the repository's origin")
    if match.get("exclude_ports_from_settings"):
        out.append("SecureVector's own port is never matched")
    return out


# Preset semantics live next to the evaluator that implements them
# (`core/egress/engine.py`), so this endpoint describes what the code does
# rather than restating marketing copy that can fall out of step with it.
_PRESET_SEMANTICS = {
    "baseline": {
        "label": "Baseline",
        "adds": [
            "Reads are recorded and allowed — never blocked.",
            "Only the rule pack below denies anything.",
        ],
    },
    "hardened": {
        "label": "Hardened",
        "adds": [
            "Everything Baseline denies, plus:",
            "Every write must be to an allowlisted host, or it is denied.",
            "An operation SecureVector cannot classify counts as a write. "
            "Guessing 'read' on an opaque protocol is the assumption that makes "
            "containment theatre.",
            "Reads still flow. Needs tuning: preview the impact first.",
        ],
    },
    "contained": {
        "label": "Contained",
        "adds": [
            "Everything Baseline denies, plus:",
            "Only allowlisted destinations are reachable at all — reads included.",
            "Intended for a single run, not as a permanent setting.",
        ],
    },
}


@router.get("/egress/presets")
async def get_presets():
    """What each preset actually enforces, rule by rule.

    The preset selector previously offered three one-line blurbs and no way to
    see what any of them would do. An operator cannot consent to 'needs tuning'
    without the list, so the list ships with the selector.
    """
    pack = load_baseline_pack()
    rules = [
        {
            "id": r.get("id"),
            "title": r.get("title"),
            "severity": r.get("severity"),
            # log_only is not a denial and must not be rendered as one.
            "effect": r.get("effect"),
            "matches": _describe_match(r.get("match") or {}),
            "rationale": (r.get("rationale") or "").strip(),
            "remediation": (r.get("remediation") or "").strip(),
            "ci_exempt": bool(r.get("ci_exempt")),
        }
        for r in pack
    ]

    # No active policy row still means Baseline applies — `_load_policy`
    # already encodes that, so reuse it rather than defaulting separately.
    active = "baseline"
    try:
        policy = await _load_policy(EgressRepository(get_database()))
        active = (policy.preset or "baseline").lower()
    except Exception as e:  # noqa: BLE001 - the page still renders without it
        logger.warning("Could not read active egress policy: %s", e)

    return {
        "active": active,
        "pack_loaded": bool(rules),
        "presets": [
            {
                "id": pid,
                "label": meta["label"],
                "active": pid == active,
                "adds": meta["adds"],
                # Every preset inherits the pack; showing it once per preset is
                # what makes "Baseline, plus..." checkable rather than asserted.
                "rules": rules,
            }
            for pid, meta in _PRESET_SEMANTICS.items()
        ],
    }
