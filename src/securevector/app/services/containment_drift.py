"""
Containment drift — a boundary that held last month is not a boundary that holds today.

A single containment proof answers "is this machine contained right now". That
is worth something, and it is not the thing that actually goes wrong. What goes
wrong is quiet: a proxy is removed, a policy is edited, a preset is switched
back for one debugging session and never switched forward, a corporate firewall
rule expires. Nothing announces any of that. The next proof would report it, but
only if somebody thought to run one, and nobody runs a proof on the day the
boundary breaks — that is precisely the day they are busy with something else.

So drift is computed by comparing consecutive proofs, per probe, and the
interesting result is not the obvious one.

**The obvious regression:** a path that was contained now reaches. Critical,
and easy.

**The one nobody else reports:** a path that SecureVector used to block is now
blocked only by the customer's own network. Both proofs say "contained". The
verdict did not move. But the guarantee migrated from a control the operator
configures to a control they may not even know exists, and the next network
change silently removes it. Calling that "no change" would be technically true
and practically dishonest, so it is reported as `enforcement_weakened`.

**Honesty rule inherited from the proof itself:** drift against a `degraded` or
`error` proof is not drift, it is noise. An offline machine produces a proof
where everything looks contained; diffing tomorrow's real proof against it
manufactures a regression that never happened. Either side inconclusive means
the whole comparison is `inconclusive`, and it says which side and why.
"""

import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Who is holding the line, strongest first. The ordering is the whole point:
# drift severity is a move down this ladder, not a change of verdict string.
SOURCE_SECUREVECTOR = "securevector"
SOURCE_NETWORK = "network"
SOURCE_NONE = "none"

_SOURCE_STRENGTH = {
    SOURCE_SECUREVECTOR: 2,
    SOURCE_NETWORK: 1,
    SOURCE_NONE: 0,
}

# Per-probe drift classifications.
DRIFT_UNCHANGED = "unchanged"
DRIFT_REGRESSED = "regressed"
DRIFT_ENFORCEMENT_WEAKENED = "enforcement_weakened"
DRIFT_IMPROVED = "improved"
DRIFT_ADDED = "added"
DRIFT_REMOVED = "removed"

# Overall drift status.
STATUS_STABLE = "stable"
STATUS_REGRESSED = "regressed"
STATUS_WEAKENED = "weakened"
STATUS_IMPROVED = "improved"
STATUS_INCONCLUSIVE = "inconclusive"

# Proof verdicts that cannot anchor a comparison.
_UNUSABLE_VERDICTS = {"degraded", "error"}


def containment_source(probe: dict) -> str:
    """Who stopped this probe: us, the network, or nobody."""
    if probe.get("blocked_by_securevector"):
        return SOURCE_SECUREVECTOR
    if probe.get("reached"):
        return SOURCE_NONE
    if probe.get("blocked_by_network"):
        return SOURCE_NETWORK
    # Not reached, not attributed. Treat as unattributed containment rather
    # than claiming credit for it.
    return SOURCE_NETWORK


def _classify(before: dict, after: dict) -> tuple:
    """Return (classification, severity, note) for one probe pair."""
    old_source = containment_source(before)
    new_source = containment_source(after)

    if old_source == new_source:
        return DRIFT_UNCHANGED, None, None

    old_rank = _SOURCE_STRENGTH[old_source]
    new_rank = _SOURCE_STRENGTH[new_source]

    if new_source == SOURCE_NONE:
        return (
            DRIFT_REGRESSED,
            "critical",
            "This path was contained in the previous proof and now reaches the "
            "network. Containment for this path is gone.",
        )

    if old_rank > new_rank:
        # securevector -> network. Still contained, by something else.
        return (
            DRIFT_ENFORCEMENT_WEAKENED,
            "medium",
            "Still contained, but no longer by SecureVector. This path now "
            "depends on a network control that is outside this policy, and a "
            "change to that control would remove containment without warning.",
        )

    return (
        DRIFT_IMPROVED,
        None,
        "This path is now enforced by SecureVector rather than left to the "
        "network."
        if new_source == SOURCE_SECUREVECTOR
        else "This path is contained where it previously was not.",
    )


