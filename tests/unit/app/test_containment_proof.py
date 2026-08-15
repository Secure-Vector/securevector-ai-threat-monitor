"""
Unit tests for Containment Proof.

The feature's entire value rests on the verdict being trustworthy. These tests
defend that property, and the most important one is `TestNeverFalselyPasses`:
an offline machine must never be reported as contained. Getting that wrong once
destroys the only reason anyone would believe the third column.
"""

import pytest

from securevector.app.services import containment_proof as cp
from securevector.core.egress import EgressPolicy


@pytest.fixture
def net(monkeypatch):
    """Control what the network appears to do, per probe id.

    Returns a setter taking {probe_id: reached_bool}; unlisted probes default
    to unreachable.
    """
    state = {"map": {}, "default": False}

    def fake(probe):
        reached = state["map"].get(probe.id, state["default"])
        return {"reached": reached, "detail": "stub reached" if reached else "stub no route"}

    monkeypatch.setattr(cp, "_run_probe_sync", fake)

    def configure(mapping=None, default=False):
        state["map"] = mapping or {}
        state["default"] = default

    return configure


async def run(policy=None):
    return await cp.run_containment_proof(policy or EgressPolicy())


class TestNeverFalselyPasses:
    """An offline machine is indistinguishable from a contained one.

    If you only observe "nothing got out", a laptop on a plane looks exactly
    like perfect containment. Reporting `contained` there is a false pass, and
    a false pass is the one defect that makes the whole verdict worthless.
    """

    @pytest.mark.asyncio
    async def test_offline_is_degraded_not_contained(self, net):
        # Nothing reaches, including the control probe.
        net({}, default=False)
        result = await run(EgressPolicy(baseline_enabled=False))
        assert result["verdict"] == cp.VERDICT_DEGRADED
        assert result["verdict"] != cp.VERDICT_CONTAINED

    @pytest.mark.asyncio
    async def test_offline_says_why_it_is_inconclusive(self, net):
        net({}, default=False)
        result = await run(EgressPolicy(baseline_enabled=False))
        joined = " ".join(result["coverage"]).lower()
        assert "inconclusive" in joined
        assert "not a pass" in joined

    @pytest.mark.asyncio
    async def test_offline_with_enforcement_on_is_still_degraded(self, net):
        """Even with every rule armed, we cannot claim a pass we did not prove.

        Enforcement blocking the probes proves the POLICY works; it does not
        prove the machine is contained, because the network was never exercised.
        """
        net({}, default=False)
        result = await run(EgressPolicy())
        assert result["verdict"] == cp.VERDICT_DEGRADED


class TestVerdicts:
    @pytest.mark.asyncio
    async def test_enforcement_blocks_everything_gives_contained(self, net):
        # Control reaches (machine is online); dangerous probes are blocked by
        # policy before they are ever attempted.
        net({"control.public_read": True}, default=True)
        result = await run(EgressPolicy())
        assert result["verdict"] == cp.VERDICT_CONTAINED
        assert result["summary"]["reached_anyway"] == 0
        assert result["summary"]["blocked_by_securevector"] == result["summary"]["dangerous"]

    @pytest.mark.asyncio
    async def test_escape_gives_uncontained(self, net):
        net({}, default=True)  # everything reaches, nothing enforced
        result = await run(EgressPolicy(baseline_enabled=False))
        assert result["verdict"] == cp.VERDICT_UNCONTAINED
        assert result["summary"]["reached_anyway"] > 0

    @pytest.mark.asyncio
    async def test_network_caught_it_is_partial_not_contained(self, net):
        """Nothing escaped, but WE did not stop it. That is a different claim.

        `partial` is the honest verdict: true today, and not a property of any
        control this product operates.
        """
        net({"control.public_read": True}, default=False)
        result = await run(EgressPolicy(baseline_enabled=False))
        assert result["verdict"] == cp.VERDICT_PARTIAL
        assert result["summary"]["blocked_by_securevector"] == 0
        assert result["summary"]["blocked_by_network"] > 0


class TestThreeColumns:
    """The three columns must be mutually exclusive and correctly attributed."""

    @pytest.mark.asyncio
    async def test_blocked_calls_are_not_attempted(self, net):
        """Enforcement means the call does not happen.

        Reporting the network result of a call we stopped would be measuring
        something that never occurred.
        """
        net({}, default=True)
        result = await run(EgressPolicy())
        for probe in result["probes"]:
            if probe["blocked_by_securevector"]:
                assert probe["attempted"] is False
                assert probe["reached"] is False

    @pytest.mark.asyncio
    async def test_columns_are_mutually_exclusive(self, net):
        net({"control.public_read": True, "publish.pypi": True}, default=False)
        result = await run(EgressPolicy(baseline_enabled=False))
        for probe in result["probes"]:
            columns = [
                probe["blocked_by_securevector"],
                probe["blocked_by_network"],
                probe["reached"],
            ]
            assert sum(bool(c) for c in columns) <= 1, f"{probe['id']} in two columns"

    @pytest.mark.asyncio
    async def test_control_probe_is_not_counted_as_dangerous(self, net):
        """The control is SUPPOSED to reach. Counting it as an escape would
        make every online machine report uncontained."""
        net({"control.public_read": True}, default=False)
        result = await run(EgressPolicy())
        assert result["summary"]["dangerous"] == result["summary"]["total"] - 1


class TestCoverageHonesty:
    @pytest.mark.asyncio
    async def test_states_tool_boundary_limitation(self, net):
        net({"control.public_read": True}, default=False)
        joined = " ".join((await run()) ["coverage"]).lower()
        assert "tool boundary" in joined
        assert "not a test of network-layer isolation" in joined

    @pytest.mark.asyncio
    async def test_states_mcp_proxy_gap(self, net):
        net({"control.public_read": True}, default=False)
        joined = " ".join((await run())["coverage"]).lower()
        assert "proxy" in joined

    @pytest.mark.asyncio
    async def test_states_canary_inference_limit(self, net):
        """We infer 'left the machine', not 'took path X'. Say so."""
        net({"control.public_read": True}, default=False)
        joined = " ".join((await run())["coverage"]).lower()
        assert "canary" in joined


class TestPreflight:
    """A tool that deliberately attempts egress looks like recon to EDR.

    Publishing exactly what it will do is what separates a self-test from
    something that gets the process quarantined.
    """

    def test_manifest_requires_user_initiation(self):
        assert cp.preflight_manifest()["requires_user_initiation"] is True

    def test_manifest_lists_every_destination(self):
        manifest = cp.preflight_manifest()
        probe_destinations = {p.url or p.host for p in cp._default_probes() if (p.url or p.host)}
        assert set(manifest["destinations"]) == probe_destinations

    def test_manifest_disclaims_writes(self):
        never = " ".join(cp.preflight_manifest()["never_does"]).lower()
        assert "publish" in never and "authenticate" in never

    def test_manifest_warns_about_edr(self):
        assert "edr" in cp.preflight_manifest()["note_for_endpoint_security"].lower()


class TestRobustness:
    @pytest.mark.asyncio
    async def test_probe_failure_does_not_raise(self, monkeypatch):
        def boom(probe):
            raise RuntimeError("network stack exploded")

        monkeypatch.setattr(cp, "_run_probe_sync", boom)
        # A probe blowing up must not take the whole proof down; enforcement
        # blocks the dangerous ones before they are attempted anyway.
        result = await cp.run_containment_proof(EgressPolicy())
        assert result["verdict"] in (
            cp.VERDICT_CONTAINED, cp.VERDICT_DEGRADED,
            cp.VERDICT_PARTIAL, cp.VERDICT_ERROR,
        )
