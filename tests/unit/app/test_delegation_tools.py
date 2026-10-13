"""MCP tools delegate and delegation_result: thin loopback clients of the app."""

import io
import urllib.error
from types import SimpleNamespace

import pytest

from securevector.mcp.tools import delegation_tools, policy_tools

DID = "dlg_0123456789abcdef0123"


class _Calls:
    def __init__(self, answers):
        self.answers = list(answers)
        self.seen = []

    def __call__(self, method, path, body):
        self.seen.append((method, path, body))
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


def test_delegate_posts_and_defaults_the_harness(monkeypatch):
    calls = _Calls([{"delegation_id": DID, "state": "pending_approval", "reason": "Waiting", "extra": 1}])
    monkeypatch.setattr(delegation_tools, "_request", calls)
    monkeypatch.setenv("SECUREVECTOR_MCP_HARNESS", "codex")
    out = delegation_tools.delegate_call("/w/app/sub", "run the tests")
    assert out["state"] == "pending_approval" and "extra" not in out
    assert calls.seen == [("POST", "/api/policy/delegate",
                           {"folder": "/w/app/sub", "prompt": "run the tests", "harness": "codex"})]


def test_wait_polls_every_two_seconds_until_done(monkeypatch):
    calls = _Calls([
        {"delegation_id": DID, "state": "pending_approval"},
        {"delegation_id": DID, "state": "running"},
        {"delegation_id": DID, "state": "done", "result": "All tests pass."},
    ])
    monkeypatch.setattr(delegation_tools, "_request", calls)
    now = [0.0]
    sleeps = []

    def sleep(s):
        sleeps.append(s)
        now[0] += s

    out = delegation_tools.delegate_call("/w", "p", wait=True, timeout_s=60, sleep=sleep, clock=lambda: now[0])
    assert out["state"] == "done" and out["result"] == "All tests pass."
    assert sleeps == [2.0, 2.0]
    assert calls.seen[1] == ("GET", f"/api/policy/delegations/{DID}", None)


def test_wait_keeps_polling_while_the_result_is_pending(monkeypatch):
    calls = _Calls([
        {"delegation_id": DID, "state": "running"},
        {"delegation_id": DID, "state": "done", "result": None, "result_pending": True},
        {"delegation_id": DID, "state": "done", "result": "ok then"},
    ])
    monkeypatch.setattr(delegation_tools, "_request", calls)
    now = [0.0]

    def sleep(s):
        now[0] += s

    out = delegation_tools.delegate_call("/w", "p", wait=True, timeout_s=60, sleep=sleep, clock=lambda: now[0])
    assert out["result"] == "ok then"


def test_wait_stops_at_timeout(monkeypatch):
    monkeypatch.setattr(delegation_tools, "_request",
                        lambda *a: {"delegation_id": DID, "state": "running"})
    now = [0.0]

    def sleep(s):
        now[0] += s

    out = delegation_tools.delegate_call("/w", "p", wait=True, timeout_s=5, sleep=sleep, clock=lambda: now[0])
    assert out["state"] == "running" and now[0] == pytest.approx(5.0)


def test_refusals_and_failures_never_raise(monkeypatch):
    forbidden = urllib.error.HTTPError("u", 403, "Forbidden", {}, io.BytesIO(b""))
    monkeypatch.setattr(delegation_tools, "_request", _Calls([forbidden]))
    out = delegation_tools.delegate_call("/w", "p")
    assert out["state"] == "failed" and "launched" in out["reason"]
    monkeypatch.setattr(delegation_tools, "_request", _Calls([ConnectionError("x")]))
    assert delegation_tools.delegate_call("/w", "p")["state"] == "failed"
    monkeypatch.setattr(delegation_tools, "_request", _Calls([{"state": "allow"}]))
    assert delegation_tools.delegate_call("/w", "p")["state"] == "failed"
    assert delegation_tools.delegate_call("", "p")["state"] == "failed"
    assert delegation_tools.delegation_result_call("../etc")["reason"] == "Unknown delegation_id."


def test_uses_the_policy_request_helper_and_loopback_only(monkeypatch):
    assert delegation_tools._request is policy_tools._request
    monkeypatch.setenv("SECUREVECTOR_APP_URL", "http://example.com:8741")
    assert delegation_tools.delegation_result_call(DID)["state"] == "failed"


@pytest.mark.asyncio
async def test_schemas_and_registration():
    from mcp.server.fastmcp import FastMCP

    m = FastMCP("t")
    delegation_tools.setup_delegation_tools(m, None, ["delegate", "delegation_result"])
    tools = {t.name: t for t in await m.list_tools()}
    assert set(tools) == {"delegate", "delegation_result"}
    d = tools["delegate"]
    assert set(d.inputSchema["required"]) == {"folder", "prompt"}
    assert set(d.inputSchema["properties"]) == {"folder", "prompt", "harness", "wait", "timeout_s"}
    for phrase in ("same harness", "approval", "inside your current folder", "wait=true", "delegation_result",
                   "final message", "child pane", "reason"):
        assert phrase in d.description, phrase
    r = tools["delegation_result"]
    assert r.inputSchema["required"] == ["delegation_id"]
    for phrase in ("held", "release", "waiting_for_user", "failed", "result_pending"):
        assert phrase in r.description, phrase
    for t in tools.values():
        assert len(t.description.split()) <= 125
        for prop in t.inputSchema["properties"].values():
            assert prop.get("description") and "\n" not in prop["description"]
    for t in tools.values():
        assert "—" not in t.description

    from securevector.mcp import __main__ as cli
    from securevector.mcp.config.server_config import MCPServerConfig

    assert {"delegate", "delegation_result"} <= set(MCPServerConfig().enabled_tools)
    args = SimpleNamespace(mode="balanced", api_key=None, host="localhost", port=8000,
                           transport="stdio", tools="delegate,delegation_result")
    assert cli.get_config_from_args(args).enabled_tools == ["delegate", "delegation_result"]


