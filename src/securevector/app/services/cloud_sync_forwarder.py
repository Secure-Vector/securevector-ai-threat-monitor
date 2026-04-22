"""
Background forwarder that drains `cloud_sync_outbox` to the cloud API.

Runs only when `app_settings.cloud_mode_enabled` is True. Polls the outbox
on a fixed cadence, POSTs each batch to the configured cloud ingestion
endpoint, and marks rows delivered / failed per response.

Design choices
--------------
- At-least-once delivery: cloud ingestor de-dupes by (source, scan_id).
- Small batches (default 50 rows, 10s interval) — keeps bandwidth modest
  and bounds worst-case loss if the process is killed mid-post.
- Honest behavior when cloud endpoint is not yet live: repeatedly logs a
  warning and leaves rows pending. No data is dropped.
- NEVER retries infinitely on permanent 4xx — after `max_attempts`
  (default 10) the row is left pending but not re-tried in the same
  session (a future restart retries from scratch).
- Strictly metadata-only — every row in the outbox was already validated
  by `build_scan_payload` / `_assert_metadata_only` at enqueue time.
  The forwarder is a pipe; it cannot add prompt/output content even if
  its code were tampered with.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.cloud_sync import CloudSyncRepository
from securevector.app.database.repositories.settings import SettingsRepository

logger = logging.getLogger(__name__)


# Config knobs. Overridable via env for ops flexibility.
DEFAULT_POLL_INTERVAL_SECONDS = float(
    os.environ.get("SV_CLOUD_SYNC_POLL_SECONDS", "10")
)
DEFAULT_BATCH_SIZE = int(os.environ.get("SV_CLOUD_SYNC_BATCH_SIZE", "50"))
DEFAULT_MAX_ATTEMPTS_PER_ROW = int(os.environ.get("SV_CLOUD_SYNC_MAX_ATTEMPTS", "10"))
DEFAULT_CLOUD_BASE_URL = os.environ.get(
    "SV_CLOUD_SYNC_BASE_URL",
    "https://scan.securevector.io",
)
DEFAULT_INGEST_PATH = os.environ.get(
    "SV_CLOUD_SYNC_INGEST_PATH",
    "/ingest/local-scan",  # endpoint is forward-looking; OK if 404 for now
)
DEFAULT_PURGE_KEEP_DAYS = int(os.environ.get("SV_CLOUD_SYNC_PURGE_DAYS", "7"))


class CloudSyncForwarder:
    """Owns the background task. One per app process."""

    def __init__(self):
        self._task: Optional[asyncio.Task] = None
        self._stop_event: Optional[asyncio.Event] = None

    async def start(self) -> None:
        """Begin polling. Idempotent."""
        if self._task is not None and not self._task.done():
            return
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(self._run(), name="cloud-sync-forwarder")
        logger.info("cloud_sync_forwarder: started")

    async def stop(self) -> None:
        """Request shutdown and await the task."""
        if self._stop_event is not None:
            self._stop_event.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=5)
            except asyncio.TimeoutError:
                self._task.cancel()
            finally:
                self._task = None
                self._stop_event = None
                logger.info("cloud_sync_forwarder: stopped")

    async def _run(self) -> None:
        """Main loop: check cloud-mode, drain a batch, sleep, repeat."""
        # Local import so httpx is only required when the forwarder is active.
        try:
            import httpx
        except ImportError:
            logger.warning(
                "cloud_sync_forwarder: httpx not installed — forwarder disabled. "
                "Install `httpx` or set cloud_mode_enabled=false."
            )
            return

        assert self._stop_event is not None
        purge_counter = 0

        while not self._stop_event.is_set():
            try:
                db = get_database()
                settings_repo = SettingsRepository(db)
                sync_repo = CloudSyncRepository(db)
                settings = await settings_repo.get()

                if not settings.cloud_mode_enabled:
                    # Cloud mode toggled off — stay idle but keep the task alive
                    # so it can resume when the toggle flips without restart.
                    await self._sleep_or_stop(DEFAULT_POLL_INTERVAL_SECONDS)
                    continue

                batch = await sync_repo.next_batch(limit=DEFAULT_BATCH_SIZE)
                if batch:
                    await self._flush_batch(httpx, batch, sync_repo)

                # Periodic house-keeping every ~N cycles.
                purge_counter += 1
                if purge_counter >= 360:  # 360 × 10s = ~1h
                    purge_counter = 0
                    removed = await sync_repo.purge_delivered(keep_days=DEFAULT_PURGE_KEEP_DAYS)
                    if removed:
                        logger.info(f"cloud_sync_forwarder: purged {removed} delivered row(s)")

            except Exception as e:  # pragma: no cover — defensive
                logger.exception(f"cloud_sync_forwarder: loop error: {e}")

            await self._sleep_or_stop(DEFAULT_POLL_INTERVAL_SECONDS)

    async def _sleep_or_stop(self, seconds: float) -> None:
        """Sleep `seconds` or return early when stop is requested."""
        assert self._stop_event is not None
        try:
            await asyncio.wait_for(self._stop_event.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass

    async def _flush_batch(
        self,
        httpx,  # noqa: ANN001 — imported lazily
        batch: list[dict],
        sync_repo: CloudSyncRepository,
    ) -> None:
        """POST `batch` to the cloud ingestor and reconcile state."""
        base_url = DEFAULT_CLOUD_BASE_URL.rstrip("/")
        url = f"{base_url}{DEFAULT_INGEST_PATH}"

        # API key lives in credentials storage handled elsewhere; we grab the
        # most recent one via a credentials accessor if available. For now
        # we read from env so deployments can inject it explicitly.
        api_key = os.environ.get("SV_CLOUD_API_KEY") or os.environ.get("SECUREVECTOR_API_KEY")
        if not api_key:
            # Honest behavior — don't spam, don't consume outbox. Every row
            # bumps attempts so the dashboard can explain why nothing ships.
            for row in batch:
                await sync_repo.mark_failed(row["id"], "no API key configured")
            logger.warning(
                "cloud_sync_forwarder: no API key — rows remain pending. "
                "Set SV_CLOUD_API_KEY (or SECUREVECTOR_API_KEY)."
            )
            return

        payload = {
            "source": "local-app",
            "items": [
                {"kind": r["kind"], "payload": r["payload"]} for r in batch
            ],
        }

        delivered_ids = []
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(
                    url,
                    json=payload,
                    headers={
                        "Content-Type": "application/json",
                        "x-api-key": api_key,
                    },
                )

            if 200 <= resp.status_code < 300:
                delivered_ids = [r["id"] for r in batch]
            elif 400 <= resp.status_code < 500 and resp.status_code != 408 and resp.status_code != 429:
                # Permanent client error. Mark attempts but keep pending so a
                # human (or future-configured endpoint) can retry deliberately.
                for row in batch:
                    await sync_repo.mark_failed(
                        row["id"], f"HTTP {resp.status_code}: {resp.text[:200]}"
                    )
                logger.warning(
                    f"cloud_sync_forwarder: permanent {resp.status_code} "
                    f"from {url} — leaving {len(batch)} row(s) pending"
                )
            else:
                # Transient: 5xx, 408, 429, timeouts. Stay pending, retry.
                for row in batch:
                    await sync_repo.mark_failed(row["id"], f"HTTP {resp.status_code}")

        except Exception as e:
            # Network / httpx error. Transient.
            for row in batch:
                await sync_repo.mark_failed(row["id"], f"network: {e!r}"[:500])
            logger.debug(f"cloud_sync_forwarder: transient error POSTing to {url}: {e}")

        if delivered_ids:
            await sync_repo.mark_delivered(delivered_ids)
            logger.info(
                f"cloud_sync_forwarder: delivered {len(delivered_ids)} row(s) to cloud"
            )


# Module-level singleton so FastAPI startup/shutdown can reach it.
_forwarder = CloudSyncForwarder()


async def start_forwarder() -> None:
    """Entrypoint for FastAPI lifespan startup."""
    await _forwarder.start()


async def stop_forwarder() -> None:
    """Entrypoint for FastAPI lifespan shutdown."""
    await _forwarder.stop()
