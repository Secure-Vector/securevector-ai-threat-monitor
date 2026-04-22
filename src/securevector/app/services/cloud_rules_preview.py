"""
Preview-then-apply cloud rule sync.

The plain `sync_rules_from_cloud()` flow pulls, normalizes, and writes
to SQLite in one shot. The UI needs something different: the user
clicks *Sync from Cloud*, sees every rule the cloud is offering
(paginated), and only then decides to persist. This module adds that
workflow.

Flow:

    1. UI → POST /rules/sync/preview
       - fetch from rules-builder
       - normalize every rule (same rules as `cloud_rules_sync`)
       - stash the normalized list in a process-local TTL cache keyed
         by a random `preview_token`
       - return summary + token (no rule list yet — it'd be huge)
    2. UI → GET /rules/sync/preview/{token}?page=1&per_page=10
       - paginate the cached list for review
    3. UI → POST /rules/sync/apply  {token, replace_existing}
       - upsert the exact rules the user reviewed
       - drop the preview from cache

Why process-local cache and not SQLite:
  - Single-user desktop app, single process; no cross-worker sharing needed.
  - Preview lifetime is short (~10 min) — SQLite would need its own cleanup.
  - Kept bounded (MAX_PREVIEWS) so a repeatedly-clicking user can't OOM.
"""

from __future__ import annotations

import logging
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.rules import RulesRepository
from securevector.app.database.repositories.settings import SettingsRepository
from securevector.app.services.cloud_proxy import CloudProxyError, get_cloud_proxy
from securevector.app.services.cloud_rules_sync import (
    CloudRulesSyncError,
    _extract_rule_list,
    _normalize_rule,
)

logger = logging.getLogger(__name__)

PREVIEW_TTL_SECONDS = 10 * 60
MAX_PREVIEWS = 8  # keep the cache small — previews are heavy


@dataclass
class _PreviewEntry:
    token: str
    created_at: float
    expires_at: float
    bundle_version: str | None
    compiled_at: str | None
    tier: str | None
    fetched: int
    skipped: int
    rules: list[dict[str, Any]] = field(default_factory=list)


_preview_cache: dict[str, _PreviewEntry] = {}


def _purge_expired(now: float | None = None) -> None:
    now = now or time.time()
    expired = [tok for tok, e in _preview_cache.items() if e.expires_at <= now]
    for tok in expired:
        _preview_cache.pop(tok, None)


def _enforce_max_size() -> None:
    # If we're over the cap, evict the oldest previews.
    while len(_preview_cache) > MAX_PREVIEWS:
        oldest_token = min(_preview_cache, key=lambda t: _preview_cache[t].created_at)
        _preview_cache.pop(oldest_token, None)


async def create_preview() -> dict[str, Any]:
    """Fetch+normalize a cloud bundle and cache it for subsequent review.

    Raises:
        CloudRulesSyncError: cloud mode off, no creds, cloud unreachable,
        or the response didn't contain a rule list.
    """
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

    raw_rules = _extract_rule_list(envelope)
    if not isinstance(raw_rules, list):
        raise CloudRulesSyncError(
            "Cloud rules response did not contain a rule list."
        )

    normalized: list[dict[str, Any]] = []
    skipped = 0
    for raw in raw_rules:
        if not isinstance(raw, dict):
            skipped += 1
            continue
        norm = _normalize_rule(raw)
        if norm is None:
            skipped += 1
            continue
        normalized.append(norm)

    _purge_expired()
    now = time.time()
    token = secrets.token_urlsafe(24)
    entry = _PreviewEntry(
        token=token,
        created_at=now,
        expires_at=now + PREVIEW_TTL_SECONDS,
        bundle_version=envelope.get("bundle_version") if isinstance(envelope, dict) else None,
        compiled_at=envelope.get("compiled_at") if isinstance(envelope, dict) else None,
        tier=envelope.get("tier") if isinstance(envelope, dict) else None,
        fetched=len(raw_rules),
        skipped=skipped,
        rules=normalized,
    )
    _preview_cache[token] = entry
    _enforce_max_size()

    # Token intentionally NOT logged — even a prefix leaks selection
    # capability to anyone who reads local log files.
    logger.info(
        f"cloud_rules_preview: created preview fetched={entry.fetched} "
        f"normalized={len(entry.rules)} skipped={entry.skipped}"
    )

    return {
        "preview_token": token,
        "expires_at": datetime.fromtimestamp(entry.expires_at, tz=timezone.utc).isoformat(),
        "bundle_version": entry.bundle_version,
        "compiled_at": entry.compiled_at,
        "tier": entry.tier,
        "fetched": entry.fetched,
        "normalized": len(entry.rules),
        "skipped": entry.skipped,
        # Full rule_id list so the UI can implement "Select all" and
        # "Clear selection" without paging through the server. ~20 KB
        # for 500 rules — fine over loopback.
        "all_rule_ids": [r["rule_id"] for r in entry.rules],
    }


