"""Privacy tests for the Live Runs emitter.

The load-bearing one is test_no_unallowlisted_field_reaches_the_payload:
it puts a distinct sentinel in every column that is NOT on the allowlist
and asserts that none of them survives serialization. When someone adds a
column to terminal_tasks later, adding it to this row keeps the boundary
honest without anyone having to remember the rule.
"""

import json
from pathlib import Path as _Path

import pytest

from securevector.app.terminals import live_runs
from securevector.app.terminals.executors import EXECUTORS

KEY = b"a-fixed-test-salt-not-the-real-one"

WORKSPACE = "/Users/tester/clients/acme-corp/pricing-model"
TITLE = "Rewrite the Acme pricing model before Tuesday"
SESSION = "3f6b1d02-9c44-4e1a-8f2b-7c9d0e1a2b3c"


def allowlisted_row():
    """A realistic row, the way TerminalStore.get_task() returns one."""
    return {
        "id": "a1b2c3d4e5f6",
        "executor_id": "claude-code",
        "workspace": WORKSPACE,
        "title": TITLE,
        "status": "working",
        "session_id": SESSION,
        "pid": 40321,
        "exit_code": None,
        "activity": "Editing /Users/tester/clients/acme-corp/pricing-model/model.py",
        "created_at": "2026-09-21T10:00:00.000+00:00",
        "last_activity_at": "2026-09-21T10:04:00.000+00:00",
        "ended_at": None,
        "archived_at": None,
        "origin": "launch",
    }


def dumped(payload):
    return json.dumps(payload, default=str)


# -- the allowlist ---------------------------------------------------------


def test_no_unallowlisted_field_reaches_the_payload():
    """Secret-looking value in every non-allowlisted column, none survives."""
    row = allowlisted_row()
    secrets_by_field = {}
    for column in [
        "workspace",
        "title",
        "session_id",
        "pid",
        "activity",
        # Columns that do not exist yet. A future migration adding one must
        # not start exporting it just because it appeared on the row.
        "prompt",
        "last_command",
        "git_branch",
        "repo_url",
        "notes",
    ]:
        value = "SENTINEL-{}-/Users/tester/secret-client".format(column)
        secrets_by_field[column] = value
        row[column] = value

    blob = dumped(live_runs.build_payload(row, "spawn", origin="ui", key=KEY))

    for column, value in secrets_by_field.items():
        assert value not in blob, "{} leaked into the Live Runs payload".format(column)
    assert "SENTINEL" not in blob


def test_payload_keys_are_exactly_the_published_shape():
    payload = live_runs.build_payload(allowlisted_row(), "spawn", origin="ui", key=KEY)
    assert set(payload) == {
        "schema",
        "event",
        "event_origin",
        "emitted_at",
        "task_id",
        "executor_id",
        "status",
        "task_origin",
        "workspace_digest",
        "has_session",
        "session_digest",
        "exit_code",
        "created_at",
        "last_activity_at",
        "ended_at",
        "archived_at",
    }
    assert payload["schema"] == live_runs.SCHEMA
    assert payload["event"] == "spawn"
    assert payload["event_origin"] == "ui"
    # A keyed digest of the local id, never the id itself, and inside the
    # charset the fleet ingest accepts.
    assert payload["task_id"] != "a1b2c3d4e5f6"
    assert payload["task_id"] == live_runs._digest("a1b2c3d4e5f6", domain="task", key=KEY)
    import re as _re

    assert _re.fullmatch(r"[0-9a-f]{32}", payload["task_id"])
    assert payload["executor_id"] == "claude-code"
    assert payload["status"] == "working"
    assert payload["task_origin"] == "launch"


def test_allowlist_matches_the_published_shape():
    """Nothing quietly added to the allowlist without a payload field."""
    assert live_runs.TASK_FIELD_ALLOWLIST == {
        "id",
        "executor_id",
        "status",
        "origin",
        "exit_code",
        "created_at",
        "last_activity_at",
        "ended_at",
        "archived_at",
    }
    for forbidden in ("workspace", "title", "activity", "pid", "session_id"):
        assert forbidden not in live_runs.TASK_FIELD_ALLOWLIST


