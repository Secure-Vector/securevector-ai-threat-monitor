"""Fleet model generation rows: one metadata row per model turn.

On an enrolled device whose fleet destination already receives tool
activity, each governed run's model turns (read from the harness transcript,
the same parse the Agent Runs view uses) are queued as `generation` outbox
rows next to the run's tool rows, so the cloud can draw the run as a step
timeline.

Gate: the global forwarding switch is on and an enabled fleet destination
(source "enrollment") with tool activity on exists. Otherwise a pass does
nothing.

Scope of a pass: runs with tool activity in the last 24 hours, written since
the fleet destination was registered (so their tool rows went to the cloud).
Only turns from that same span are sent, and only once they have settled
(a turn still streaming would freeze partial token counts).

Dedupe: each queued row's span id is recorded in `fleet_generation_sent`.
The outbox cannot serve as the record: delivered rows are purged after a
week and finding a span id there means scanning JSON payloads.

Metadata only: ids, a digest, counts, a sanitised model id, a cost and a
timestamp. Never prompt or output text, previews, tool results, tool names
or arguments; a turn's tool calls travel only as a count.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional

logger = logging.getLogger(__name__)

ENROLLMENT_SOURCE = "enrollment"
# Most rows queued in one pass, so a large backlog never stalls the app.
MAX_ROWS_PER_PASS = 500
# Runs considered: tool activity inside this window.
RUN_LOOKBACK = timedelta(hours=24)
# Turns considered: never older than this, whatever the run's age.
GENERATION_MAX_AGE = timedelta(days=7)
# A turn is sent once it is this old, so its token counts are final.
SETTLE = timedelta(seconds=120)
# Sent markers outlive the oldest turn a pass can consider.
MARKER_KEEP_DAYS = 14
# Runs read per pass (newest first).
MAX_RUNS_PER_PASS = 50

_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9._:/-]{1,64}$")
_TURN_STARTS = ("prompt", "tool_result")

# trace_id -> transcript stamp of a run whose every turn was settled and
# handled on the last pass; an unchanged stamp skips the re-read.
_done_stamps: dict[str, str] = {}
_DONE_MAX = 1000


def sanitize_model_id(model: Any) -> Optional[str]:
    """The model id when it is a short plain identifier, else None."""
    if not isinstance(model, str) or not _MODEL_ID_RE.match(model):
        return None
    return model


def _non_neg_int(value: Any) -> int:
    try:
        n = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return n if n > 0 else 0


def generation_span_id(trace_id: Optional[str], gen: Mapping[str, Any]) -> str:
    """Stable span id for one turn: a digest of the transcript request id,
    or of trace id + timestamp + model when the turn has none.

    The request id is global to the transcript, not to the run: a resumed
    session copies earlier turns into the new transcript with the same
    request ids, so those copied turns dedupe to the first run that sent
    them and are not re-sent under the resumed run's trace id.
    """
    rid = gen.get("request_id")
    if rid:
        seed = f"generation|{rid}"
    else:
        seed = f"generation|{trace_id or ''}|{gen.get('called_at') or ''}|{gen.get('model') or ''}"
    return hashlib.sha256(seed.encode("utf-8", "ignore")).hexdigest()[:32]


def build_generation_row(
    gen: Mapping[str, Any],
    *,
    trace_id: Optional[str],
    session_id: Optional[str],
    runtime_kind: Optional[str],
    device_id: Optional[str],
) -> dict[str, Any]:
    """The flat generation payload for one parsed transcript turn.

    trace_id, session_id, harness, agent and device_id are computed exactly
    as the run's tool rows compute them, so the cloud groups both together.
    """
    duration = gen.get("duration_ms")
    try:
        duration_ms = int(duration) if duration is not None else None
    except (TypeError, ValueError):
        duration_ms = None
    if duration_ms is not None and duration_ms < 0:
        duration_ms = None
    cost = gen.get("cost")
    try:
        cost_usd = float(cost) if cost is not None else None
    except (TypeError, ValueError):
        cost_usd = None
    if cost_usd is not None and not cost_usd >= 0:
        cost_usd = None
    turn_start = gen.get("turn_start")
    names = gen.get("tool_use_names")
    return {
        "timestamp": str(gen.get("called_at")) if gen.get("called_at") else None,
        "device_id": device_id,
        "harness": runtime_kind or "unknown",
        "agent": (f"run-{str(trace_id)[:12]}" if trace_id else (runtime_kind or "unknown")),
        "trace_id": trace_id,
        "session_id": session_id,
        "span_id": generation_span_id(trace_id, gen),
        "duration_ms": duration_ms,
        "duration_estimated": bool(gen.get("duration_estimated") or False),
        "turn_start": turn_start if turn_start in _TURN_STARTS else None,
        "model_id": sanitize_model_id(gen.get("model")),
        "tokens_in": _non_neg_int(gen.get("input_tokens")),
        "tokens_out": _non_neg_int(gen.get("output_tokens")),
        "tokens_cache_read": _non_neg_int(gen.get("cache_read_tokens")),
        "tokens_cache_write": _non_neg_int(gen.get("cache_creation_tokens")),
        "cost_usd": cost_usd,
        "tool_use_count": len(names) if isinstance(names, (list, tuple)) else 0,
    }


def _utc(ts: Any) -> Optional[datetime]:
    """Parse an audit ('YYYY-MM-DD HH:MM:SS', UTC) or ISO timestamp."""
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(str(ts).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _sql_ts(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


async def _load_generations(runtime_kind: str, session_id: str) -> tuple[list, str]:
    """(generations, transcript stamp) from the shared, cached parse.

    Uses the same cache key as the Agent Health warm-up, so a run it just
    analysed costs nothing extra here.
    """
    from securevector.app.server.routes.traces import _parse_with_stamp

    return await asyncio.to_thread(_parse_with_stamp, runtime_kind, session_id, False, True)


async def _price_map(db) -> dict:
    try:
        from securevector.app.database.repositories.costs import CostsRepository

        pricing = await CostsRepository(db).list_pricing()
        return {p.model_id: (p.input_per_million, p.output_per_million) for p in pricing}
    except Exception:  # noqa: BLE001 - cost is best-effort
        return {}


async def _fleet_destinations(db) -> list[dict]:
    from securevector.app.database.repositories.external_forwarders import (
        ExternalForwardersRepository,
        is_siem_forwarding_enabled,
    )

    if not await is_siem_forwarding_enabled(db):
        return []
    active = await ExternalForwardersRepository(db).list_active()
    return [
        f for f in active
        if str(f.get("source") or "") == ENROLLMENT_SOURCE and f.get("include_tool_audits", True)
    ]


async def forward_generations_once(
    db=None,
    *,
    now: Optional[datetime] = None,
    max_rows: int = MAX_ROWS_PER_PASS,
) -> int:
    """One pass. Returns the number of generation rows queued."""
    from securevector.app.database.repositories.external_forwarders import (
        ExternalForwardOutboxRepository,
        build_generation_payload,
    )
    from securevector.app.server.routes.transcript_generations import apply_cost

    if db is None:
        from securevector.app.database.connection import get_database

        db = get_database()
    fleet = await _fleet_destinations(db)
    if not fleet:
        return 0
    now = now or datetime.now(timezone.utc)
    enrolled = [t for t in (_utc(f.get("created_at")) for f in fleet) if t is not None]
    enrolled_at = min(enrolled) if enrolled else now - RUN_LOOKBACK
    run_since = max(enrolled_at, now - RUN_LOOKBACK)
    gen_since = max(enrolled_at, now - GENERATION_MAX_AGE)
    settled_before = now - SETTLE

    # Own transaction via the wrapper: never a bare commit on the shared
    # connection, which could commit another coroutine's open work.
    async with db.transaction() as tx:
        await tx.execute(
            "DELETE FROM fleet_generation_sent WHERE sent_at < ?",
            (_sql_ts(now - timedelta(days=MARKER_KEEP_DAYS)),),
        )

    runs = await db.fetch_all(
        """
        SELECT trace_id, MAX(session_id) AS session_id, MAX(runtime_kind) AS runtime_kind,
               MAX(device_id) AS device_id, MAX(called_at) AS last_at
          FROM tool_call_audit
         WHERE trace_id IS NOT NULL
           AND called_at >= ?
           AND runtime_kind IN ('claude-code', 'codex')
         GROUP BY trace_id
         ORDER BY last_at DESC
         LIMIT ?
        """,
        (_sql_ts(run_since), MAX_RUNS_PER_PASS),
    )
    if not runs:
        return 0

    from securevector.app.utils.device_id import get_device_id

    outbox = ExternalForwardOutboxRepository(db)
    prices: Optional[dict] = None
    queued = 0
    for run in runs:
        if queued >= max_rows:
            break
        trace_id = run["trace_id"]
        session_id = run["session_id"]
        runtime_kind = run["runtime_kind"]
        if not session_id:
            continue
        try:
            gens, stamp = await _load_generations(runtime_kind, session_id)
        except Exception:  # noqa: BLE001 - one unreadable transcript never stops the pass
            logger.debug("fleet generations: transcript read failed", exc_info=True)
            continue
        if stamp and _done_stamps.get(trace_id) == stamp:
            continue
        device_id = run["device_id"] or get_device_id()

        deferred = False
        candidates: list[dict] = []
        for g in gens or []:
            at = _utc(g.get("called_at"))
            if at is None or at < gen_since:
                continue
            if at > settled_before:
                deferred = True
                continue
            candidates.append(g)
        if candidates and not any(g.get("cost") is not None for g in candidates):
            if prices is None:
                prices = await _price_map(db)
            if prices:
                apply_cost(candidates, prices)

        rows = [
            build_generation_row(
                g, trace_id=trace_id, session_id=session_id,
                runtime_kind=runtime_kind, device_id=device_id,
            )
            for g in candidates
        ]
        sent: set = set()
        ids = list({r["span_id"] for r in rows})
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            marks = ",".join("?" * len(chunk))
            for m in await db.fetch_all(
                f"SELECT span_id FROM fleet_generation_sent WHERE span_id IN ({marks})", tuple(chunk)
            ):
                sent.add(m["span_id"])

        for row in rows:
            if row["span_id"] in sent:
                continue
            if queued >= max_rows:
                deferred = True
                break
            payload = build_generation_payload(row)
            written = await outbox.enqueue_fanout("generation", payload, forwarders=fleet)
            if not written:
                # Dropped by the destination's rate limit: try again next pass.
                deferred = True
                continue
            async with db.transaction() as tx:
                await tx.execute(
                    "INSERT OR IGNORE INTO fleet_generation_sent (span_id, trace_id) VALUES (?, ?)",
                    (row["span_id"], trace_id),
                )
            sent.add(row["span_id"])
            queued += 1

        if stamp and not deferred:
            _done_stamps[trace_id] = stamp
            while len(_done_stamps) > _DONE_MAX:
                _done_stamps.pop(next(iter(_done_stamps)))
    if queued:
        logger.debug("fleet: queued %d generation row(s)", queued)
    return queued


def reset_state() -> None:
    """Forget per-run skip stamps (tests)."""
    _done_stamps.clear()
