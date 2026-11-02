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
    assert out["total_cost_usd"] == pytest.approx(BOX_USD, abs=1e-6)
    assert 0.50 < out["total_cost_usd"] < 0.51  # was $3.40 at 1.0x cache rate


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
@pytest.mark.parametrize("form,provider", [
    ("{m}", "anthropic"),
    ("anthropic.{m}", "amazon-bedrock"),
    ("us.anthropic.{m}-v1:0", "bedrock"),
    ("eu.anthropic.{m}-20261001-v1:0", "amazon-bedrock"),
    ("global.anthropic.{m}-v1:0", "amazon-bedrock"),
    ("{m}@20261001", "vertex"),
])
async def test_new_models_price_in_every_id_form(db, model, form, provider):
    inp, write, read, outp = NEW[model]
    card = await CostsRepository(db).resolve_rate_card(provider, form.format(m=model))
    assert card is not None
    assert (card.input, card.cache_write, card.cache_read, card.output) == (inp, write, read, outp)
    ic, oc = compute_cost(provider, form.format(m=model), card, 1_000_000, 1_000_000, 1_000_000, 1_000_000)
    assert ic + oc == pytest.approx(inp + write + read + outp)


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


@pytest.mark.asyncio
async def test_proxy_recorder_reads_bedrock_converse_usage(db):
    rec = CostRecorder(db)
    body = json.dumps({"modelId": "us.anthropic.claude-haiku-4-5-20251001-v1:0", "usage": {
        "inputTokens": 956, "outputTokens": 36_155,
        "cacheReadInputTokens": 3_221_219, "cacheWriteInputTokens": 0}}).encode()
    await rec.record("amazon-bedrock", "b1", body)
    row = await db.fetch_one("SELECT * FROM llm_cost_records WHERE agent_id = 'b1'")
    assert row["pricing_known"] == 1
    assert row["total_cost_usd"] == pytest.approx(BOX_USD, abs=1e-6)


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
