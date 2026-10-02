"""Refuse to remove a Guard while the sessions it governs are still running.

A 6.0.0 release-gate criterion asks for "stop all tasks before uninstall or
upgrade". The dangerous half of that is not the app's own uninstall, which the
installer handles outside a running process: it is removing one harness's Guard
plugin from inside the app while sessions of that harness are live. The files
vanish, the hooks stop firing, and those sessions keep running with nothing
watching them. Nothing in the audit trail marks the moment governance stopped,
because the thing that writes the trail is what was removed.

So the uninstall is refused while such sessions exist, and says which. It is not
made to stop them: ending someone's running agent as a side effect of a settings
click is worse than making them do it deliberately. `force` exists for the case
where a session is wedged, and writes the loss of governance to each affected
task's trail so the gap is on the record.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from securevector.app.terminals.store import RUNNING

logger = logging.getLogger(__name__)

# Live for this purpose means "still doing something a Guard would have seen".
# An ended session cannot lose governance it no longer has. Derived from the
# store's own RUNNING tuple rather than repeated here: RUNNING is what a live
# status actually means to the board, so a new one added there is a live
# status here too, automatically, instead of silently falling outside a
# second hand-copied list.
LIVE_STATUSES = frozenset(RUNNING)


class _BoardUnreadable(Exception):
    """The board could not be read, so liveness could not be determined.

    Not a subclass of anything callers might already be catching for a
    different reason; it exists only to carry the failure from
    `live_sessions_for` to `block_uninstall` so the latter can refuse rather
    than guess.
    """


def _manager(app: Any):
    return getattr(getattr(app, "state", None), "terminal_manager", None)


async def live_sessions_for(app: Any, executor_id: str) -> list[dict]:
    """Sessions of this harness that would lose their Guard.

    Returns [] when Terminals is not wired up at all, which is the case in
    the engine-only deployments: there is no board, so nothing can be
    governed and nothing can be stranded. Raises `_BoardUnreadable` when
    Terminals IS wired up but the read itself failed: a database hiccup here
    must not read as "nothing is running". This is a release-gate safety
    check, and a safety check that goes quiet on error is worse than useless
    -- it is confidently wrong. Failing the read has to fail the uninstall,
    not wave it through.
    """
    manager = _manager(app)
    if manager is None:
        return []
    try:
        rows = await manager.store.list_tasks()
    except Exception as exc:  # noqa: BLE001 - any read failure must refuse, not guess
        logger.warning("Could not read the board before uninstall", exc_info=True)
        raise _BoardUnreadable(str(exc)) from exc
    return [
        r
        for r in rows
        if r.get("executor_id") == executor_id and r.get("status") in LIVE_STATUSES
    ]


def describe(rows: list[dict]) -> str:
    """One sentence naming what would be stranded."""
    n = len(rows)
    what = "session" if n == 1 else "sessions"
    ids = ", ".join((r.get("id") or "")[:12] for r in rows[:3])
    more = f" and {n - 3} more" if n > 3 else ""
    return (
        f"{n} {what} of this harness {'is' if n == 1 else 'are'} still running "
        f"({ids}{more}). Stop them first, or they keep running with nothing watching them."
    )


async def note_forced(app: Any, rows: list[dict], executor_id: str) -> None:
    """Record on each stranded task that its Guard was removed underneath it.

    Best effort by design: a failure to write this must not abort an uninstall
    the person has already forced, or they would be stuck unable to remove a
    plugin at all.
    """
    manager = _manager(app)
    if manager is None:
        return
    for row in rows:
        try:
            await manager.store.add_event(
                row["id"],
                kind="guard_removed",
                origin="ui",
                detail=f"{executor_id} Guard uninstalled while this session was running",
            )
        except Exception:  # noqa: BLE001
            logger.warning("Could not record forced uninstall for %s", row.get("id"), exc_info=True)


async def block_uninstall(app: Any, executor_id: str, force: bool) -> Optional[str]:
    """None when the uninstall may go ahead, otherwise the refusal to send.

    When forced, the refusal is skipped but the loss is written to the trail
    first, while the rows are still known. A board read that fails is its
    own refusal: `force` still gets a person past it (there is nothing to
    write `guard_removed` against when the rows themselves could not be
    read), but the plain path fails closed rather than reporting a clean
    board it never actually saw.
    """
    try:
        rows = await live_sessions_for(app, executor_id)
    except _BoardUnreadable:
        if force:
            return None
        return (
            "Could not check for running sessions of this harness; refusing "
            "to guess whether the uninstall is safe. Try again, or pass "
            "force=true to uninstall anyway."
        )
    if not rows:
        return None
    if force:
        await note_forced(app, rows, executor_id)
        return None
    return describe(rows)
