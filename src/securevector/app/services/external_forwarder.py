"""
External SIEM forwarder service.

One ``asyncio.Task`` iterates over every enabled destination in
``external_forwarders``, drains a small batch from each destination's
outbox slice, encodes as OCSF 1.3.0, hands off to the per-kind
translator, and POSTs. Runs independently of cloud mode — customers
without SecureVector Cloud still use SIEM export.

Design choices (and why they differ from cloud_sync_forwarder)
-------------------------------------------------------------

- **Multiple destinations, independent queues.** A failing Datadog
  destination never slows Splunk. Each destination has its own poll
  cycle within the shared tick.
- **Per-destination circuit breaker.** ``consecutive_fails`` on the
  config row drives exponential backoff (1 min → 1 hr cap). A broken
  destination idles instead of hammering itself into submission.
- **Drop rows that exceed max_attempts.** cloud_sync leaves them
  pending (the cloud is our own service, we want to fix it and catch
  up); a broken customer SIEM might be broken forever. Better to lose
  the tail than grow the queue unbounded.
- **Secret resolution at send time.** Secrets never live in the loop
  variables; they are fetched from ``forwarder_secrets`` per delivery
  and passed via the auth header, then discarded.
- **Metadata-only enforcement is upstream.** Every outbox row was
  already validated by ``_assert_metadata_only`` at enqueue time. The
  forwarder is a pipe; it cannot add prompt / output / reasoning text
  even if its code were tampered with.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Optional

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.external_forwarders import (
    ExternalForwardersRepository,
    ExternalForwardOutboxRepository,
)
from securevector.app.services import forwarder_secrets, siem_ocsf

logger = logging.getLogger(__name__)


POLL_INTERVAL_SECONDS = float(os.environ.get("SV_SIEM_POLL_SECONDS", "10"))
BATCH_SIZE = int(os.environ.get("SV_SIEM_BATCH_SIZE", "50"))
MAX_ATTEMPTS_PER_ROW = int(os.environ.get("SV_SIEM_MAX_ATTEMPTS", "10"))
PURGE_KEEP_DAYS = int(os.environ.get("SV_SIEM_PURGE_DAYS", "7"))
REQUEST_TIMEOUT_SECONDS = float(os.environ.get("SV_SIEM_HTTP_TIMEOUT", "15"))

# Circuit breaker knobs — exponential backoff per destination
_BREAKER_TRIP_AFTER = 5  # consecutive failures before backing off
_BREAKER_BASE_SECONDS = 60.0
_BREAKER_CAP_SECONDS = 60.0 * 60.0  # 1 hour cap


class ExternalForwarderService:
    """Owns one asyncio task that fans out to N destinations."""

    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self._stop_event: Optional[asyncio.Event] = None
        # Map of forwarder_id → asyncio-monotonic time at which this
        # destination is eligible to send again (circuit breaker).
        self._breaker_until: dict[int, float] = {}

    async def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(self._run(), name="external-forwarder")
        logger.info("external_forwarder: started")

    async def stop(self) -> None:
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
                logger.info("external_forwarder: stopped")

    async def _run(self) -> None:
        try:
            import httpx
        except ImportError:
            logger.warning(
                "external_forwarder: httpx not installed — SIEM export disabled."
            )
            return

        assert self._stop_event is not None
        purge_counter = 0

        while not self._stop_event.is_set():
            try:
                db = get_database()
                fwds_repo = ExternalForwardersRepository(db)
                outbox_repo = ExternalForwardOutboxRepository(db)

                active = await fwds_repo.list_active()
                if active:
                    await self._tick_all(httpx, active, fwds_repo, outbox_repo)

                purge_counter += 1
                if purge_counter >= 360:  # ~1 hour at 10s cadence
                    purge_counter = 0
                    removed = await outbox_repo.purge_delivered(keep_days=PURGE_KEEP_DAYS)
                    if removed:
                        logger.info(f"external_forwarder: purged {removed} delivered row(s)")

            except Exception as e:
                logger.exception(f"external_forwarder: loop error: {e}")

            await self._sleep_or_stop(POLL_INTERVAL_SECONDS)

    async def _sleep_or_stop(self, seconds: float) -> None:
        assert self._stop_event is not None
        try:
            await asyncio.wait_for(self._stop_event.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass  # stop event did not fire within sleep timeout; normal tick progression

    async def _tick_all(
        self,
        httpx,
        active: list[dict[str, Any]],
        fwds_repo: ExternalForwardersRepository,
        outbox_repo: ExternalForwardOutboxRepository,
    ) -> None:
        now_mono = asyncio.get_event_loop().time()
        for fwd in active:
            fid = int(fwd["id"])
            # Circuit breaker: skip this destination if still cooling off.
            if self._breaker_until.get(fid, 0.0) > now_mono:
                continue

            # Drop rows that have been retried past the limit — prevents
            # unbounded queue growth when a destination is permanently dead.
            removed = await outbox_repo.drop_exceeded(fid, max_attempts=MAX_ATTEMPTS_PER_ROW)
            if removed:
                logger.warning(
                    f"external_forwarder: dropped {removed} row(s) for "
                    f"forwarder id={fid} (exceeded {MAX_ATTEMPTS_PER_ROW} attempts)"
                )

            batch = await outbox_repo.next_batch(fid, limit=BATCH_SIZE)
            if not batch:
                continue

            await self._deliver(httpx, fwd, batch, fwds_repo, outbox_repo)

    async def _deliver(
        self,
        httpx,
        fwd: dict[str, Any],
        batch: list[dict[str, Any]],
        fwds_repo: ExternalForwardersRepository,
        outbox_repo: ExternalForwardOutboxRepository,
    ) -> None:
        fid = int(fwd["id"])
        kind = fwd["kind"]
        url = fwd["url"]
        ids = [int(r["id"]) for r in batch]

        redaction = fwd.get("redaction_level") or "standard"
        events = siem_ocsf.encode_batch(batch, redaction=redaction)

        # `file` is a local NDJSON append — no HTTP, no translator, no
        # auth. Keeps the same outbox / breaker / delivered accounting
        # as network destinations so health views are uniform.
        if kind == "file":
            await self._deliver_to_file(fwd, events, ids, fwds_repo, outbox_repo)
            return

        translator = siem_ocsf.TRANSLATORS.get(kind)
        if translator is None:
            # Shouldn't happen — app-layer validation limits `kind`.
            # Defensive: drop rows so a misconfigured destination doesn't
            # fill the outbox forever.
            # CodeQL: the `fwd` dict contains `secret_ref` elsewhere, but
            # `kind` here is the destination category literal (webhook,
            # splunk_hec, datadog, otlp_http, file). Not a secret.
            logger.error(f"external_forwarder: no translator for kind={kind!r}")  # lgtm[py/clear-text-logging-sensitive-data]
            await outbox_repo.mark_failed(ids, f"unknown kind: {kind}")
            await outbox_repo.drop_exceeded(fid, max_attempts=1)
            return

        body, content_type, extra_headers = translator(events, fwd)

        try:
            headers = _build_auth_headers(fwd, content_type, extra_headers)
        except ValueError as e:
            # Missing secret — mark attempts so the health view surfaces
            # the misconfig; do NOT trip the breaker, the user can fix it.
            await outbox_repo.mark_failed(ids, str(e))
            await fwds_repo.mark_failure(fid, str(e))
            logger.warning(f"external_forwarder: id={fid} skipped — {e}")
            return

        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
                resp = await client.post(url, content=body, headers=headers)
            status = resp.status_code
            text_preview = resp.text[:200] if resp.text else ""
        except Exception as e:
            # Network / DNS / TLS error — transient.
            err = f"network: {type(e).__name__}: {e!s}"[:500]
            await outbox_repo.mark_failed(ids, err)
            await fwds_repo.mark_failure(fid, err)
            self._maybe_trip_breaker(fid, int(fwd.get("consecutive_fails") or 0) + 1)
            logger.debug(f"external_forwarder: id={fid} transient error: {err}")
            return

        if 200 <= status < 300:
            await outbox_repo.mark_delivered(ids)
            await fwds_repo.mark_success(fid, delivered=len(ids))
            self._breaker_until.pop(fid, None)
            # CodeQL: fid/kind/status/len(ids) are primitives derived
            # from the row and response — no secret material here. The
            # `fwd` dict carries `secret_ref` in other fields we never
            # log. Suppressing the false positive.
            logger.info(  # lgtm[py/clear-text-logging-sensitive-data]
                f"external_forwarder: id={fid} kind={kind} delivered "
                f"{len(ids)} event(s) (HTTP {status})"
            )
            return

        # Permanent 4xx (except 408 Request Timeout / 429 Too Many Requests)
        # → leave rows pending but bump attempts so the user sees the error.
        err = f"HTTP {status}: {text_preview}"
        if 400 <= status < 500 and status not in (408, 429):
            await outbox_repo.mark_failed(ids, err)
            await fwds_repo.mark_failure(fid, err)
            # Permanent errors trip the breaker quickly — retries won't
            # help until the user edits the destination.
            self._maybe_trip_breaker(fid, int(fwd.get("consecutive_fails") or 0) + 1, hard=True)
            logger.warning(
                f"external_forwarder: id={fid} permanent {status} — "
                f"{len(ids)} row(s) held for retry: {text_preview}"
            )
            return

        # Transient (5xx, 408, 429) — stay pending, soft-breaker.
        await outbox_repo.mark_failed(ids, err)
        await fwds_repo.mark_failure(fid, err)
        self._maybe_trip_breaker(fid, int(fwd.get("consecutive_fails") or 0) + 1)
        logger.debug(f"external_forwarder: id={fid} transient {status}: {text_preview}")

    async def _deliver_to_file(
        self,
        fwd: dict[str, Any],
        events: list[dict[str, Any]],
        ids: list[int],
        fwds_repo: ExternalForwardersRepository,
        outbox_repo: ExternalForwardOutboxRepository,
    ) -> None:
        """Append encoded OCSF events to a local NDJSON file.

        Zero-infra indie destination. `url` column holds the filesystem
        path; empty / '~/…' values expand to the app data directory
        default. Each event is a single NDJSON line so `jq`, `grep`,
        and `tail -f` work without shimming.

        Redaction tier was already applied at encode time — a file
        destination at `minimal` never receives prompt text, regardless
        of what the scan callsite passed in.
        """
        import json as _json
        import os as _os
        from pathlib import Path as _Path

        fid = int(fwd["id"])
        raw_path = (fwd.get("url") or "").strip()
        if not raw_path:
            try:
                from securevector.app.utils.platform import user_data_dir
                raw_path = str(_Path(user_data_dir(None, None)) / "siem-events.jsonl")
            except Exception:
                raw_path = str(_Path.home() / ".securevector" / "siem-events.jsonl")
        expanded = _os.path.expanduser(raw_path)

        try:
            path = _Path(expanded)
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as f:
                for ev in events:
                    f.write(_json.dumps(ev, separators=(",", ":"), ensure_ascii=False))
                    f.write("\n")
        except OSError as e:
            err = f"file write: {type(e).__name__}: {e!s}"[:500]
            await outbox_repo.mark_failed(ids, err)
            await fwds_repo.mark_failure(fid, err)
            self._maybe_trip_breaker(fid, int(fwd.get("consecutive_fails") or 0) + 1)
            logger.warning(f"external_forwarder: id={fid} file-write failed: {err}")
            return

        await outbox_repo.mark_delivered(ids)
        await fwds_repo.mark_success(fid, delivered=len(ids))
        self._breaker_until.pop(fid, None)
        # CodeQL: fid/len(ids)/expanded are non-secret — path is the
        # user-configured file destination, not credential material.
        logger.info(  # lgtm[py/clear-text-logging-sensitive-data]
            f"external_forwarder: id={fid} kind=file delivered "
            f"{len(ids)} event(s) → {expanded}"
        )

    def _maybe_trip_breaker(self, forwarder_id: int, consecutive: int, *, hard: bool = False) -> None:
        """Exponential backoff once consecutive failures cross the threshold.

        The cooldown is stored in-memory (per-process monotonic time) so a
        restart clears all breakers — a user fixing a destination shouldn't
        have to wait for the in-flight cooldown.
        """
        threshold = 1 if hard else _BREAKER_TRIP_AFTER
        if consecutive < threshold:
            return
        exponent = max(0, consecutive - threshold)
        backoff = min(_BREAKER_BASE_SECONDS * (2 ** exponent), _BREAKER_CAP_SECONDS)
        self._breaker_until[forwarder_id] = asyncio.get_event_loop().time() + backoff
        logger.info(
            f"external_forwarder: id={forwarder_id} breaker tripped — "
            f"backing off {int(backoff)}s (consecutive={consecutive})"
        )


def _build_auth_headers(
    fwd: dict[str, Any],
    content_type: str,
    extra_headers: dict[str, str],
) -> dict[str, str]:
    """Assemble HTTP headers per destination kind.

    Raises ValueError if a kind that requires a secret doesn't have one —
    the caller marks the batch failed with a useful message.
    """
    kind = fwd["kind"]
    secret_ref = fwd.get("secret_ref")
    secret = forwarder_secrets.get_secret(secret_ref) if secret_ref else None

    headers: dict[str, str] = {"Content-Type": content_type}
    # User-provided static headers (never secrets — those go via secret_ref)
    headers.update(fwd.get("headers") or {})
    headers.update(extra_headers or {})

    if kind == "splunk_hec":
        if not secret:
            raise ValueError("Splunk HEC forwarder has no token configured")
        headers["Authorization"] = f"Splunk {secret}"
    elif kind == "datadog":
        if not secret:
            raise ValueError("Datadog forwarder has no API key configured")
        headers["DD-API-KEY"] = secret
    elif kind == "webhook":
        # Secret is OPTIONAL for webhooks — user may be posting to an
        # endpoint that doesn't need auth. If present, send as Bearer.
        if secret:
            headers.setdefault("Authorization", f"Bearer {secret}")
    elif kind == "otlp_http":
        # OTLP collectors often use Bearer tokens when protected. Same
        # optional-secret handling.
        if secret:
            headers.setdefault("Authorization", f"Bearer {secret}")

    return headers


# Module-level singleton for FastAPI lifespan.
_service = ExternalForwarderService()


async def start_external_forwarder() -> None:
    await _service.start()


async def stop_external_forwarder() -> None:
    await _service.stop()
