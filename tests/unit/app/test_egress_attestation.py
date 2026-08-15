"""
Attestation export.

This document travels. It is read by someone who was not present for the test,
does not have the app, and has every incentive to quote the most favourable
line in it. So the tests here are adversarial in one direction only: they try
to find a path where an inconclusive or failing proof exports as something a
reader could reasonably call a pass.
"""

import csv
import io
import json

import pytest

from securevector.app.services import egress_attestation


def proof(verdict="contained", probes=None, coverage=None):
    return {
        "id": "11112222-3333-4444-5555-666677778888",
        "started_at": "2026-08-05T00:00:00",
        "verdict": verdict,
        "policy_preset": "baseline",
        "result_hash": "abc123",
        "prev_hash": "def456",
        "coverage": coverage if coverage is not None else [
            "Enforcement is tested at the agent tool boundary.",
            "A remote MCP server is an egress proxy.",
        ],
        "probes": probes if probes is not None else [
            {
                "id": "publish.pypi", "title": "Package publish to PyPI",
                "category": "supply-chain", "destination": "https://upload.pypi.org/legacy/",
                "expect_contained": True, "policy_action": "block",
                "blocked_by_securevector": True, "blocked_by_network": False,
                "reached": False, "detail": "not attempted", "duration_ms": 2,
            },
        ],
    }


class TestNeverExportsAFalsePass:
    @pytest.mark.parametrize("bad", ["degraded", "error"])
    def test_inconclusive_verdict_says_so_in_markdown(self, bad):
        md = egress_attestation.to_markdown(proof(verdict=bad))
        assert f"## Verdict: {bad}" in md
        assert "not" in md.lower()
        assert "guarantee of it" in md

    def test_degraded_markdown_explicitly_refuses_the_pass_reading(self):
        md = egress_attestation.to_markdown(proof(verdict="degraded"))
        assert "inconclusive" in md.lower()
        assert "must not be read as a pass" in md

    @pytest.mark.parametrize("bad", ["degraded", "error"])
    def test_inconclusive_verdict_survives_into_csv_comments(self, bad):
        out = egress_attestation.to_csv(proof(verdict=bad))
        assert f"# verdict: {bad}" in out

    def test_no_export_format_claims_a_guarantee(self):
        p = proof()
        for text in (
            egress_attestation.to_markdown(p),
            egress_attestation.to_csv(p),
            egress_attestation.to_json(p),
        ):
            lowered = text.lower()
            assert "guaranteed" not in lowered
            assert "guarantee of it" in lowered or "not a guarantee" in lowered

    def test_uncontained_is_stated_plainly(self):
        md = egress_attestation.to_markdown(proof(verdict="uncontained"))
        assert "is not contained" in md

    def test_partial_names_the_network_dependency(self):
        md = egress_attestation.to_markdown(proof(verdict="partial"))
        assert "outside this policy" in md


class TestCoverageIsNotAFootnote:
    def test_coverage_precedes_results_in_markdown(self):
        md = egress_attestation.to_markdown(proof())
        assert md.index("does NOT establish") < md.index("## Results")

    def test_every_coverage_line_is_carried(self):
        lines = ["gap one is real", "gap two is also real"]
        md = egress_attestation.to_markdown(proof(coverage=lines))
        for line in lines:
            assert line in md

    def test_csv_carries_coverage_in_leading_comments(self):
        out = egress_attestation.to_csv(proof(coverage=["a specific gap"]))
        header_index = out.index("probe_id,")
        assert out.index("a specific gap") < header_index


class TestCsvShape:
    def test_data_rows_parse_after_comment_lines(self):
        out = egress_attestation.to_csv(proof())
        body = "\n".join(
            line for line in out.splitlines() if not line.startswith("#")
        )
        rows = list(csv.reader(io.StringIO(body)))
        header = rows[0]
        assert header[0] == "probe_id"
        assert rows[1][0] == "publish.pypi"
        assert rows[1][header.index("blocked_by_securevector")] == "yes"
        assert rows[1][header.index("reached_anyway")] == "no"

    def test_reached_probe_is_marked_yes(self):
        p = proof(verdict="uncontained", probes=[{
            "id": "exfil.webhook", "title": "POST to a collector",
            "category": "exfiltration", "destination": "https://webhook.site/",
            "expect_contained": True, "policy_action": "allow",
            "blocked_by_securevector": False, "blocked_by_network": False,
            "reached": True, "detail": "HTTP 200", "duration_ms": 120,
        }])
        out = egress_attestation.to_csv(p)
        body = "\n".join(line for line in out.splitlines() if not line.startswith("#"))
        rows = list(csv.reader(io.StringIO(body)))
        assert rows[1][rows[0].index("reached_anyway")] == "yes"


class TestJsonExport:
    def test_is_valid_json_with_a_schema_marker(self):
        payload = json.loads(egress_attestation.to_json(proof()))
        assert payload["schema"] == "securevector.containment_proof.v1"
        assert payload["proof"]["verdict"] == "contained"

    def test_disclaimer_is_part_of_the_payload(self):
        payload = json.loads(egress_attestation.to_json(proof()))
        assert "not a" in payload["disclaimer"]


class TestDriftInclusion:
    def test_comparable_drift_is_rendered(self):
        drift = {
            "comparable": True, "status": "weakened",
            "reason": "One path is no longer enforced by SecureVector.",
            "changes": [{
                "probe_id": "publish.pypi", "drift": "enforcement_weakened",
                "from": "securevector", "to": "network",
                "note": "Now depends on a network control.",
            }],
        }
        md = egress_attestation.to_markdown(proof(), drift)
        assert "weakened" in md
        assert "publish.pypi" in md

    def test_inconclusive_drift_reason_is_still_shown(self):
        drift = {"comparable": False, "reason": "Only one proof exists."}
        md = egress_attestation.to_markdown(proof(), drift)
        assert "Only one proof exists." in md

    def test_missing_drift_does_not_break_export(self):
        assert "## Results" in egress_attestation.to_markdown(proof(), None)


class TestHashChain:
    def test_result_hash_is_published_for_tamper_detection(self):
        md = egress_attestation.to_markdown(proof())
        assert "abc123" in md
        assert "hash-chained" in md
        assert "# result_hash: abc123" in egress_attestation.to_csv(proof())
