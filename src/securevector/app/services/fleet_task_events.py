"""Fleet sink for Agent Task lifecycle events.

Installed as the Live Runs sink at app startup. Each metadata-only payload
the Live Runs emitter builds is queued as one `task_event` outbox row for
the enrolled fleet destination (source "enrollment"), and the background
forwarder delivers it in the same flat NDJSON batch as tool activity.

Never to a SIEM destination: a customer's own Splunk or webhook has no use
for board lifecycle rows, and keeping them fleet-only keeps the contract
small. On a device that is not enrolled there is no such destination and
the sink does nothing.

The payload is checked against the `task_event` allow-list before it is
written, so a field that is not on it (a title, a workspace path, activity
text) is refused rather than queued.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

from securevector.app.terminals import live_runs

logger = logging.getLogger(__name__)

ENROLLMENT_SOURCE = "enrollment"


async def enqueue_task_event(payload: Mapping[str, Any]) -> int:
    """Queue one Live Runs payload for the fleet destination(s).

    Returns the number of outbox rows written: 0 when the device is not
    enrolled, when forwarding is switched off globally, or when no enabled
    fleet destination exists.
    """
    from securevector.app.database.connection import get_database
    from securevector.app.database.repositories.external_forwarders import (
        ExternalForwardersRepository,
        ExternalForwardOutboxRepository,
        build_task_event_payload,
        is_siem_forwarding_enabled,
    )

    db = get_database()
    # The global forwarding switch stops every outbound row, fleet included,
    # the same way it already does for tool activity.
    if not await is_siem_forwarding_enabled(db):
        return 0
    active = await ExternalForwardersRepository(db).list_active()
    fleet = [f for f in active if str(f.get("source") or "") == ENROLLMENT_SOURCE]
    if not fleet:
        return 0
    row = build_task_event_payload(payload)
    written = await ExternalForwardOutboxRepository(db).enqueue_fanout(
        "task_event", row, forwarders=fleet
    )
    if written:
        logger.debug("fleet: queued task_event for %d destination(s)", written)
    return written


def install() -> None:
    """Make the fleet sink the Live Runs transport."""
    live_runs.set_sink(enqueue_task_event)


def uninstall() -> None:
    """Remove the fleet sink if it is the installed one."""
    if live_runs.get_sink() is enqueue_task_event:
        live_runs.set_sink(None)
