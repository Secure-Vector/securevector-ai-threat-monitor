"""Hook relay: stdlib-only, silent, exit 0 on every path."""

import contextlib
import io
import json
import sys

from securevector.app.terminals import hook_relay


def _run(monkeypatch, env, stdin, posted):
    for key in ("SV_TERMINAL_TASK_ID", "SV_TERMINAL_PORT", "SV_TERMINAL_HOOK_TOKEN"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(
        hook_relay, "_post", lambda url, body, token: posted.append((url, body, token))
    )
    monkeypatch.setattr(sys, "stdin", io.StringIO(stdin))
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    code = hook_relay.main()
    return code, out.getvalue()


def test_noop_without_env(monkeypatch):
    posted = []
    code, out = _run(monkeypatch, {}, '{"hook_event_name": "Stop"}', posted)
    assert code == 0 and out == "" and posted == []


def test_forwards_selected_fields_and_preview(monkeypatch):
    posted = []
    env = {"SV_TERMINAL_TASK_ID": "t1", "SV_TERMINAL_PORT": "8741", "SV_TERMINAL_HOOK_TOKEN": "tok"}
    payload = {
        "hook_event_name": "PreToolUse",
        "session_id": "s",
        "tool_name": "Bash",
        "tool_input": {"command": "x" * 500},
        "cwd": "/w",
        "transcript_path": "/secret",
    }
    code, out = _run(monkeypatch, env, json.dumps(payload), posted)
    assert code == 0 and out == ""
    url, body, token = posted[0]
    assert url == "http://127.0.0.1:8741/api/terminals/tasks/t1/events"
    assert token == "tok"
    assert body["hook_event_name"] == "PreToolUse" and body["tool_name"] == "Bash"
    assert "transcript_path" not in body
    assert len(body["tool_input_preview"]) <= hook_relay.PREVIEW_LIMIT
    assert "tool_input" not in body


def test_bad_json_is_swallowed(monkeypatch):
    posted = []
    env = {"SV_TERMINAL_TASK_ID": "t1", "SV_TERMINAL_PORT": "8741", "SV_TERMINAL_HOOK_TOKEN": "tok"}
    code, out = _run(monkeypatch, env, "not json", posted)
    assert code == 0 and out == "" and posted == []


def test_post_failure_is_swallowed(monkeypatch):
    env = {"SV_TERMINAL_TASK_ID": "t1", "SV_TERMINAL_PORT": "8741", "SV_TERMINAL_HOOK_TOKEN": "tok"}
    for key, value in env.items():
        monkeypatch.setenv(key, value)

    def boom(url, body, token):
        raise OSError("down")

    monkeypatch.setattr(hook_relay, "_post", boom)
    monkeypatch.setattr(sys, "stdin", io.StringIO('{"hook_event_name": "Stop"}'))
    assert hook_relay.main() == 0


def test_post_sends_header_method_body_and_timeout(monkeypatch):
    captured = {}

    class FakeOpener:
        def open(self, req, timeout=None):
            captured["req"] = req
            captured["timeout"] = timeout
            return contextlib.nullcontext()

    monkeypatch.setattr(hook_relay, "_OPENER", FakeOpener())
    hook_relay._post("http://127.0.0.1:1/x", {"hook_event_name": "Stop"}, "tok")

    req = captured["req"]
    assert req.get_method() == "POST"
    assert req.get_header("X-sv-terminal-hook") == "tok"
    assert req.get_header("Content-type") == "application/json"
    assert json.loads(req.data) == {"hook_event_name": "Stop"}
    assert captured["timeout"] == 2
