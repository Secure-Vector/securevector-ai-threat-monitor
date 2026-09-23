"""`sv-monitor session ...`: the CLI over the Terminals API.

The CLI is deliberately a thin client: it must never grow a way to build argv,
choose an environment, or start a process itself. These tests pin that shape,
the four-part auth handshake, and the failure paths people actually hit (app
not running, bad harness, missing folder).
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from securevector.app.terminals import cli as session_cli
from securevector.app.terminals import client as session_client
from securevector.app.terminals.client import ApiError, AppNotRunning, TerminalsClient


class FakeClient:
    """Stands in for TerminalsClient, recording what the CLI asked for."""

    def __init__(self, **payloads):
        self.calls = []
        self.payloads = payloads

    def _record(self, name, *args, **kwargs):
        self.calls.append((name, args, kwargs))
        return self.payloads.get(name, {})

    def tasks(self):
        return self._record("tasks")

    def executors(self):
        return self._record("executors")

    def unlinked(self):
        return self._record("unlinked")

    def launch(self, *a, **k):
        return self._record("launch", *a, **k)

    def link(self, *a, **k):
        return self._record("link", *a, **k)

    def stop(self, *a, **k):
        return self._record("stop", *a, **k)

    def stop_all(self, *a, **k):
        return self._record("stop_all", *a, **k)


@pytest.fixture
def run(monkeypatch):
    """Run the CLI against a FakeClient and hand back (exit code, client)."""

    def _run(argv, **payloads):
        fake = FakeClient(**payloads)
        monkeypatch.setattr(session_cli, "TerminalsClient", lambda: fake)
        code = session_cli.main(argv)
        return code, fake

    return _run


# -- shape ------------------------------------------------------------------


def test_the_cli_never_offers_argv_env_or_a_command():
    """The whole security posture of governed spawn rests on the host owning
    argv and the environment. A CLI flag that let a caller name either would
    hand that away, so there must not be one."""
    parser = session_cli.build_parser()
    text = parser.format_help()
    for forbidden in ("--argv", "--env", "--command", "--exec", "--shell"):
        assert forbidden not in text
    body = Path(session_cli.__file__).read_text(encoding="utf-8")
    assert "subprocess" not in body, "the CLI must never start a process itself"
    assert "os.exec" not in body


def test_every_action_is_wired():
    parser = session_cli.build_parser()
    args = parser.parse_args(["list"])
    assert args.action == "list"
    assert set(session_cli.ACTIONS) == {
        "list",
        "harnesses",
        "unlinked",
        "launch",
        "link",
        "stop",
    }


def test_no_action_prints_help_and_fails(capsys):
    code = session_cli.main([])
    assert code == 2
    assert "ACTION" in capsys.readouterr().out


# -- reads ------------------------------------------------------------------


def test_list_renders_a_table_with_the_same_eight_character_session(run, capsys):
    code, _ = run(
        ["list"],
        tasks={
            "items": [
                {
                    "id": "abc123",
                    "executor_id": "claude-code",
                    "status": "working",
                    "origin": "linked",
                    "session_id": "ac8210e6-75d5-4402-b635-01a694a61a68",
                    "workspace": "/w",
                }
            ],
            "running": 1,
        },
    )
    out = capsys.readouterr().out
    assert code == 0
    assert "ac8210e6" in out, "the page shows eight characters; these must agree"
    assert "ac8210e6-75d5" not in out, "and not the whole id, which crowds the row"
    assert "1 session(s), 1 running here." in out


def test_list_says_so_when_the_board_is_empty(run, capsys):
    code, _ = run(["list"], tasks={"items": [], "running": 0})
    assert code == 0
    assert "No sessions on the board." in capsys.readouterr().out


def test_json_is_the_raw_payload(run, capsys):
    payload = {"items": [{"id": "abc123"}], "running": 0}
    code, _ = run(["list", "--json"], tasks=payload)
    assert code == 0
    assert json.loads(capsys.readouterr().out) == payload


def test_unlinked_points_at_the_command_that_acts_on_it(run, capsys):
    code, _ = run(
        ["unlinked"],
        unlinked={"items": [{"session_id": "s" * 40, "executor_id": "codex", "calls": 3}]},
    )
    out = capsys.readouterr().out
    assert code == 0
    assert "folder not reported" in out, "a row with no cwd still says what it is"
    assert "sv-monitor session link" in out


# -- writes -----------------------------------------------------------------


def test_launch_resolves_the_folder_in_this_shell(run, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    code, fake = run(["launch", "claude-code"], launch={"id": "t1"})
    assert code == 0
    name, args, kwargs = fake.calls[0]
    assert name == "launch"
    # "." has to mean the directory the person is standing in, not the app's.
    assert args[1] == str(tmp_path.resolve())


def test_launch_passes_the_resume_id_through(run, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    code, fake = run(["launch", "codex", ".", "--resume", "sess-abc12345"], launch={"id": "t1"})
    assert code == 0
    assert fake.calls[0][2]["resume_session_id"] == "sess-abc12345"


def test_link_sends_no_folder_when_none_was_named(run):
    code, fake = run(["link", "claude-code", "sess-abc12345"], link={"id": "t1"})
    assert code == 0
    # None, not "": the host resolves the folder from the transcript when the
    # client does not name one, and "" would look like a named empty path.
    assert fake.calls[0][2]["workspace"] is None


def test_stop_needs_a_target(run, capsys):
    code, fake = run(["stop"])
    assert code == 2
    assert fake.calls == [], "nothing is stopped when nothing was named"
    assert "Name a session id" in capsys.readouterr().err


def test_stop_all_is_explicit(run):
    code, fake = run(["stop", "--all"])
    assert code == 0
    assert fake.calls[0][0] == "stop_all"


def test_a_title_longer_than_the_api_allows_is_refused_locally(run, capsys):
    code, fake = run(["launch", "claude-code", ".", "--title", "x" * 200])
    assert code == 2
    assert fake.calls == [], "refused before a request is made"
    assert "longer than" in capsys.readouterr().err


# -- failure paths ----------------------------------------------------------


def test_app_not_running_is_a_sentence_not_a_traceback(monkeypatch, capsys):
    def boom():
        raise AppNotRunning("SecureVector is not running. Start the app, then try again.")

    monkeypatch.setattr(session_cli, "TerminalsClient", boom)
    code = session_cli.main(["list"])
    assert code == 3
    err = capsys.readouterr().err
    assert "SecureVector is not running" in err
    assert "Traceback" not in err


def test_an_api_refusal_prints_only_what_the_host_said(monkeypatch, capsys):
    class Refusing(FakeClient):
        def tasks(self):
            raise ApiError(400, "Unknown executor")

    monkeypatch.setattr(session_cli, "TerminalsClient", lambda: Refusing())
    code = session_cli.main(["list"])
    assert code == 4
    assert capsys.readouterr().err.strip() == "Unknown executor"


# -- the handshake ----------------------------------------------------------


def test_every_request_carries_all_four_parts_of_the_handshake(monkeypatch):
    """Loopback Host, matching Origin, the cookie, and the custom header. Miss
    any one and the app refuses, which is the point: a page in another tab
    cannot assemble all four."""
    seen = {}

    class FakeResp:
        def read(self):
            return b'{"ok": true}'

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, data=None, timeout=None):
        seen["url"] = req.full_url
        seen["headers"] = {k.lower(): v for k, v in req.header_items()}
        seen["method"] = req.get_method()
        return FakeResp()

    monkeypatch.setattr(session_client._opener, "open", fake_urlopen)
    c = TerminalsClient(port=8741, token="t" * 48)
    c.tasks()

    assert seen["url"].startswith("http://127.0.0.1:8741/")
    assert seen["headers"]["origin"] == "http://127.0.0.1:8741"
    assert seen["headers"]["x-sv-terminals"] == "1"
    assert seen["headers"]["cookie"] == "sv_terminals=" + "t" * 48


# -- redirects must never be followed ----------------------------------------
#
# `urlopen()` follows a 30x by default, and CPython's redirect handling
# copies the original request's headers -- Cookie included -- onto the
# request it builds for the new location. The scenario that matters:
# `RUNTIME_JSON` can outlive a crashed app, and once the OS hands that port
# to something else, a redirect from whatever now answers there would carry
# the per-install token off to wherever it names.


def test_the_redirect_handler_refuses_every_redirect_code():
    handler = session_client._NoRedirect()
    for code in (301, 302, 303, 307, 308):
        with pytest.raises(session_client.RedirectRefused) as excinfo:
            handler.redirect_request(
                None, None, code, "moved", {}, "http://evil.example/harvest"
            )
        assert excinfo.value.code == code
        assert excinfo.value.location == "http://evil.example/harvest"


def test_the_client_opener_is_wired_with_the_no_redirect_handler():
    """Not just that the handler class exists somewhere: that `_opener`, the
    one `_request()` actually calls, carries it."""
    assert any(
        isinstance(h, session_client._NoRedirect) for h in session_client._opener.handlers
    )


def test_a_redirect_is_surfaced_as_an_api_error_and_the_cookie_is_not_resent(monkeypatch):
    """Stands in for what the real opener does on a 302: raises
    RedirectRefused instead of building and sending a second, header-copying
    request. Asserting there is exactly one call, and inspecting what it
    carried, is what proves the cookie never had a second request to ride
    along on."""
    calls = []

    def fake_open(req, data=None, timeout=None):
        calls.append(req)
        raise session_client.RedirectRefused(302, "http://evil.example/harvest")

    monkeypatch.setattr(session_client._opener, "open", fake_open)
    c = TerminalsClient(port=8741, token="t" * 48)

    with pytest.raises(ApiError) as excinfo:
        c.tasks()

    assert excinfo.value.status == 302
    assert "evil.example" in excinfo.value.detail
    assert len(calls) == 1, "no second request was made; nowhere for the cookie to leak to"
    assert calls[0].get_header("Cookie") == "sv_terminals=" + "t" * 48


def test_writes_declare_themselves_as_cli(monkeypatch):
    """The event trail records which surface asked. `ui` for a click, `cli`
    here, so an audit can tell them apart."""
    bodies = []

    class FakeResp:
        def read(self):
            return b"{}"

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, data=None, timeout=None):
        bodies.append((req.full_url, json.loads(data) if data else None))
        return FakeResp()

    monkeypatch.setattr(session_client._opener, "open", fake_urlopen)
    c = TerminalsClient(port=8741, token="t" * 48)
    c.launch("claude-code", "/w")
    c.link("claude-code", "sess-abc12345")
    c.stop("t1")
    c.stop_all()

    assert bodies[0][1]["origin"] == "cli"
    assert bodies[1][1]["origin"] == "cli"
    assert bodies[2][0].endswith("/stop?origin=cli")
    assert bodies[3][0].endswith("/stop-all?origin=cli")


def test_a_task_id_cannot_smuggle_a_path_segment(monkeypatch):
    seen = {}

    class FakeResp:
        def read(self):
            return b"{}"

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(
        session_client._opener,
        "open",
        lambda req, data=None, timeout=None: (seen.update(url=req.full_url), FakeResp())[1],
    )
    c = TerminalsClient(port=8741, token="t" * 48)
    c.stop("../../stop-all")
    assert "../.." not in seen["url"]
    assert "%2F" in seen["url"]


def test_a_truncated_token_is_refused_before_any_request(monkeypatch, tmp_path):
    token = tmp_path / "terminals" / "ui-token"
    token.parent.mkdir(parents=True)
    token.write_text("short")
    monkeypatch.setattr(session_client, "_data_dir", lambda: tmp_path)
    with pytest.raises(AppNotRunning, match="truncated"):
        session_client.read_token()


def test_a_runtime_file_with_no_usable_port_is_refused(monkeypatch, tmp_path):
    runtime = tmp_path / "runtime.json"
    runtime.write_text(json.dumps({"web_port": "eight-seven-four-one"}))
    monkeypatch.setattr(session_client, "RUNTIME_JSON", runtime)
    with pytest.raises(AppNotRunning, match="no usable web port"):
        session_client.read_port()


def test_the_token_comes_from_the_same_resolver_the_server_writes_with():
    """A second copy of the per-platform path would read a token no app ever
    wrote, and report "open the app once" while the app was running."""
    body = Path(session_client.__file__).read_text(encoding="utf-8")
    assert "get_app_data_dir" in body
    assert "Application Support" not in body, "no hand-rolled platform path"


def test_quoting_is_left_to_the_shell_nowhere_in_this_module():
    """The CLI builds no command line at all. Anything it prints for a person
    to copy lives in the page, which quotes for display only."""
    body = Path(session_cli.__file__).read_text(encoding="utf-8")
    assert "shell=True" not in body
    assert "os.system" not in body


def test_namespace_without_json_attribute_does_not_crash(run):
    """`--json` is defined per action, so a hand-built Namespace can lack it.
    Guarding here keeps a future caller from a confusing AttributeError."""
    fake = FakeClient(tasks={"items": [], "running": 0})
    args = SimpleNamespace(action="list", json=False)
    assert session_cli.cmd_list(fake, args) == 0


def test_a_rejected_body_reads_as_a_sentence_not_a_python_list():
    """FastAPI answers a rejected body with `detail` as a LIST of validation
    objects. The obvious `.get("detail")` prints that list verbatim at someone,
    which is what happened the first time this ran against a stale server."""
    import urllib.error

    class Err(urllib.error.HTTPError):
        def __init__(self, code, body):
            self.code = code
            self._b = json.dumps(body).encode()

        def read(self):
            return self._b

    assert (
        session_client._detail(
            Err(422, {"detail": [{"loc": ["body", "argv"], "msg": "Extra inputs are not permitted"}]})
        )
        == "argv: Extra inputs are not permitted"
    )
    assert session_client._detail(Err(400, {"detail": "Unknown executor"})) == "Unknown executor"
    assert session_client._detail(Err(500, {})) == "HTTP 500"
    assert session_client._detail(Err(503, "not json at all")) == "HTTP 503"


# -- the watched column -------------------------------------------------------


def test_list_says_whether_each_session_is_actually_watched(run, capsys):
    """A surface that disagreed with the page about whether a session is being
    watched would be worse than one that stayed silent."""
    code, _ = run(
        ["list"],
        tasks={
            "items": [
                {"id": "a", "executor_id": "claude-code", "status": "working",
                 "origin": "linked", "session_id": "s1", "workspace": "/w", "verified": True},
                {"id": "b", "executor_id": "claude-code", "status": "working",
                 "origin": "linked", "session_id": "s2", "workspace": "/w", "verified": False},
                {"id": "c", "executor_id": "codex", "status": "done",
                 "origin": "launch", "session_id": "s3", "workspace": "/w", "verified": None},
            ],
            "running": 0,
        },
    )
    out = capsys.readouterr().out
    assert code == 0
    assert "WATCHED" in out
    # Uppercase NO so it is findable by eye in a column of lowercase.
    assert "NO" in out
    assert "1 live session(s) are NOT reporting governed calls" in out


def test_nothing_unwatched_means_no_warning_line(run, capsys):
    """The line has to mean something when it appears, so it must not appear
    on a healthy board."""
    code, _ = run(
        ["list"],
        tasks={"items": [{"id": "a", "executor_id": "codex", "status": "working",
                          "origin": "launch", "session_id": "s", "workspace": "/w",
                          "verified": True}], "running": 1},
    )
    assert code == 0
    assert "NOT reporting" not in capsys.readouterr().out


def test_an_older_host_without_the_field_does_not_crash_the_cli(run, capsys):
    """`verified` is new. A CLI from this build talking to an app that predates
    it must degrade to "unknown", not traceback."""
    code, _ = run(
        ["list"],
        tasks={"items": [{"id": "a", "executor_id": "codex", "status": "working",
                          "origin": "launch", "workspace": "/w"}], "running": 1},
    )
    assert code == 0
    assert "NOT reporting" not in capsys.readouterr().out
