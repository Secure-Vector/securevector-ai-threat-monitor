"""Cost records: cache read and write pricing, Bedrock and Vertex model ids,
Anthropic input semantics, and the harness cost paths (OpenClaw, OpenCode)."""

from __future__ import annotations

import json

import pytest
import pytest_asyncio

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import init_database_schema
from securevector.app.database.repositories.costs import (
    CostsRepository,
    RateCard,
    compute_cost,
    input_includes_cached,
    model_id_candidates,
)
from securevector.app.server.routes import costs as costs_routes
from securevector.app.services.cost_recorder import CostRecorder


@pytest_asyncio.fixture
async def db(tmp_path):
    conn = DatabaseConnection(tmp_path / "costs.db")
    await init_database_schema(conn)
    return conn


async def _track(db, monkeypatch, **body):
    monkeypatch.setattr(costs_routes, "get_database", lambda: db)
    req = costs_routes.RecordCostRequest(**body)
    return await costs_routes.record_cost(req)


# --- the real box: OpenClaw on Bedrock Haiku 4.5 ---------------------------

BOX = dict(input_tokens=956, input_cached_tokens=3_221_219, output_tokens=36_155)
# 956 x $1 + 3,221,219 x $0.10 + 36,155 x $5, per million tokens.
BOX_USD = (956 * 1.0 + 3_221_219 * 0.10 + 36_155 * 5.0) / 1_000_000


@pytest.mark.asyncio
async def test_bedrock_haiku_box_mix_prices_cache_reads_at_a_tenth(db, monkeypatch):
    out = await _track(db, monkeypatch, agent_id="agent:main:x", provider="amazon-bedrock",
                       model_id="us.anthropic.claude-haiku-4-5-20251001-v1:0", **BOX)
    assert out["pricing_known"] is True
    # us. is a regional Bedrock endpoint: 1.1x on Haiku 4.5.
    assert out["total_cost_usd"] == pytest.approx(1.1 * BOX_USD, abs=1e-6)
    assert 0.55 < out["total_cost_usd"] < 0.56  # was $3.74 at 1.0x cache rate


@pytest.mark.asyncio
async def test_cache_writes_are_stored_and_priced(db, monkeypatch):
    out = await _track(db, monkeypatch, provider="amazon-bedrock",
                       model_id="global.anthropic.claude-haiku-4-5-20251001-v1:0",
                       input_cache_write_tokens=100_000, **BOX)
    assert out["total_cost_usd"] == pytest.approx(BOX_USD + 100_000 * 1.25 / 1_000_000, abs=1e-6)
    row = await db.fetch_one("SELECT input_cache_write_tokens, input_cached_tokens FROM llm_cost_records "
                             "WHERE id = ?", (out["id"],))
    assert row["input_cache_write_tokens"] == 100_000
    assert row["input_cached_tokens"] == 3_221_219
    records, _ = await CostsRepository(db).list_records()
    assert records[0].input_cache_write_tokens == 100_000


# --- new models, first-party and Bedrock / Vertex forms ---------------------

NEW = {
    # model: (input, cache write 5m, cache read, output)
    "claude-fable-5-1": (10.0, 12.5, 0.25, 50.0),
    "claude-mythos-5-1": (10.0, 12.5, 0.25, 50.0),
    "claude-opus-5-5": (4.0, 5.0, 0.20, 20.0),
    "claude-sonnet-5-5": (2.0, 2.5, 0.10, 10.0),
    "claude-haiku-5-5": (0.10, 0.125, 0.01, 0.50),
}


@pytest.mark.asyncio
@pytest.mark.parametrize("model", sorted(NEW))
# Bedrock regional and in-region ids carry the 10% regional-endpoint premium;
# global, first-party and Vertex (endpoint not on the record) do not.
@pytest.mark.parametrize("form,provider,premium", [
    ("{m}", "anthropic", 1.0),
    ("anthropic.{m}", "amazon-bedrock", 1.1),
    ("us.anthropic.{m}-v1:0", "bedrock", 1.1),
    ("eu.anthropic.{m}-20261001-v1:0", "amazon-bedrock", 1.1),
    ("global.anthropic.{m}-v1:0", "amazon-bedrock", 1.0),
    ("{m}@20261001", "vertex", 1.0),
])
async def test_new_models_price_in_every_id_form(db, model, form, provider, premium):
    inp, write, read, outp = NEW[model]
    card = await CostsRepository(db).resolve_rate_card(provider, form.format(m=model))
    assert card is not None
    assert (card.input, card.cache_write, card.cache_read, card.output) == (inp, write, read, outp)
    ic, oc = compute_cost(provider, form.format(m=model), card, 1_000_000, 1_000_000, 1_000_000, 1_000_000)
    assert ic + oc == pytest.approx(premium * (inp + write + read + outp))


