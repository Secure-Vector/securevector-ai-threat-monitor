"""
Tests for resolving a local egress policy against a synced org policy.

The property that matters most here is one-directional: the org policy can
tighten what the operator set, and the operator can tighten it further, but
neither can loosen the other. Every test below is a way that could break.

The allowlist-replacement tests are the load-bearing ones. If a union ever
creeps back in, `contained` becomes opt-out for anyone with access to their
own device, and nothing else in the system would notice.
"""

import pytest

from securevector.core.egress import EgressPolicy
from securevector.core.egress.policy_merge import (
    resolve_effective_policy,
    synced_policy_from_bundle,
)


def _local(**kw):
    return EgressPolicy(**{"policy_name": "local", "source": "local", **kw})


# --- no org policy ---------------------------------------------------------

def test_without_a_synced_policy_the_local_policy_is_returned_untouched():
    local = _local(preset="hardened", allowlist=["a.com"], denylist=["b.com"])
    assert resolve_effective_policy(local, None) is local


def test_a_bundle_without_an_egress_section_yields_no_synced_policy():
    # Absence must stay distinguishable from an empty policy, or an org that
    # never configured egress would silently wipe the local allowlist.
    assert synced_policy_from_bundle(None) is None
    assert synced_policy_from_bundle("not a dict") is None


def test_an_empty_egress_section_is_a_real_policy_not_an_absent_one():
    synced = synced_policy_from_bundle({"preset": "baseline"})
    assert synced is not None
    assert synced.preset == "baseline"
    assert synced.source == "synced"


# --- preset: strictest wins, in both directions ----------------------------

@pytest.mark.parametrize(
    "local_preset,org_preset,expected",
    [
        ("baseline", "contained", "contained"),   # org tightens
        ("baseline", "hardened", "hardened"),
        ("contained", "baseline", "contained"),   # operator stays stricter
        ("hardened", "baseline", "hardened"),
        ("hardened", "contained", "contained"),
        ("contained", "contained", "contained"),
    ],
)
def test_strictest_preset_wins(local_preset, org_preset, expected):
    effective = resolve_effective_policy(
        _local(preset=local_preset),
        EgressPolicy(preset=org_preset, source="synced"),
    )
    assert effective.preset == expected


def test_an_org_policy_cannot_downgrade_a_stricter_local_preset():
    # The governance direction people expect is org-over-local. This asserts
    # the other half: a permissive org policy must not relax a careful
    # operator's machine.
    effective = resolve_effective_policy(
        _local(preset="contained"),
        EgressPolicy(preset="baseline", source="synced"),
    )
    assert effective.preset == "contained"


def test_unknown_org_preset_does_not_rank_as_strictest():
    # A preset this device does not understand must not win by accident.
    effective = resolve_effective_policy(
        _local(preset="hardened"),
        EgressPolicy(preset="paranoid", source="synced"),
    )
    assert effective.preset == "hardened"


# --- allowlist: org replaces local ----------------------------------------

def test_org_allowlist_replaces_the_local_one():
    effective = resolve_effective_policy(
        _local(allowlist=["local-only.com", "shared.com"]),
        EgressPolicy(allowlist=["org.com", "shared.com"], source="synced"),
    )
    assert effective.allowlist == ["org.com", "shared.com"]


def test_a_local_allowlist_cannot_widen_org_containment():
    # The reason replacement exists at all. A union here would let the
    # governed user grant themselves any destination under `contained`.
    effective = resolve_effective_policy(
        _local(preset="contained", allowlist=["exfil.example"]),
        EgressPolicy(
            preset="contained", allowlist=["github.com"], source="synced"
        ),
    )
    assert "exfil.example" not in effective.allowlist
    assert effective.allowlist == ["github.com"]


def test_an_empty_org_allowlist_still_replaces_a_populated_local_one():
    effective = resolve_effective_policy(
        _local(allowlist=["a.com"]),
        EgressPolicy(preset="contained", allowlist=[], source="synced"),
    )
    assert effective.allowlist == []


def test_suppressed_local_hosts_are_reported_not_discarded_silently():
    effective = resolve_effective_policy(
        _local(allowlist=["gone.com", "also-gone.com", "kept.com"]),
        EgressPolicy(allowlist=["kept.com"], source="synced"),
    )
    assert effective.org_managed_allowlist is True
    assert effective.local_allowlist_suppressed == ["also-gone.com", "gone.com"]


def test_nothing_is_reported_suppressed_when_the_org_covers_every_local_host():
    effective = resolve_effective_policy(
        _local(allowlist=["a.com"]),
        EgressPolicy(allowlist=["a.com", "b.com"], source="synced"),
    )
    assert effective.local_allowlist_suppressed == []


# --- denylist: union, because a deny only ever tightens --------------------

def test_denylists_union_from_both_sides():
    effective = resolve_effective_policy(
        _local(denylist=["local-bad.com"]),
        EgressPolicy(denylist=["org-bad.com"], source="synced"),
    )
    assert effective.denylist == ["local-bad.com", "org-bad.com"]


def test_a_local_denial_survives_an_org_allow_of_the_same_host():
    # The operator must be able to refuse a destination their org permits.
    # The engine reads the denylist first, so carrying both is the mechanism.
    effective = resolve_effective_policy(
        _local(denylist=["risky.com"]),
        EgressPolicy(allowlist=["risky.com"], source="synced"),
    )
    assert "risky.com" in effective.denylist
    assert "risky.com" in effective.allowlist


# --- host-shaped local settings are not org business -----------------------

def test_machine_settings_stay_local():
    effective = resolve_effective_policy(
        _local(fail_closed=True, ci_profile=True, baseline_enabled=False),
        EgressPolicy(preset="contained", source="synced"),
    )
    assert effective.fail_closed is True
    assert effective.ci_profile is True
    assert effective.baseline_enabled is False


# --- attribution -----------------------------------------------------------

def test_effective_policy_is_attributed_to_the_org():
    effective = resolve_effective_policy(
        _local(),
        EgressPolicy(
            preset="hardened", policy_name="Contractor laptops",
            policy_version=7, source="synced",
        ),
    )
    assert effective.source == "synced"
    assert effective.policy_name == "Contractor laptops"
    assert effective.policy_version == 7


def test_bundle_section_maps_onto_a_policy_with_provenance():
    synced = synced_policy_from_bundle({
        "preset": "contained",
        "allowlist": ["GitHub.com", "pypi.org"],
        "denylist": ["paste.example"],
        "sources": [{
            "policy_id": "pol_1", "policy_name": "Locked down",
            "policy_version": 3, "preset": "contained",
        }],
    })
    assert synced.preset == "contained"
    assert synced.allowlist == ["github.com", "pypi.org"]   # normalised
    assert synced.denylist == ["paste.example"]
    assert synced.policy_name == "Locked down"
    assert synced.policy_version == 3


def test_unknown_bundle_preset_keeps_the_host_lists():
    # Dropping the destinations because the preset was unreadable would be a
    # policy that reports as applied while permitting nothing.
    synced = synced_policy_from_bundle(
        {"preset": "paranoid", "allowlist": ["a.com"]}
    )
    assert synced.preset == "baseline"
    assert synced.allowlist == ["a.com"]
