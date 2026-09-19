import asyncio

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.terminals.store import TerminalStore, cwd_from_preview


async def _store(tmp_path) -> TerminalStore:
    db = DatabaseConnection(tmp_path / "t.db")
    await run_migrations(db)
    return TerminalStore(db)


@pytest.mark.asyncio
async def test_migration_creates_tables(tmp_path):
    db = DatabaseConnection(tmp_path / "t.db")
    version = await run_migrations(db)
    assert version >= 48
    rows = await db.fetch_all(
        "SELECT name FROM sqlite_master WHERE name IN ('terminal_tasks','terminal_events')"
    )
    assert {r["name"] for r in rows} == {"terminal_tasks", "terminal_events"}


@pytest.mark.asyncio
async def test_task_lifecycle(tmp_path):
    store = await _store(tmp_path)
    await store.create_task(
        "t1", executor_id="claude-code", workspace="/w", title="Fix tests", pid=123
    )
    task = await store.get_task("t1")
    assert task["status"] == "starting" and task["pid"] == 123
    await store.set_session("t1", "sess-1")
    await store.update_status("t1", "working", activity="Bash: ls -la")
    await store.set_exit("t1", 0)
    task = await store.get_task("t1")
    assert task["session_id"] == "sess-1" and task["status"] == "done" and task["exit_code"] == 0
    assert task["activity"] == "Bash: ls -la"
    assert task["ended_at"] is not None


@pytest.mark.asyncio
async def test_list_tasks_newest_first_and_running_filter(tmp_path):
    store = await _store(tmp_path)
    await store.create_task("a", executor_id="claude-code", workspace="/w", title=None, pid=1)
    await store.create_task("b", executor_id="claude-code", workspace="/w", title=None, pid=2)
    await store.set_exit("a", 1)
    ids = [t["id"] for t in await store.list_tasks()]
    assert ids == ["b", "a"]
    assert [t["id"] for t in await store.list_tasks(running_only=True)] == ["b"]


@pytest.mark.asyncio
async def test_archive_hides_finished_task_but_keeps_its_audit(tmp_path):
    store = await _store(tmp_path)
    await store.create_task("finished", executor_id="claude-code", workspace="/w", title=None, pid=1)
    await store.set_exit("finished", 0)
    await store.add_event("finished", kind="exit", origin="pty", detail="0")

    assert await store.archive_task("finished") is True
    assert await store.list_tasks() == []
    assert (await store.get_task("finished"))["archived_at"] is not None
    assert [event["kind"] for event in await store.list_events("finished")] == ["exit", "archived"]


@pytest.mark.asyncio
async def test_archive_refuses_a_running_task(tmp_path):
    store = await _store(tmp_path)
    await store.create_task("running", executor_id="claude-code", workspace="/w", title=None, pid=1)
    with pytest.raises(ValueError, match="Stop the task"):
        await store.archive_task("running")


def test_cwd_scrape_refuses_a_marker_matched_inside_a_tool_argument():
    """The reported bug. An edit to a file containing `cwd=str(workspace)` put
    eight kilobytes of Python on the board as a session's folder: the marker
    matched inside the tool's own arguments and the value ran to the end of the
    blob. A folder has to look like a folder."""
    blob = (
        "return Launch(argv=argv, env=env, cwd=str(workspace))\'\'\', \'\'\' "
        "resume_args: list[str] = []\n    if resume_session_id:\n"
    )
    assert cwd_from_preview(blob) is None


def test_cwd_scrape_keeps_looking_after_a_bad_match():
    """One unusable marker must not hide a real one later in the same text."""
    assert cwd_from_preview("cwd=str(workspace)) junk\n cwd=/real/path") == "/real/path"


@pytest.mark.parametrize(
    "preview,expected",
    [
        ("cmd=ls; cwd=/Users/y/repo", "/Users/y/repo"),
        ('cwd="/Users/y/My Repo"; next', "/Users/y/My Repo"),
        ("cwd=~/work", "~/work"),
        ("cwd=C:\\Users\\y", "C:\\Users\\y"),
        ("cwd=relative/path", None),
        ("cwd=", None),
        ("nothing here", None),
        (None, None),
    ],
)
def test_cwd_scrape_accepts_only_what_could_be_a_folder(preview, expected):
    assert cwd_from_preview(preview) == expected


