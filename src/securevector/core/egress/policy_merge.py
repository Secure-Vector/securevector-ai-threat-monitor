"""
Resolve the local egress policy against the org policy synced from the cloud.

The device holds two policies at once: the one the operator set locally and
the one the org pushed on the signed bundle. Neither replaces the other
wholesale, because each protects against something the other cannot.

The rule, in one line: **the org policy can only ever tighten, and the
operator can only ever tighten it further.**

That asymmetry is the whole point of org governance, and it decides each
field differently:

  * ``preset``   strictest of the two. The operator may run `contained` on a
                 laptop the org only asked to run `hardened` on; they may not
                 run `baseline` on one the org placed under `contained`.

  * ``denylist`` union. A deny is a tightening from whichever side authored
                 it, so both always apply.

  * ``allowlist`` **the org's list replaces the operator's** whenever the org
                 authored an egress policy at all. This is the one field where
                 a union would be actively unsafe: under `contained` the
                 allowlist *is* the set of permitted destinations, so a union
                 would let the governed operator self-grant any destination
                 and opt out of containment without the org ever seeing it.
                 Union here would make org containment advisory.

  * ``fail_closed`` / ``ci_profile`` / ``baseline_enabled`` stay local. They
                 describe how this machine behaves on evaluation errors and
                 whether it is a CI runner, which is a property of the host
                 rather than of org policy, and the cloud does not author them.

The replaced allowlist is the one part of this a user can be surprised by, so
`EgressPolicy.org_managed_allowlist` carries it out to the API and the page.
A control that silently drops the operator's allowlist while still rendering
it would be worse than no control at all.
"""

from __future__ import annotations

import logging
from typing import Optional

from securevector.core.egress.engine import (
    PRESET_BASELINE,
    VALID_PRESETS,
    EgressPolicy,
)

logger = logging.getLogger(__name__)

# Strictness order. Mirrors the cloud's EGRESS_PRESET_RANK in
# llm-security-engine `src/policy/bundle_builder.py`; if one side gains a
# preset the other does not know, the unknown value must not silently rank
# as the weakest, so it falls back to baseline loudly instead.
PRESET_RANK = {PRESET_BASELINE: 1, "hardened": 2, "contained": 3}


def _rank(preset: Optional[str]) -> int:
    if preset not in PRESET_RANK:
        if preset:
            logger.warning(
                "Unknown egress preset %r; treating as baseline", preset
            )
        return PRESET_RANK[PRESET_BASELINE]
    return PRESET_RANK[preset]


def _clean_hosts(raw) -> list:
    """Lowercase, de-duplicate and sort, dropping anything unusable.

    Degrading a bad entry to nothing is the safe direction for a denylist and
    the safe direction for an allowlist too: a dropped allowlist entry denies
    a destination, which is recoverable, where a malformed entry that matched
    too broadly would not be.
    """
    out = set()
    for entry in raw or []:
        host = str(entry).strip().lower().rstrip(".")
        if host:
            out.add(host)
    return sorted(out)


def synced_policy_from_bundle(egress: Optional[dict]) -> Optional[EgressPolicy]:
    """Build an EgressPolicy from a verified bundle's ``egress`` section.

    Returns None when the bundle carried no egress policy, which is distinct
    from an egress policy that happens to be empty: the former leaves local
    policy alone, the latter is an org policy of `baseline` with no hosts.
    """
    if not isinstance(egress, dict):
        return None

    preset = str(egress.get("preset") or PRESET_BASELINE).strip().lower()
    if preset not in VALID_PRESETS:
        logger.warning(
            "Synced egress policy has unknown preset %r; applying baseline. "
            "Host lists are still applied.",
            preset,
        )
        preset = PRESET_BASELINE

    sources = egress.get("sources") or []
    name = "Organization policy"
    version = None
    if isinstance(sources, list) and sources and isinstance(sources[0], dict):
        name = str(sources[0].get("policy_name") or name)
        raw_version = sources[0].get("policy_version")
        version = raw_version if isinstance(raw_version, int) else None

    return EgressPolicy(
        preset=preset,
        allowlist=_clean_hosts(egress.get("allowlist")),
        denylist=_clean_hosts(egress.get("denylist")),
        policy_name=name,
        policy_version=version,
        source="synced",
    )


def resolve_effective_policy(
    local: EgressPolicy,
    synced: Optional[EgressPolicy],
) -> EgressPolicy:
    """Combine the local and org policies into the one the engine evaluates.

    With no org policy this returns ``local`` unchanged, so a device that
    never enrolled behaves exactly as it did before sync existed.
    """
    if synced is None:
        return local

    effective_preset = (
        synced.preset if _rank(synced.preset) >= _rank(local.preset)
        else local.preset
    )

    dropped = sorted(set(_clean_hosts(local.allowlist)) - set(synced.allowlist))
    if dropped:
        # Worth a log line even though the UI shows it: this is the moment a
        # destination the operator had permitted stops being permitted, and
        # the first symptom otherwise is a blocked call with no explanation.
        logger.info(
            "Org egress policy replaces the local allowlist; %d local "
            "host(s) no longer permitted: %s",
            len(dropped),
            ", ".join(dropped[:5]),
        )

    return EgressPolicy(
        preset=effective_preset,
        # Org list wins outright. See the module docstring for why a union
        # would make containment opt-out.
        allowlist=list(synced.allowlist),
        denylist=_clean_hosts(list(local.denylist) + list(synced.denylist)),
        # Host-shaped settings the cloud does not author.
        fail_closed=local.fail_closed,
        ci_profile=local.ci_profile,
        baseline_enabled=local.baseline_enabled,
        policy_name=synced.policy_name,
        policy_version=synced.policy_version,
        source="synced",
        org_managed_allowlist=True,
        local_allowlist_suppressed=dropped,
    )
