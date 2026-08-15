"""
Attestation export — the proof, in a form somebody else can read.

The containment proof exists to be shown to a party who was not there: a
customer's security reviewer, an auditor, the person on the other side of a
vendor questionnaire. That audience does not have the app, will not run the
probe, and cannot be assumed to read the caveats charitably. So the export is
written for the least charitable reader.

Three rules, and the third is the one that makes the document worth anything:

1. **The verdict is copied, never restated.** A `degraded` proof exports as a
   degraded attestation. There is no path in this module that turns an
   inconclusive run into a document that reads like a pass.

2. **Coverage gaps sit above the results, not in a footnote.** What was not
   tested is the first thing a reviewer needs and the last thing a vendor
   volunteers. Putting it first is the difference between an attestation and a
   marketing artifact.

3. **It never says "guaranteed".** This document reports what a set of probes
   observed at one moment on one machine. It is evidence, and evidence is
   defeasible. An attestation that overclaims is worse than none, because it
   transfers a false confidence that survives long after the test.

The hash chain is included so a reviewer can detect a removed or edited proof:
each proof commits to its predecessor, so deleting an inconvenient run breaks
the chain visibly rather than quietly.
"""

import csv
import io
import json
import logging

logger = logging.getLogger(__name__)

_VERDICT_STATEMENT = {
    "contained": (
        "Every dangerous path tested was stopped by SecureVector before the "
        "call executed."
    ),
    "partial": (
        "No dangerous path tested reached the network, but not all of them "
        "were stopped by SecureVector. The remainder were stopped by this "
        "network's own controls, which are outside this policy's management "
        "and can change without notice."
    ),
    "uncontained": (
        "At least one dangerous path tested reached the network. This machine "
        "is not contained for those paths."
    ),
    "degraded": (
        "Containment could NOT be established. This machine could not reach "
        "the public internet during the test, so 'nothing got out' carries no "
        "information: an offline machine is indistinguishable from a contained "
        "one when observed this way. These results are inconclusive and must "
        "not be read as a pass."
    ),
    "error": (
        "The test did not complete. No conclusion about containment can be "
        "drawn from this run."
    ),
}

_COLUMN_LABELS = [
    "probe_id", "title", "category", "destination", "expected_contained",
    "policy_action", "blocked_by_securevector", "blocked_by_network",
    "reached_anyway", "detail", "duration_ms",
]


def _rows(proof: dict) -> list:
    for probe in proof.get("probes") or []:
        yield [
            probe.get("id"),
            probe.get("title"),
            probe.get("category"),
            probe.get("destination"),
            "yes" if probe.get("expect_contained") else "no",
            probe.get("policy_action"),
            "yes" if probe.get("blocked_by_securevector") else "no",
            "yes" if probe.get("blocked_by_network") else "no",
            "yes" if probe.get("reached") else "no",
            probe.get("detail"),
            probe.get("duration_ms"),
        ]


def to_csv(proof: dict, drift: dict = None) -> str:
    """Per-probe results as CSV, with the caveats carried in leading comments.

    Comment lines rather than a separate file: a CSV that can be opened without
    its caveats will be, and the row a reviewer quotes will be the one without
    context. Spreadsheet software shows the leading lines; it cannot show a
    document that was not attached.
    """
    out = io.StringIO()
    verdict = (proof.get("verdict") or "unknown").lower()

    def comment(text):
        out.write(f"# {text}\n")

    comment("SecureVector containment proof")
    comment(f"proof_id: {proof.get('id')}")
    comment(f"run_at: {proof.get('started_at')}")
    comment(f"policy_preset: {proof.get('policy_preset')}")
    comment(f"verdict: {verdict}")
    comment(_VERDICT_STATEMENT.get(verdict, "Unrecognised verdict."))
    comment(f"result_hash: {proof.get('result_hash')}")
    if drift and drift.get("comparable"):
        comment(f"drift_since_previous: {drift.get('status')} - {drift.get('reason')}")
    comment("")
    comment("NOT TESTED BY THIS PROOF:")
    for line in proof.get("coverage") or []:
        comment(f"  - {line}")
    comment("")
    comment(
        "This document reports what these probes observed at one moment on "
        "one machine. It is evidence of containment, not a guarantee of it."
    )
    comment("")

    writer = csv.writer(out)
    writer.writerow(_COLUMN_LABELS)
    for row in _rows(proof):
        writer.writerow(row)
    return out.getvalue()


def to_markdown(proof: dict, drift: dict = None) -> str:
    """Human-readable attestation.

    Ordering is load-bearing: verdict, then what was NOT tested, then results.
    A reviewer who stops reading after the second section has still read the
    part that prevents them from overstating this document downstream.
    """
    verdict = (proof.get("verdict") or "unknown").lower()
    lines = []
    add = lines.append

    add("# Containment Proof")
    add("")
    add(f"- **Run at:** {proof.get('started_at')}")
    add(f"- **Policy preset:** {proof.get('policy_preset')}")
    add(f"- **Proof id:** `{proof.get('id')}`")
    add(f"- **Result hash:** `{proof.get('result_hash')}`")
    add("")
    add(f"## Verdict: {verdict}")
    add("")
    add(_VERDICT_STATEMENT.get(verdict, "Unrecognised verdict."))
    add("")

    if drift and drift.get("comparable"):
        add(f"## Change since the previous proof: {drift.get('status')}")
        add("")
        add(drift.get("reason") or "")
        add("")
        for change in drift.get("changes") or []:
            add(
                f"- `{change.get('probe_id')}` **{change.get('drift')}** "
                f"({change.get('from')} to {change.get('to')}): "
                f"{change.get('note') or ''}"
            )
        if drift.get("changes"):
            add("")
    elif drift and drift.get("reason"):
        add("## Change since the previous proof")
        add("")
        add(drift["reason"])
        add("")

    add("## What this proof does NOT establish")
    add("")
    for line in proof.get("coverage") or []:
        add(f"- {line}")
    add("")

    add("## Results")
    add("")
    add("| Probe | Blocked by SecureVector | Blocked by your network | Reached anyway |")
    add("|---|---|---|---|")
    for probe in proof.get("probes") or []:
        add(
            f"| {probe.get('title')} "
            f"| {'yes' if probe.get('blocked_by_securevector') else 'no'} "
            f"| {'yes' if probe.get('blocked_by_network') else 'no'} "
            f"| {'**yes**' if probe.get('reached') else 'no'} |"
        )
    add("")
    add("---")
    add("")
    add(
        "This document reports what a fixed set of probes observed at one "
        "moment on one machine. It is evidence of containment, not a guarantee "
        "of it. Enforcement is tested at the agent tool boundary; a process "
        "that reaches the network by a path those hooks do not cover is not "
        "visible here."
    )
    add("")
    add(
        "Proofs are hash-chained: each commits to its predecessor, so a "
        "removed or edited run breaks the chain rather than disappearing "
        "quietly."
    )
    return "\n".join(lines)


def to_json(proof: dict, drift: dict = None) -> str:
    """Machine-readable export for a reviewer's own tooling."""
    payload = {
        "schema": "securevector.containment_proof.v1",
        "proof": proof,
        "drift": drift,
        "disclaimer": (
            "Evidence of containment at one moment on one machine, not a "
            "guarantee. Coverage gaps are listed in proof.coverage and are "
            "part of the result, not a footnote."
        ),
    }
    return json.dumps(payload, indent=2, sort_keys=True, default=str)
