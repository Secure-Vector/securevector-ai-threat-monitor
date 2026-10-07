import asyncio
import base64
import stat
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.terminals import routes
from securevector.app.terminals.auth import COOKIE, HEADER, TerminalAuth
from securevector.app.terminals.manager import ManagerSettings, TerminalManager
from securevector.app.terminals.store import TerminalStore
from tests.unit.app.terminals.test_manager import FakeHost

ORIGIN = "http://127.0.0.1:8741"
HOST = "127.0.0.1:8741"
TOKEN = "t" * 48
WRITE = {HEADER: "1", "Origin": ORIGIN}
# Starlette's TestClient builds every websocket_connect request against a
# hardcoded "ws://testserver" base (see starlette.testclient), not base_url,
# so the Host header must be set explicitly to match the origin the fixture
# actually authorises, and the session cookie -- scoped to the real
# "127.0.0.1"/"localhost" domains -- never gets auto-attached by httpx's
# cookie jar for a "testserver" request, so it must be passed explicitly
# too. This is the same workaround test_auth.py's websocket tests use for
# auth.check_ws, applied here for the real per-task endpoint.
WS_HEADERS = {"Origin": ORIGIN, "Host": HOST, "Cookie": f"{COOKIE}={TOKEN}"}


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def _wait_until(predicate, timeout: float = 2.0) -> None:
    # Starlette's TestClient runs the ASGI app for a websocket test in a
    # background portal thread and hands off each send_json() into an
    # in-memory queue without waiting for the server task to consume it, so
    # calling ws.close() immediately after a burst of sends can tear the
    # connection down before the server has even been scheduled to process
    # them (observed directly: the assertions below racing empty, and
    # occasionally a CancelledError out of the TestClient's own WS session
    # teardown). Poll for the expected server-side effect before closing,
    # rather than assuming send_json() is synchronous with server processing.
    deadline = time.time() + timeout
    while not predicate() and time.time() < deadline:
        time.sleep(0.01)


