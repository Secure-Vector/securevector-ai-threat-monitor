"""Tests for per-run cost enforcement (issue #203).

Covers the acceptance surface that is testable at the unit level: everything
defaults to OFF on a fresh install, the tool-call cap and loop breaker emit
deny rows only past their thresholds, the run exemption lifts the caps, the
kill switch covers the rail, the per-run cost/token ceilings ride
budget-status, existing daily-budget behaviour is unchanged, and stops are
promotable and visible.
"""

from __future__ import annotations

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.costs import CostsRepository
from securevector.app.database.repositories.custom_tools import CustomToolsRepository
from securevector.app.database.repositories.settings import SettingsRepository
from securevector.app.services.run_limits import (
    LOOP_REPEAT_LIMIT,
    RUN_CAP_PREFIX,
    create_run_exemption,
    evaluate_run_limits,
    has_run_exemption,
    recent_stops,
)

RUNTIME = "claude-code"
SESSION = "sess-run-limits"


async def _build_db(tmp_path) -> DatabaseConnection:
    db = DatabaseConnection(tmp_path / "test.db")
    await run_migrations(db)
    return db


async def _log_calls(db, n, *, tool_id="builtin:bash", args_preview=None,
                     action="allow", reason=None, session_id=SESSION):
    repo = CustomToolsRepository(db)
    for i in range(n):
        await repo.log_tool_call_audit(
            tool_id=tool_id,
            function_name=tool_id.split(":")[-1],
            action=action,
            reason=reason,
            args_preview=args_preview if args_preview is not None else f"call {i}",
            runtime_kind=RUNTIME,
            session_id=session_id,
        )


# --- defaults (acceptance 1) ----------------------------------------------

@pytest.mark.asyncio
async def test_everything_defaults_off_on_fresh_install(tmp_path):
    db = await _build_db(tmp_path)
    s = await SettingsRepository(db).get()
    assert s.run_max_tool_calls is None
    assert s.run_max_cost_usd is None
    assert s.run_max_tokens is None
    assert s.run_loop_breaker is False
    assert s.run_limit_action == "warn"
    # and with nothing configured, the decision path emits nothing
    await _log_calls(db, 5)
    assert await evaluate_run_limits(db, RUNTIME, SESSION) == []
    await db.disconnect()


# --- tool-call cap ---------------------------------------------------------

@pytest.mark.asyncio
async def test_tool_call_cap_denies_at_the_configured_count(tmp_path):
    db = await _build_db(tmp_path)
    await SettingsRepository(db).update(run_max_tool_calls=10)

    await _log_calls(db, 9)
    assert await evaluate_run_limits(db, RUNTIME, SESSION) == []

    await _log_calls(db, 1)
    rows = await evaluate_run_limits(db, RUNTIME, SESSION)
    assert len(rows) == 1
    row = rows[0]
    assert row["tool_id"] == "*"
    assert row["effect"] == "deny"
    assert row["source"] == "run_limit"
    # the reason names the control, the observed value and the threshold —
    # it is the blocked ledger's grouping key
    assert row["reason"].startswith(RUN_CAP_PREFIX)
    assert "10" in row["reason"]
    await db.disconnect()


@pytest.mark.asyncio
async def test_cap_is_per_session_not_global(tmp_path):
    db = await _build_db(tmp_path)
    await SettingsRepository(db).update(run_max_tool_calls=5)
    await _log_calls(db, 8, session_id="other-session")
    assert await evaluate_run_limits(db, RUNTIME, SESSION) == []
    await db.disconnect()


@pytest.mark.asyncio
async def test_kill_switch_covers_the_rail(tmp_path):
    db = await _build_db(tmp_path)
    await SettingsRepository(db).update(run_max_tool_calls=3, tool_permissions_enabled=False)
    await _log_calls(db, 6)
    assert await evaluate_run_limits(db, RUNTIME, SESSION) == []
    await db.disconnect()


# --- exemption: stop now, approve to continue ------------------------------

@pytest.mark.asyncio
async def test_exemption_lifts_the_cap_and_is_revocable_shaped(tmp_path):
    db = await _build_db(tmp_path)
    await SettingsRepository(db).update(run_max_tool_calls=3)
    await _log_calls(db, 5)
    assert (await evaluate_run_limits(db, RUNTIME, SESSION)) != []

    grant = await create_run_exemption(db, RUNTIME, SESSION)
    assert grant["tool_id"] == "*"
    assert await has_run_exemption(db, RUNTIME, SESSION)
    assert await evaluate_run_limits(db, RUNTIME, SESSION) == []
    # scoped: another session stays capped
    assert not await has_run_exemption(db, RUNTIME, "another-session")
    await db.disconnect()


