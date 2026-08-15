"""
Counterfactual replay — answer "what would this policy have done?" before it does it.

Hardened and Contained are the presets nobody enables, for a reason that has
nothing to do with whether they are correct: switching a live machine to a
stricter policy is an unbounded bet. The operator cannot know whether tomorrow
morning starts with six blocked calls or sixty, and the cost of finding out the
hard way is a broken workflow during real work. So the strict preset sits
unused, and the product's whole upper range is decorative.

Replay removes the bet. It runs a *candidate* policy against destinations this
machine already recorded and reports exactly what would have changed: which
calls flip to blocked, which hosts are responsible, and how many of those hosts
one promotion each would resolve. The answer arrives before the switch, from
this machine's own history, not from a vendor's guess about a typical
developer.

**What replay reconstructs, and what it does not.** Audit rows store the
destination, not the command, and that is deliberate: the command is where
secrets live. So replay reconstructs an attempt from `(host, port, scheme,
operation, kind)` and re-decides it. Two consequences, both stated rather than
smoothed over:

- Preset, allowlist and denylist changes replay **exactly** — those decisions
  read only fields the audit row carries.
- Baseline rule matches are **carried over** from the recorded verdict rather
  than re-derived, because the flags they key on (`is_publish`,
  `inline_remote`) come from parsing the original command. A row recorded while
  Baseline was disabled therefore replays without its Baseline verdict, and
  `caveats` says so.

Replay is an estimate of the past, not a promise about the future. A policy
that would have blocked nothing last month can still block something tomorrow;
what replay rules out is the *known* breakage, which is the part that actually
stops people from turning strictness on.
"""

from typing import Optional

from .destinations import EgressAttempt
from .engine import (
    ALLOW,
    BLOCK,
    LOG_ONLY,
    EgressContext,
    EgressPolicy,
    evaluate_attempt,
    load_baseline_pack,
)

# Baseline rule ids whose match depends on a command-derived flag that the
# audit row does not carry. When the recorded verdict names one of these, the
# flag is reconstructed from the rule id itself.
_PUBLISH_RULE = "sv.egress.package_publish"
_INLINE_REMOTE_RULE = "sv.egress.git_push_inline_url"


def attempt_from_audit_row(row: dict) -> EgressAttempt:
    """Rebuild an evaluable attempt from a stored audit row.

    `evidence` is deliberately dropped. It is already redacted and truncated for
    display, and replay has no use for it: feeding a display string back into a
    parser would invent destinations that were never extracted.
    """
    rule_id = row.get("rule_id")
    return EgressAttempt(
        host=row.get("host"),
        operation=(row.get("operation") or "unknown"),
        kind=(row.get("kind") or "http"),
        detector=(row.get("detector") or "replay"),
        confidence=(row.get("confidence") or "HEURISTIC"),
        scheme=row.get("scheme"),
        port=row.get("port"),
        evidence="",
        is_publish=(rule_id == _PUBLISH_RULE),
        inline_remote=(rule_id == _INLINE_REMOTE_RULE),
    )