def _fake_claude_bin(tmp_path: Path) -> Path:
    # build_launch (executors.py) resolves the executor binary to an
    # absolute path via shutil.which and raises ExecutorUnavailable if
    # "claude" is not on the child PATH, so the fixture needs a real,
    # executable stub on disk rather than a bare PATH like "/bin" (the
    # plan's literal fixture assumed "claude" would resolve there, which is
    # not true on a real machine -- see test_routes.py for the same helper).
    tmp_bin = tmp_path / "bin"
    tmp_bin.mkdir(exist_ok=True)
    fake_claude = tmp_bin / "claude"
    fake_claude.write_text("#!/bin/sh\nexit 0\n")
    fake_claude.chmod(fake_claude.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return tmp_bin


@pytest.fixture
def env(tmp_path):
    ws_dir = tmp_path / "proj"
    ws_dir.mkdir()
    db = DatabaseConnection(tmp_path / "t.db")
    asyncio.run(run_migrations(db))
    host = FakeHost()
    tmp_bin = _fake_claude_bin(tmp_path)
    manager = TerminalManager(
        host,
        TerminalStore(db),
        ManagerSettings(
            data_dir=tmp_path / "data",
            port=8741,
            plugin_dir=lambda: tmp_path / "plugin",
            plugin_enabled=lambda: True,
            parent_env={"PATH": str(tmp_bin)},
        ),
    )
    app = FastAPI()
    app.state.terminal_auth = TerminalAuth(token=TOKEN, port=8741)
    app.state.terminal_manager = manager
    app.include_router(routes.router, prefix="/api")
    client = TestClient(app, base_url=ORIGIN)
    client.get("/api/terminals/session")
    task = client.post(
        "/api/terminals/tasks",
        json={"executor_id": "claude-code", "workspace": str(ws_dir)},
        headers=WRITE,
    ).json()
    return client, manager, host, task["id"]


def test_ws_replays_then_relays_input_and_resize(env):
    client, manager, host, tid = env
    with client.websocket_connect(f"/api/terminals/tasks/{tid}/ws", headers=WS_HEADERS) as ws:
        first = ws.receive_json()
        assert first == {"t": "replay", "data": _b64(b"snapshot")}
        ws.send_json({"t": "resize", "rows": 40, "cols": 120})
        ws.send_json({"t": "input", "data": _b64(b"ls\r")})
        ws.send_json({"t": "resize", "rows": 40, "cols": 100})
        ws.send_json({"t": "pong"})
        _wait_until(lambda: len(host.writes) >= 1 and len(host.resizes) >= 3)
        ws.close()
    assert host.resizes[:2] == [(tid, 40, 121), (tid, 40, 120)]
    assert host.resizes[-1] == (tid, 40, 100)
    assert host.writes == [(tid, b"ls\r")]


def test_ws_rejects_without_cookie_or_origin(env):
    client, _, _, tid = env
    no_cookie = {"Origin": ORIGIN, "Host": HOST}
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(f"/api/terminals/tasks/{tid}/ws", headers=no_cookie) as ws:
            ws.receive_json()
    assert exc.value.code == 4001

    no_origin = {"Host": HOST, "Cookie": f"{COOKIE}={TOKEN}"}
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(f"/api/terminals/tasks/{tid}/ws", headers=no_origin) as ws:
            ws.receive_json()
    assert exc.value.code == 4001


def test_ws_unknown_task_closes_4004(env):
    client, *_ = env
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/api/terminals/tasks/nope/ws", headers=WS_HEADERS) as ws:
            ws.receive_json()
    assert exc.value.code == 4004


def test_ws_forwards_output_and_exit(env):
    client, manager, host, tid = env

    class PushingHost(FakeHost):
        def attach(self, task_id, loop):
            snapshot, sub = super().attach(task_id, loop)
            sub.push_threadsafe(b"hello")
            sub.push_threadsafe(None)
            return snapshot, sub

    manager.host = PushingHost()
    with client.websocket_connect(f"/api/terminals/tasks/{tid}/ws", headers=WS_HEADERS) as ws:
        assert ws.receive_json()["t"] == "replay"
        assert ws.receive_json() == {"t": "out", "data": _b64(b"hello")}
        assert ws.receive_json() == {"t": "exit", "code": None}


def test_ws_reattach_to_finished_task_reports_the_stored_exit_code(env):
    # Row exists (exit_code == 0, a clean exit) but the host session is gone
    # -- e.g. the process restarted. The fallback in the except KeyError
    # branch must report the row's real exit code, not a hardcoded None
    # (which the page would render as "Task ended with exit code null.").
    client, manager, host, tid = env
    asyncio.run(manager.store.set_exit(tid, 0))

    class GoneHost(FakeHost):
        def attach(self, task_id, loop):
            raise KeyError(task_id)

    manager.host = GoneHost()
    with client.websocket_connect(f"/api/terminals/tasks/{tid}/ws", headers=WS_HEADERS) as ws:
        assert ws.receive_json() == {"t": "replay", "data": ""}
        assert ws.receive_json() == {"t": "exit", "code": 0}


def test_ws_ignores_malformed_frames_then_relays_input(env):
    # A frame that decodes to a non-dict JSON value (int/str/list/null) must
    # not crash pump_input on frame.get(...), and a resize with non-int
    # rows/cols must not crash on int(...); both should be skipped so later,
    # well-formed frames on the same connection are still processed.
    client, manager, host, tid = env
    with client.websocket_connect(f"/api/terminals/tasks/{tid}/ws", headers=WS_HEADERS) as ws:
        ws.receive_json()  # replay
        for bad in (123, "hi", [1, 2], None):
            ws.send_json(bad)
        ws.send_json({"t": "resize", "rows": "nope", "cols": "nope"})
        ws.send_json({"t": "input", "data": _b64(b"ls\r")})
        _wait_until(lambda: len(host.writes) >= 1)
        ws.close()
    assert host.writes == [(tid, b"ls\r")]
    assert host.resizes == []


def test_ws_detaches_subscriber_on_immediate_disconnect(env):
    # attach() succeeding must always be paired with detach(), even for a
    # client that disconnects right after connecting (before, during, or
    # right after the replay send) -- otherwise the subscriber leaks.
    client, manager, host, tid = env

    class TrackingHost(FakeHost):
        def __init__(self):
            super().__init__()
            self.attached = set()

        def attach(self, task_id, loop):
            snapshot, sub = super().attach(task_id, loop)
            self.attached.add(sub)
            return snapshot, sub

        def detach(self, task_id, sub):
            self.attached.discard(sub)

    tracking = TrackingHost()
    manager.host = tracking
    with client.websocket_connect(f"/api/terminals/tasks/{tid}/ws", headers=WS_HEADERS) as ws:
        ws.receive_json()  # replay
        ws.close()
    _wait_until(lambda: len(tracking.attached) == 0)
    assert tracking.attached == set()


def test_ws_pings_and_times_out_independent_of_output(env, monkeypatch):
    # Ping and the client-timeout reap must not be starved by a task that
    # writes continuously: previously both lived inside pump_output's own
    # read-timeout branch, which a busy queue never hits.
    monkeypatch.setattr(routes, "HEARTBEAT_SECONDS", 0.05)
    monkeypatch.setattr(routes, "CLIENT_TIMEOUT_SECONDS", 0.2)
    client, manager, host, tid = env

    class ContinuousHost(FakeHost):
        def attach(self, task_id, loop):
            snapshot, sub = super().attach(task_id, loop)

            async def _feed():
                try:
                    for _ in range(100):
                        await asyncio.sleep(0.01)
                        sub.push_threadsafe(b"x")
                except asyncio.CancelledError:
                    return

            loop.create_task(_feed())
            return snapshot, sub

    manager.host = ContinuousHost()

    seen_ping = False
    seen_out = False
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(f"/api/terminals/tasks/{tid}/ws", headers=WS_HEADERS) as ws:
            ws.receive_json()  # replay
            # Never reply -- last_client_frame never advances, so the
            # heartbeat task's own timeout must fire and close us out.
            for _ in range(500):
                frame = ws.receive_json()
                if frame.get("t") == "ping":
                    seen_ping = True
                elif frame.get("t") == "out":
                    seen_out = True
    assert exc.value.code == 4008
    assert seen_ping
    assert seen_out
