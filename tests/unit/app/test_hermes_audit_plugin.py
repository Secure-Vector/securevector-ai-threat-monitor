"""The Hermes directory plugin's tool-call audit and session markers
(plugins/hermes/audit.py). No network: urlopen is mocked, and the real
Hermes is never imported."""

from __future__ import annotations

import json
import sys
import types

import pytest
import pytest_asyncio

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import init_database_schema
from securevector.plugins.hermes import audit as haudit
from securevector.plugins.hermes import cost as hcost

SID = "20261102_101500_abc"


def _tool_kwargs(**extra):
    """The kwargs Hermes 0.18 passes to post_tool_call (model_tools.py:885)."""
    kw = dict(tool_name="terminal", args={"command": "ls -la"}, result='{"output": "x"}',
              task_id="t1", session_id=SID, tool_call_id="call_1", turn_id="turn-1",
              api_request_id="turn-1:api:1", duration_ms=12, status="ok", error_type=None,
              error_message=None, middleware_trace=[], telemetry_schema_version=1)
    kw.update(extra)
    return kw


@pytest.fixture
def captured(monkeypatch):
    sent = []

    class Resp:
        def read(self, n=-1):
            return b""

        def close(self):
            pass

    def fake_open(self_or_req, req=None, timeout=None):
        sent.append(req if req is not None else self_or_req)
        return Resp()

    monkeypatch.setattr(hcost.urllib.request, "urlopen", lambda req, timeout=None: fake_open(req))
    monkeypatch.setattr(hcost.urllib.request.OpenerDirector, "open", fake_open)
    monkeypatch.delenv("SECUREVECTOR_API_KEY", raising=False)
    monkeypatch.setenv("SECUREVECTOR_ENGINE_ENDPOINT", "http://127.0.0.1:9999")
    return sent


@pytest.fixture(autouse=True)
def fake_registry(monkeypatch):
    manager = types.SimpleNamespace(_hooks={})
    pkg = types.ModuleType("hermes_cli")
    mod = types.ModuleType("hermes_cli.plugins")
    mod.get_plugin_manager = lambda: manager
    pkg.plugins = mod
    monkeypatch.setitem(sys.modules, "hermes_cli", pkg)
    monkeypatch.setitem(sys.modules, "hermes_cli.plugins", mod)
    yield manager
    hcost.drain(1.0)


def _bodies(captured):
    hcost.drain(1.0)
    return [(r.full_url, json.loads(r.data)) for r in captured]


def test_tool_row_carries_harness_name_and_args_preview():
    row = haudit.build_tool_row(_tool_kwargs())
    assert row == {
        "tool_id": "terminal", "function_name": "terminal", "action": "allow", "risk": None,
        "reason": None, "is_essential": False, "args_preview": '{"command": "ls -la"}',
        "runtime_kind": "hermes", "session_id": SID, "request_id": "call_1",
    }


def test_args_preview_is_redacted_and_capped():
    secret = "sk-proj-" + "a" * 30
    row = haudit.build_tool_row(_tool_kwargs(args={"api_key": "abcdefgh123", "cmd": f"echo {secret}"}))
    assert secret not in row["args_preview"] and "abcdefgh123" not in row["args_preview"]
    assert "[REDACTED]" in row["args_preview"]
    big = haudit.build_tool_row(_tool_kwargs(args={"content": "x" * 20000}))
    assert len(big["args_preview"]) == haudit.ARGS_PREVIEW_LIMIT
    assert haudit.redact("AKIAABCDEFGHIJKLMNOP and ghp_" + "b" * 30) == "[REDACTED] and [REDACTED]"


def test_tool_row_ids_are_truncated_and_junk_is_skipped():
    row = haudit.build_tool_row(_tool_kwargs(tool_call_id="c" * 100, session_id="s" * 300, args=None))
    assert len(row["request_id"]) == 64 and len(row["session_id"]) == 200
    assert row["args_preview"] is None
    assert haudit.build_tool_row(_tool_kwargs(tool_name="")) is None
    assert haudit.build_tool_row({}) is None


