"""Migration v46 and the generation-span repository methods."""

from __future__ import annotations

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.costs import CostsRepository
from securevector.app.database.repositories.custom_tools import CustomToolsRepository
from securevector.app.utils.trace_id import derive_trace_id


async def _db(tmp_path) -> DatabaseConnection:
    db = DatabaseConnection(tmp_path / "t.db")
    await run_migrations(db)
    return db


@pytest.mark.asyncio
async def test_migration_v46_adds_columns_and_backfills_proxy_trace_ids(tmp_path):
    db = await _db(tmp_path)
    costs = CostsRepository(db)
    # A pre-v46 style proxy row: session_id only.
    await costs.record_cost(agent_id="proxy", provider="openai", model_id="gpt-4o", input_tokens=1,
                            output_tokens=1, input_cost_usd=0, output_cost_usd=0, total_cost_usd=0,
                            session_id="proxy-abc")
    # Re-run the v46 backfill on the live table.
    from securevector.app.database.migrations import migrate_to_v46
    await migrate_to_v46(db)
    row = await db.fetch_one("SELECT trace_id, runtime_kind FROM llm_cost_records WHERE session_id = 'proxy-abc'")
    assert row["runtime_kind"] == "llm-proxy"
    assert row["trace_id"] == derive_trace_id("llm-proxy", "proxy-abc")
    cols = {r[1] for r in await (await (await db.connect()).execute("PRAGMA table_info(llm_cost_records)")).fetchall()}
    assert {"span_id", "input_preview", "output_preview", "verdict_action", "duration_ms"} <= cols
    audit_cols = {r[1] for r in await (await (await db.connect()).execute("PRAGMA table_info(tool_call_audit)")).fetchall()}
    assert "span_id" in audit_cols


@pytest.mark.asyncio
async def test_record_generation_is_idempotent_and_prices(tmp_path):
    db = await _db(tmp_path)
    costs = CostsRepository(db)
    await costs.upsert_pricing(provider="openai", model_id="gpt-4o", display_name="gpt-4o", input_per_million=2.5, output_per_million=10.0)
    tid = derive_trace_id("python", "run-1")
    args = dict(trace_id=tid, span_id="s1", session_id="run-1", runtime_kind="python", provider="openai",
                model_id="gpt-4o", input_tokens=1_000_000, output_tokens=100_000, started_at="2026-09-04T10:00:00",
                duration_ms=120, input_preview="hi", output_preview="hello", finish_reason="stop")
    first = await costs.record_generation(**args)
    assert first["pricing_known"] is True
    assert first["total_cost_usd"] == pytest.approx(2.5 + 1.0)
    second = await costs.record_generation(**{**args, "output_tokens": 200_000})
    assert second["id"] == first["id"], "resend updates the same row"
    gens = await costs.get_trace_generations(tid)
    assert len(gens) == 1
    g = gens[0]
    assert g["output_tokens"] == 200_000 and g["total_cost_usd"] == pytest.approx(2.5 + 2.0)
    assert g["input_preview"] == "hi" and g["duration_ms"] == 120 and g["turn_index"] == 0


@pytest.mark.asyncio
async def test_resolve_rates_falls_back_to_model_and_prefix(tmp_path):
    db = await _db(tmp_path)
    costs = CostsRepository(db)
    await costs.upsert_pricing(provider="anthropic", model_id="claude-3-5-sonnet", display_name="claude-3-5-sonnet", input_per_million=3.0, output_per_million=15.0)
    assert await costs.resolve_rates("bedrock", "anthropic.claude-3-5-sonnet-20241022-v2:0") == (3.0, 15.0)
    assert await costs.resolve_rates(None, "claude-3-5-sonnet") == (3.0, 15.0)
    assert await costs.resolve_rates("openai", "nope") == (None, None)
    r = await costs.record_generation(trace_id="t", span_id="x", session_id="s", runtime_kind="python",
                                      provider="openai", model_id="nope", input_tokens=5, output_tokens=5)
    assert r["pricing_known"] is False and r["total_cost_usd"] == 0


@pytest.mark.asyncio
async def test_generation_runs_group_by_trace_with_cost_and_max_turn(tmp_path):
    db = await _db(tmp_path)
    costs = CostsRepository(db)
    await costs.upsert_pricing(provider="openai", model_id="gpt-4o", display_name="gpt-4o", input_per_million=1.0, output_per_million=1.0)
    tid = derive_trace_id("python", "run-2")
    for i, out in enumerate((1_000_000, 3_000_000, 1_000_000)):
        await costs.record_generation(trace_id=tid, span_id=f"s{i}", session_id="run-2", runtime_kind="python",
                                      provider="openai", model_id="gpt-4o", input_tokens=0, output_tokens=out,
                                      verdict_action="log_only" if i == 1 else "allow")
    runs = await costs.get_generation_runs()
    (run,) = [r for r in runs if r["trace_id"] == tid]
    assert run["generations"] == 3 and run["tokens"] == 5_000_000
    assert run["cost"] == pytest.approx(5.0) and run["max_turn_cost"] == pytest.approx(3.0)
    assert run["flagged"] == 1 and run["models"] == "gpt-4o"
    gens = await costs.get_trace_generations(tid)
    assert [g["turn_index"] for g in gens] == [0, 1, 2]


@pytest.mark.asyncio
async def test_tool_audit_round_trips_span_ids(tmp_path):
    db = await _db(tmp_path)
    tools = CustomToolsRepository(db)
    await tools.log_tool_call_audit("search", "search", "allow", runtime_kind="python", session_id="run-3",
                                    request_id="r1", span_id="r1", parent_span_id="gen-1")
    await tools.log_tool_call_audit("search", "search", "allow", runtime_kind="python", session_id="run-3",
                                    request_id="r2")
    spans = await tools.get_trace_spans(derive_trace_id("python", "run-3"))
    assert [s["span_id"] for s in spans] == ["r1", None]
    assert [s["parent_span_id"] for s in spans] == ["gen-1", None]