def test_executor_vocabulary_tracks_the_real_executors():
    """A fifth harness must be a conscious decision, not a silent passthrough."""
    assert live_runs.EXECUTOR_IDS == set(EXECUTORS.keys())


# -- the workspace path ----------------------------------------------------


def test_workspace_path_never_appears_and_digest_is_stable():
    row = allowlisted_row()
    first = live_runs.build_payload(row, "spawn", origin="ui", key=KEY)
    second = live_runs.build_payload(row, "stop", origin="ui", key=KEY)

    assert WORKSPACE not in dumped(first)
    assert "acme-corp" not in dumped(first)
    assert "tester" not in dumped(first)
    assert first["workspace_digest"]
    assert first["workspace_digest"] == second["workspace_digest"]


def test_workspace_digest_differs_for_different_paths():
    a = live_runs.workspace_digest("/Users/tester/one", key=KEY)
    b = live_runs.workspace_digest("/Users/tester/two", key=KEY)
    assert a and b and a != b


def test_workspace_digest_normalises_equivalent_spellings():
    a = live_runs.workspace_digest("/Users/tester/one", key=KEY)
    b = live_runs.workspace_digest("/Users/tester/./one/", key=KEY)
    assert a == b


def test_workspace_digest_is_keyed_so_the_cloud_cannot_recompute_it():
    assert live_runs.workspace_digest(WORKSPACE, key=b"one") != live_runs.workspace_digest(
        WORKSPACE, key=b"two"
    )


def test_workspace_digest_is_empty_for_empty_input():
    assert live_runs.workspace_digest(None, key=KEY) is None
    assert live_runs.workspace_digest("   ", key=KEY) is None


def test_salt_is_persisted_and_reused(tmp_path):
    first = live_runs.salt_from_data_dir(tmp_path)
    second = live_runs.salt_from_data_dir(tmp_path)
    assert first == second
    assert len(first) >= 32
    assert live_runs.salt_from_data_dir(tmp_path / "other") != first


# -- the title -------------------------------------------------------------


def test_title_never_appears():
    payload = live_runs.build_payload(allowlisted_row(), "linked", origin="ui", key=KEY)
    blob = dumped(payload)
    assert TITLE not in blob
    assert "Acme" not in blob
    assert "title" not in payload


# -- session id ------------------------------------------------------------


def test_session_id_is_digested_never_sent():
    payload = live_runs.build_payload(allowlisted_row(), "adopted", origin="ui", key=KEY)
    assert SESSION not in dumped(payload)
    assert payload["has_session"] is True
    assert payload["session_digest"]
    assert payload["session_digest"] != SESSION


def test_session_digest_is_domain_separated_from_workspace_digest():
    """The same string in two fields must not digest to the same token."""
    row = allowlisted_row()
    row["workspace"] = "shared-value"
    row["session_id"] = "shared-value"
    payload = live_runs.build_payload(row, "spawn", origin="ui", key=KEY)
    assert payload["workspace_digest"] != payload["session_digest"]


def test_missing_session_reports_absent():
    row = allowlisted_row()
    row["session_id"] = None
    payload = live_runs.build_payload(row, "spawn", origin="ui", key=KEY)
    assert payload["has_session"] is False
    assert payload["session_digest"] is None


# -- closed vocabularies ---------------------------------------------------


def test_unknown_enum_values_are_dropped_not_forwarded():
    row = allowlisted_row()
    row["executor_id"] = "evil-harness /Users/tester/secret"
    row["status"] = "leaking /Users/tester/secret"
    row["origin"] = "/Users/tester/secret"
    payload = live_runs.build_payload(row, "not-a-kind", origin="not-an-origin", key=KEY)
    assert payload["executor_id"] is None
    assert payload["status"] is None
    assert payload["task_origin"] is None
    assert payload["event"] is None
    assert payload["event_origin"] is None
    assert "secret" not in dumped(payload)