def _require_entry(token: str) -> _PreviewEntry:
    _purge_expired()
    entry = _preview_cache.get(token)
    if entry is None:
        raise CloudRulesSyncError(
            "Preview not found or expired. Please re-sync from cloud."
        )
    return entry


def get_preview_page(token: str, page: int, per_page: int) -> dict[str, Any]:
    """Return one page of the cached preview for UI review."""
    if page < 1:
        page = 1
    if per_page not in (10, 25, 50, 100):
        per_page = 10  # prevent arbitrary page sizes

    entry = _require_entry(token)
    total = len(entry.rules)
    start = (page - 1) * per_page
    end = start + per_page
    page_rules = entry.rules[start:end]

    # Return a lean projection — the full normalized row has metadata dicts
    # that are noisy in the UI. `patterns_preview` is capped at 3 for the
    # collapsed view; `patterns` carries the full list so the UI can
    # expand a row without a follow-up fetch.
    items = [
        {
            "rule_id": r["rule_id"],
            "name": r["name"],
            "category": r["category"],
            "severity": r["severity"],
            "description": r["description"][:240],
            "pattern_count": len(r["patterns"]),
            "patterns_preview": r["patterns"][:3],
            "patterns": r["patterns"],
            "source_tier": r.get("metadata", {}).get("tier"),
        }
        for r in page_rules
    ]

    total_pages = (total + per_page - 1) // per_page if per_page else 1
    return {
        "preview_token": token,
        "page": page,
        "per_page": per_page,
        "total": total,
        "total_pages": total_pages,
        "bundle_version": entry.bundle_version,
        "items": items,
    }


async def apply_preview(
    token: str,
    replace_existing: bool,
    *,
    skip_rule_ids: Optional[list[str]] = None,
    selected_rule_ids: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Persist the cached preview to `community_rules`, then drop it.

    Filtering model — three mutually exclusive modes, resolved in order:

      1. ``selected_rule_ids`` is a non-None list → apply **only** those
         rule IDs. An empty list applies nothing (user deselected all).
      2. ``skip_rule_ids`` is a non-None list → apply everything **except**
         those rule IDs. Typically how the UI sends partial selections,
         since the client only needs to track which rules the user
         unchecked rather than the full set of kept ones.
      3. Neither is provided → apply the whole cached bundle (the
         default "Save all" / "Apply all N rules" flow).

    If both are provided the selected list wins and the skip list is
    ignored (keeps the server's contract unambiguous).
    """
    started_at = datetime.now(timezone.utc).isoformat()
    entry = _require_entry(token)

    db = get_database()
    repo = RulesRepository(db)

    # Resolve which rules to persist.
    rules_to_apply: list[dict[str, Any]]
    if selected_rule_ids is not None:
        keep = set(selected_rule_ids)
        rules_to_apply = [r for r in entry.rules if r["rule_id"] in keep]
    elif skip_rule_ids:
        drop = set(skip_rule_ids)
        rules_to_apply = [r for r in entry.rules if r["rule_id"] not in drop]
    else:
        rules_to_apply = list(entry.rules)

    skipped = len(entry.rules) - len(rules_to_apply)

    if replace_existing:
        removed = await repo.clear_community_rules()
        logger.info(f"cloud_rules_preview: cleared {removed} existing community rule(s)")

    upserted = 0
    for rule in rules_to_apply:
        try:
            await repo.cache_community_rule(**rule)
            upserted += 1
        except Exception as e:
            # A single bad row shouldn't kill the whole apply — match
            # sync_rules_from_cloud's behavior.
            logger.warning(
                f"cloud_rules_preview: failed to upsert rule id={rule['rule_id']}: {e}"
            )

    # Fresh count for the UI
    total_after = 0
    try:
        row = await db.fetch_one("SELECT COUNT(*) AS n FROM community_rules")
        total_after = int(row["n"]) if row else 0
    except Exception:
        total_after = upserted

    # Preview is consumed — drop it so the same token can't be replayed.
    _preview_cache.pop(token, None)

    result = {
        "ok": True,
        "started_at": started_at,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "preview_token": token,
        "bundle_version": entry.bundle_version,
        "normalized": len(entry.rules),
        "selected": len(rules_to_apply),
        "skipped_by_user": skipped,
        "upserted": upserted,
        "replaced_existing": replace_existing,
        "total_after": total_after,
        "source": "cloud_sync_preview",
    }
    logger.info(f"cloud_rules_preview: applied {result}")
    return result


def discard_preview(token: str) -> bool:
    """Drop a preview without applying. Returns True if it existed."""
    return _preview_cache.pop(token, None) is not None
