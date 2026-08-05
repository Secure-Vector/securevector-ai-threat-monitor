"""
Counterfactual replay of a candidate policy against recorded destinations.

Replay exists so a stricter preset can be enabled on evidence instead of on
nerve. That only works if the number it reports is trustworthy in one specific
direction: it must not *understate* the cost of the switch. An operator who
enables Hardened on a promise of "four blocks" and gets forty stops trusting
every number this product prints. Understatement is therefore the failure the
tests here are built around.
"""

from securevector.core.egress import EgressPolicy
from securevector.core.egress.replay import (
    attempt_from_audit_row,
    replay_policy,
    summarize_replay,
)


def row(host, operation="read", action="allow", kind="http", rule_id=None):
    return {
        "host": host,
        "port": 443,
        "scheme": "https",
        "operation": operation,
        "kind": kind,
        "action": action,
        "rule_id": rule_id,
        "confidence": "PARSED",
        "detector": "bash",
    }


class TestAttemptReconstruction:
    def test_core_destination_fields_survive(self):
        attempt = attempt_from_audit_row(row("api.example.com", operation="write"))
        assert attempt.host == "api.example.com"
        assert attempt.operation == "write"
        assert attempt.scheme == "https"
        assert attempt.port == 443

    def test_evidence_is_never_carried_into_replay(self):
        """Evidence is a redacted display string; feeding it back invents data."""
        r = row("api.example.com")
        r["evidence"] = "curl -H 'Authorization: [REDACTED]' https://api.example.com"
        assert attempt_from_audit_row(r).evidence == ""

    def test_publish_flag_is_recovered_from_the_recorded_rule(self):
        attempt = attempt_from_audit_row(
            row("upload.pypi.org", operation="write", action="block",
                rule_id="sv.egress.package_publish")
        )
        assert attempt.is_publish is True

    def test_inline_remote_flag_is_recovered_from_the_recorded_rule(self):
        attempt = attempt_from_audit_row(
            row("evil.example.com", operation="write", action="block",
                kind="git", rule_id="sv.egress.git_push_inline_url")
        )
        assert attempt.inline_remote is True

    def test_missing_operation_degrades_to_unknown_not_read(self):
        """Guessing 'read' on an opaque row is how containment becomes theatre."""
        r = row("x.example.com")
        r["operation"] = None
        assert attempt_from_audit_row(r).operation == "unknown"


class TestBaselineReplayIsANoOp:
    def test_baseline_over_reads_blocks_nothing_new(self):
        rows = [row(f"host{i}.example.com") for i in range(5)]
        result = replay_policy(rows, EgressPolicy(preset="baseline"), pack=[])
        assert result["newly_blocked_calls"] == 0
        assert result["unchanged"] == 5


class TestHardenedReplay:
    def test_writes_to_unlisted_hosts_become_blocked(self):
        rows = [
            row("docs.example.com", operation="read"),
            row("api.example.com", operation="write"),
            row("api.example.com", operation="write"),
        ]
        result = replay_policy(rows, EgressPolicy(preset="hardened"), pack=[])
        assert result["newly_blocked_calls"] == 2
        assert [h["host"] for h in result["newly_blocked_hosts"]] == ["api.example.com"]

    def test_reads_are_still_not_blocked_under_hardened(self):
        rows = [row("docs.example.com", operation="read") for _ in range(3)]
        result = replay_policy(rows, EgressPolicy(preset="hardened"), pack=[])
        assert result["newly_blocked_calls"] == 0

    def test_allowlisted_write_host_is_not_counted(self):
        rows = [row("api.example.com", operation="write")]
        policy = EgressPolicy(preset="hardened", allowlist=["api.example.com"])
        assert replay_policy(rows, policy, pack=[])["newly_blocked_calls"] == 0

    def test_unknown_operation_counts_as_a_new_block(self):
        rows = [row("opaque.example.com", operation="unknown")]
        result = replay_policy(rows, EgressPolicy(preset="hardened"), pack=[])
        assert result["newly_blocked_calls"] == 1