def test_wildcard_grants_are_not_emitted_as_allow_rows(tmp_path, monkeypatch):
    """A run exemption must lift ONLY the run cap — a '*' allow row reaching
    the plugins would lift policy denies too.

    Sync test + asyncio.run setup, like the killswitch route tests: a
    TestClient inside an async test runs handlers on a second event loop
    against a DB bound to the first, which wedges aiosqlite.
    """
    import asyncio

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from securevector.app.server.routes import tool_permissions as tp

    async def _setup():
        db = await _build_db(tmp_path)
        await create_run_exemption(db, RUNTIME, SESSION)
        await db.disconnect()

    asyncio.run(_setup())
    db = DatabaseConnection(tmp_path / "test.db")
    app = FastAPI()
    app.include_router(tp.router, prefix="/api")
    monkeypatch.setattr(tp, "get_database", lambda: db)
    try:
        with TestClient(app) as client:
            res = client.get(
                "/api/tool-permissions/synced-overrides",
                params={"runtime": RUNTIME, "session_id": SESSION},
            ).json()
        assert all(r["tool_id"] != "*" or r["effect"] == "deny" for r in res["synced"])
        assert not any(
            r.get("source") == "jit_grant" and r["tool_id"] == "*" for r in res["synced"]
        )
    finally:
        asyncio.run(db.disconnect())


# --- loop breaker ----------------------------------------------------------

@pytest.mark.asyncio
async def test_loop_breaker_denies_identical_repeats(tmp_path):
    db = await _build_db(tmp_path)
    await SettingsRepository(db).update(run_loop_breaker=True)

    await _log_calls(db, LOOP_REPEAT_LIMIT - 1, args_preview="same args")
    assert await evaluate_run_limits(db, RUNTIME, SESSION) == []

    await _log_calls(db, 1, args_preview="same args")
    rows = await evaluate_run_limits(db, RUNTIME, SESSION)
    assert len(rows) == 1
    assert rows[0]["tool_id"] == "builtin:bash"  # per-tool deny, not wildcard
    assert rows[0]["reason"].startswith("Loop breaker")
    await db.disconnect()


@pytest.mark.asyncio
async def test_loop_breaker_off_by_default_ignores_repeats(tmp_path):
    db = await _build_db(tmp_path)
    await _log_calls(db, LOOP_REPEAT_LIMIT + 5, args_preview="same args")
    assert await evaluate_run_limits(db, RUNTIME, SESSION) == []
    await db.disconnect()


# --- per-run ceilings on budget-status -------------------------------------
# Sync tests + asyncio.run for setup/teardown, mirroring the killswitch route
# tests: a TestClient must never run inside an async test (two event loops,
# one aiosqlite).

import asyncio as _asyncio  # noqa: E402


def _setup_db(tmp_path, coro_factory):
    """Run async setup against a fresh DB on its own loop, then return a new
    connection to the same file for the sync TestClient phase."""
    async def _run():
        db = await _build_db(tmp_path)
        await coro_factory(db)
        await db.disconnect()

    _asyncio.run(_run())
    return DatabaseConnection(tmp_path / "test.db")


