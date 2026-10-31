"""GovRun, Hermes and OpenClaw on the Agent Sessions board.

Each one reports to the audit trail through its own Guard, so its sessions
can be linked; each can be launched from the app, with argv built by the host;
none relays this app's per-task hook events, so a launch is ungoverned.
"""

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.services.governance_gaps import harness_label
from securevector.app.terminals.executors import EXECUTORS, build_launch
from securevector.app.terminals.store import RUNTIME_TO_EXECUTOR, TerminalStore

from .test_manager import _manager, _stub_binary

NEW = {"govrun": ("GovRun", "govrun"), "hermes": ("Hermes", "hermes"), "openclaw": ("OpenClaw", "openclaw")}
_SID = "sess-0123456789abcdef"


def test_new_harness_executors_are_listed_with_ids_labels_and_binaries():
    for executor_id, (label, binary) in NEW.items():
        executor = EXECUTORS[executor_id]
        assert executor.id == executor_id
        assert executor.label == label
        assert executor.binary == binary
        # No Claude-only flags and no first prompt in argv for these.
        assert executor.supports_terminal_settings is False
        assert executor.prompt_argv == ()


def test_new_harness_labels_in_governance_helper():
    assert harness_label("govrun") == "GovRun"
    assert harness_label("hermes") == "Hermes"
    assert harness_label("openclaw") == "OpenClaw"


def test_runtime_to_executor_maps_new_harness_runtimes():
    for runtime in NEW:
        assert RUNTIME_TO_EXECUTOR[runtime] == runtime


def _launch(executor_id, tmp_path, monkeypatch, **kw):
    monkeypatch.setattr("shutil.which", lambda binary, path=None: f"/usr/local/bin/{binary}")
    ws = tmp_path / "proj"
    ws.mkdir(exist_ok=True)
    return build_launch(
        executor_id,
        workspace=ws,
        task_dir=tmp_path / "task",
        port=8741,
        task_id="t1",
        hook_token="tok",
        parent_env={"PATH": "/bin", "GOVRUN_AUTO_APPROVE": "1", "OPENCLAW_GATEWAY_TOKEN": "x"},
        plugin_dir=tmp_path / "plugin",
        **kw,
    )


@pytest.mark.parametrize(
    "executor_id,argv",
    [
        ("govrun", ["/usr/local/bin/govrun"]),
        ("hermes", ["/usr/local/bin/hermes"]),
        ("openclaw", ["/usr/local/bin/openclaw", "tui"]),
    ],
)
def test_new_harness_launch_argv_is_built_by_the_host(tmp_path, monkeypatch, executor_id, argv):
    launch = _launch(executor_id, tmp_path, monkeypatch)
    assert launch.argv == argv
    assert launch.cwd == str((tmp_path / "proj").resolve())
    assert launch.env["SV_TERMINAL_TASK_ID"] == "t1"
    # The env allowlist is unchanged: names it does not admit never arrive.
    assert "GOVRUN_AUTO_APPROVE" not in launch.env
    assert "OPENCLAW_GATEWAY_TOKEN" not in launch.env
    # No hook settings file is written for a harness that cannot take it.
    assert not (tmp_path / "task" / "settings.json").exists()


@pytest.mark.parametrize(
    "executor_id,argv",
    [
        ("govrun", ["/usr/local/bin/govrun", "--resume", _SID]),
        ("hermes", ["/usr/local/bin/hermes", "--resume", _SID]),
        ("openclaw", ["/usr/local/bin/openclaw", "tui", "--session", _SID]),
    ],
)
def test_new_harness_resume_argv_is_built_by_the_host(tmp_path, monkeypatch, executor_id, argv):
    launch = _launch(executor_id, tmp_path, monkeypatch, resume_session_id=_SID)
    assert launch.argv == argv


@pytest.mark.parametrize("executor_id", sorted(NEW))
def test_new_harness_takes_no_first_prompt_in_argv(tmp_path, monkeypatch, executor_id):
    with pytest.raises(ValueError):
        _launch(executor_id, tmp_path, monkeypatch, initial_prompt="do it")