def replay_policy(
    rows: list,
    candidate: EgressPolicy,
    current: Optional[EgressPolicy] = None,
    pack: Optional[list] = None,
    ctx: Optional[EgressContext] = None,
) -> dict:
    """Re-decide recorded destinations under `candidate`.

    Returns the delta against what was actually recorded, plus the per-host
    breakdown an operator needs to decide whether the switch is affordable.

    `current` is accepted but only used to describe the comparison; the
    "before" side always comes from the recorded action, because that is what
    genuinely happened on this machine. Re-deriving the before side would
    compare two estimates instead of comparing an estimate to a fact.
    """
    pack = pack if pack is not None else load_baseline_pack()
    ctx = ctx or EgressContext()

    # Under hardened, first-seen detection needs the set of hosts known *before*
    # the switch. Every host in the replay window was seen by definition, so
    # deriving it from the window itself is both correct and self-contained.
    if candidate.preset == "hardened" and not ctx.known_hosts:
        ctx = EgressContext(
            origin_git_host=ctx.origin_git_host,
            known_hosts=frozenset(
                str(r["host"]).lower() for r in rows if r.get("host")
            ),
            local_app_port=ctx.local_app_port,
            runtime_kind=ctx.runtime_kind,
            session_id=ctx.session_id,
        )

    newly_blocked: dict = {}
    newly_allowed: dict = {}
    unchanged = 0
    baseline_carryover = 0

    for row in rows:
        was = (row.get("action") or ALLOW).lower()
        attempt = attempt_from_audit_row(row)
        if attempt.is_publish or attempt.inline_remote:
            baseline_carryover += 1

        verdict = evaluate_attempt(attempt, candidate, ctx, pack)
        now = verdict.action

        # log_only and allow are the same thing from the caller's perspective:
        # the call proceeded. Only the block boundary is a workflow change.
        was_blocked = was == BLOCK
        now_blocked = now == BLOCK

        if was_blocked == now_blocked:
            unchanged += 1
            continue

        bucket = newly_blocked if now_blocked else newly_allowed
        host = row.get("host") or "(undetermined host)"
        entry = bucket.setdefault(host, {
            "host": host,
            "calls": 0,
            "operations": set(),
            "rule_ids": set(),
            "promotable": True,
            "example_reason": verdict.reason,
        })
        entry["calls"] += 1
        entry["operations"].add(attempt.operation)
        if verdict.rule_id:
            entry["rule_ids"].add(verdict.rule_id)
        # One non-promotable verdict makes the whole host non-promotable: the
        # operator cannot clear it with a single click, and reporting otherwise
        # would understate the cost of the switch.
        if now_blocked and not verdict.promotable:
            entry["promotable"] = False

    def _finalize(bucket):
        out = []
        for entry in bucket.values():
            out.append({
                "host": entry["host"],
                "calls": entry["calls"],
                "operations": sorted(entry["operations"]),
                "rule_ids": sorted(entry["rule_ids"]),
                "promotable": entry["promotable"],
                "example_reason": entry["example_reason"],
            })
        out.sort(key=lambda e: (-e["calls"], e["host"]))
        return out

    blocked = _finalize(newly_blocked)
    allowed = _finalize(newly_allowed)

    caveats = [
        "Replay re-decides destinations this machine already recorded. It "
        "cannot predict destinations that have not been seen yet, so it bounds "
        "known breakage, not all breakage.",
    ]
    if baseline_carryover == 0 and any(
        (r.get("rule_id") or "").startswith("sv.egress.") for r in rows
    ):
        caveats.append(
            "Baseline verdicts are carried over from the recorded row rather "
            "than re-derived, because the flags they match on come from the "
            "original command, which is not stored."
        )
    if not rows:
        caveats.append(
            "No egress was recorded in this window, so this replay establishes "
            "nothing. Run agents under the current policy first."
        )

    return {
        "candidate_preset": candidate.preset,
        "current_preset": current.preset if current else None,
        "rows_replayed": len(rows),
        "unchanged": unchanged,
        "newly_blocked_calls": sum(e["calls"] for e in blocked),
        "newly_blocked_hosts": blocked,
        "newly_allowed_calls": sum(e["calls"] for e in allowed),
        "newly_allowed_hosts": allowed,
        # The number the decision actually turns on: how many one-click
        # promotions would clear the new blocks. A switch that costs four
        # promotions is affordable; one that costs eighty is not.
        "promotions_to_clear": sum(1 for e in blocked if e["promotable"]),
        "unclearable_hosts": [e["host"] for e in blocked if not e["promotable"]],
        "caveats": caveats,
    }


def summarize_replay(result: dict) -> str:
    """One honest sentence for the UI, above the table."""
    calls = result["newly_blocked_calls"]
    hosts = len(result["newly_blocked_hosts"])
    if not result["rows_replayed"]:
        return "Nothing recorded in this window; this replay establishes nothing."
    if calls == 0:
        return (
            f"No recorded call would have been blocked by the "
            f"{result['candidate_preset']} preset."
        )
    promotions = result["promotions_to_clear"]
    tail = (
        f" {promotions} of {hosts} would clear with one promotion each."
        if promotions else ""
    )
    call_word = "call" if calls == 1 else "calls"
    host_word = "host" if hosts == 1 else "hosts"
    return (
        f"{calls} recorded {call_word} across {hosts} {host_word} would have "
        f"been blocked by the {result['candidate_preset']} preset.{tail}"
    )


__all__ = [
    "attempt_from_audit_row",
    "replay_policy",
    "summarize_replay",
    "ALLOW",
    "BLOCK",
    "LOG_ONLY",
]
