"""The plugin install and uninstall routes must not be reachable from a tab.

Before 2026-09-21 these eight routes carried no check at all. A page on any
origin could POST `/api/hooks/<harness>/uninstall` and remove the Guard while
sessions were live; CORS hides the reply, never the effect. A product whose
claim is that it watches agents must not let an unknown page switch the
watching off.

The check here is Host plus a REQUIRED Origin rather than the terminals cookie,
because that cookie is scoped to /api/terminals and the browser never sends it
to /api/hooks. See `TerminalAuth.require_local_write`.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from securevector.app.server.routes import (
    hooks_claude_code,
    hooks_codex,
    hooks_copilot_cli,
    hooks_opencode,
)
from securevector.app.terminals.auth import TerminalAuth

MODULES = {
    "claude-code": hooks_claude_code,
    "codex": hooks_codex,
    "copilot-cli": hooks_copilot_cli,
    "opencode": hooks_opencode,
}

PAGE = {"host": "127.0.0.1:8741", "origin": "http://127.0.0.1:8741"}
EVIL = {"host": "127.0.0.1:8741", "origin": "https://evil.example"}
BARE = {"host": "127.0.0.1:8741"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    app = FastAPI()
    for mod in MODULES.values():
        monkeypatch.setattr(mod, "STAGING_DIR", tmp_path / mod.__name__, raising=False)
        app.include_router(mod.router, prefix="/api")
    app.state.terminal_auth = TerminalAuth(token="t" * 48, port=8741)
    return TestClient(app)


@pytest.mark.parametrize("harness", sorted(MODULES))
@pytest.mark.parametrize("action", ["install", "uninstall"])
def test_another_origin_is_refused(client, harness, action):
    r = client.post(f"/api/hooks/{harness}/{action}", headers=EVIL)
    assert r.status_code == 403, f"{harness}/{action} is reachable from any page"


@pytest.mark.parametrize("harness", sorted(MODULES))
@pytest.mark.parametrize("action", ["install", "uninstall"])
def test_no_origin_at_all_is_refused(client, harness, action):
    """A bare curl sends no Origin. Treating absent as acceptable is what left
    these reachable in the first place, so Origin is required, not merely
    validated when present."""
    r = client.post(f"/api/hooks/{harness}/{action}", headers=BARE)
    assert r.status_code == 403


@pytest.mark.parametrize("harness", sorted(MODULES))
def test_a_foreign_host_header_is_refused(client, harness):
    r = client.post(
        f"/api/hooks/{harness}/uninstall",
        headers={"host": "attacker.test", "origin": "http://attacker.test"},
    )
    assert r.status_code == 403


@pytest.mark.parametrize("harness", sorted(MODULES))
def test_the_apps_own_page_still_works(client, harness):
    """The check must not lock the Integrations page out of its own buttons,
    which is why it is Host plus Origin and not the terminals cookie."""
    assert client.post(f"/api/hooks/{harness}/install", headers=PAGE).status_code == 200


@pytest.mark.parametrize("harness", sorted(MODULES))
def test_force_is_not_reachable_from_the_query_string(client, harness):
    """`force` bypasses the live-session guard, so it must not ride in a URL: a
    query parameter is reachable from a plain link and lands in logs and
    history. It is a JSON body field, and an unknown body field is refused."""
    r = client.post(f"/api/hooks/{harness}/uninstall?force=true", headers=EVIL)
    assert r.status_code == 403, "origin is checked first, whatever the query says"
    r = client.post(f"/api/hooks/{harness}/uninstall", headers=PAGE, json={"forced": True})
    assert r.status_code == 422, "the body shape is closed, as the spawn body is"


def _hooks_modules():
    """Every hooks router in the package, discovered from DISK.

    Not a list maintained in this file. The first version of the test below
    iterated the same four modules the file already gated, so it was
    self-referential: it passed while Cursor and OpenClaw shipped completely
    ungated, and a reviewer had to find that by firing a live cross-origin
    POST. A regression guard whose scope comes from what is already covered
    guarantees nothing. Globbing the directory means a harness added later is
    covered the day its file lands.
    """
    import importlib
    import pathlib

    here = pathlib.Path(__file__).resolve().parents[4] / "src/securevector/app/server/routes"
    mods = []
    for path in sorted(here.glob("hooks*.py")):
        if path.name.startswith("_"):
            continue
        mods.append(importlib.import_module(f"securevector.app.server.routes.{path.stem}"))
    return mods


def test_the_discovery_actually_finds_the_harnesses():
    """A glob that matched nothing would make the test below pass vacuously,
    which is the same failure mode it exists to correct."""
    names = {m.__name__.rsplit(".", 1)[-1] for m in _hooks_modules()}
    for expected in ("hooks", "hooks_claude_code", "hooks_codex", "hooks_cursor",
                     "hooks_copilot_cli", "hooks_opencode"):
        assert expected in names, f"{expected} was not discovered"


def test_every_state_changing_hooks_route_is_gated():
    """Every non-GET route any hooks router exposes must carry the origin gate.

    Reads are deliberately not gated: a status endpoint discloses nothing an
    attacker could not learn another way, and the page polls them.
    """
    from fastapi.routing import APIRoute

    ungated = []
    for mod in _hooks_modules():
        router = getattr(mod, "router", None)
        if router is None:
            continue
        for route in router.routes:
            if not isinstance(route, APIRoute):
                continue
            if route.methods <= {"GET", "HEAD", "OPTIONS"}:
                continue
            names = {getattr(d.call, "__name__", "") for d in route.dependant.dependencies}
            if "require_local_origin" not in names:
                ungated.append(f"{mod.__name__.rsplit('.', 1)[-1]} {sorted(route.methods)} {route.path}")

    assert not ungated, (
        "state-changing hooks routes reachable from any origin: " + "; ".join(ungated)
    )


def test_every_terminals_executor_has_a_live_session_guard_on_its_uninstall():
    """The pairing that is currently correct only by coincidence.

    Cursor and OpenClaw uninstall without a `block_uninstall` check, which is
    right today because neither is a Terminals executor, so neither can own a
    board session to strand. The moment one becomes an executor that stops
    being true, and nothing would have told anybody.

    So: derive the requirement from `EXECUTORS`, the actual list of harnesses
    the app can launch. Add a harness there and this fails until its uninstall
    route learns to refuse while its sessions are live.
    """
    import inspect

    from securevector.app.terminals.executors import EXECUTORS

    # Which module serves which harness. Asserted below to cover EXECUTORS in
    # full, so a new executor with no entry here fails rather than skips.
    BY_EXECUTOR = {
        "claude-code": hooks_claude_code,
        "codex": hooks_codex,
        "copilot-cli": hooks_copilot_cli,
        "opencode": hooks_opencode,
    }

    missing = set(EXECUTORS) - set(BY_EXECUTOR)
    assert not missing, (
        f"executor(s) {sorted(missing)} have no hooks module mapped here, so their "
        "uninstall is unchecked; map them and confirm the route guards live sessions"
    )

    for executor_id, mod in BY_EXECUTOR.items():
        src = inspect.getsource(mod)
        assert f'block_uninstall(request.app, "{executor_id}"' in src, (
            f"{mod.__name__} can strand live {executor_id} sessions: its uninstall "
            "does not consult the board"
        )
