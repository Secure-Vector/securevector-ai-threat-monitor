"""
Repository for `synced_bundle_envelope` (V31 migration).

Stores the raw signed bundle JSON + HS256 signature alongside the
extracted rules in `synced_tool_rules`. The cloud-sync loop calls
`save_envelope()` after every successful apply and `load_latest()`
on every iteration + on startup so the verifier can re-check the
signature without re-fetching from the cloud.

Lifecycle:
- Written by `cloud_sync._sync_once` immediately after
  `SyncedRulesRepository.replace_bundle()` succeeds.
- Read by `cloud_sync._verify_envelope_or_quarantine` at the top of
  every poll iteration and on app startup.
- Cleared on graceful unenroll alongside synced_tool_rules.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

from securevector.app.database.connection import DatabaseConnection

logger = logging.getLogger(__name__)


@dataclass
class SyncedBundleEnvelope:
    """One stored signed bundle. There is at most one active envelope
    per device (single-row table by convention — save_envelope wipes
    older bundle_ids on each apply so signature on disk always matches
    the rules in synced_tool_rules)."""

    bundle_id: str
    bundle_json: str
    signature: str
    signing_key_fingerprint: Optional[str]
    applied_at: str
    verified_at: str
    tampered_at: Optional[str]
    tamper_reason: Optional[str]


class SyncedBundleEnvelopeRepository:
    """CRUD over the synced_bundle_envelope table."""

    def __init__(self, db: DatabaseConnection):
        self.db = db

    async def save_envelope(
        self,
        *,
        bundle_id: str,
        bundle_json: str,
        signature: str,
        signing_key_fingerprint: Optional[str],
    ) -> None:
        """
        Replace the stored envelope with a fresh one. Old envelopes are
        discarded so the table always holds at most one row — the
        signature on disk must match the rules in synced_tool_rules.
        """
        conn = await self.db.connect()
        try:
            await conn.execute("DELETE FROM synced_bundle_envelope")
            await conn.execute(
                """
                INSERT INTO synced_bundle_envelope
                    (bundle_id, bundle_json, signature, signing_key_fingerprint,
                     applied_at, verified_at, tampered_at, tamper_reason)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL)
                """,
                (bundle_id, bundle_json, signature, signing_key_fingerprint),
            )
            await conn.commit()
        except Exception:
            await conn.rollback()
            raise

    async def load_latest(self) -> Optional[SyncedBundleEnvelope]:
        """Return the active envelope, or None if no bundle has been applied."""
        row = await self.db.fetch_one(
            "SELECT bundle_id, bundle_json, signature, signing_key_fingerprint, "
            "applied_at, verified_at, tampered_at, tamper_reason "
            "FROM synced_bundle_envelope LIMIT 1"
        )
        if not row:
            return None
        return SyncedBundleEnvelope(
            bundle_id=row["bundle_id"],
            bundle_json=row["bundle_json"],
            signature=row["signature"],
            signing_key_fingerprint=row["signing_key_fingerprint"],
            applied_at=str(row["applied_at"]),
            verified_at=str(row["verified_at"]),
            tampered_at=str(row["tampered_at"]) if row["tampered_at"] else None,
            tamper_reason=row["tamper_reason"],
        )

    async def mark_tampered(self, reason: str) -> None:
        """Stamp the envelope row as tampered so the UI surfaces the red
        banner and subsequent polls keep the rules suspended until the
        cloud pushes a fresh bundle."""
        conn = await self.db.connect()
        await conn.execute(
            "UPDATE synced_bundle_envelope SET tampered_at = CURRENT_TIMESTAMP, "
            "tamper_reason = ?",
            (reason,),
        )
        await conn.commit()

    async def clear(self) -> None:
        """Drop the envelope (used on unenroll and on tamper-recovery)."""
        conn = await self.db.connect()
        await conn.execute("DELETE FROM synced_bundle_envelope")
        await conn.commit()

    async def touch_verified(self) -> None:
        """Update verified_at on a successful re-verify pass. Cheap, runs
        every poll so the audit panel can show 'last verified Xs ago'."""
        conn = await self.db.connect()
        await conn.execute(
            "UPDATE synced_bundle_envelope SET verified_at = CURRENT_TIMESTAMP, "
            "tampered_at = NULL, tamper_reason = NULL"
        )
        await conn.commit()