@pytest.mark.asyncio
async def test_archive_unlinks_a_live_linked_session(tmp_path):
    """A linked row has no process to stop, and its status only leaves RUNNING
    when the harness reports a session end, which most never do. Refusing to
    archive it the way a running task is refused strands it on the board for
    good, so the exemption is what makes unlinking possible at all."""
    store = await _store(tmp_path)
    await store.create_task(
        "adopted", executor_id="codex", workspace="/w", title=None, pid=None,
        origin="linked", status="working", session_id="sess-1",
    )

    assert await store.archive_task("adopted") is True
    assert await store.list_tasks() == []
    assert (await store.get_task("adopted"))["archived_at"] is not None


@pytest.mark.asyncio
async def test_archive_still_refuses_a_running_launched_task_with_a_session(tmp_path):
    """The exemption is about origin, not about carrying a session id: a task
    the app spawned still owns a process, so the stop-first rule stands."""
    store = await _store(tmp_path)
    await store.create_task("spawned", executor_id="claude-code", workspace="/w",
                            title=None, pid=1, status="working")
    await store.set_session("spawned", "sess-2")
    with pytest.raises(ValueError, match="Stop the task"):
        await store.archive_task("spawned")


@pytest.mark.asyncio
async def test_an_archived_linked_session_can_be_adopted_again(tmp_path):
    """Archiving frees the session id: unlinked_sessions excludes only rows
    that are still on the board, so a session comes back on offer."""
    store = await _store(tmp_path)
    await store.create_task(
        "adopted", executor_id="codex", workspace="/w", title=None, pid=None,
        origin="linked", status="working", session_id="sess-3",
    )
    assert await store.task_for_session("sess-3") is not None

    await store.archive_task("adopted")
    assert await store.task_for_session("sess-3") is None


@pytest.mark.asyncio
async def test_mark_running_interrupted(tmp_path):
    store = await _store(tmp_path)
    await store.create_task("a", executor_id="claude-code", workspace="/w", title=None, pid=1)
    await store.create_task("b", executor_id="claude-code", workspace="/w", title=None, pid=2)
    await store.set_exit("b", 0)
    interrupted = await store.mark_running_interrupted()
    assert [t["id"] for t in interrupted] == ["a"]
    assert interrupted[0]["status"] == "interrupted"
    assert interrupted[0]["ended_at"] is not None
    assert (await store.get_task("a"))["status"] == "interrupted"
    assert (await store.get_task("b"))["status"] == "done"


@pytest.mark.asyncio
async def test_events_are_hash_chained_and_verifiable(tmp_path):
    store = await _store(tmp_path)
    await store.create_task("a", executor_id="claude-code", workspace="/w", title=None, pid=1)
    await store.add_event("a", kind="spawn", origin="ui", detail="claude-code in /w")
    await store.add_event("a", kind="input", origin="ui", detail="line 1, 4 bytes")
    events = await store.list_events("a")
    assert [e["kind"] for e in events] == ["spawn", "input"]
    assert events[0]["prev_hash"] is None
    assert events[1]["prev_hash"] == events[0]["row_hash"]
    assert await store.verify_chain() == {"ok": True, "checked": 2, "first_bad_seq": None}
    await store.db.execute("UPDATE terminal_events SET detail='tampered' WHERE seq=1")
    result = await store.verify_chain()
    assert result["ok"] is False and result["first_bad_seq"] == 1


@pytest.mark.asyncio
async def test_add_event_concurrent_calls_keep_chain_intact(tmp_path):
    store = await _store(tmp_path)
    await store.create_task("a", executor_id="claude-code", workspace="/w", title=None, pid=1)
    await asyncio.gather(
        *(store.add_event("a", kind="input", origin="ui", detail=f"line {i}") for i in range(8))
    )
    events = await store.list_events("a")
    assert [e["seq"] for e in events] == list(range(1, 9))
    assert await store.verify_chain() == {"ok": True, "checked": 8, "first_bad_seq": None}


@pytest.mark.asyncio
async def test_set_exit_none_is_failed_with_no_exit_code(tmp_path):
    store = await _store(tmp_path)
    await store.create_task("a", executor_id="claude-code", workspace="/w", title=None, pid=1)
    await store.set_exit("a", None)
    task = await store.get_task("a")
    assert task["status"] == "failed"
    assert task["exit_code"] is None


@pytest.mark.asyncio
async def test_update_status_truncates_activity_to_200_chars(tmp_path):
    store = await _store(tmp_path)
    await store.create_task("a", executor_id="claude-code", workspace="/w", title=None, pid=1)
    await store.update_status("a", "working", activity="x" * 300)
    task = await store.get_task("a")
    assert len(task["activity"]) == 200


