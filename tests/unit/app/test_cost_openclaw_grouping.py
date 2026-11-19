"""OpenClaw cost rows group under agent "openclaw": rows sent before 6.2.0
carry the session key ("agent:...") or "openclaw-agent" as agent_id and are
read as "openclaw" without rewriting them."""

from __future__ import annotations

import pytest
import pytest_asyncio

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import init_database_schema
from securevector.app.database.repositories.costs import CostsRepository
from securevector.app.server.routes import costs as costs_routes


@pytest_asyncio.fixture
async def db(tmp_path):
    conn = DatabaseConnection(tmp_path / "costs.db")
    await init_database_schema(conn)
    return conn


async def _track(db, monkeypatch, **body):
    monkeypatch.setattr(costs_routes, "get_database", lambda: db)
    body = {"provider": "anthropic", "model_id": "claude-haiku-4-5", "input_tokens": 1000,
            "output_tokens": 100, **body}
    return await costs_routes.record_cost(costs_routes.RecordCostRequest(**body))


async def _seed(db, monkeypatch):
    # Old plugin rows: one per session key, plus the old default id.
    await _track(db, monkeypatch, agent_id="agent:main:explicit:aaa")
    await _track(db, monkeypatch, agent_id="agent:main:explicit:bbb")
    await _track(db, monkeypatch, agent_id="openclaw-agent")
    # New plugin row.
    await _track(db, monkeypatch, agent_id="openclaw", runtime_kind="openclaw",
                 session_id="agent:main:explicit:ccc", request_id="run-1:1")
    # Other harnesses stay apart, including a non-OpenClaw "agent:" row.
    await _track(db, monkeypatch, agent_id="hermes", runtime_kind="hermes")
    await _track(db, monkeypatch, agent_id="agent:other", runtime_kind="hermes")


@pytest.mark.asyncio
async def test_old_rows_group_under_openclaw(db, monkeypatch):
    await _seed(db, monkeypatch)
    repo = CostsRepository(db)
    by_agent = {s.agent_id: s for s in await repo.get_agent_summaries()}
    assert by_agent["openclaw"].total_requests == 4
    assert by_agent["hermes"].total_requests == 1
    assert by_agent["agent:other"].total_requests == 1
    assert not any(a.startswith("agent:main") or a == "openclaw-agent" for a in by_agent)
    # Stored rows are not rewritten.
    row = await db.fetch_one("SELECT COUNT(*) AS n FROM llm_cost_records WHERE agent_id LIKE 'agent:main:%'")
    assert row["n"] == 2


@pytest.mark.asyncio
async def test_openclaw_filter_spend_and_delete_include_old_rows(db, monkeypatch):
    await _seed(db, monkeypatch)
    repo = CostsRepository(db)
    records, total = await repo.list_records(agent_id="openclaw")
    assert total == 4 and len(records) == 4
    one = (await repo.list_records(agent_id="hermes"))[1]
    assert one == 1
    all_today = await repo.get_today_spend()
    oc_today = await repo.get_today_spend("openclaw")
    assert 0 < oc_today < all_today
    assert await repo.get_monthly_spend("openclaw") == pytest.approx(oc_today)
    assert (await repo.get_dashboard_summary())["top_agent"] == "openclaw"
    assert await repo.delete_records("openclaw") == 4
    left = await db.fetch_all("SELECT agent_id FROM llm_cost_records ORDER BY agent_id")
    assert [r["agent_id"] for r in left] == ["agent:other", "hermes"]


@pytest.mark.asyncio
async def test_new_row_keeps_session_harness_and_request_id(db, monkeypatch):
    await _track(db, monkeypatch, agent_id="openclaw", runtime_kind="openclaw",
                 session_id="agent:main:explicit:ccc", request_id="run-1:1")
    again = await _track(db, monkeypatch, agent_id="openclaw", runtime_kind="openclaw",
                         session_id="agent:main:explicit:ccc", request_id="run-1:1")
    row = await db.fetch_one("SELECT COUNT(*) AS n, MAX(session_id) AS s, MAX(runtime_kind) AS k "
                             "FROM llm_cost_records")
    assert row["n"] == 1 and again["status"] == "recorded"
    assert row["s"] == "agent:main:explicit:ccc" and row["k"] == "openclaw"