def test_model_id_candidates_reduce_to_first_party():
    assert model_id_candidates("us.anthropic.claude-haiku-4-5-20251001-v1:0")[-1] == "claude-haiku-4-5"
    assert "claude-opus-4-1-20250805" in model_id_candidates("claude-opus-4-1@20250805")
    assert model_id_candidates("anthropic/claude-sonnet-5-5")[-1] == "claude-sonnet-5-5"
    # Non-Bedrock ids are not cut at a "-vN" that is part of the name.
    assert model_id_candidates("deepseek-v3") == ["deepseek-v3"]


@pytest.mark.asyncio
async def test_dated_first_party_keys_still_resolve(db):
    repo = CostsRepository(db)
    card = await repo.resolve_rate_card("amazon-bedrock", "anthropic.claude-3-5-haiku-20241022-v1:0")
    assert (card.input, card.output, card.cache_read) == (0.8, 4.0, 0.08)
    # The 5.5 entries win over the shorter 5.0 keys they start with.
    assert (await repo.resolve_rates("anthropic", "claude-opus-5-5"))[0] == 4.0
    assert (await repo.resolve_rates("anthropic", "claude-opus-5"))[0] == 5.0


# --- input semantics --------------------------------------------------------

def test_anthropic_input_excludes_cache_openai_includes_it():
    card = RateCard(input=1.0, output=0.0)
    # Anthropic: input_tokens is the uncached part; nothing is subtracted.
    ic, _ = compute_cost("anthropic", "claude-haiku-4-5", card, 1_000, 0, 9_000)
    assert ic == pytest.approx((1_000 + 9_000 * 0.1) / 1e6)
    # OpenAI: prompt_tokens already counts the cached ones.
    ic, _ = compute_cost("openai", "gpt-4o", card, 10_000, 0, 9_000)
    assert ic == pytest.approx((1_000 + 9_000 * 0.5) / 1e6)
    assert input_includes_cached("amazon-bedrock", "anthropic.claude-x") is False
    assert input_includes_cached("vertex", "claude-opus-4-5@20251101") is False
    assert input_includes_cached("vertex", "gemini-2.5-pro") is True
    # An explicit sender flag wins.
    ic, _ = compute_cost("openai", "gpt-4o", card, 1_000, 0, 9_000, includes_cached=False)
    assert ic == pytest.approx((1_000 + 9_000 * 0.5) / 1e6)


@pytest.mark.asyncio
async def test_proxy_recorder_reads_anthropic_cache_fields(db):
    rec = CostRecorder(db)
    body = json.dumps({"model": "claude-sonnet-5-5", "usage": {
        "input_tokens": 100, "output_tokens": 10,
        "cache_read_input_tokens": 50_000, "cache_creation_input_tokens": 2_000}}).encode()
    assert rec.extract_usage(body, "anthropic") == ("claude-sonnet-5-5", 100, 10, 50_000, 2_000)
    assert rec.extract_tokens(body, "anthropic") == ("claude-sonnet-5-5", 100, 10, 50_000)
    await rec.record("anthropic", "a1", body)
    row = await db.fetch_one("SELECT * FROM llm_cost_records WHERE agent_id = 'a1'")
    expected = (100 * 2.0 + 50_000 * 0.10 + 2_000 * 2.5 + 10 * 10.0) / 1e6
    assert row["total_cost_usd"] == pytest.approx(expected, abs=1e-8)
    assert row["input_cache_write_tokens"] == 2_000
    assert row["runtime_kind"] == "llm-proxy"


@pytest.mark.asyncio
async def test_proxy_recorder_reads_bedrock_converse_usage(db):
    rec = CostRecorder(db)
    body = json.dumps({"modelId": "us.anthropic.claude-haiku-4-5-20251001-v1:0", "usage": {
        "inputTokens": 956, "outputTokens": 36_155,
        "cacheReadInputTokens": 3_221_219, "cacheWriteInputTokens": 0}}).encode()
    await rec.record("amazon-bedrock", "b1", body)
    row = await db.fetch_one("SELECT * FROM llm_cost_records WHERE agent_id = 'b1'")
    assert row["pricing_known"] == 1
    # us. is a regional Bedrock endpoint: 1.1x on Haiku 4.5.
    assert row["total_cost_usd"] == pytest.approx(1.1 * BOX_USD, abs=1e-6)


# --- harness senders --------------------------------------------------------