def test_odd_task_id_is_digested_rather_than_exported():
    row = allowlisted_row()
    row["id"] = "/Users/tester/secret-client/run-1"
    payload = live_runs.build_payload(row, "spawn", origin="ui", key=KEY)
    assert payload["task_id"]
    assert "secret-client" not in dumped(payload)


def test_free_text_in_a_timestamp_column_is_dropped():
    row = allowlisted_row()
    row["ended_at"] = "/Users/tester/secret-client"
    payload = live_runs.build_payload(row, "stop", origin="ui", key=KEY)
    assert payload["ended_at"] is None
    assert "secret-client" not in dumped(payload)


def test_exit_code_is_coerced_to_an_integer():
    row = allowlisted_row()
    row["exit_code"] = "137"
    assert live_runs.build_payload(row, "stop", key=KEY)["exit_code"] == 137
    row["exit_code"] = "/Users/tester/secret"
    assert live_runs.build_payload(row, "stop", key=KEY)["exit_code"] is None


def test_build_payload_survives_a_garbage_row():
    payload = live_runs.build_payload(None, None, key=KEY)
    assert payload["schema"] == live_runs.SCHEMA
    assert payload["task_id"] is None


# -- emit ------------------------------------------------------------------


@pytest.fixture(autouse=True)
def clean_emitter():
    live_runs.set_sink(None)
    live_runs.set_salt(KEY)
    yield
    live_runs.set_sink(None)
    live_runs.set_salt(None)


@pytest.mark.asyncio
async def test_emit_is_a_noop_without_a_sink():
    """the cloud endpoint does not exist yet: emit must simply do nothing."""
    assert await live_runs.emit(allowlisted_row(), "spawn", origin="ui") is False


@pytest.mark.asyncio
async def test_emit_is_a_noop_when_cloud_connect_is_off(monkeypatch):
    sent = []
    live_runs.set_sink(lambda payload: sent.append(payload))

    async def not_connected():
        return False

    monkeypatch.setattr(live_runs, "cloud_connected", not_connected)
    assert await live_runs.emit(allowlisted_row(), "spawn", origin="ui") is False
    assert sent == []


@pytest.mark.asyncio
async def test_cloud_connected_is_false_when_settings_cannot_be_read(monkeypatch):
    """Fail closed: a broken settings read must not start exporting."""
    from securevector.app.database import connection as connection_module

    def explode():
        raise RuntimeError("database not initialized")

    monkeypatch.setattr(connection_module, "get_database", explode)
    assert await live_runs.cloud_connected() is False


@pytest.mark.asyncio
async def test_emit_sends_when_connected(monkeypatch):
    sent = []

    async def sink(payload):
        sent.append(payload)

    async def connected():
        return True

    live_runs.set_sink(sink)
    monkeypatch.setattr(live_runs, "cloud_connected", connected)

    assert await live_runs.emit(allowlisted_row(), "spawn", origin="ui") is True
    assert len(sent) == 1
    assert WORKSPACE not in dumped(sent[0])
    assert TITLE not in dumped(sent[0])


@pytest.mark.asyncio
async def test_emit_swallows_a_sink_that_raises(monkeypatch):
    async def connected():
        return True

    def boom(payload):
        raise RuntimeError("cloud is on fire at /Users/tester/secret")

    live_runs.set_sink(boom)
    monkeypatch.setattr(live_runs, "cloud_connected", connected)

    assert await live_runs.emit(allowlisted_row(), "stop", origin="ui") is False


@pytest.mark.asyncio
async def test_emit_swallows_an_async_sink_that_raises(monkeypatch):
    async def connected():
        return True

    async def boom(payload):
        raise RuntimeError("cloud rejected the run")

    live_runs.set_sink(boom)
    monkeypatch.setattr(live_runs, "cloud_connected", connected)

    assert await live_runs.emit(allowlisted_row(), "stop", origin="ui") is False


