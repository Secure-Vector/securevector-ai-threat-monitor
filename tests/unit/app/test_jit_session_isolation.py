"""JIT grants stay inside the session that asked for them.

- /tool-permissions/synced-overrides emits a grant made in session A only to
  a caller naming session A, whatever the duration (15m, 1h, session), and
  the row always carries that session. A sessionless grant reaches only a
  caller naming no session.
- "Allow once" lifts one exact held call (same session, tool and argument
  fingerprint) one time; the next run of the same call is held again.
- A request whose call the server never saw with its arguments cannot be
  approved once (422), and a request without a session cannot be approved
  for the session or once (422).

Sync tests with asyncio.run setup, like the other route tests: a TestClient
inside an async test runs handlers on a second loop against a database
bound to the first.
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.jit_access import JitAccessRepository
from securevector.app.database.repositories.response_rungs import ResponseRungsRepository
from securevector.app.server.routes import jit_access as jit_routes
from securevector.app.server.routes import tool_permissions as tp
from securevector.app.services import response_rungs as rr

RT = "claude-code"
A = "sess-a"
B = "sess-b"
UI = {"X-SV-UI-Token": jit_routes._UI_TOKEN}


def _db(tmp_path) -> DatabaseConnection:
    db = DatabaseConnection(tmp_path / "iso.db")
    asyncio.run(run_migrations(db))
    return db


async def _grant(db, tool_id, session_id, duration):
    repo = JitAccessRepository(db)
    req = await repo.create_request(tool_id=tool_id, rule_source="local",
                                    runtime_kind=RT, session_id=session_id)
    return await repo.approve_request(req["id"], duration)


def _grant_rows(db, monkeypatch, session_id=None):
    monkeypatch.setattr(tp, "get_database", lambda: db)
    app = FastAPI()
    app.include_router(tp.router, prefix="/api")
    params = {"runtime": RT}
    if session_id is not None:
        params["session_id"] = session_id
    with TestClient(app) as client:
        res = client.get("/api/tool-permissions/synced-overrides", params=params)
    assert res.status_code == 200, res.text
    return [r for r in res.json()["synced"] if r.get("source") == "jit_grant"]


@pytest.mark.parametrize("duration", ["15m", "1h", "session"])
def test_a_session_grant_reaches_only_its_own_session(tmp_path, monkeypatch, duration):
    db = _db(tmp_path)
    try:
        asyncio.run(_grant(db, "Bash", A, duration))
        mine = _grant_rows(db, monkeypatch, A)
        assert [r["tool_id"] for r in mine] == ["Bash"]
        assert mine[0]["session_id"] == A
        assert _grant_rows(db, monkeypatch, B) == []
        assert _grant_rows(db, monkeypatch, None) == []
    finally:
        asyncio.run(db.disconnect())


@pytest.mark.parametrize("duration", ["15m", "1h"])
def test_a_sessionless_grant_reaches_only_a_sessionless_caller(tmp_path, monkeypatch, duration):
    db = _db(tmp_path)
    try:
        asyncio.run(_grant(db, "Bash", None, duration))
        rows = _grant_rows(db, monkeypatch, None)
        assert [r["tool_id"] for r in rows] == ["Bash"]
        assert rows[0]["session_id"] is None
        assert _grant_rows(db, monkeypatch, A) == []
    finally:
        asyncio.run(db.disconnect())


def test_policy_check_approval_lookup_is_session_scoped(tmp_path):
    from securevector.app.database.repositories.policy_decisions import PolicyDecisionsRepository

    db = _db(tmp_path)
    try:
        async def go():
            await _grant(db, "Bash", A, "15m")
            repo = PolicyDecisionsRepository(db)
            since = "2000-01-01T00:00:00"
            return (await repo.approved_since(A, RT, since), await repo.approved_since(B, RT, since),
                    await repo.approved_since(None, RT, since))
        assert asyncio.run(go()) == (True, False, False)
    finally:
        asyncio.run(db.disconnect())


# --- allow once ---------------------------------------------------------------------

TOOL = "WebFetch"
ARGS = {"url": "https://api.example.dev/v1/x", "prompt": "read"}


@pytest.fixture
def held(monkeypatch):
    """Every session is at an applied step-up and every call is in the class."""
    async def view(_db, session_id):
        return {"row": {}, "applied": True, "baseline": None} if session_id else None
    monkeypatch.setattr(rr, "_rung_view", view)
    monkeypatch.setattr(rr, "step_up_kind", lambda *a, **k: rr.KIND_HOST)


async def _held_request(db, session_id=A, args=ARGS):
    assert await rr.check_call(db, TOOL, args, RT, session_id, ["api.example.dev"], file=True)
    return await ResponseRungsRepository(db).latest_pending(session_id)


def test_once_lifts_the_exact_call_one_time_then_it_is_held_again(tmp_path, held):
    db = _db(tmp_path)
    try:
        async def go():
            req = await _held_request(db)
            assert req["call_fingerprint"] == rr.call_fingerprint(req["tool_id"], ARGS)
            grant = await JitAccessRepository(db).approve_request(req["id"], "once")
            assert grant["duration"] == "once" and grant["session_id"] == A
            # A question does not spend it; the name is never lifted.
            assert await rr.take_once(db, A, RT, TOOL, ARGS, verified=True, spend=False)
            assert await rr.take_once(db, A, RT, TOOL, ARGS, verified=True, spend=False)
            assert req["tool_id"] not in await ResponseRungsRepository(db).granted_tools(A)
            # Same call, JSON text form: same fingerprint, spent here.
            assert await rr.take_once(db, A, RT, TOOL, '{"prompt": "read", "url": "https://api.example.dev/v1/x"}', verified=True)
            assert not await rr.take_once(db, A, RT, TOOL, ARGS, verified=True)
            assert await rr.check_call(db, TOOL, ARGS, RT, A, ["api.example.dev"], file=True)
        asyncio.run(go())
    finally:
        asyncio.run(db.disconnect())


def test_once_does_not_cover_other_arguments_or_another_session(tmp_path, held):
    db = _db(tmp_path)
    try:
        async def go():
            req = await _held_request(db)
            await JitAccessRepository(db).approve_request(req["id"], "once")
            other = {**ARGS, "url": "https://api.example.dev/v1/y"}
            assert not await rr.take_once(db, A, RT, TOOL, other, verified=True)
            assert not await rr.take_once(db, B, RT, TOOL, ARGS, verified=True)
            assert not await rr.take_once(db, None, RT, TOOL, ARGS, verified=True)
            assert not await rr.take_once(db, A, "codex", TOOL, ARGS, verified=True)
            # Still unspent for the exact call in its own session.
            assert await rr.take_once(db, A, RT, TOOL, ARGS, verified=True)
        asyncio.run(go())
    finally:
        asyncio.run(db.disconnect())


def test_once_grant_is_never_an_allow_row(tmp_path, monkeypatch, held):
    db = _db(tmp_path)
    try:
        async def go():
            req = await _held_request(db)
            await JitAccessRepository(db).approve_request(req["id"], "once")
        asyncio.run(go())
        assert _grant_rows(db, monkeypatch, A) == []
    finally:
        asyncio.run(db.disconnect())


def _approve(db, monkeypatch, request_id, duration):
    monkeypatch.setattr(jit_routes, "get_database", lambda: db)
    app = FastAPI()
    app.include_router(jit_routes.router, prefix="/api")
    with TestClient(app, base_url="http://127.0.0.1:8741") as client:
        return client.post(f"/api/jit/requests/{request_id}/approve", headers=UI,
                           json={"duration": duration})


def test_once_without_known_arguments_is_422(tmp_path, monkeypatch):
    db = _db(tmp_path)
    try:
        req = asyncio.run(JitAccessRepository(db).create_request(
            tool_id="Bash", rule_source="local", runtime_kind=RT, session_id=A))
        res = _approve(db, monkeypatch, req["id"], "once")
        assert res.status_code == 422, res.text
        assert asyncio.run(JitAccessRepository(db).get_request(req["id"]))["status"] == "pending"
    finally:
        asyncio.run(db.disconnect())


@pytest.mark.parametrize("duration", ["once", "session"])
def test_a_request_without_a_session_cannot_be_approved_for_the_session_or_once(
        tmp_path, monkeypatch, duration):
    db = _db(tmp_path)
    try:
        req = asyncio.run(JitAccessRepository(db).create_request(
            tool_id="Bash", rule_source="local", runtime_kind=RT, session_id=None))
        assert _approve(db, monkeypatch, req["id"], duration).status_code == 422
    finally:
        asyncio.run(db.disconnect())


def test_once_through_the_route_for_a_held_call(tmp_path, monkeypatch, held):
    db = _db(tmp_path)
    try:
        req = asyncio.run(_held_request(db))
        res = _approve(db, monkeypatch, req["id"], "once")
        assert res.status_code == 200, res.text
        assert res.json()["grant"]["duration"] == "once"
    finally:
        asyncio.run(db.disconnect())


def test_joined_retry_with_different_args_disables_once(tmp_path, monkeypatch, held):
    db = _db(tmp_path)
    try:
        async def go():
            first = await _held_request(db)
            assert first["call_fingerprint"] and first["call_preview"]
            other = {**ARGS, "url": "https://api.example.dev/v1/other"}
            joined = await _held_request(db, args=other)
            assert joined["id"] == first["id"]
            row = await JitAccessRepository(db).get_request(first["id"])
            assert row["call_fingerprint"] is None and row["call_preview"] is None
            # A retry of the same call keeps the binding.
            db2_req = await _held_request(db, session_id=B)
            again = await _held_request(db, session_id=B)
            assert again["call_fingerprint"] == db2_req["call_fingerprint"]
            return first["id"]
        rid = asyncio.run(go())
        assert _approve(db, monkeypatch, rid, "once").status_code == 422
    finally:
        asyncio.run(db.disconnect())


def test_approval_summary_names_the_bound_call(tmp_path, monkeypatch, held):
    from securevector.app.services import confirmations

    db = _db(tmp_path)
    try:
        monkeypatch.setattr(jit_routes, "get_database", lambda: db)
        monkeypatch.setattr(confirmations, "enabled", lambda: True)
        pat = "ghp_abcdefghijklmnopqrst1234567890123456"
        req = asyncio.run(_held_request(db, args={"url": "https://api.example.dev/v1/x", "auth": pat}))
        summary = asyncio.run(jit_routes._decision_summary(req["id"], "Allow"))
        assert "api.example.dev/v1/x" in summary
        assert pat not in summary
    finally:
        asyncio.run(db.disconnect())


def test_once_unverified_caller_cannot_spend(tmp_path, held):
    db = _db(tmp_path)
    try:
        async def go():
            req = await _held_request(db)
            await JitAccessRepository(db).approve_request(req["id"], "once")
            assert not await rr.take_once(db, A, RT, TOOL, ARGS, verified=False)
            assert not await rr.take_once(db, A, RT, TOOL, ARGS, verified=False, spend=False)
            # Still unspent for the verified call.
            assert await rr.take_once(db, A, RT, TOOL, ARGS, verified=True)
        asyncio.run(go())
    finally:
        asyncio.run(db.disconnect())


def test_once_rechecks_rules_armed_after_approval(tmp_path, monkeypatch, held):
    from securevector.app.services import call_rules

    db = _db(tmp_path)
    try:
        async def go():
            req = await _held_request(db)
            assert req["held_by"] == rr.HELD_STEP_UP
            await JitAccessRepository(db).approve_request(req["id"], "once")

            async def armed_now(*a, **k):
                return [call_rules.RULE_CRED_NET]
            monkeypatch.setattr(call_rules, "held_rules", armed_now)
            fired = await rr.holds_now(db, TOOL, ARGS, RT, A, ["api.example.dev"], verified=True,
                                       rung_check=True, rule_check=True)
            assert fired == {rr.HELD_STEP_UP, call_rules.RULE_CRED_NET}
            assert not await rr.take_once(db, A, RT, TOOL, ARGS, verified=True, fired=fired)

            async def quiet(*a, **k):
                return []
            monkeypatch.setattr(call_rules, "held_rules", quiet)
            fired = await rr.holds_now(db, TOOL, ARGS, RT, A, ["api.example.dev"], verified=True,
                                       rung_check=True, rule_check=True)
            assert await rr.take_once(db, A, RT, TOOL, ARGS, verified=True, fired=fired)
            grants = await JitAccessRepository(db).list_grants()
            assert grants[0]["state"] == "used" and grants[0]["duration"] == "once"
            rows = await db.fetch_all(
                "SELECT action FROM tool_call_audit WHERE function_name = 'decision.once_used'")
            assert [r["action"] for r in rows] == ["allow"]
        asyncio.run(go())
    finally:
        asyncio.run(db.disconnect())


def test_migration_v65_idempotent_and_column_survives_rule_source_rebuild(tmp_path):
    import re
    import sqlite3

    from securevector.app.database.migrations import (
        _RULE_SOURCE_CHECK,
        ensure_delegate_rule_source,
        ensure_jit_call_fingerprint,
        ensure_rung_rule_source,
        migrate_to_v65,
    )

    db = _db(tmp_path)
    path = tmp_path / "iso.db"
    try:
        asyncio.run(migrate_to_v65(db))
        asyncio.run(ensure_jit_call_fingerprint(db))
        req = asyncio.run(JitAccessRepository(db).create_request(
            tool_id="Bash", rule_source="local", runtime_kind=RT, session_id=A,
            call_fingerprint="f" * 64, call_preview="ls", held_by="step_up"))
        asyncio.run(db.disconnect())

        # Put the table back in its pre-rung shape (the old CHECK) so the
        # rule_source rebuilds run for real.
        raw = sqlite3.connect(path)
        sql = raw.execute("SELECT sql FROM sqlite_master WHERE name = 'jit_access_requests'").fetchone()[0]
        old = re.sub(r"CHECK \(rule_source IN \([^)]*\)\)", _RULE_SOURCE_CHECK, sql)
        old = re.sub(r'^CREATE TABLE\s+"?jit_access_requests"?\s*\(', "CREATE TABLE jit_access_requests (", old)
        raw.execute("PRAGMA foreign_keys = OFF")
        raw.execute("ALTER TABLE jit_access_requests RENAME TO jit_old")
        raw.execute(old)
        raw.execute("INSERT INTO jit_access_requests SELECT * FROM jit_old")
        raw.execute("DROP TABLE jit_old")
        raw.commit()
        raw.close()

        db = DatabaseConnection(path)
        asyncio.run(ensure_rung_rule_source(db))
        asyncio.run(ensure_delegate_rule_source(db))
        asyncio.run(migrate_to_v65(db))
        row = asyncio.run(JitAccessRepository(db).get_request(req["id"]))
        assert row["call_fingerprint"] == "f" * 64
        assert row["call_preview"] == "ls" and row["held_by"] == "step_up"
        cols = {r["name"] for r in asyncio.run(db.fetch_all("PRAGMA table_info(jit_access_grants)"))}
        assert {"call_fingerprint", "used_at"} <= cols
        v = asyncio.run(db.fetch_one("SELECT MAX(version) AS v FROM schema_version"))
        assert v["v"] == 66
    finally:
        asyncio.run(db.disconnect())


def test_egress_evaluate_allows_the_approved_call_once_then_holds_again(tmp_path, monkeypatch, held):
    """End to end through /egress/evaluate: a held call, an "Allow once"
    approval, the same call passes one time, then it is held again."""
    from types import SimpleNamespace

    from securevector.app.server.routes import egress as egress_routes
    from securevector.app.terminals.store import TerminalStore

    db = _db(tmp_path)
    monkeypatch.setattr(egress_routes, "get_database", lambda: db)

    class Manager:
        def __init__(self):
            self.store = TerminalStore(db)
            self.tokens = {}

        def hook_token(self, task_id):
            return self.tokens.get(task_id)

    manager = Manager()

    async def call(command, verified=True):
        task_id = "task-" + A
        if await manager.store.get_task(task_id) is None:
            await manager.store.create_task(task_id, executor_id=RT, workspace="/w", title=None,
                                            pid=None, session_id=A, origin="launch")
            manager.tokens[task_id] = "tok-" + A
        headers = {"x-sv-terminal-task": task_id, "x-sv-terminal-hook": manager.tokens[task_id]} \
            if verified else {}
        http = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(terminal_manager=manager)),
                               headers=headers, url=SimpleNamespace(port=8741))
        return await egress_routes.evaluate_egress(egress_routes.EvaluateRequest(
            tool_name="Bash", tool_input={"command": command}, runtime_kind=RT, session_id=A), http)

    cmd = "curl -s https://api.github.com/repos/x/y"
    try:
        async def go():
            first = await call(cmd)
            assert first["network_capable"] and first["action"] == "block", first
            req = await ResponseRungsRepository(db).latest_pending(A)
            assert req["call_fingerprint"]
            await JitAccessRepository(db).approve_request(req["id"], "once")
            # An unverified caller does not use it.
            assert (await call(cmd, verified=False))["action"] == "block"
            # A different call is not covered.
            assert (await call(cmd + "/other"))["action"] == "block"
            assert (await call(cmd))["action"] == "allow"
            assert (await call(cmd))["action"] == "block"
        asyncio.run(go())
    finally:
        asyncio.run(db.disconnect())