@pytest.mark.asyncio
async def test_opencode_message_record_prices(db, monkeypatch):
    # The body plugins/opencode/lib/client.js costRecordFromMessage builds.
    out = await _track(db, monkeypatch, agent_id="opencode", provider="anthropic",
                       model_id="claude-sonnet-5-5", input_tokens=10, output_tokens=200,
                       input_cached_tokens=40_000, input_cache_write_tokens=1_000,
                       input_includes_cached=False, session_id="ses_1")
    assert out["total_cost_usd"] == pytest.approx((10 * 2 + 200 * 10 + 40_000 * 0.1 + 1_000 * 2.5) / 1e6)
    row = await db.fetch_one("SELECT session_id FROM llm_cost_records WHERE id = ?", (out["id"],))
    assert row["session_id"] == "ses_1"


@pytest.mark.asyncio
async def test_includes_cached_record_stores_the_uncached_input(db, monkeypatch):
    # The Hermes plugin sends the full prompt with input_includes_cached set.
    # The cost matches the uncached form; the stored input is the uncached part.
    out = await _track(db, monkeypatch, agent_id="hermes", provider="anthropic",
                       model_id="claude-sonnet-5-5", input_tokens=41_010, output_tokens=200,
                       input_cached_tokens=40_000, input_cache_write_tokens=1_000,
                       input_includes_cached=True, session_id="ses_h", runtime_kind="hermes")
    assert out["total_cost_usd"] == pytest.approx((10 * 2 + 200 * 10 + 40_000 * 0.1 + 1_000 * 2.5) / 1e6)
    row = await db.fetch_one(
        "SELECT input_tokens, input_cached_tokens, input_cache_write_tokens FROM llm_cost_records WHERE id = ?",
        (out["id"],))
    assert (row["input_tokens"], row["input_cached_tokens"], row["input_cache_write_tokens"]) == (10, 40_000, 1_000)
    kind = await db.fetch_one("SELECT runtime_kind FROM llm_cost_records WHERE id = ?", (out["id"],))
    assert kind["runtime_kind"] == "hermes"


@pytest.mark.asyncio
async def test_omitted_includes_cached_follows_the_provider_convention(db, monkeypatch):
    # OpenAI counts the cache inside input: stored input is the uncached part.
    out = await _track(db, monkeypatch, agent_id="x", provider="openai", model_id="gpt-4o",
                       input_tokens=1_000, output_tokens=10, input_cached_tokens=400)
    row = await db.fetch_one("SELECT input_tokens FROM llm_cost_records WHERE id = ?", (out["id"],))
    assert row["input_tokens"] == 600
    # Anthropic counts it apart: stored as sent.
    out = await _track(db, monkeypatch, agent_id="y", provider="anthropic", model_id="claude-sonnet-5-5",
                       input_tokens=1_000, output_tokens=10, input_cached_tokens=400)
    row = await db.fetch_one("SELECT input_tokens FROM llm_cost_records WHERE id = ?", (out["id"],))
    assert row["input_tokens"] == 1_000


async def _expected(db, provider, model, inp, out, read, write=0):
    from securevector.app.database.repositories.costs import CostsRepository
    card = await CostsRepository(db).resolve_rate_card(provider, model)
    assert card is not None, (provider, model)
    ic, oc = compute_cost(provider, model, card, inp, out, read, write)
    return round(ic + oc, 8)


