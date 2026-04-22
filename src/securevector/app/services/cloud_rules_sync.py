"""
Pull-from-cloud rule sync (cloud → local).

Fetches the customer's rule bundle from the cloud API via
`CloudProxyService.get_rules()` and upserts each rule into the local
`community_rules` cache. This is the *policy-pull* direction of the
bidirectional pattern:

    cloud → local      — rules / policy / threat-intel feed (this module)
    local → cloud      — metadata-only scan events (cloud_sync_forwarder)

Why local-initiated (never cloud-push):
  - Cloud can't open inbound connections to behind-NAT / home / corp-VPN
    installs.
  - The local app decides when to apply new rules (auditable, reproducible,
    dry-run friendly).
  - Matches every EDR/SIEM/agent peer (CrowdStrike, SentinelOne, Wazuh,
    Splunk UF, Datadog Agent — all pull policy).

Preconditions for a successful sync:
  - Cloud Mode is enabled (`app_settings.cloud_mode_enabled`).
  - An API key + bearer token are configured via the usual Cloud Connect
    flow (see `cloud_proxy` / `credentials`).

The /api/rules payload from the cloud is expected to carry a list of rules
under `rules` (or similar). We defensively accept a few common shapes so
this module doesn't break if the cloud adds envelope fields.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.rules import RulesRepository
from securevector.app.database.repositories.settings import SettingsRepository
from securevector.app.services.cloud_proxy import CloudProxyError, get_cloud_proxy

logger = logging.getLogger(__name__)


class CloudRulesSyncError(Exception):
    """Raised when a cloud → local rule sync cannot be completed."""


def _normalize_rule(raw: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Normalize one cloud-rule dict into the columns `cache_community_rule` expects.

    Returns None if the rule is missing a required field (id, name, category,
    severity, patterns) — caller skips those and logs a warning, so one bad
    row never poisons the whole sync.
    """
    rule_id = raw.get("id") or raw.get("rule_id")
    name = raw.get("name") or raw.get("rule_name")
    category = raw.get("category")
    description = raw.get("description") or ""
    severity = (raw.get("severity") or "").lower()
    patterns = raw.get("patterns") or raw.get("matched_patterns") or []

    if not rule_id or not name or not category or severity not in {"low", "medium", "high", "critical"}:
        return None
    if not isinstance(patterns, list):
        # Cloud sometimes ships a single pattern as a string — accept that.
        patterns = [str(patterns)] if patterns else []
    if not patterns:
        # A rule with zero patterns is a no-op locally; skip it.
        return None

    return {
        "rule_id": str(rule_id),
        "name": str(name),
        "category": str(category),
        "description": str(description),
        "severity": severity,
        "patterns": [str(p) for p in patterns],
        "source_file": None,
        "metadata": {
            "source": "cloud_sync",
            "synced_at": datetime.now(timezone.utc).isoformat(),
            **{
                k: raw[k]
                for k in ("tier", "updated_at", "version")
                if k in raw
            },
        },
    }


def _extract_rule_list(envelope: Any) -> list[dict[str, Any]]:
    """Best-effort extraction of the rule list from an unknown envelope shape."""
    if isinstance(envelope, list):
        return envelope
    if isinstance(envelope, dict):
        # Most common keys the cloud might use
        for key in ("rules", "data", "items", "results"):
            value = envelope.get(key)
            if isinstance(value, list):
                return value
        # {"community": [...], "professional": [...]} style
        collected: list[dict[str, Any]] = []
        for value in envelope.values():
            if isinstance(value, list) and value and isinstance(value[0], dict):
                collected.extend(value)
        if collected:
            return collected
    return []


async def sync_rules_from_cloud(
    *,
    replace_existing: bool = False,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Pull rules from the cloud and upsert them into `community_rules`.

    Args:
        replace_existing: If True, `DELETE FROM community_rules` first so the
            local cache becomes an exact mirror of the cloud bundle. Default
            False — upsert merges, preserving any local-only entries.
        dry_run: If True, fetch and normalize but don't write to SQLite.
            Returns the would-be stats so the UI can preview the sync.

    Returns:
        dict with keys:
          - ok                 (bool)
          - started_at         (iso timestamp)
          - finished_at        (iso timestamp)
          - fetched            (int) rules fetched from cloud
          - normalized         (int) rules that passed validation
          - skipped            (int) rules rejected for missing fields
          - upserted           (int) rows written to community_rules
          - dry_run            (bool)
          - replaced_existing  (bool)
          - total_after        (int) total rules in local cache after sync
          - source             'cloud_sync'

    Raises:
        CloudRulesSyncError — cloud mode off, no credentials, cloud unreachable,
        or the response doesn't contain a rule list. Caller maps to HTTP code.
    """
    started_at = datetime.now(timezone.utc).isoformat()

    db = get_database()
    settings = await SettingsRepository(db).get()
    if not settings.cloud_mode_enabled:
        raise CloudRulesSyncError(
            "Cloud Mode is off. Enable Cloud Connect before syncing rules."
        )

    try:
        proxy = get_cloud_proxy()
        envelope = await proxy.get_rules()
    except CloudProxyError as e:
        raise CloudRulesSyncError(f"Cloud rules fetch failed: {e}") from e
    except Exception as e:
        raise CloudRulesSyncError(f"Unexpected error fetching cloud rules: {e}") from e

    raw_rules = _extract_rule_list(envelope)
    if not isinstance(raw_rules, list):
        raise CloudRulesSyncError(
            "Cloud /api/rules response did not contain a rule list."
        )

    fetched = len(raw_rules)
    normalized_rules: list[dict[str, Any]] = []
    skipped = 0
    for raw in raw_rules:
        if not isinstance(raw, dict):
            skipped += 1
            continue
        normalized = _normalize_rule(raw)
        if normalized is None:
            skipped += 1
            continue
        normalized_rules.append(normalized)

    if skipped:
        logger.info(
            f"cloud_rules_sync: skipped {skipped} rule(s) with missing or invalid fields"
        )

    upserted = 0
    if not dry_run:
        repo = RulesRepository(db)
        if replace_existing:
            removed = await repo.clear_community_rules()
            logger.info(f"cloud_rules_sync: cleared {removed} existing community rule(s)")
        for rule in normalized_rules:
            try:
                await repo.cache_community_rule(**rule)
                upserted += 1
            except Exception as e:  # defensive — never let one bad row kill the sync
                logger.warning(
                    f"cloud_rules_sync: failed to upsert rule id={rule['rule_id']}: {e}"
                )

    # Fresh count so the UI can render the new total without another round-trip
    total_after = 0
    try:
        count_row = await db.fetch_one("SELECT COUNT(*) AS n FROM community_rules")
        total_after = int(count_row["n"]) if count_row else 0
    except Exception:
        total_after = len(normalized_rules)

    result = {
        "ok": True,
        "started_at": started_at,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "fetched": fetched,
        "normalized": len(normalized_rules),
        "skipped": skipped,
        "upserted": upserted,
        "dry_run": dry_run,
        "replaced_existing": replace_existing,
        "total_after": total_after,
        "source": "cloud_sync",
    }
    logger.info(f"cloud_rules_sync: {result}")
    return result
