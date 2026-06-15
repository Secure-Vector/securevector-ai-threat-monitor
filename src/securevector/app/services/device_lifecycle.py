"""
Device-lifecycle event emission for managed (enrolled) devices.

fleet-local-push, story #112.

Generic managed-device pattern — same shape as Wazuh / osquery+Fleet /
Tanium agents reporting enroll/check-out to their manager. The
destination is NEVER hardcoded in this OSS source: it always arrives at
runtime in the cloud enrollment response's ``forwarder_destinations``
list (identity-service #110, gated on admin consent). Nothing forwards
unless enrollment returned a destination.

What this module does
---------------------
1. ``register_enrollment_destinations(destinations)`` — on a successful
   enrollment, persist each admin-supplied destination to the existing
   ``external_forwarders`` repo tagged ``source="enrollment"`` (so the UI
   badges them as managed), then emit a ``device.lifecycle.enrolled``
   OCSF event to them.
2. ``emit_lifecycle_to_enrollment_destinations(activity)`` — emit a
   lifecycle event (e.g. ``uninstalling``) to every enrollment-sourced
   destination. Used by the pre-uninstall / shutdown hook.

Privacy contract
----------------
Lifecycle events are metadata-only: device id, activity, app version,
timestamp. NO prompt text, NO LLM output, NO tool args — same contract
as every other byte that leaves this host. The OCSF ``raw_data`` slot is
always ``null``.

Defensive by design
--------------------
Every public entry point is best-effort: a malformed destination, a DB
error, or an unreachable cloud must NEVER error the enrollment itself or
block app shutdown. Failures are logged and swallowed.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Iterable, Optional

logger = logging.getLogger(__name__)


# Lifecycle activities we emit. Kept as an explicit set so a typo can't
# silently invent a new activity string that downstream dashboards won't
# recognise.
LIFECYCLE_ENROLLED = "enrolled"
LIFECYCLE_UNINSTALLING = "uninstalling"
_KNOWN_ACTIVITIES = frozenset({LIFECYCLE_ENROLLED, LIFECYCLE_UNINSTALLING})

# How long we wait for the cloud /ocsf/ingest endpoint to ack a lifecycle
# event before giving up. The acceptance criteria call for a short ack
# wait so an unreachable cloud never wedges shutdown.
_ACK_TIMEOUT_SECONDS = 5.0


def _now_millis() -> int:
    return int(time.time() * 1000)


def encode_lifecycle_event(
    activity: str,
    *,
    device_id: Optional[str] = None,
    app_version: Optional[str] = None,
    org_id: Optional[str] = None,
) -> dict[str, Any]:
    """Encode a device-lifecycle event as an OCSF 5001 Device Inventory Info
    event (category 5 Discovery). Activity-specific detail lands in
    ``metadata.event_code`` (``device.lifecycle.<activity>``) and
    ``unmapped`` so dashboards can pivot on enroll vs uninstall.

    Metadata-only: ``raw_data`` is always ``null``. We never carry prompt
    text, output, or tool args in a lifecycle event.
    """
    from securevector.app.services.siem_ocsf import _metadata_block

    metadata = _metadata_block()
    # event_code lets the SOC route "device.lifecycle.*" without parsing
    # the unmapped blob.
    metadata["event_code"] = f"device.lifecycle.{activity}"

    device: dict[str, Any] = {}
    if device_id:
        device["uid"] = str(device_id)
        device["type_id"] = 0  # Unknown — we don't classify host OS here
        device["type"] = "Endpoint"

    unmapped: dict[str, Any] = {"lifecycle_activity": activity}
    if app_version:
        unmapped["app_version"] = str(app_version)
    if org_id:
        unmapped["org_id"] = str(org_id)

    event: dict[str, Any] = {
        "metadata": metadata,
        "category_uid": 5,
        "class_uid": 5001,
        "class_name": "Device Inventory Info",
        # activity_id 1=Log 2=Collect 99=Other — lifecycle is closest to
        # a collected inventory signal; the precise activity is in
        # event_code + unmapped.
        "activity_id": 2,
        "severity_id": 1,  # Informational
        "time": _now_millis(),
        "raw_data": None,
        "unmapped": unmapped,
    }
    if device:
        event["device"] = device
    return event


async def _post_event_to_destination(
    fwd: dict[str, Any], event: dict[str, Any]
) -> bool:
    """POST a single OCSF event to one destination, reusing the SIEM
    translators + auth-header builder so the on-wire shape is identical to
    every other event this destination receives.

    Returns True on a 2xx ack within the timeout, False otherwise. Never
    raises — lifecycle emission is best-effort.
    """
    from securevector.app.services import external_forwarder, siem_ocsf

    kind = fwd.get("kind")

    # `file` destinations are local NDJSON — no network, no ack to wait on.
    if kind == "file":
        try:
            import json as _json
            import os as _os
            from pathlib import Path as _Path

            raw_path = (fwd.get("url") or "").strip()
            if not raw_path:
                try:
                    from securevector.app.utils.platform import user_data_dir
                    raw_path = str(_Path(user_data_dir(None, None)) / "siem-events.jsonl")
                except Exception:
                    raw_path = str(_Path.home() / ".securevector" / "siem-events.jsonl")
            path = _Path(_os.path.expanduser(raw_path))
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as f:
                f.write(_json.dumps(event, separators=(",", ":"), ensure_ascii=False))
                f.write("\n")
            return True
        except Exception as e:
            logger.debug("device_lifecycle: file emit failed: %s", type(e).__name__)
            return False

    translator = siem_ocsf.TRANSLATORS.get(str(kind))
    if translator is None:
        logger.debug("device_lifecycle: no translator for destination kind")
        return False

    try:
        body, content_type, extra_headers = translator([event], fwd)
        headers = external_forwarder._build_auth_headers(fwd, content_type, extra_headers)
    except Exception as e:
        logger.debug("device_lifecycle: could not build request: %s", type(e).__name__)
        return False

    try:
        import httpx
    except ImportError:
        logger.debug("device_lifecycle: httpx unavailable — lifecycle event not sent")
        return False

    url = fwd.get("url")
    if not url:
        return False

    try:
        async with httpx.AsyncClient(timeout=_ACK_TIMEOUT_SECONDS) as client:
            resp = await client.post(url, content=body, headers=headers)
        return 200 <= resp.status_code < 300
    except Exception as e:
        # Unreachable cloud / DNS / TLS — swallow. We do NOT block
        # enrollment or shutdown on a lifecycle ack.
        logger.debug("device_lifecycle: post failed: %s", type(e).__name__)
        return False


async def _emit_to_destinations(
    activity: str, destinations: Iterable[dict[str, Any]]
) -> int:
    """Emit a lifecycle event to each destination. Returns the ack count.
    Best-effort: a single bad destination never affects the others."""
    from securevector.app.services.credentials import get_enrolled_credentials
    from securevector.app.utils.device_id import get_device_id

    try:
        from securevector import __version__ as app_version
    except Exception:
        app_version = None

    try:
        device_id = get_device_id()
    except Exception:
        device_id = None

    org_id = None
    try:
        creds = get_enrolled_credentials()
        if creds:
            org_id = creds.org_id
    except Exception:
        # org_id is optional metadata on the lifecycle event; if credentials
        # can't be read we still emit the event without it rather than block
        # device shutdown/uninstall reporting.
        pass

    event = encode_lifecycle_event(
        activity, device_id=device_id, app_version=app_version, org_id=org_id
    )

    acked = 0
    for fwd in destinations:
        try:
            if await _post_event_to_destination(fwd, event):
                acked += 1
        except Exception as e:  # pragma: no cover - defensive
            logger.debug("device_lifecycle: emit to one destination failed: %s", type(e).__name__)
    return acked


async def emit_lifecycle_to_enrollment_destinations(activity: str) -> int:
    """Emit a ``device.lifecycle.<activity>`` event to every
    enrollment-sourced destination currently registered.

    Used by the pre-uninstall / shutdown hook for ``uninstalling``. No-op
    (returns 0) if no enrollment-sourced destinations exist — a personal /
    never-enrolled install forwards nothing. Never raises.
    """
    if activity not in _KNOWN_ACTIVITIES:
        logger.debug("device_lifecycle: unknown activity, skipping")
        return 0
    try:
        from securevector.app.database.connection import get_database
        from securevector.app.database.repositories.external_forwarders import (
            ExternalForwardersRepository,
        )

        repo = ExternalForwardersRepository(get_database())
        all_fwds = await repo.list_all()
    except Exception as e:
        logger.debug("device_lifecycle: could not load forwarders: %s", type(e).__name__)
        return 0

    enrollment_fwds = [f for f in all_fwds if str(f.get("source") or "") == "enrollment"]
    if not enrollment_fwds:
        return 0
    return await _emit_to_destinations(activity, enrollment_fwds)


# ---------------------------------------------------------------------------
# Pre-uninstall / process-exit backstop hook
# ---------------------------------------------------------------------------
#
# pip / setup.py have no native pre-uninstall hook, so the Python-native
# mechanism for "emit before the process goes away" is atexit. We register
# a single idempotent atexit handler that fires the uninstalling lifecycle
# event if (and only if) the FastAPI lifespan shutdown didn't already do
# it. The server's graceful shutdown is the primary path; this is the
# backstop for a hard exit / non-server invocation.

# Module-level teardown state. Held in a mutable dict rather than rebindable
# module globals so the idempotency flags are mutated in place (no `global`
# rebinding) — clearer intent and avoids the false "unused global" lint.
_STATE = {"uninstall_emitted": False, "atexit_registered": False}


def _run_uninstalling_emit_sync() -> None:
    """Synchronous atexit entry point — drives the async emit on a fresh
    event loop. Idempotent + fully swallowed: a teardown hook must never
    raise into the interpreter's exit path."""
    if _STATE["uninstall_emitted"]:
        return
    _STATE["uninstall_emitted"] = True
    try:
        import asyncio

        # We are at process exit — there is no running loop we'd be
        # interrupting, so a fresh asyncio.run is safe. The 5s ack timeout
        # inside the emit bounds how long exit can block.
        try:
            asyncio.run(
                emit_lifecycle_to_enrollment_destinations(LIFECYCLE_UNINSTALLING)
            )
        except RuntimeError:
            # An event loop is already running in this thread (rare at
            # exit). Fall back to a dedicated loop.
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(
                    emit_lifecycle_to_enrollment_destinations(LIFECYCLE_UNINSTALLING)
                )
            finally:
                loop.close()
    except Exception:  # pragma: no cover - exit path, swallow everything
        pass