@pytest.mark.asyncio
async def test_emit_does_not_wait_forever_on_a_hanging_sink(monkeypatch):
    import asyncio

    async def connected():
        return True

    async def hangs(payload):
        await asyncio.sleep(60)

    live_runs.set_sink(hangs)
    monkeypatch.setattr(live_runs, "cloud_connected", connected)

    assert await live_runs.emit(allowlisted_row(), "stop", origin="ui", timeout=0.01) is False


@pytest.mark.asyncio
async def test_emit_nowait_does_not_block_or_raise(monkeypatch):
    import asyncio

    sent = []

    async def connected():
        return True

    async def sink(payload):
        sent.append(payload)

    live_runs.set_sink(sink)
    monkeypatch.setattr(live_runs, "cloud_connected", connected)

    row = allowlisted_row()
    handle = live_runs.emit_nowait(row, "spawn", origin="ui")
    assert handle is not None
    # The row can change the instant after the call; the snapshot must not.
    row["title"] = "mutated"
    await asyncio.wait_for(handle, 1.0)
    assert len(sent) == 1
    assert "mutated" not in dumped(sent[0])


def test_emit_nowait_returns_none_without_a_running_loop():
    assert live_runs.emit_nowait(allowlisted_row(), "spawn", origin="ui") is None


@pytest.mark.asyncio
async def test_emit_nowait_skips_a_missing_row(monkeypatch):
    """`store.get_task()` can return None (row archived, or read in the
    narrow window before create_task() commits). Scheduling emit() anyway
    would build an all-None payload that still carries a real event kind,
    which a Live Runs consumer cannot tell apart from a task nothing is
    known about. There is nothing honest to send, so nothing is scheduled."""
    sent = []

    async def connected():
        return True

    async def sink(payload):
        sent.append(payload)

    live_runs.set_sink(sink)
    monkeypatch.setattr(live_runs, "cloud_connected", connected)

    assert live_runs.emit_nowait(None, "spawn", origin="ui") is None
    assert sent == []


# -- has_sink() --------------------------------------------------------------


def test_has_sink_reflects_whether_a_sink_is_installed():
    assert live_runs.has_sink() is False
    live_runs.set_sink(lambda payload: None)
    assert live_runs.has_sink() is True
    live_runs.set_sink(None)
    assert live_runs.has_sink() is False


# -- closed vocabularies stay honest about what is actually emitted --------


def test_every_add_event_kind_in_the_codebase_is_allowlisted():
    """EVENT_KINDS used to miss `interrupted`, `exit`, `hook`, `attach` and
    `detach`: real values `add_event(kind=...)` is called with elsewhere in
    Terminals, that `_enum()` would silently degrade to None on export. Scan
    every call site for its literal kind= and pin them all as allowlisted,
    so a new one introduced later without updating EVENT_KINDS fails this
    test instead of silently losing its event on the wire."""
    import re

    terminals_dir = _Path(__file__).resolve().parents[4] / "src/securevector/app/terminals"
    routes_dir = (
        _Path(__file__).resolve().parents[4] / "src/securevector/app/server/routes"
    )
    # The lookbehind matters: `runtime_kind="openclaw"` is a DIFFERENT keyword
    # and appears in a comment in main.py. Without it the scan reports a
    # missing event kind that was never an event kind, and the next person
    # "fixes" it by widening the allowlist with a value nothing emits.
    kind_re = re.compile(r'(?<![A-Za-z_])kind="([a-z_]+)"')
    found: set[str] = set()
    # main.py and server/app.py also call add_event (the "quit" and "shutdown"
    # stop-all paths), and were outside the scan until 2026-09-21. A scan that
    # misses a caller certifies nothing about that caller.
    app_dir = _Path(__file__).resolve().parents[4] / "src/securevector/app"
    roots = (
        list(terminals_dir.glob("*.py"))
        + list(routes_dir.glob("hooks*.py"))
        + [app_dir / "main.py", app_dir / "server" / "app.py"]
    )
    for py_file in [f for f in roots if f.exists()]:
        found |= set(kind_re.findall(py_file.read_text(encoding="utf-8")))
    assert found, "the scan itself found nothing, which means it is broken"
    # And prove the two newly added roots are genuinely being read, or their
    # inclusion would be decorative.
    # Prove the widened scan is actually reading main.py. `<= found` would be a
    # TAUTOLOGY, since `found` is the union that already includes it.
    #
    # Only main.py is asserted. server/app.py is in the roots for the future,
    # but contributes nothing today and that is CORRECT: its shutdown path
    # calls stop_all, and the kind literal lives inside the manager where
    # add_event is actually called. Asserting it non-empty would be asserting
    # something untrue about how that path works.
    main_kinds = set(kind_re.findall((app_dir / "main.py").read_text(encoding="utf-8")))
    assert main_kinds, "main.py contributed no event kinds; is it still a caller?"
    assert main_kinds <= live_runs.EVENT_KINDS
    assert found <= live_runs.EVENT_KINDS, found - live_runs.EVENT_KINDS