async def _audit(store, *, session_id, runtime_kind, preview=None):
    await store.db.execute(
        "INSERT INTO tool_call_audit "
        "(tool_id, function_name, action, risk, reason, is_essential, args_preview, "
        "called_at, session_id, runtime_kind) "
        "VALUES ('bash', 'bash', 'allow', NULL, NULL, 0, ?, datetime('now'), ?, ?)",
        (preview, session_id, runtime_kind),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("runtime", sorted(NEW))
async def test_unlinked_sessions_offers_new_harness_session_until_linked(tmp_path, runtime):
    db = DatabaseConnection(tmp_path / "t.db")
    await run_migrations(db)
    store = TerminalStore(db)
    await _audit(store, session_id=f"{runtime}-session-1", runtime_kind=runtime, preview="cwd=/repo/app")

    rows = await store.unlinked_sessions()
    assert [r["session_id"] for r in rows] == [f"{runtime}-session-1"]
    assert rows[0]["executor_id"] == runtime
    assert rows[0]["workspace"] == "/repo/app"

    await store.create_task(
        "L1", executor_id=runtime, workspace="/repo/app", title=None, pid=None,
        origin="linked", status="working", session_id=f"{runtime}-session-1",
    )
    assert await store.unlinked_sessions() == []


@pytest.mark.asyncio
@pytest.mark.parametrize("runtime", sorted(NEW))
async def test_link_session_puts_new_harness_session_on_the_board(tmp_path, runtime):
    m, _ws = await _manager(tmp_path)
    await _audit(m.store, session_id=f"{runtime}-session-2", runtime_kind=runtime, preview="cwd=/repo/x")
    task = await m.link_session(runtime, f"{runtime}-session-2")
    assert task["executor_id"] == runtime and task["origin"] == "linked"
    assert task["workspace"] == "/repo/x"
    assert await m.store.unlinked_sessions() == []


@pytest.mark.asyncio
async def test_new_harness_executor_status_is_ungoverned_with_no_guard_install(tmp_path):
    m, _ws = await _manager(tmp_path)
    for name in NEW:
        _stub_binary(tmp_path, name)
    rows = {row["id"]: row for row in m.executor_status()}
    for executor_id, (label, _binary) in NEW.items():
        row = rows[executor_id]
        assert row["installed"] is True
        assert row["governed"] is False
        assert row["supports_resume"] is True
        assert row["guard_relay"] is False
        assert label in row["hint"] and "ungoverned" in row["hint"]
        assert m.would_be_governed(executor_id) is False
    assert rows["codex"]["guard_relay"] is True


@pytest.mark.asyncio
async def test_new_harness_spawn_runs_ungoverned_and_says_so(tmp_path):
    m, ws = await _manager(tmp_path)
    _stub_binary(tmp_path, "hermes")
    task = await m.spawn("hermes", str(ws), title=None, origin="ui")
    assert task["id"] in m.ungoverned_ids()
    events = await m.store.list_events(task["id"])
    missing = [e["detail"] for e in events if e["kind"] == "guard_missing"]
    assert missing and "Hermes" in missing[0] and "ungoverned" in missing[0]


# A folder scraped from an audit preview may be a tool argument. For these
# harnesses it is shown as reported and never used to resume until a person
# names the folder.


@pytest.mark.asyncio
@pytest.mark.parametrize("prefilled", [False, True])
async def test_reported_folder_is_marked_and_blocks_resume(tmp_path, prefilled):
    from securevector.app.terminals.manager import FOLDER_REPORTED

    m, ws = await _manager(tmp_path)
    _stub_binary(tmp_path, "hermes")
    sid = "hermes-session-9"
    await _audit(m.store, session_id=sid, runtime_kind="hermes", preview=f"cwd={ws}")
    # The board pre-fills the scraped folder; that is still the agent's report.
    task = await m.link_session("hermes", sid, workspace=str(ws) if prefilled else None)
    assert task["workspace"] == str(ws)
    assert await m.store.tasks_with_event(FOLDER_REPORTED, [task["id"]]) == {task["id"]}
    with pytest.raises(ValueError, match="--folder"):
        await m.spawn("hermes", str(ws), title=None, origin="ui", resume_session_id=sid)


@pytest.mark.asyncio
async def test_confirmed_folder_is_not_marked_and_resume_proceeds(tmp_path):
    from securevector.app.terminals.manager import FOLDER_REPORTED

    m, ws = await _manager(tmp_path)
    _stub_binary(tmp_path, "hermes")
    sid = "hermes-session-10"
    await _audit(m.store, session_id=sid, runtime_kind="hermes", preview=f"cwd={ws}")
    task = await m.link_session("hermes", sid, workspace=str(ws), folder_confirmed=True)
    assert await m.store.tasks_with_event(FOLDER_REPORTED, [task["id"]]) == set()
    resumed = await m.spawn("hermes", str(ws), title=None, origin="ui", resume_session_id=sid)
    assert resumed["executor_id"] == "hermes"


@pytest.mark.asyncio
async def test_a_typed_folder_other_than_the_report_is_not_marked(tmp_path):
    from securevector.app.terminals.manager import FOLDER_REPORTED

    m, ws = await _manager(tmp_path)
    sid = "openclaw-session-11"
    await _audit(m.store, session_id=sid, runtime_kind="openclaw", preview="cwd=/somewhere/else")
    task = await m.link_session("openclaw", sid, workspace=str(ws))
    assert await m.store.tasks_with_event(FOLDER_REPORTED, [task["id"]]) == set()


@pytest.mark.asyncio
async def test_existing_harness_linked_folder_is_never_marked_reported(tmp_path):
    from securevector.app.terminals.manager import FOLDER_REPORTED

    m, _ws = await _manager(tmp_path)
    sid = "codex-session-12"
    await _audit(m.store, session_id=sid, runtime_kind="codex", preview="cwd=/repo/c")
    task = await m.link_session("codex", sid)
    assert await m.store.tasks_with_event(FOLDER_REPORTED, [task["id"]]) == set()


def test_cli_link_with_folder_marks_it_confirmed():
    from securevector.app.terminals.client import TerminalsClient

    sent = {}
    client = TerminalsClient.__new__(TerminalsClient)
    client._request = lambda method, path, body=None: sent.update(body or {}) or {}
    client.link("govrun", "govrun-session-1", workspace="/repo/g")
    assert sent["folder_confirmed"] is True
    client.link("govrun", "govrun-session-1")
    assert sent["folder_confirmed"] is False


@pytest.mark.asyncio
async def test_relaunch_from_a_reported_folder_row_is_refused(tmp_path):
    m, ws = await _manager(tmp_path)
    _stub_binary(tmp_path, "govrun")
    sid = "govrun-session-13"
    await _audit(m.store, session_id=sid, runtime_kind="govrun", preview=f"cwd={ws}")
    task = await m.link_session("govrun", sid)
    with pytest.raises(ValueError, match="--folder"):
        await m.spawn("govrun", str(ws), title=None, origin="ui", from_task_id=task["id"])