class TestNeverUnderstatesTheCost:
    """The direction that matters: replay may not make a switch look cheap."""

    def test_promotions_to_clear_excludes_non_promotable_blocks(self):
        rows = [row("10.0.0.5", operation="write")]
        policy = EgressPolicy(preset="contained")
        result = replay_policy(rows, policy, pack=[])
        # Contained blocks are promotable; the count must equal the host count
        # so nothing is quietly presented as already-solved.
        assert result["promotions_to_clear"] == len(result["newly_blocked_hosts"])

    def test_non_promotable_host_is_named_as_unclearable(self):
        rows = [row("upload.pypi.org", operation="write")]
        pack = [{
            "id": "sv.egress.package_publish",
            "title": "Package publish",
            "severity": "critical",
            "effect": "deny",
            "match": {"hosts": ["upload.pypi.org"]},
        }]
        result = replay_policy(rows, EgressPolicy(preset="hardened"), pack=pack)
        assert result["unclearable_hosts"] == ["upload.pypi.org"]
        assert result["promotions_to_clear"] == 0

    def test_every_new_block_is_counted_per_call_not_per_host(self):
        rows = [row("api.example.com", operation="write") for _ in range(9)]
        result = replay_policy(rows, EgressPolicy(preset="contained"), pack=[])
        assert result["newly_blocked_calls"] == 9
        assert len(result["newly_blocked_hosts"]) == 1

    def test_empty_history_says_it_establishes_nothing(self):
        result = replay_policy([], EgressPolicy(preset="contained"), pack=[])
        assert result["newly_blocked_calls"] == 0
        assert any("establishes nothing" in c for c in result["caveats"])
        assert "establishes nothing" in summarize_replay(result)

    def test_caveat_about_unseen_destinations_is_always_present(self):
        rows = [row("api.example.com")]
        result = replay_policy(rows, EgressPolicy(preset="hardened"), pack=[])
        assert any("not been seen yet" in c for c in result["caveats"])


class TestRelaxationDirection:
    def test_promoting_a_host_shows_up_as_newly_allowed(self):
        rows = [row("api.example.com", operation="write", action="block",
                    rule_id="preset.hardened_write")]
        policy = EgressPolicy(preset="baseline", allowlist=["api.example.com"])
        result = replay_policy(rows, policy, pack=[])
        assert result["newly_allowed_calls"] == 1
        assert result["newly_blocked_calls"] == 0

    def test_denylist_blocks_even_under_baseline(self):
        rows = [row("bad.example.com", operation="read")]
        policy = EgressPolicy(preset="baseline", denylist=["bad.example.com"])
        result = replay_policy(rows, policy, pack=[])
        assert result["newly_blocked_calls"] == 1


class TestSummary:
    def test_zero_blocks_reads_as_no_change(self):
        rows = [row("docs.example.com")]
        result = replay_policy(rows, EgressPolicy(preset="baseline"), pack=[])
        assert "No recorded call" in summarize_replay(result)

    def test_summary_names_the_promotion_cost(self):
        rows = [row("api.example.com", operation="write")]
        result = replay_policy(rows, EgressPolicy(preset="hardened"), pack=[])
        assert "promotion" in summarize_replay(result)

    def test_singular_counts_read_as_english(self):
        rows = [row("api.example.com", operation="write")]
        text = summarize_replay(replay_policy(rows, EgressPolicy(preset="hardened"), pack=[]))
        assert "1 recorded call across 1 host" in text

    def test_plural_counts_read_as_english(self):
        rows = [row("a.example.com", operation="write"),
                row("b.example.com", operation="write")]
        text = summarize_replay(replay_policy(rows, EgressPolicy(preset="hardened"), pack=[]))
        assert "2 recorded calls across 2 hosts" in text