def _budget_client(db, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from securevector.app.server.routes import costs as costs_routes

    app = FastAPI()
    app.include_router(costs_routes.router, prefix="/api")
    monkeypatch.setattr(costs_routes, "get_database", lambda: db)
    return TestClient(app)


async def _record(db, session_id, cost, tokens):
    await CostsRepository(db).record_cost(
        agent_id="local-agent", provider="anthropic", model_id="claude-x",
        input_tokens=tokens, output_tokens=0,
        input_cost_usd=cost, output_cost_usd=0.0, total_cost_usd=cost,
        session_id=session_id,
    )


def test_cost_ceiling_trips_on_run_spend(tmp_path, monkeypatch):
    async def seed(db):
        await SettingsRepository(db).update(run_max_cost_usd=5.0, run_limit_action="block")
        await _record(db, SESSION, 6.0, 1000)

    db = _setup_db(tmp_path, seed)
    try:
        with _budget_client(db, monkeypatch) as client:
            res = client.get("/api/costs/budget-status",
                             params={"agent_id": "local-agent", "session_id": SESSION}).json()
            assert res["over_run_limit"] is True
            assert res["run_limit_action"] == "block"
            assert res["run_limit_reason"].startswith("Per-run cost ceiling")
            # daily budget behaviour unchanged: no daily budget set -> not over
            assert res["over_budget"] is False
            # another run of the same agent is clean
            res2 = client.get("/api/costs/budget-status",
                              params={"agent_id": "local-agent", "session_id": "fresh-run"}).json()
            assert res2["over_run_limit"] is False
    finally:
        _asyncio.run(db.disconnect())


def test_token_ceiling_works_without_pricing(tmp_path, monkeypatch):
    """The token ceiling is the subscription-mode counterpart: token counts
    come straight off the provider responses, no pricing table needed."""
    async def seed(db):
        await SettingsRepository(db).update(run_max_tokens=500)
        await _record(db, SESSION, 0.0, 800)  # unpriced: cost 0, tokens real

    db = _setup_db(tmp_path, seed)
    try:
        with _budget_client(db, monkeypatch) as client:
            res = client.get("/api/costs/budget-status",
                             params={"agent_id": "local-agent", "session_id": SESSION}).json()
        assert res["over_run_limit"] is True
        assert res["run_limit_reason"].startswith("Per-run token ceiling")
    finally:
        _asyncio.run(db.disconnect())


def test_exemption_lifts_the_ceiling_too(tmp_path, monkeypatch):
    async def seed(db):
        await SettingsRepository(db).update(run_max_cost_usd=1.0)
        await _record(db, SESSION, 2.0, 100)
        await create_run_exemption(db, "openclaw", SESSION)

    db = _setup_db(tmp_path, seed)
    try:
        with _budget_client(db, monkeypatch) as client:
            res = client.get("/api/costs/budget-status",
                             params={"agent_id": "local-agent", "session_id": SESSION}).json()
        assert res["over_run_limit"] is False
        assert res["run_exempted"] is True
    finally:
        _asyncio.run(db.disconnect())


def test_budget_status_without_session_is_unchanged(tmp_path, monkeypatch):
    async def seed(db):
        pass

    db = _setup_db(tmp_path, seed)
    try:
        with _budget_client(db, monkeypatch) as client:
            res = client.get("/api/costs/budget-status", params={"agent_id": "a"}).json()
        assert res["over_budget"] is False
        assert res["over_run_limit"] is False
        assert res["session_id"] is None
    finally:
        _asyncio.run(db.disconnect())


# --- run-limits settings API + stops ---------------------------------------

def test_run_limits_roundtrip_and_immediate_effect(tmp_path, monkeypatch):
    async def seed(db):
        pass

    db = _setup_db(tmp_path, seed)
    try:
        with _budget_client(db, monkeypatch) as client:
            res = client.get("/api/costs/run-limits").json()
            assert res["run_max_tool_calls"] is None and res["run_loop_breaker"] is False

            put = client.put("/api/costs/run-limits", json={
                "run_max_tool_calls": 50, "run_max_cost_usd": 10.0,
                "run_max_tokens": 2000000, "run_limit_action": "block",
                "run_loop_breaker": True,
            })
            assert put.status_code == 200 and put.json()["run_max_tool_calls"] == 50

            # disabling takes effect without any restart: a fresh PUT clears
            # the cap and the decision path reads settings per call
            client.put("/api/costs/run-limits", json={"run_limit_action": "warn"})

            bad = client.put("/api/costs/run-limits", json={"run_limit_action": "explode"})
            assert bad.status_code == 422
    finally:
        _asyncio.run(db.disconnect())

    async def verify():
        db2 = DatabaseConnection(tmp_path / "test.db")
        assert (await SettingsRepository(db2).get()).run_max_tool_calls is None
        await _log_calls(db2, 60)
        assert await evaluate_run_limits(db2, RUNTIME, SESSION) == []
        await db2.disconnect()

    _asyncio.run(verify())


@pytest.mark.asyncio
async def test_recent_stops_surface_with_exemption_state(tmp_path):
    db = await _build_db(tmp_path)
    await _log_calls(
        db, 2, action="block",
        reason=f"{RUN_CAP_PREFIX}: this session has made 51 tool calls (limit 50). "
               "Approve continuation under Cost Settings to resume.",
    )
    stops = await recent_stops(db)
    assert len(stops) == 1
    assert stops[0]["stops"] == 2
    assert stops[0]["session_id"] == SESSION
    assert stops[0]["exempted"] is False

    await create_run_exemption(db, RUNTIME, SESSION)
    stops = await recent_stops(db)
    assert stops[0]["exempted"] is True
    await db.disconnect()


# --- synced-overrides integration ------------------------------------------

def test_overrides_endpoint_emits_run_limit_deny_first(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from securevector.app.server.routes import tool_permissions as tp

    async def seed(db):
        await SettingsRepository(db).update(run_max_tool_calls=3)
        await _log_calls(db, 4)

    db = _setup_db(tmp_path, seed)
    app = FastAPI()
    app.include_router(tp.router, prefix="/api")
    monkeypatch.setattr(tp, "get_database", lambda: db)
    try:
        with TestClient(app) as client:
            res = client.get("/api/tool-permissions/synced-overrides",
                             params={"runtime": RUNTIME, "session_id": SESSION}).json()
            assert res["synced"], "run-limit deny row expected"
            first = res["synced"][0]
            assert first["tool_id"] == "*" and first["effect"] == "deny"
            assert first["source"] == "run_limit"

            # without a session id the endpoint's contract is unchanged
            res2 = client.get("/api/tool-permissions/synced-overrides",
                              params={"runtime": RUNTIME}).json()
            assert not any(r.get("source") == "run_limit" for r in res2["synced"])
    finally:
        _asyncio.run(db.disconnect())
