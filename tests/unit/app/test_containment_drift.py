"""
Drift comparison between consecutive containment proofs.

The property under test is narrow and load-bearing: drift must never invent a
regression, and must never hide one. The two failure directions have different
costs. A manufactured regression trains the operator to ignore the signal; a
hidden one is the reason the feature exists. Both are covered here.
"""

import pytest

from securevector.app.services.containment_drift import (
    DRIFT_ADDED,
    DRIFT_ENFORCEMENT_WEAKENED,
    DRIFT_IMPROVED,
    DRIFT_REGRESSED,
    DRIFT_REMOVED,
    SOURCE_NETWORK,
    SOURCE_NONE,
    SOURCE_SECUREVECTOR,
    STATUS_INCONCLUSIVE,
    STATUS_REGRESSED,
    STATUS_STABLE,
    STATUS_WEAKENED,
    containment_source,
    diff_proofs,
)


def probe(probe_id, *, sv=False, network=False, reached=False, title=None):
    return {
        "id": probe_id,
        "title": title or probe_id,
        "category": "supply-chain",
        "blocked_by_securevector": sv,
        "blocked_by_network": network,
        "reached": reached,
        "expect_contained": True,
    }


def proof(probes, verdict="contained", preset="baseline", proof_id="p1"):
    return {
        "id": proof_id,
        "started_at": "2026-08-05T00:00:00",
        "verdict": verdict,
        "policy_preset": preset,
        "probes": probes,
    }


class TestContainmentSource:
    def test_securevector_wins_attribution(self):
        assert containment_source(probe("a", sv=True)) == SOURCE_SECUREVECTOR

    def test_reached_means_nobody_held_it(self):
        assert containment_source(probe("a", reached=True)) == SOURCE_NONE

    def test_network_block_attributed_to_network(self):
        assert containment_source(probe("a", network=True)) == SOURCE_NETWORK

    def test_unattributed_containment_is_not_credited_to_us(self):
        """Not reached, nobody claimed it. We must not take the credit."""
        assert containment_source(probe("a")) == SOURCE_NETWORK


class TestNeverInventsRegressions:
    """A degraded proof cannot anchor a comparison."""

    @pytest.mark.parametrize("bad", ["degraded", "error"])
    def test_degraded_previous_is_inconclusive(self, bad):
        before = proof([probe("x", sv=True)], verdict=bad)
        after = proof([probe("x", reached=True)], proof_id="p2")
        result = diff_proofs(before, after)
        assert result["status"] == STATUS_INCONCLUSIVE
        assert result["comparable"] is False
        assert not result["regressions"]
        assert "previous" in result["reason"]

    @pytest.mark.parametrize("bad", ["degraded", "error"])
    def test_degraded_current_is_inconclusive(self, bad):
        """An offline run today must not read as today's regression."""
        before = proof([probe("x", sv=True)])
        after = proof([probe("x", reached=True)], verdict=bad, proof_id="p2")
        result = diff_proofs(before, after)
        assert result["status"] == STATUS_INCONCLUSIVE
        assert not result["regressions"]

    def test_single_proof_is_inconclusive_not_stable(self):
        result = diff_proofs(None, proof([probe("x", sv=True)]))
        assert result["status"] == STATUS_INCONCLUSIVE
        assert result["comparable"] is False

    def test_no_proof_at_all_is_inconclusive(self):
        assert diff_proofs(None, None)["status"] == STATUS_INCONCLUSIVE

    def test_identical_proofs_are_stable(self):
        probes = [probe("x", sv=True), probe("y", network=True)]
        result = diff_proofs(proof(probes), proof(probes, proof_id="p2"))
        assert result["status"] == STATUS_STABLE
        assert result["changes"] == []


class TestRegressionDetection:
    def test_contained_to_reached_is_critical(self):
        result = diff_proofs(
            proof([probe("x", sv=True)]),
            proof([probe("x", reached=True)], verdict="uncontained", proof_id="p2"),
        )
        assert result["status"] == STATUS_REGRESSED
        assert len(result["regressions"]) == 1
        assert result["regressions"][0]["drift"] == DRIFT_REGRESSED
        assert result["regressions"][0]["severity"] == "critical"

    def test_network_containment_to_reached_is_also_a_regression(self):
        result = diff_proofs(
            proof([probe("x", network=True)], verdict="partial"),
            proof([probe("x", reached=True)], verdict="uncontained", proof_id="p2"),
        )
        assert result["status"] == STATUS_REGRESSED


class TestEnforcementWeakened:
    """The finding nobody else reports: both proofs pass, the guarantee moved."""

    def test_securevector_to_network_is_weakened_not_stable(self):
        before = proof([probe("x", sv=True)], verdict="contained")
        after = proof([probe("x", network=True)], verdict="partial", proof_id="p2")
        result = diff_proofs(before, after)
        assert result["status"] == STATUS_WEAKENED
        assert result["changes"][0]["drift"] == DRIFT_ENFORCEMENT_WEAKENED
        assert result["changes"][0]["from"] == SOURCE_SECUREVECTOR
        assert result["changes"][0]["to"] == SOURCE_NETWORK

    def test_weakened_is_reported_even_when_both_verdicts_are_clean(self):
        """Both runs say contained. The change is real and must still surface."""
        before = proof([probe("x", sv=True)], verdict="contained")
        after = proof([probe("x", network=True)], verdict="contained", proof_id="p2")
        assert diff_proofs(before, after)["status"] == STATUS_WEAKENED

    def test_regression_outranks_weakening(self):
        before = proof([probe("x", sv=True), probe("y", sv=True)])
        after = proof(
            [probe("x", network=True), probe("y", reached=True)],
            verdict="uncontained", proof_id="p2",
        )
        assert diff_proofs(before, after)["status"] == STATUS_REGRESSED


class TestImprovementAndCoverage:
    def test_network_to_securevector_is_an_improvement(self):
        before = proof([probe("x", network=True)], verdict="partial")
        after = proof([probe("x", sv=True)], proof_id="p2")
        result = diff_proofs(before, after)
        assert result["changes"][0]["drift"] == DRIFT_IMPROVED

    def test_new_probe_is_flagged_not_silently_compared(self):
        before = proof([probe("x", sv=True)])
        after = proof([probe("x", sv=True), probe("z", sv=True)], proof_id="p2")
        change = next(c for c in diff_proofs(before, after)["changes"]
                      if c["probe_id"] == "z")
        assert change["drift"] == DRIFT_ADDED

    def test_dropped_probe_is_a_coverage_loss_not_a_pass(self):
        """Silence about an untested path reads as 'fine'. It is not."""
        before = proof([probe("x", sv=True), probe("y", sv=True)])
        after = proof([probe("x", sv=True)], proof_id="p2")
        change = next(c for c in diff_proofs(before, after)["changes"]
                      if c["probe_id"] == "y")
        assert change["drift"] == DRIFT_REMOVED
        assert "unknown" in change["note"].lower()


class TestPresetAttribution:
    def test_preset_change_is_named_in_the_reason(self):
        before = proof([probe("x", sv=True)], preset="hardened")
        after = proof([probe("x", reached=True)], verdict="uncontained",
                      preset="baseline", proof_id="p2")
        result = diff_proofs(before, after)
        assert "hardened" in result["reason"] and "baseline" in result["reason"]