def test_every_stop_all_origin_is_allowlisted():
    """`shutdown` and `quit` are the origins `stop_all` is actually called
    with (server/app.py on a clean web shutdown, main.py on the desktop
    app's own quit) -- the two most common ways a task ever stops."""
    assert {"shutdown", "quit"} <= live_runs.EVENT_ORIGINS


# --- wired into the manager, and harmless there -------------------------------
#
# The module is only worth anything if it is called, and only safe if the call
# cannot hurt the local path. Both halves are pinned here.

_MANAGER = (
    _Path(__file__).resolve().parents[4]
    / "src/securevector/app/terminals/manager.py"
).read_text(encoding="utf-8")


def test_every_lifecycle_transition_emits():
    import re as _re

    kinds = _re.findall(r'live_runs\.emit_nowait\([^,]+, "([a-z_]+)"', _MANAGER)
    assert sorted(kinds) == sorted(
        ["spawn", "stop", "hook", "exit", "interrupted", "archived", "heartbeat"]
    )
    assert _MANAGER.count("live_runs.emit_nowait(") == len(kinds)
    # Spawn and stop pass the row they already have in hand -- fetched a
    # few lines above for another reason in each case -- rather than
    # re-reading the store just for this call.
    assert 'live_runs.emit_nowait(task, "spawn"' in _MANAGER
    assert 'live_runs.emit_nowait(task, "stop"' in _MANAGER


def test_every_emit_site_is_guarded_by_has_sink():
    """With no sink installed, scheduling `emit_nowait()` is pure waste: a
    snapshot, an asyncio Task, and a settings read that can only ever
    resolve to a no-op. Every call site checks `has_sink()` first so that
    cost is not paid on each transition."""
    lines = _MANAGER.splitlines()
    for i, line in enumerate(lines):
        if "live_runs.emit_nowait(" in line:
            window = "\n".join(lines[max(0, i - 20):i])
            assert "live_runs.has_sink()" in window, line


def test_the_manager_never_awaits_the_emit():
    """`emit_nowait`, never `await live_runs.emit(`. A cloud that is slow or
    gone must not hold up a local launch or stop, and an awaited emit on the
    spawn path would do exactly that."""
    assert "await live_runs.emit(" not in _MANAGER


def test_no_call_site_passes_a_detail():
    """The audit `detail` beside these calls carries the working folder
    (`f"{executor_id} in {launch.cwd}"`). The emitter takes no detail
    parameter at all, so there is no channel through which it could be
    forwarded; this pins that no call site invents one."""
    assert "emit_nowait(" in _MANAGER
    for line in _MANAGER.splitlines():
        if "live_runs.emit_nowait(" in line:
            assert "detail" not in line, line


def test_the_stop_emit_happens_before_the_host_is_told_to_stop():
    """Same ordering the audit event uses: recorded while the row still reads
    as running, so an exit cannot race it."""
    stop_emit = _MANAGER.index('live_runs.emit_nowait(task, "stop"')
    host_stop = _MANAGER.index("self.host.stop, task_id", stop_emit - 2000)
    assert stop_emit < host_stop