def register_preuninstall_hook() -> None:
    """Register the atexit backstop that emits device.lifecycle.uninstalling
    on process exit. Idempotent — safe to call on every app startup.

    The server's lifespan shutdown is the primary emit path; this guards
    the case where the process exits without the graceful shutdown running
    (hard kill of the parent that still lets atexit fire, CLI teardown,
    etc.). The shared `_STATE["uninstall_emitted"]` flag prevents a double
    emit when both paths run."""
    if _STATE["atexit_registered"]:
        return
    try:
        import atexit

        atexit.register(_run_uninstalling_emit_sync)
        _STATE["atexit_registered"] = True
    except Exception:  # pragma: no cover - defensive
        logger.debug("device_lifecycle: could not register atexit hook")


def mark_uninstall_emitted() -> None:
    """Let the server's async lifespan shutdown record that it already
    emitted the uninstalling event, so the atexit backstop won't fire a
    duplicate."""
    _STATE["uninstall_emitted"] = True


async def register_enrollment_destinations(
    destinations: Optional[list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    """Register admin-supplied forwarder destinations returned by the cloud
    enrollment response.

    ``destinations`` is the ``forwarder_destinations`` array from the
    enrollment response — present ONLY when the admin opted in. Each entry
    has the shape::

        { name, type, url, token, source: "enrollment" }

    For each entry we create an ``external_forwarders`` row via the existing
    repo CRUD, tagged ``source="enrollment"`` (the UI badges these as
    managed 🔒), then emit a ``device.lifecycle.enrolled`` OCSF event to the
    newly-registered destinations.

    Returns the list of created forwarder records (possibly empty).

    Defensive contract: absent / empty / malformed destinations are a
    no-op, and ANY failure here is logged and swallowed — enrollment must
    never fail because destination registration hit a snag.
    """
    if not destinations:
        return []

    try:
        from securevector.app.database.connection import get_database
        from securevector.app.database.repositories.external_forwarders import (
            ExternalForwardersRepository,
        )

        repo = ExternalForwardersRepository(get_database())
    except Exception as e:
        logger.warning("device_lifecycle: forwarder repo unavailable, skipping destinations: %s", type(e).__name__)
        return []

    created: list[dict[str, Any]] = []
    for dest in destinations:
        if not isinstance(dest, dict):
            continue
        url = (dest.get("url") or "").strip()
        if not url:
            # A destination with no URL is meaningless — skip it rather
            # than write a broken row.
            continue
        # Map the enrollment `type` to our forwarder `kind`. Default to a
        # generic webhook, which is the right default for the cloud's
        # /ocsf/ingest endpoint (accepts a JSON array of OCSF events).
        kind = str(dest.get("type") or "webhook").strip().lower()
        if kind not in ("webhook", "splunk_hec", "datadog", "otlp_http", "file"):
            kind = "webhook"
        name = str(dest.get("name") or "SecureVector Cloud").strip() or "SecureVector Cloud"
        token = dest.get("token") or None

        try:
            record = await repo.create(
                kind=kind,
                name=name,
                url=url,
                secret=token,
                # Managed destinations get all events at standard tier —
                # metadata-only, SOC-grade detail, no raw text.
                event_filter="all",
                include_tool_audits=True,
                redaction_level="standard",
                enabled=True,
                source="enrollment",
            )
            created.append(record)
            logger.info("device_lifecycle: registered enrollment destination id=%d", int(record["id"]))
        except Exception as e:
            # Bad URL, duplicate, validation error — log + continue. One
            # bad destination must not abort the others or the enrollment.
            logger.warning("device_lifecycle: failed to register a destination: %s", type(e).__name__)

    if created:
        try:
            await _emit_to_destinations(LIFECYCLE_ENROLLED, created)
        except Exception as e:  # pragma: no cover - defensive
            logger.debug("device_lifecycle: enrolled event emission failed: %s", type(e).__name__)

    return created