def test_post_tool_call_posts_to_call_audit_and_returns_none(captured):
    assert haudit.on_post_tool_call(**_tool_kwargs()) is None
    [(url, body)] = _bodies(captured)
    assert url == "http://127.0.0.1:9999/api/tool-permissions/call-audit"
    assert body["runtime_kind"] == "hermes" and body["function_name"] == "terminal"


def test_session_hooks_write_start_turn_and_end_markers(captured):
    assert haudit.on_session_start(session_id=SID, model="m", platform="cli") is None
    assert haudit.on_session_end(session_id=SID, task_id="t", turn_id="turn-1", completed=True,
                                 interrupted=False, model="m", platform="cli") is None
    assert haudit.on_session_finalize(session_id=SID, platform="cli", reason="session_boundary") is None
    bodies = [b for _, b in _bodies(captured)]
    assert [b["tool_id"] for b in bodies] == ["__session_start__", "__turn_end__", "__session_end__"]
    for b in bodies:
        assert b["function_name"] == b["tool_id"] and b["action"] == "log_only"
        assert b["runtime_kind"] == "hermes" and b["session_id"] == SID
        assert b["args_preview"] == f"session_id={SID}"


def test_markers_without_a_session_are_not_sent(captured):
    haudit.on_session_finalize(session_id=None, platform="cli", reason="shutdown")
    haudit.on_session_start()
    assert _bodies(captured) == []