@pytest.mark.asyncio
async def test_list_verdicts_filters_by_session_and_orders_newest_first(tmp_path):
    store = await _store(tmp_path)
    await store.db.execute(
        "INSERT INTO tool_call_audit (tool_id, function_name, action, risk, reason, is_essential, "
        "args_preview, runtime_kind, session_id) VALUES ('bash', 'Bash', 'allow', 'green', 'ok', 0, "
        "'ls', 'claude-code', 'sess-1')"
    )
    await store.db.execute(
        "INSERT INTO tool_call_audit (tool_id, function_name, action, risk, reason, is_essential, "
        "args_preview, runtime_kind, session_id) VALUES ('bash', 'Bash', 'block', 'red', 'rm on root', 0, "
        "'rm -rf /', 'claude-code', 'sess-1')"
    )
    await store.db.execute(
        "INSERT INTO tool_call_audit (tool_id, function_name, action, risk, reason, is_essential, "
        "args_preview, runtime_kind, session_id) VALUES ('bash', 'Bash', 'allow', 'green', 'ok', 0, "
        "'ls', 'claude-code', 'sess-other')"
    )
    items = await store.list_verdicts("sess-1")
    assert [i["action"] for i in items] == ["block", "allow"]
    assert await store.list_verdicts("sess-1", limit=1) == items[:1]
    assert await store.list_verdicts("sess-does-not-exist") == []


@pytest.mark.asyncio
async def test_tasks_with_event_answers_the_whole_board_in_one_query(tmp_path):
    store = await _store(tmp_path)
    for tid in ("a", "b", "c"):
        await store.create_task(tid, executor_id="claude-code", workspace="/w", title=None, pid=1)
        await store.add_event(tid, kind="spawn", origin="ui", detail=tid)
    await store.add_event("a", kind="guard_missing", origin="ui", detail="ungoverned")
    await store.add_event("c", kind="guard_missing", origin="ui", detail="ungoverned")
    # Two events of the same kind on one task must not produce a duplicate.
    await store.add_event("c", kind="guard_missing", origin="ui", detail="ungoverned again")

    assert await store.tasks_with_event("guard_missing", ["a", "b", "c"]) == {"a", "c"}
    assert await store.tasks_with_event("guard_missing", ["b"]) == set()
    assert await store.tasks_with_event("guard_missing", []) == set()
    assert await store.tasks_with_event("spawn", ["a", "b"]) == {"a", "b"}
    # An id that names no task at all is simply absent from the answer.
    assert await store.tasks_with_event("guard_missing", ["a", "nope"]) == {"a"}


@pytest.mark.asyncio
async def test_tasks_with_event_chunks_past_the_sqlite_parameter_cap(tmp_path):
    store = await _store(tmp_path)
    # 1200 ids is three chunks; SQLite would refuse them as one bound list.
    ids = [f"t{i:04d}" for i in range(1200)]
    for tid in (ids[0], ids[700], ids[1199]):
        await store.create_task(tid, executor_id="claude-code", workspace="/w", title=None, pid=1)
        await store.add_event(tid, kind="guard_missing", origin="ui", detail="ungoverned")

    assert await store.tasks_with_event("guard_missing", ids) == {ids[0], ids[700], ids[1199]}


# --- linked sessions -------------------------------------------------------


async def _audit(store, *, session_id, runtime_kind, function_name, called_at, preview=None):
    """Insert one tool_call_audit row directly.

    The repository write path derives called_at from SQLite's own clock, so
    the liveness rules (which are entirely about age) need a writer that can
    place a row in the past.
    """
    await store.db.execute(
        "INSERT INTO tool_call_audit "
        "(tool_id, function_name, action, risk, reason, is_essential, args_preview, "
        "called_at, session_id, runtime_kind) "
        "VALUES (?, ?, 'allow', NULL, NULL, 0, ?, ?, ?, ?)",
        (function_name, function_name, preview, called_at, session_id, runtime_kind),
    )


def _stamp(minutes_ago: int) -> str:
    from datetime import datetime, timedelta, timezone

    when = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    return when.strftime("%Y-%m-%d %H:%M:%S")


@pytest.mark.asyncio
async def test_migration_adds_origin_defaulting_to_launch(tmp_path):
    db = DatabaseConnection(tmp_path / "t.db")
    version = await run_migrations(db)
    assert version >= 50
    columns = {r["name"] for r in await db.fetch_all("PRAGMA table_info(terminal_tasks)")}
    assert "origin" in columns
    store = TerminalStore(db)
    await store.create_task("t1", executor_id="claude-code", workspace="/w", title=None, pid=1)
    assert (await store.get_task("t1"))["origin"] == "launch"


