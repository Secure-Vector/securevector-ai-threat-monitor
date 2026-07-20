"""Model-pricing coverage for the current models agents actually run in 2026.

Persona reviews flagged "model not in price table" for claude-fable-5 /
claude-opus-4-8. This guards that the seed loads them and that cost computes.
"""

from __future__ import annotations

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.costs import CostsRepository
from securevector.app.server.routes.transcript_generations import apply_cost

# The models that must resolve to a price (Claude 5 family + Opus 4.8 + Codex).
REQUIRED_MODELS = [
    "claude-fable-5", "claude-mythos-5", "claude-sonnet-5", "claude-opus-4-8",
]


async def _repo(tmp_path) -> CostsRepository:
    db = DatabaseConnection(tmp_path / "pricing.db")
    await run_migrations(db)   # seeds model_pricing from the yml
    return CostsRepository(db)


@pytest.mark.asyncio
async def test_current_models_are_priced(tmp_path):
    repo = await _repo(tmp_path)
    priced = {p.model_id for p in await repo.list_pricing()}
    for m in REQUIRED_MODELS:
        assert m in priced, f"{m} missing from model_pricing seed"


@pytest.mark.asyncio
async def test_pricing_has_nonzero_rates(tmp_path):
    repo = await _repo(tmp_path)
    by_id = {p.model_id: p for p in await repo.list_pricing()}
    for m in REQUIRED_MODELS:
        p = by_id[m]
        assert p.input_per_million > 0 and p.output_per_million > 0


@pytest.mark.asyncio
async def test_generation_cost_computes_for_current_model(tmp_path):
    """The end-to-end path a persona hit: a fable-5 generation → real dollars."""
    repo = await _repo(tmp_path)
    price_map = {
        p.model_id: (p.input_per_million, p.output_per_million)
        for p in await repo.list_pricing()
    }
    gen = {"model": "claude-fable-5", "input_tokens": 1_000_000,
           "output_tokens": 1_000_000, "cost": None}
    apply_cost([gen], price_map)
    assert gen["cost"] is not None and gen["cost"] > 0
    # input_per_million + output_per_million for 1M each.
    expected = price_map["claude-fable-5"][0] + price_map["claude-fable-5"][1]
    assert gen["cost"] == pytest.approx(expected)