def diff_proofs(previous: Optional[dict], current: Optional[dict]) -> dict:
    """Compare two persisted containment proofs.

    Both arguments are rows as returned by `EgressRepository.latest_proof`.
    Returns a report safe to render directly; every inconclusive path names the
    reason rather than degrading to an empty diff.
    """
    if not current:
        return {
            "status": STATUS_INCONCLUSIVE,
            "reason": "No containment proof has been run on this machine.",
            "changes": [],
            "regressions": [],
            "comparable": False,
        }
    if not previous:
        return {
            "status": STATUS_INCONCLUSIVE,
            "reason": (
                "Only one containment proof exists. Drift needs two proofs to "
                "compare; the next run will produce one."
            ),
            "changes": [],
            "regressions": [],
            "comparable": False,
            "current_verdict": current.get("verdict"),
        }

    for label, proof in (("previous", previous), ("current", current)):
        verdict = (proof.get("verdict") or "").lower()
        if verdict in _UNUSABLE_VERDICTS:
            return {
                "status": STATUS_INCONCLUSIVE,
                "reason": (
                    f"The {label} proof was '{verdict}', so it does not "
                    "establish a containment baseline. An offline or "
                    "unfinished run looks identical to a contained one, and "
                    "diffing against it would manufacture changes that did "
                    "not happen."
                ),
                "changes": [],
                "regressions": [],
                "comparable": False,
                "previous_verdict": previous.get("verdict"),
                "current_verdict": current.get("verdict"),
            }

    before = {p["id"]: p for p in (previous.get("probes") or []) if p.get("id")}
    after = {p["id"]: p for p in (current.get("probes") or []) if p.get("id")}

    changes = []

    for probe_id, new_probe in after.items():
        old_probe = before.get(probe_id)
        if old_probe is None:
            changes.append({
                "probe_id": probe_id,
                "title": new_probe.get("title"),
                "category": new_probe.get("category"),
                "drift": DRIFT_ADDED,
                "severity": None,
                "from": None,
                "to": containment_source(new_probe),
                "note": (
                    "New probe in this proof; there is no previous result to "
                    "compare it against."
                ),
            })
            continue

        drift, severity, note = _classify(old_probe, new_probe)
        if drift == DRIFT_UNCHANGED:
            continue
        changes.append({
            "probe_id": probe_id,
            "title": new_probe.get("title"),
            "category": new_probe.get("category"),
            "drift": drift,
            "severity": severity,
            "from": containment_source(old_probe),
            "to": containment_source(new_probe),
            "note": note,
        })

    for probe_id, old_probe in before.items():
        if probe_id in after:
            continue
        changes.append({
            "probe_id": probe_id,
            "title": old_probe.get("title"),
            "category": old_probe.get("category"),
            "drift": DRIFT_REMOVED,
            "severity": "low",
            "from": containment_source(old_probe),
            "to": None,
            # A dropped probe is a coverage loss, not a pass. Silence about it
            # would read as "this path is fine" when it was simply not tested.
            "note": (
                "This path was tested in the previous proof and is not tested "
                "in this one. Its current state is unknown."
            ),
        })

    regressions = [c for c in changes if c["drift"] == DRIFT_REGRESSED]
    weakened = [c for c in changes if c["drift"] == DRIFT_ENFORCEMENT_WEAKENED]

    if regressions:
        status = STATUS_REGRESSED
        reason = (
            f"{len(regressions)} containment path(s) that held in the previous "
            "proof now reach the network."
        )
    elif weakened:
        status = STATUS_WEAKENED
        reason = (
            f"{len(weakened)} path(s) are still contained, but no longer by "
            "SecureVector. The guarantee moved to a control this policy does "
            "not manage."
        )
    elif any(c["drift"] == DRIFT_IMPROVED for c in changes):
        status = STATUS_IMPROVED
        reason = "Containment improved since the previous proof."
    else:
        status = STATUS_STABLE
        reason = "No containment change since the previous proof."

    # Policy preset changes explain most drift, and pairing the two removes an
    # investigation step: "it regressed" plus "you switched off hardened" is a
    # finished answer, where either alone is a ticket.
    old_preset = previous.get("policy_preset")
    new_preset = current.get("policy_preset")
    if old_preset != new_preset:
        reason += f" Policy preset changed from '{old_preset}' to '{new_preset}'."

    return {
        "status": status,
        "reason": reason,
        "comparable": True,
        "previous_proof_id": previous.get("id"),
        "current_proof_id": current.get("id"),
        "previous_at": previous.get("started_at"),
        "current_at": current.get("started_at"),
        "previous_verdict": previous.get("verdict"),
        "current_verdict": current.get("verdict"),
        "previous_preset": old_preset,
        "current_preset": new_preset,
        "changes": changes,
        "regressions": regressions,
        "enforcement_weakened": weakened,
        "unchanged_count": len(after) - len([
            c for c in changes if c["drift"] != DRIFT_REMOVED
        ]),
    }