@pytest.mark.asyncio
async def test_create_linked_task_carries_origin_session_and_no_pid(tmp_path):
    store = await _store(tmp_path)
    await store.create_task(
        "L1",
        executor_id="codex",
        workspace="/w",
        title="Outside",
        pid=None,
        origin="linked",
        status="working",
        session_id="sess-outside",
        activity="linked",
    )
    task = await store.get_task("L1")
    assert task["origin"] == "linked" and task["pid"] is None
    assert task["status"] == "working" and task["session_id"] == "sess-outside"
    assert task["activity"] == "linked"
    assert [t["id"] for t in await store.list_linked_tasks()] == ["L1"]


@pytest.mark.asyncio
async def test_task_for_session_ignores_archived_rows(tmp_path):
    store = await _store(tmp_path)
    await store.create_task(
        "L1", executor_id="codex", workspace="/w", title=None, pid=None,
        origin="linked", status="working", session_id="sess-1",
    )
    assert (await store.task_for_session("sess-1"))["id"] == "L1"
    await store.update_linked_state(
        "L1", status="done", activity=None, last_activity_at=None, ended_at=None
    )
    await store.archive_task("L1")
    assert await store.task_for_session("sess-1") is None


@pytest.mark.asyncio
async def test_session_activity_separates_calls_from_boundaries(tmp_path):
    store = await _store(tmp_path)
    await _audit(store, session_id="s1", runtime_kind="codex",
                 function_name="__session_start__", called_at=_stamp(40))
    await _audit(store, session_id="s1", runtime_kind="codex",
                 function_name="Bash", called_at=_stamp(20))
    await _audit(store, session_id="s1", runtime_kind="codex",
                 function_name="__session_end__", called_at=_stamp(5))
    await _audit(store, session_id="s2", runtime_kind="codex",
                 function_name="Read", called_at=_stamp(1))

    seen = await store.session_activity(["s1", "s2", "missing"])
    assert set(seen) == {"s1", "s2"}
    assert seen["s1"]["last_call"] < seen["s1"]["last_end"]
    assert seen["s1"]["last_any"] == seen["s1"]["last_end"]
    assert seen["s2"]["last_end"] is None
    assert await store.session_activity([]) == {}


@pytest.mark.asyncio
async def test_unlinked_sessions_excludes_linked_and_unknown_runtimes(tmp_path):
    store = await _store(tmp_path)
    await _audit(store, session_id="free", runtime_kind="claude-code",
                 function_name="Bash", called_at=_stamp(3))
    await _audit(store, session_id="free", runtime_kind="claude-code",
                 function_name="__session_start__", called_at=_stamp(4))
    await _audit(store, session_id="taken", runtime_kind="codex",
                 function_name="Read", called_at=_stamp(2))
    await _audit(store, session_id="sdk", runtime_kind="langchain",
                 function_name="Read", called_at=_stamp(1))
    await _audit(store, session_id="stale", runtime_kind="codex",
                 function_name="Read", called_at=_stamp(60 * 30))
    await store.create_task(
        "L1", executor_id="codex", workspace="/w", title=None, pid=None,
        origin="linked", status="working", session_id="taken",
    )

    rows = await store.unlinked_sessions()
    assert [r["session_id"] for r in rows] == ["free"]
    assert rows[0]["executor_id"] == "claude-code"
    # The boundary sentinel is not a call, so it is not counted as one.
    assert rows[0]["calls"] == 1
    assert rows[0]["workspace"] is None


@pytest.mark.asyncio
async def test_unlinked_sessions_offers_a_session_again_once_archived(tmp_path):
    store = await _store(tmp_path)
    await _audit(store, session_id="s1", runtime_kind="codex",
                 function_name="Read", called_at=_stamp(2), preview="cwd=/repo/app")
    await store.create_task(
        "L1", executor_id="codex", workspace="/w", title=None, pid=None,
        origin="linked", status="done", session_id="s1",
    )
    assert await store.unlinked_sessions() == []
    await store.archive_task("L1")
    rows = await store.unlinked_sessions()
    assert [r["session_id"] for r in rows] == ["s1"]
    assert rows[0]["workspace"] == "/repo/app"


