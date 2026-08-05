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

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.egress import EgressRepository
from securevector.app.services import egress_attestation
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
async def evaluate_egress(request: EvaluateRequest):
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

        ctx = EgressContext(
            origin_git_host=request.origin_git_host,
            runtime_kind=request.runtime_kind,
            session_id=request.session_id,
        )
        # First-seen detection only matters under the hardened preset, and the
        # query is not free, so it is loaded only when it will be read.
        if policy.preset == "hardened":
            ctx.known_hosts = await repo.known_hosts()

        evaluation = evaluate_tool_call(
            request.tool_name, request.tool_input or {}, policy, ctx,
            mcp_endpoint=request.mcp_endpoint, pack=_pack(),
        )

        if evaluation.network_capable and evaluation.verdicts:
            await repo.log_attempts(
                evaluation.verdicts,
                tool_name=request.tool_name,
                runtime_kind=request.runtime_kind,
                session_id=request.session_id,
                request_id=request.request_id,
            )

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
async def patch_policy(patch: PolicyPatch):
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


class PromoteRequest(BaseModel):
    host: str


@router.post("/egress/promote")
async def promote_destination(request: PromoteRequest):
    """Allow a previously-blocked destination. The deny-time promotion path.

    This is the mechanism that keeps the policy maintainable. Nobody authors an
    allowlist from a blank page; everybody clicks allow when something they
    recognise gets stopped.
    """
    repo = EgressRepository(get_database())
    row = await repo.get_active_policy()
    if not row:
        raise HTTPException(status_code=404, detail="No active egress policy")
    if not await repo.promote_host(row["id"], request.host):
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


@router.get("/egress/blast-radius")
async def get_blast_radius(days: int = 30, new_within_days: int = 7):
    """How far the agents on this machine can reach.

    The headline number. It stays meaningful when the policy is working and
    nothing is being blocked, which a blocked-events counter does not.
    """
    repo = EgressRepository(get_database())
    return await repo.blast_radius(days=days, new_within_days=new_within_days)


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
