"""Removing a Guard must not strand the sessions it was watching.

The 6.0.0 criterion says "stop all tasks before uninstall or upgrade". The half
this app can actually enforce is the Guard plugin uninstall: the files go, the
hooks stop firing, and the live sessions of that harness keep running with
nothing recording them. Worse, nothing marks the moment governance ended,
because what writes the trail is what was removed.
"""

from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from securevector.app.terminals.guardrail import (
    LIVE_STATUSES,
    block_uninstall,
    describe,
    live_sessions_for,
)
from securevector.app.terminals.store import RUNNING


class FakeStore:
    def __init__(self, rows, boom=False):
        self.rows = rows
        self.boom = boom
        self.events = []

    async def list_tasks(self):
        if self.boom:
            raise RuntimeError("database is locked")
        return self.rows

    async def add_event(self, task_id, *, kind, origin, detail=None):
        self.events.append((task_id, kind, origin, detail))


def app_with(rows, boom=False):
    store = FakeStore(rows, boom)
    manager = SimpleNamespace(store=store)
    return SimpleNamespace(state=SimpleNamespace(terminal_manager=manager)), store


def row(i, executor="claude-code", status="working"):
    return {"id": f"task{i:08d}abcd", "executor_id": executor, "status": status}


@pytest.mark.asyncio
async def test_a_live_session_of_that_harness_blocks_the_uninstall():
    app, _ = app_with([row(1)])
    refusal = await block_uninstall(app, "claude-code", force=False)
    assert refusal and "still running" in refusal
    assert "task00000001" in refusal, "it names what would be stranded"


@pytest.mark.asyncio
async def test_another_harness_sessions_are_none_of_its_business():
    app, _ = app_with([row(1, executor="codex")])
    assert await block_uninstall(app, "claude-code", force=False) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["done", "failed", "interrupted"])
async def test_an_ended_session_cannot_lose_governance_it_no_longer_has(status):
    app, _ = app_with([row(1, status=status)])
    assert await block_uninstall(app, "claude-code", force=False) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("status", sorted(LIVE_STATUSES))
async def test_every_live_status_counts(status):
    app, _ = app_with([row(1, status=status)])
    assert await block_uninstall(app, "claude-code", force=False) is not None


@pytest.mark.asyncio
async def test_forcing_is_allowed_but_written_to_each_stranded_trail():
    """A wedged session must not make a plugin impossible to remove. The gap in
    governance goes on the record instead."""
    app, store = app_with([row(1), row(2)])
    assert await block_uninstall(app, "claude-code", force=True) is None
    assert [e[1] for e in store.events] == ["guard_removed", "guard_removed"]
    assert "while this session was running" in store.events[0][3]


@pytest.mark.asyncio
async def test_the_note_is_written_before_the_files_go():
    """Order matters: the rows are read and the events written while the Guard
    still exists, so the trail records the removal rather than losing it."""
    app, store = app_with([row(1)])
    await block_uninstall(app, "claude-code", force=True)
    assert store.events, "nothing forced means nothing to explain later"


@pytest.mark.asyncio
async def test_no_terminals_wiring_means_nothing_to_strand():
    """Engine-only deployments have no board, so no uninstall can orphan
    anything and the check must not invent a refusal."""
    app = SimpleNamespace(state=SimpleNamespace())
    assert await live_sessions_for(app, "claude-code") == []
    assert await block_uninstall(app, "claude-code", force=False) is None


@pytest.mark.asyncio
async def test_a_failing_board_read_refuses_the_uninstall():
    """This is a release-gate safety check, not a best-effort one. Returning
    None (allowed) on a database hiccup would let an uninstall through that
    could strand live sessions with nothing watching them, and no
    `guard_removed` event would even be written since the rows were never
    read. Failing the read has to fail the uninstall, same as finding a live
    session does -- silently permitting it here was the bug."""
    app, _ = app_with([], boom=True)
    refusal = await block_uninstall(app, "claude-code", force=False)
    assert refusal is not None
    assert "force=true" in refusal


@pytest.mark.asyncio
async def test_forcing_past_a_failing_board_read_is_still_allowed():
    """A wedged database must not make a plugin permanently impossible to
    remove, same reasoning as forcing past a live session. There is nothing
    to write `guard_removed` against here, since the rows themselves could
    not be read, so force just lets the uninstall through with no note."""
    app, _ = app_with([], boom=True)
    assert await block_uninstall(app, "claude-code", force=True) is None


def test_the_refusal_names_a_few_and_counts_the_rest():
    many = [row(i) for i in range(6)]
    text = describe(many)
    assert text.startswith("6 sessions")
    assert "and 3 more" in text
    assert text.count("task0000") == 3, "three ids, then a count; not a wall of ids"


def test_one_session_reads_as_one():
    text = describe([row(1)])
    assert "1 session of this harness is still running" in text


def test_live_statuses_cannot_drift_from_the_store_definition():
    """LIVE_STATUSES used to be a hand-copied frozenset of the store's own
    RUNNING tuple. A live status added to RUNNING later would silently NOT
    block an uninstall for it, since this list would still be the old one.
    Pinning them as the same object's contents makes that impossible."""
    assert LIVE_STATUSES == frozenset(RUNNING)


# --- wired to the routes that actually serve each harness ---------------------
#
# The first attempt patched `hooks.py`, which serves the OPENCLAW plugin, and
# gave it the executor id "claude-code". So the real Claude Code uninstall at
# `hooks_claude_code.py` was never guarded, and a live POST removed the plugin
# with a session running. These pin the mapping.

ROUTES = Path(__file__).resolve().parents[4] / "src/securevector/app/server/routes"

GUARDED = {
    "hooks_claude_code.py": "claude-code",
    "hooks_codex.py": "codex",
    "hooks_opencode.py": "opencode",
    "hooks_copilot_cli.py": "copilot-cli",
}


@pytest.mark.parametrize("filename,executor", sorted(GUARDED.items()))
def test_every_executor_uninstall_is_guarded_with_its_own_id(filename, executor):
    body = (ROUTES / filename).read_text(encoding="utf-8")
    assert "block_uninstall" in body, f"{filename} can strand sessions unguarded"
    assert f'block_uninstall(request.app, "{executor}", bool(body and body.force))' in body, (
        f"{filename} must name ITS OWN harness; a wrong id guards the wrong sessions"
    )
    # The refusal has to be a refusal, not a log line.
    assert re.search(r"raise HTTPException\(status_code=409, detail=refusal\)", body)


def test_openclaw_is_not_guarded_because_it_is_not_an_executor():
    """OpenClaw has a Guard plugin but is not a Terminals executor in 6.0.0, so
    no board session can depend on it and a refusal there would block a removal
    for no reason."""
    body = (ROUTES / "hooks.py").read_text(encoding="utf-8")
    assert "block_uninstall" not in body


def test_no_guarded_route_forgot_its_request_parameter():
    """`request.app` is how the check reaches the manager. A route that kept the
    old zero-argument signature would raise NameError on the first uninstall.
    `force` moved from a query string bool to a JSON body field
    (`Optional[ForceBody] = None`) behind `require_local_origin`, so a plain
    cross-origin POST with no body can no longer trigger it at all."""
    for filename in GUARDED:
        body = (ROUTES / filename).read_text(encoding="utf-8")
        assert (
            "async def uninstall_plugin(request: Request, body: Optional[ForceBody] = None):"
            in body
        )
        assert "dependencies=[Depends(require_local_origin)]" in body, (
            f"{filename}'s uninstall route must require a local Origin, not just a session cookie"
        )
        assert "Request" in body.split("\n\n")[0] or "from fastapi import" in body