@pytest.mark.asyncio
async def test_mark_running_interrupted_leaves_linked_tasks_alone(tmp_path):
    store = await _store(tmp_path)
    await store.create_task("launched", executor_id="claude-code", workspace="/w", title=None, pid=1)
    await store.create_task(
        "linked", executor_id="codex", workspace="/w", title=None, pid=None,
        origin="linked", status="working", session_id="s1",
    )
    interrupted = await store.mark_running_interrupted()
    assert [t["id"] for t in interrupted] == ["launched"]
    assert (await store.get_task("linked"))["status"] == "working"


@pytest.mark.asyncio
async def test_cwd_from_preview_handles_spaces_quotes_and_oversize():
    from securevector.app.terminals.store import CWD_MAX_CHARS, cwd_from_preview

    assert cwd_from_preview("session_id=abc cwd=/repo/app") == "/repo/app"
    # A path is the one field here that legitimately contains spaces, so the
    # value runs to the end rather than to the next space.
    assert cwd_from_preview("cwd=/Users/me/My Projects/app") == "/Users/me/My Projects/app"
    assert cwd_from_preview('cwd="/Users/me/My Projects/app"; shell=zsh') == (
        "/Users/me/My Projects/app"
    )
    assert cwd_from_preview("cwd='/tmp/a b'") == "/tmp/a b"
    assert cwd_from_preview("cwd=/repo/app; shell=zsh") == "/repo/app"
    assert cwd_from_preview("tool=Bash cmd=ls") is None
    assert cwd_from_preview("cwd=") is None
    assert cwd_from_preview("cwd=   ") is None
    assert cwd_from_preview(None) is None
    assert cwd_from_preview("") is None
    # Oversize is now refused rather than cut to the cap. A truncated path is
    # a fabricated one: it still looks like a folder, so it reaches the board
    # and a launch into it fails at the host. This function's own contract is
    # that callers fall back to a placeholder "rather than inventing a path",
    # and truncation was inventing one.
    assert cwd_from_preview("cwd=/" + "a" * 5000) is None
    assert CWD_MAX_CHARS == 1024


@pytest.mark.asyncio
async def test_unlinked_sessions_is_not_starved_by_a_busy_board(tmp_path):
    store = await _store(tmp_path)
    # 30 claimed sessions, all newer than the free one. Filtering them out in
    # Python after a LIMIT would return an empty list.
    for i in range(30):
        sid = f"sess-claimed{i:03d}"
        await _audit(store, session_id=sid, runtime_kind="codex",
                     function_name="Read", called_at=_stamp(1))
        await store.create_task(
            f"T{i}", executor_id="codex", workspace="/w", title=None, pid=None,
            origin="linked", status="working", session_id=sid,
        )
    await _audit(store, session_id="sess-free0001", runtime_kind="codex",
                 function_name="Read", called_at=_stamp(10))

    rows = await store.unlinked_sessions()
    assert [r["session_id"] for r in rows] == ["sess-free0001"]


@pytest.mark.asyncio
async def test_unlinked_sessions_reads_the_newest_row_not_the_largest_value(tmp_path):
    store = await _store(tmp_path)
    # The older row sorts higher as a string, so MAX() would pick it.
    await _audit(store, session_id="sess-moved01", runtime_kind="codex",
                 function_name="Read", called_at=_stamp(30), preview="cwd=/zzz/old")
    await _audit(store, session_id="sess-moved01", runtime_kind="claude-code",
                 function_name="Read", called_at=_stamp(2), preview="cwd=/aaa/new")

    (row,) = await store.unlinked_sessions()
    assert row["workspace"] == "/aaa/new"
    assert row["runtime_kind"] == "claude-code" and row["executor_id"] == "claude-code"


@pytest.mark.asyncio
async def test_migration_v50_is_idempotent_over_a_populated_table(tmp_path):
    from securevector.app.database.migrations import migrate_to_v50

    db = DatabaseConnection(tmp_path / "t.db")
    await run_migrations(db)
    store = TerminalStore(db)
    await store.create_task(
        "L1", executor_id="codex", workspace="/w", title="Keep me", pid=None,
        origin="linked", status="working", session_id="sess-abc12345",
    )

    await migrate_to_v50(db)
    await migrate_to_v50(db)

    columns = [r["name"] for r in await db.fetch_all("PRAGMA table_info(terminal_tasks)")]
    assert columns.count("origin") == 1
    task = await store.get_task("L1")
    assert task is not None
    assert task["origin"] == "linked" and task["title"] == "Keep me"