def test_hooks_never_raise(captured, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("x")

    monkeypatch.setattr(haudit, "build_tool_row", boom)
    monkeypatch.setattr(haudit, "build_marker", boom)
    haudit.on_post_tool_call(**_tool_kwargs())
    haudit.on_session_start(session_id=SID)
    haudit.on_session_end(session_id=SID)
    haudit.on_session_finalize(session_id=SID)
    assert _bodies(captured) == []


def _sdk_tool_hook():
    def pre_tool_call(**kwargs):
        return None

    pre_tool_call.__module__ = "securevector_sdk_hermes.plugin"
    return pre_tool_call


@pytest.mark.parametrize("hook", ["pre_tool_call", "post_tool_call"])
def test_tool_rows_silent_when_the_sdk_tool_hook_is_registered(captured, fake_registry, hook):
    fake_registry._hooks[hook] = [_sdk_tool_hook()]
    haudit.on_post_tool_call(**_tool_kwargs())
    # Session markers still go: the SDK sends none.
    haudit.on_session_finalize(session_id=SID)
    assert [b["tool_id"] for _, b in _bodies(captured)] == ["__session_end__"]


def test_sdk_cost_hook_alone_does_not_silence_tool_rows(captured, fake_registry):
    cost_hook = lambda **k: None  # noqa: E731
    cost_hook.__module__ = "securevector_sdk_hermes.costs"
    fake_registry._hooks["post_api_request"] = [cost_hook]
    haudit.on_post_tool_call(**_tool_kwargs())
    assert len(_bodies(captured)) == 1


def test_without_a_registry_defers_to_an_enabled_sdk(captured, monkeypatch):
    cfg_mod = types.ModuleType("securevector_sdk_hermes.config")
    cfg_mod.Config = type("Config", (), {"from_env": staticmethod(lambda: types.SimpleNamespace(enabled=True))})
    monkeypatch.setitem(sys.modules, "securevector_sdk_hermes", types.ModuleType("securevector_sdk_hermes"))
    monkeypatch.setitem(sys.modules, "securevector_sdk_hermes.plugin", types.ModuleType("p"))
    monkeypatch.setitem(sys.modules, "securevector_sdk_hermes.config", cfg_mod)
    monkeypatch.setattr(hcost, "_sdk_hooks_from_registry", lambda hook_name="post_api_request": None)
    haudit.on_post_tool_call(**_tool_kwargs())
    assert _bodies(captured) == []


def test_audit_shares_the_cost_worker_queue(captured, monkeypatch):
    queued = []
    monkeypatch.setattr(hcost, "_enqueue", lambda url, body: queued.append((url, body)))
    haudit.on_post_tool_call(**_tool_kwargs())
    assert len(queued) == 1 and queued[0][0].endswith(haudit.AUDIT_PATH)


def test_redaction_patterns_match_the_opencode_list():
    from pathlib import Path
    src = (Path(__file__).resolve().parents[3] / "src" / "securevector" / "plugins" / "opencode"
           / "lib" / "redact.js").read_text(encoding="utf-8")
    block = src[src.index("const SECRET_PATTERNS = ["):src.index("];")]
    js_count = sum(1 for line in block.splitlines() if line.strip().startswith("/"))
    assert js_count == len(haudit._SECRET_PATTERNS)


# --- end to end: the app's Live grid reads the plugin's rows ----------------

@pytest_asyncio.fixture
async def db(tmp_path):
    conn = DatabaseConnection(tmp_path / "audit.db")
    await init_database_schema(conn)
    return conn


@pytest.mark.asyncio
async def test_live_grid_names_hermes_counts_its_call_and_ends_the_session(db, monkeypatch):
    from securevector.app.server.routes import tool_permissions as tp
    from securevector.app.services import observability

    monkeypatch.setattr(tp, "get_database", lambda: db)
    for body in (haudit.build_marker("__session_start__", {"session_id": SID}, "session started"),
                 haudit.build_tool_row(_tool_kwargs()),
                 haudit.build_marker("__turn_end__", {"session_id": SID}, "turn ended")):
        await tp.record_call_audit(tp.AuditLogRequest(**body))
    body = await observability.live_sessions(db)
    [s] = [x for x in body["sessions"] if x["session_id"] == SID]
    assert s["harness"] == "hermes"
    assert s["tool_calls"]["allowed"] == 1
    assert s["ended"] is False  # a turn end never ends a session

    await tp.record_call_audit(tp.AuditLogRequest(
        **haudit.build_marker("__session_end__", {"session_id": SID}, "session ended")))
    body = await observability.live_sessions(db)
    [s] = [x for x in body["sessions"] if x["session_id"] == SID]
    assert s["ended"] is True


def test_huge_args_are_cut_before_serialising_and_still_redacted():
    secret = "ghp_" + "c" * 30
    row = haudit.build_tool_row(_tool_kwargs(args={"token": secret, "content": "y" * 5_000_000,
                                                   "items": list(range(100_000))}))
    assert len(row["args_preview"]) == haudit.ARGS_PREVIEW_LIMIT
    assert secret not in row["args_preview"]
    assert haudit._precap({"content": "y" * 5_000_000})["content"] == "y" * haudit._PRE_CAP
    assert len(haudit._precap(list(range(100_000)))) == haudit._PRE_CAP_ITEMS
    deep = {}
    node = deep
    for _ in range(50):
        node["n"] = {}
        node = node["n"]
    assert haudit.args_preview(deep)  # deep nesting is cut, never raises


@pytest.mark.parametrize("hook, call, marker", [
    ("on_session_start", "on_session_start", "__session_start__"),
    ("on_session_end", "on_session_end", "__turn_end__"),
    ("on_session_finalize", "on_session_finalize", "__session_end__"),
])
def test_session_marker_silent_when_the_sdk_registers_that_hook(captured, fake_registry, hook, call, marker):
    sdk = lambda **k: None  # noqa: E731
    sdk.__module__ = "securevector_sdk_hermes.plugin"
    fake_registry._hooks[hook] = [sdk]
    for name in ("on_session_start", "on_session_end", "on_session_finalize"):
        getattr(haudit, name)(session_id=SID)
    sent = [b["tool_id"] for _, b in _bodies(captured)]
    assert marker not in sent and len(sent) == 2