CACHED_ROWS = [
    # (provider, proxy body, model, full prompt, output, cache read)
    ("openai", {"model": "gpt-4o", "usage": {"prompt_tokens": 10_000, "completion_tokens": 50,
                                            "prompt_tokens_details": {"cached_tokens": 8_000}}},
     "gpt-4o", 10_000, 50, 8_000),
    ("gemini", {"modelVersion": "gemini-2.5-pro", "usageMetadata": {
        "promptTokenCount": 20_000, "candidatesTokenCount": 70, "cachedContentTokenCount": 15_000}},
     "gemini-2.5-pro", 20_000, 70, 15_000),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("provider, body, model, full, out, read", CACHED_ROWS)
async def test_cached_rows_store_uncached_input_and_count_tokens_once(db, monkeypatch, provider, body, model,
                                                                     full, out, read):
    from securevector.app.database.repositories.costs import CostsRepository
    from securevector.app.services import observability

    expected = await _expected(db, provider, model, full, out, read)
    # The proxy recorder and /costs/track with the flag omitted.
    await CostRecorder(db).record(provider, "proxy-agent", json.dumps(body).encode(), session_id="s-proxy")
    await _track(db, monkeypatch, agent_id="track-agent", provider=provider, model_id=model,
                 input_tokens=full, output_tokens=out, input_cached_tokens=read, session_id="s-track")
    for agent, sid in (("proxy-agent", "s-proxy"), ("track-agent", "s-track")):
        row = await db.fetch_one("SELECT * FROM llm_cost_records WHERE agent_id = ?", (agent,))
        assert row["input_tokens"] == full - read  # Cost & Tokens "Input" column
        assert row["input_cached_tokens"] == read  # "Cache Read" column
        assert row["total_cost_usd"] == pytest.approx(expected, abs=1e-8)  # cost unchanged
        usage = await CostsRepository(db).get_run_usage(sid)
        assert usage["tokens"] == full + out  # cache counted once
    summaries = {a.agent_id: a for a in await CostsRepository(db).get_agent_summaries()}
    assert summaries["proxy-agent"].total_input_tokens == full - read
    live = await observability.live_sessions(db)
    by = {x["session_id"]: x for x in live["sessions"]}
    assert by["s-proxy"]["tokens"] == by["s-track"]["tokens"] == full + out


@pytest.mark.asyncio
async def test_generation_rows_store_uncached_input(db):
    from securevector.app.database.repositories.costs import CostsRepository
    repo = CostsRepository(db)
    expected = await _expected(db, "openai", "gpt-4o", 10_000, 50, 8_000)
    out = await repo.record_generation(trace_id="t1", span_id="g1", session_id="s-gen", runtime_kind="sdk",
                                       provider="openai", model_id="gpt-4o", input_tokens=10_000,
                                       output_tokens=50, input_cached_tokens=8_000)
    assert out["total_cost_usd"] == pytest.approx(expected, abs=1e-8)
    row = await db.fetch_one("SELECT input_tokens FROM llm_cost_records WHERE id = ?", (out["id"],))
    assert row["input_tokens"] == 2_000


V69_ROWS = [  # (id, agent, provider, model, input, read, write, runtime_kind, span_id) before v69
    ("hermes", "hermes", "anthropic", "claude-sonnet-5-5", 41_010, 40_000, 1_000, None, None),
    ("proxy_openai", "local-agent", "openai", "gpt-4o", 10_000, 8_000, 0, "llm-proxy", None),
    ("otlp_gemini", "sdk", "gemini", "gemini-2.5-pro", 20_000, 15_000, 0, "langchain", "span-1"),
    ("proxy_claude", "local-agent", "anthropic", "claude-sonnet-5-5", 100, 50_000, 2_000, "llm-proxy", None),
    ("openclaw_openai", "openclaw-agent", "openai", "gpt-4o", 9_000, 4_000, 0, "llm-proxy", None),
    ("openclaw_agent", "agent:main", "openai", "gpt-4o", 9_000, 4_000, 0, None, None),
    ("track_openai", "x", "openai", "gpt-4o", 9_000, 4_000, 0, None, None),
    ("opencode", "opencode", "openai", "gpt-4o", 10, 4_000, 0, None, None),
    ("unknown", "local-agent", "unknown", "m", 9_000, 4_000, 0, "llm-proxy", None),
    ("no_cache", "local-agent", "openai", "gpt-4o", 500, 0, 0, "llm-proxy", None),
]
V69_AFTER = {"hermes": 10, "proxy_openai": 2_000, "otlp_gemini": 5_000, "proxy_claude": 100,
             "openclaw_openai": 9_000, "openclaw_agent": 9_000, "track_openai": 9_000, "opencode": 10,
             "unknown": 9_000, "no_cache": 500}


async def _v69_seed(db):
    for rid, agent, prov, model, inp, read, write, kind, span in V69_ROWS:
        await db.execute(
            "INSERT INTO llm_cost_records (id, agent_id, provider, model_id, input_tokens, output_tokens, "
            "input_cached_tokens, input_cache_write_tokens, input_cost_usd, output_cost_usd, total_cost_usd, "
            "pricing_known, recorded_at, runtime_kind, span_id, trace_id) "
            "VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0.5, 0.25, 0.75, 1, '2026-10-01', ?, ?, ?)",
            (rid, agent, prov, model, inp, read, write, kind, span, "t-1" if span else None))
    await db.execute("DELETE FROM schema_version WHERE version = 69")


async def _v69_inputs(db):
    rows = await db.fetch_all("SELECT id, input_tokens, total_cost_usd FROM llm_cost_records")
    assert all(r["total_cost_usd"] == 0.75 for r in rows)  # costs never change
    return {r["id"]: r["input_tokens"] for r in rows}


@pytest.mark.asyncio
async def test_v69_strips_only_full_prompt_rows_once(db):
    from securevector.app.database.migrations import migrate_to_v69

    await _v69_seed(db)
    await migrate_to_v69(db)
    assert await _v69_inputs(db) == V69_AFTER
    await migrate_to_v69(db)  # a second run changes nothing
    assert await _v69_inputs(db) == V69_AFTER
    assert await db.fetch_one("SELECT 1 FROM schema_version WHERE version = 69")


@pytest.mark.asyncio
async def test_v69_strips_untagged_6_1_proxy_rows(db):
    from securevector.app.database.migrations import migrate_to_v69

    rows = [  # (id, agent, provider, model, input, read, session_id)
        ("proxy_61", "local-agent", "openai", "gpt-4o", 10_000, 8_000, "sess-1"),
        ("proxy_61_claude", "local-agent", "anthropic", "claude-sonnet-5-5", 100, 8_000, "sess-1"),
        ("openclaw_61", "openclaw-agent", "openai", "gpt-4o", 9_000, 4_000, "sess-2"),
        ("track_61", "x", "openai", "gpt-4o", 9_000, 4_000, None),
    ]
    for rid, agent, prov, model, inp, read, sid in rows:
        await db.execute(
            "INSERT INTO llm_cost_records (id, agent_id, provider, model_id, input_tokens, output_tokens, "
            "input_cached_tokens, input_cost_usd, output_cost_usd, total_cost_usd, pricing_known, "
            "recorded_at, session_id) VALUES (?, ?, ?, ?, ?, 1, ?, 0.5, 0.25, 0.75, 1, '2026-10-01', ?)",
            (rid, agent, prov, model, inp, read, sid))
    await db.execute("DELETE FROM schema_version WHERE version = 69")
    await migrate_to_v69(db)
    assert await _v69_inputs(db) == {"proxy_61": 2_000, "proxy_61_claude": 100,
                                     "openclaw_61": 9_000, "track_61": 9_000}


@pytest.mark.asyncio
async def test_v69_failure_mid_way_leaves_no_partial_strip(db, monkeypatch):
    from securevector.app.database import migrations
    from securevector.app.database.repositories import costs as costs_repo

    await _v69_seed(db)
    before = await _v69_inputs(db)

    def boom(*a, **k):
        raise RuntimeError("stop")

    monkeypatch.setattr(costs_repo, "input_includes_cached", boom)  # after the Hermes UPDATE ran
    with pytest.raises(RuntimeError):
        await migrations.migrate_to_v69(db)
    assert await _v69_inputs(db) == before
    assert await db.fetch_one("SELECT 1 FROM schema_version WHERE version = 69") is None
    monkeypatch.undo()
    await migrations.migrate_to_v69(db)
    assert await _v69_inputs(db) == V69_AFTER


def test_unknown_provider_input_is_stored_as_sent():
    from securevector.app.database.repositories.costs import stored_input
    assert stored_input(None, "m", 9_000, 4_000) == 9_000
    assert stored_input("unknown", "m", 9_000, 4_000) == 9_000
    assert stored_input("unknown", "m", 9_000, 4_000, includes_cached=True) == 5_000
    assert stored_input("openai", "gpt-4o", 9_000, 4_000) == 5_000


def test_openclaw_plugin_sends_cache_writes_in_both_copies():
    from pathlib import Path
    root = Path(__file__).resolve().parents[3] / "src" / "securevector"
    for p in (root / "plugins" / "openclaw" / "index.ts", root / "app" / "server" / "routes" / "hooks.py"):
        src = p.read_text(encoding="utf-8")
        assert "const cacheWriteTokens = usage.cacheWrite || 0;" in src, p
        assert "input_cache_write_tokens: cacheWriteTokens," in src, p
        assert "input_includes_cached: false," in src, p


@pytest.mark.asyncio
async def test_migration_adds_nullable_cache_columns(db):
    cols = {r["name"]: r for r in await db.fetch_all("PRAGMA table_info(llm_cost_records)")}
    assert cols["input_cache_write_tokens"]["notnull"] == 0
    pcols = {r["name"] for r in await db.fetch_all("PRAGMA table_info(model_pricing)")}
    assert {"cache_read_per_million", "cache_write_per_million"} <= pcols


# --- review fixes -----------------------------------------------------------

@pytest.mark.asyncio
async def test_ollama_local_models_stay_unpriced(db):
    repo = CostsRepository(db)
    assert await repo.resolve_rate_card("ollama", "command-r:35b") is None
    assert await repo.resolve_rate_card("ollama", "deepseek-v4-flash:latest") is None
    rec = CostRecorder(db)
    body = json.dumps({"model": "command-r:35b", "prompt_eval_count": 10, "eval_count": 5}).encode()
    await rec.record("ollama", "o1", body)
    row = await db.fetch_one("SELECT pricing_known, total_cost_usd FROM llm_cost_records WHERE agent_id = 'o1'")
    assert row["pricing_known"] == 0 and row["total_cost_usd"] == 0


@pytest.mark.asyncio
async def test_prefix_match_only_accepts_date_or_version_suffixes(db, monkeypatch):
    repo = CostsRepository(db)
    # Unknown newer models do not borrow an older price.
    assert await repo.resolve_rate_card("anthropic", "claude-opus-5-6") is None
    assert await repo.resolve_rate_card("openai", "gpt-5-codex") is None
    out = await _track(db, monkeypatch, provider="anthropic", model_id="claude-opus-5-6",
                       input_tokens=1, output_tokens=1)
    assert out["pricing_known"] is False
    # Real variants still resolve to the right key.
    assert (await repo.resolve_rates("anthropic", "claude-opus-5"))[0] == 5.0
    assert (await repo.resolve_rates("anthropic", "claude-opus-5-5"))[0] == 4.0
    assert (await repo.resolve_rates("anthropic", "claude-haiku-4-5-20251001"))[0] == 1.0
    assert (await repo.resolve_rates("anthropic", "claude-haiku-4-5"))[0] == 1.0
    gpt4o = await repo.get_pricing("openai", "gpt-4o")
    mini = await repo.get_pricing("openai", "gpt-4o-mini")
    assert gpt4o.input_per_million != mini.input_per_million
    assert (await repo.resolve_rates("openai", "gpt-4o-mini"))[0] == mini.input_per_million
    assert (await repo.resolve_rates("openai", "gpt-4o-2024-08-06"))[0] == gpt4o.input_per_million


@pytest.mark.asyncio
async def test_duplicate_request_id_is_recorded_once(db, monkeypatch):
    body = dict(agent_id="opencode", provider="anthropic", model_id="claude-sonnet-5-5",
                input_tokens=10, output_tokens=20, request_id="msg_1")
    first = await _track(db, monkeypatch, **body)
    again = await _track(db, monkeypatch, **body)
    assert again["id"] == first["id"]
    n = await db.fetch_one("SELECT COUNT(*) AS n FROM llm_cost_records WHERE request_id = 'msg_1'")
    assert n["n"] == 1
    # Without a request_id every send is a record; another agent is its own.
    nodup = {k: v for k, v in body.items() if k != "request_id"}
    await _track(db, monkeypatch, **nodup)
    await _track(db, monkeypatch, **nodup)
    await _track(db, monkeypatch, **{**body, "agent_id": "other"})
    n = await db.fetch_one("SELECT COUNT(*) AS n FROM llm_cost_records")
    assert n["n"] == 4


@pytest.mark.asyncio
async def test_concurrent_sends_of_one_request_store_one_row(db):
    import asyncio

    repo = CostsRepository(db)
    real_fetch_one = db.fetch_one
    gate = asyncio.Barrier(2)
    calls = {"n": 0}

    async def fetch_one(sql, params=()):
        row = await real_fetch_one(sql, params)
        calls["n"] += 1
        if calls["n"] <= 2:  # both sends pass the existing-record check first
            await gate.wait()
        return row

    db.fetch_one = fetch_one
    args = dict(agent_id="opencode", provider="anthropic", model_id="claude-sonnet-5-5",
                input_tokens=10, output_tokens=20, input_cost_usd=0.1, output_cost_usd=0.2,
                total_cost_usd=0.3, request_id="msg_race")
    a, b = await asyncio.gather(repo.record_cost(**args), repo.record_cost(**args))
    db.fetch_one = real_fetch_one
    assert a.id == b.id
    n = await db.fetch_one("SELECT COUNT(*) AS n FROM llm_cost_records WHERE request_id = 'msg_race'")
    assert n["n"] == 1


async def _v70_seed(db):
    await db.execute("DROP INDEX IF EXISTS uq_llm_cost_records_agent_request")
    await db.execute("DELETE FROM schema_version WHERE version = 70")
    rows = [  # (id, agent, request_id, recorded_at)
        ("late", "a", "r1", "2026-10-03"),
        ("first", "a", "r1", "2026-10-01"),
        ("mid", "a", "r1", "2026-10-02"),
        ("other_agent", "b", "r1", "2026-10-02"),
        ("single", "a", "r2", "2026-10-02"),
        ("null_1", "a", None, "2026-10-01"),
        ("null_2", "a", None, "2026-10-01"),
    ]
    for rid, agent, req, at in rows:
        await db.execute(
            "INSERT INTO llm_cost_records (id, agent_id, provider, model_id, request_id, "
            "input_tokens, output_tokens, input_cost_usd, output_cost_usd, total_cost_usd, "
            "pricing_known, recorded_at) VALUES (?, ?, 'openai', 'gpt-4o', ?, 1, 1, 0, 0, 0, 1, ?)",
            (rid, agent, req, at))


async def _cost_ids(db):
    return {r["id"] for r in await db.fetch_all("SELECT id FROM llm_cost_records")}


@pytest.mark.asyncio
async def test_v70_removes_duplicates_keeping_the_earliest(db):
    import sqlite3

    from securevector.app.database.migrations import migrate_to_v70

    await _v70_seed(db)
    await migrate_to_v70(db)
    after = {"first", "other_agent", "single", "null_1", "null_2"}
    assert await _cost_ids(db) == after
    assert await db.fetch_one("SELECT 1 FROM schema_version WHERE version = 70")
    with pytest.raises(sqlite3.IntegrityError):
        await db.execute(
            "INSERT INTO llm_cost_records (id, agent_id, provider, model_id, request_id, recorded_at) "
            "VALUES ('dup', 'a', 'openai', 'gpt-4o', 'r1', '2026-10-04')")
    # Rows without a request_id stay free to repeat.
    await db.execute(
        "INSERT INTO llm_cost_records (id, agent_id, provider, model_id, recorded_at) "
        "VALUES ('null_3', 'a', 'openai', 'gpt-4o', '2026-10-04')")
    await migrate_to_v70(db)  # a second run changes nothing
    assert await _cost_ids(db) == after | {"null_3"}


@pytest.mark.parametrize("field", ["input_tokens", "output_tokens", "input_cached_tokens",
                                   "input_cache_write_tokens"])
@pytest.mark.parametrize("bad", [2**63, 10**12 + 1, -1, True, "5", 1.5])
def test_track_token_fields_are_bounded_strict_ints(field, bad):
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        costs_routes.RecordCostRequest(provider="anthropic", model_id="m", **{field: bad})
    ok = costs_routes.RecordCostRequest(provider="anthropic", model_id="m", **{field: 10**12})
    assert getattr(ok, field) == 10**12


@pytest.mark.asyncio
async def test_sync_drops_a_cache_rate_the_yaml_no_longer_has(db):
    repo = CostsRepository(db)
    await repo.upsert_pricing(provider="anthropic", model_id="claude-x", display_name="x",
                              input_per_million=1.0, output_per_million=2.0,
                              cache_read_per_million=0.05, cache_write_per_million=1.5)
    await repo.upsert_pricing(provider="anthropic", model_id="claude-x", display_name="x",
                              input_per_million=1.0, output_per_million=2.0)
    p = await repo.get_pricing("anthropic", "claude-x")
    assert p.cache_read_per_million is None and p.cache_write_per_million is None


def test_harness_coverage_reports_opencode_token_data():
    from securevector.app.services import harness_coverage
    assert harness_coverage.COVERAGE["opencode"]["token_data"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("model_id,key", [("gemini-2.0-flash-001", "gemini-2.0-flash"),
                                          ("gemini-1.5-pro-002", "gemini-1.5-pro")])
async def test_google_three_digit_versions_price_on_the_track_path(db, monkeypatch, model_id, key):
    # Not in the bundled file (no longer priced officially), so seeded here.
    await CostsRepository(db).upsert_pricing(provider="gemini", model_id=key, display_name=key,
                                             input_per_million=1.0, output_per_million=4.0)
    out = await _track(db, monkeypatch, provider="gemini", model_id=model_id,
                       input_tokens=1_000_000, output_tokens=1_000_000)
    assert out["pricing_known"] is True
    assert out["total_cost_usd"] == pytest.approx(5.0)


@pytest.mark.asyncio
async def test_google_three_digit_version_prices_on_proxy_and_stored_traces(db):
    repo = CostsRepository(db)
    await CostRecorder(db).record("gemini", "g1", json.dumps({
        "modelVersion": "gemini-2.5-flash-001",
        "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5}}).encode())
    row = await db.fetch_one("SELECT pricing_known FROM llm_cost_records WHERE agent_id = 'g1'")
    assert row["pricing_known"] == 1
    out = await repo.record_generation(trace_id="t", span_id="s", session_id="x", runtime_kind="sdk",
                                       provider="gemini", model_id="gemini-2.5-pro-002",
                                       input_tokens=10, output_tokens=5)
    assert out["pricing_known"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("model_id", ["claude-opus-5-6", "claude-sonnet-5-6", "claude-haiku-4-5-5",
                                      "gpt-5-codex", "gpt-5-6"])
async def test_short_number_or_word_after_a_key_stays_unpriced(db, monkeypatch, model_id):
    provider = "openai" if model_id.startswith("gpt") else "anthropic"
    out = await _track(db, monkeypatch, provider=provider, model_id=model_id,
                       input_tokens=1, output_tokens=1)
    assert out["pricing_known"] is False


# --- stored rates carry the regional-endpoint premium -----------------------

@pytest.mark.asyncio
async def test_stored_rates_on_a_regional_bedrock_row_are_effective_rates(db, monkeypatch):
    out = await _track(db, monkeypatch, agent_id="rate-check", provider="amazon-bedrock",
                       model_id="us.anthropic.claude-haiku-4-5-20251001-v1:0",
                       input_tokens=1_000_000, output_tokens=1_000_000)
    row = await db.fetch_one("SELECT rate_input, rate_output, total_cost_usd FROM llm_cost_records "
                             "WHERE id = ?", (out["id"],))
    assert row["rate_input"] == pytest.approx(1.1)
    assert row["rate_output"] == pytest.approx(5.5)
    # tokens x stored rate == stored cost
    assert row["total_cost_usd"] == pytest.approx(row["rate_input"] + row["rate_output"])


def test_optimizer_rates_include_the_regional_premium():
    from securevector.app.services.cost_optimizer import _rates_for
    pricing = {"claude-haiku-4-5": ("anthropic", 1.0, 5.0)}
    us = _rates_for("us.anthropic.claude-haiku-4-5-20251001-v1:0", pricing)
    assert (us["in_rate"], us["out_rate"]) == (pytest.approx(1.1), pytest.approx(5.5))
    glob = _rates_for("global.anthropic.claude-haiku-4-5-20251001-v1:0", pricing)
    assert (glob["in_rate"], glob["out_rate"]) == (1.0, 5.0)
    assert _rates_for("claude-haiku-4-5", pricing)["in_rate"] == 1.0


@pytest.mark.asyncio
async def test_policy_check_estimate_matches_the_stored_cost(db, monkeypatch):
    from securevector.app.services import policy_check

    usage = {"turns": 3, "input": 1_200, "output": 4_000, "cache_read": 250_000, "cache_create": 9_000}
    total, by_model = await policy_check._estimate_cost(db, {"claude-fable-5-1": usage})
    out = await _track(db, monkeypatch, agent_id="pc", provider="anthropic", model_id="claude-fable-5-1",
                       input_tokens=1_200, output_tokens=4_000, input_cached_tokens=250_000,
                       input_cache_write_tokens=9_000)
    row = await db.fetch_one("SELECT total_cost_usd FROM llm_cost_records WHERE id = ?", (out["id"],))
    assert total == pytest.approx(row["total_cost_usd"], rel=1e-6)
    # Fable 5.1 reads cost $0.25/M, not a tenth of the input rate.
    assert total == pytest.approx((1_200 * 10 + 4_000 * 50 + 250_000 * 0.25 + 9_000 * 12.5) / 1e6)
    assert by_model[0]["cost_usd"] == pytest.approx(total)


def test_optimizer_cache_rates_include_the_regional_premium():
    from securevector.app.services.cost_optimizer import _rates_for, analyze_session

    pricing = {"claude-haiku-4-5": ("anthropic", 1.0, 5.0, 0.1, 1.25)}
    model = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
    r = _rates_for(model, pricing)
    assert r["in_rate"] * r["read_discount"] == pytest.approx(0.11)
    assert r["in_rate"] * r["write_premium"] == pytest.approx(1.375)
    gen = {"model": model, "input_tokens": 1_000, "cache_read_tokens": 100_000,
           "cache_creation_tokens": 2_000, "output_tokens": 500, "called_at": None,
           "tools_called": [], "tool_results": []}
    card = RateCard(input=1.0, output=5.0, cache_read=0.1, cache_write=1.25)
    in_cost, out_cost = compute_cost("anthropic", model, card, 1_000, 500, 100_000, 2_000)
    assert analyze_session([gen], pricing)["observed"]["est_cost_usd"] == pytest.approx(in_cost + out_cost)


@pytest.mark.parametrize("field, value", [
    ("agent_id", "a" * 201), ("provider", "p" * 201), ("model_id", "m" * 201),
    ("runtime_kind", "Hermes"), ("runtime_kind", "x" * 41), ("runtime_kind", "a b"), ("runtime_kind", ""),
])
def test_track_request_bounds_its_text_fields(field, value):
    from pydantic import ValidationError

    body = {"provider": "openai", "model_id": "gpt-4o", field: value}
    with pytest.raises(ValidationError):
        costs_routes.RecordCostRequest(**body)


def test_track_request_accepts_a_harness_name():
    req = costs_routes.RecordCostRequest(provider="p" * 200, model_id="gpt-4o", runtime_kind="claude-code_2")
    assert req.runtime_kind == "claude-code_2" and costs_routes.RecordCostRequest(
        provider="openai", model_id="gpt-4o").runtime_kind is None