def test_stale_registrations_are_rewritten_once_and_only_ours(tmp_path, monkeypatch):
    import json

    from securevector.app.services import mcp_registration as reg

    monkeypatch.setattr(reg, "_home", lambda: tmp_path)
    monkeypatch.setattr(reg, "available", lambda: True)
    for var in ("CLAUDE_HOME", "CODEX_HOME", "COPILOT_HOME", "CURSOR_HOME", "OPENCODE_CONFIG",
                "XDG_CONFIG_HOME", "GEMINI_HOME"):
        monkeypatch.delenv(var, raising=False)
    (tmp_path / ".claude").mkdir()
    cfg = tmp_path / ".claude.json"
    old = reg._json_entry("claude-code")
    old["args"] = ["-m", "securevector.mcp", "--tools", "check_policy,session_burn"]
    cfg.write_text(json.dumps({"mcpServers": {"securevector": old, "other": {"command": "x"}}}))
    (tmp_path / ".cursor").mkdir()
    (tmp_path / ".cursor" / "mcp.json").write_text(json.dumps({"mcpServers": {"securevector": {"command": "mine"}}}))
    assert reg.is_ours(old) and not reg.is_current("claude-code", old)
    assert reg.refresh_stale() == ["claude-code"]
    data = json.loads(cfg.read_text())
    assert data["mcpServers"]["securevector"]["args"][-1] == reg.TOOLS
    assert data["mcpServers"]["other"] == {"command": "x"}
    assert reg.is_current("claude-code", data["mcpServers"]["securevector"])
    assert json.loads((tmp_path / ".cursor" / "mcp.json").read_text())["mcpServers"]["securevector"] == {
        "command": "mine"}
    assert reg.refresh_stale() == []


def test_stale_codex_block_is_rewritten(tmp_path, monkeypatch):
    from securevector.app.services import mcp_registration as reg

    monkeypatch.setattr(reg, "_home", lambda: tmp_path)
    monkeypatch.setattr(reg, "available", lambda: True)
    monkeypatch.delenv("CODEX_HOME", raising=False)
    (tmp_path / ".codex").mkdir()
    cfg = tmp_path / ".codex" / "config.toml"
    cfg.write_text('model = "o3"\n' + reg._codex_block().replace(reg.TOOLS, "check_policy,session_burn"))
    assert reg.refresh_stale() == ["codex"]
    assert reg.TOOLS in cfg.read_text() and 'model = "o3"' in cfg.read_text()
    assert reg.refresh_stale() == []


def test_refresh_ignores_interpreter_and_checkout_differences(tmp_path, monkeypatch):
    import json

    from securevector.app.services import mcp_registration as reg

    monkeypatch.setattr(reg, "_home", lambda: tmp_path)
    monkeypatch.setattr(reg, "available", lambda: True)
    for var in ("CLAUDE_HOME", "CODEX_HOME"):
        monkeypatch.delenv(var, raising=False)
    (tmp_path / ".claude").mkdir()
    cfg = tmp_path / ".claude.json"
    entry = reg._json_entry("claude-code")
    entry["command"] = "/opt/other/python3"
    entry["env"] = dict(entry["env"], PYTHONPATH="/some/other/checkout/src")
    cfg.write_text(json.dumps({"mcpServers": {"securevector": entry}}))
    (tmp_path / ".codex").mkdir()
    codex = tmp_path / ".codex" / "config.toml"
    codex.write_text(reg._codex_block().replace(json.dumps(reg.sys.executable), '"/opt/other/python3"'))
    before = (cfg.read_text(), codex.read_text())
    assert reg.refresh_stale() == []
    assert (cfg.read_text(), codex.read_text()) == before
    monkeypatch.setattr(reg, "_app_url", lambda: "http://127.0.0.1:9999")
    assert sorted(reg.refresh_stale()) == ["claude-code", "codex"]


def test_refresh_keeps_every_other_codex_table(tmp_path, monkeypatch):
    from securevector.app.services import mcp_registration as reg

    monkeypatch.setattr(reg, "_home", lambda: tmp_path)
    monkeypatch.setattr(reg, "available", lambda: True)
    monkeypatch.setattr(reg, "_app_url", lambda: "http://127.0.0.1:9999")
    monkeypatch.delenv("CODEX_HOME", raising=False)
    (tmp_path / ".codex").mkdir()
    cfg = tmp_path / ".codex" / "config.toml"
    cfg.write_text(
        '[hooks.state]\n\n[hooks.state."securevector-guard@securevector-local:hooks/hooks.json:stop:0:0"]\n'
        'trusted_hash = "sha256:abc"\n'
        + reg._codex_block().replace("http://127.0.0.1:9999", "http://127.0.0.1:8741")
        + '[marketplaces.securevector-local]\nsource_type = "local"\n\n'
        '[plugins."securevector-guard@securevector-local"]\nenabled = true\n'
    )
    headers = lambda: [l for l in cfg.read_text().splitlines() if l.startswith("[")]
    before = headers()
    assert reg.refresh_stale() == ["codex"]
    assert sorted(headers()) == sorted(before)
    assert 'enabled = true' in cfg.read_text() and 'trusted_hash = "sha256:abc"' in cfg.read_text()
