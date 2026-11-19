"""Bedrock / Vertex regional-endpoint premium on Claude 4.5 and later."""

from __future__ import annotations

import pytest

from securevector.app.database.repositories.costs import (
    RateCard,
    claude_version,
    compute_cost,
    lookup_rate_card,
    regional_premium,
)

_TABLE = {
    ("anthropic", "claude-haiku-4-5"): RateCard(1.0, 5.0, 0.1, 1.25),
    ("anthropic", "claude-3-5-sonnet"): RateCard(3.0, 15.0, 0.3, 3.75),
    ("anthropic", "claude-sonnet-4"): RateCard(3.0, 15.0, 0.3, 3.75),
}


def _total(provider, model_id, **kw):
    card = lookup_rate_card(provider, model_id, _TABLE)
    assert card is not None, model_id
    i, o = compute_cost(provider, model_id, card, 1_000_000, 1_000_000, **kw)
    return round(i + o, 6)


def test_bedrock_us_prefix_carries_the_premium():
    assert _total("bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0") == 6.60


def test_bedrock_global_prefix_has_no_premium():
    assert _total("bedrock", "global.anthropic.claude-haiku-4-5-20251001-v1:0") == 6.00


def test_first_party_is_global():
    assert _total("anthropic", "claude-haiku-4-5") == 6.00


def test_bedrock_claude_3_5_has_no_premium():
    assert _total("bedrock", "us.anthropic.claude-3-5-sonnet-20241022-v2:0") == 18.00


@pytest.mark.parametrize("mid", [
    "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
    "apac.anthropic.claude-haiku-4-5-20251001-v1:0",
    "jp.anthropic.claude-haiku-4-5-20251001-v1:0",
    "au.anthropic.claude-haiku-4-5-20251001-v1:0",
    "anthropic.claude-haiku-4-5-20251001-v1:0",
])
def test_bedrock_regional_and_in_region_ids(mid):
    assert regional_premium("bedrock", mid) == 1.1


def test_premium_covers_cache_rates():
    card = lookup_rate_card("bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0", _TABLE)
    i, _ = compute_cost("bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0", card,
                        0, 0, cache_read_tokens=1_000_000, cache_write_tokens=1_000_000)
    assert round(i, 6) == round(1.1 * (0.1 + 1.25), 6)


def test_older_claude_4_and_non_claude_models_have_no_premium():
    assert regional_premium("bedrock", "us.anthropic.claude-sonnet-4-20250514-v1:0") == 1.0
    assert regional_premium("bedrock", "us.anthropic.claude-opus-4-1-20250805-v1:0") == 1.0
    assert regional_premium("bedrock", "us.meta.llama3-1-70b-instruct-v1:0") == 1.0
    assert regional_premium("bedrock", "us.amazon.nova-pro-v1:0") == 1.0


def test_vertex_needs_the_endpoint_on_the_record():
    assert regional_premium("vertex", "claude-haiku-4-5@20251001") == 1.0
    assert regional_premium("vertex", "claude-haiku-4-5@20251001", endpoint="us-east5") == 1.1
    assert regional_premium("vertex", "claude-haiku-4-5@20251001", endpoint="global") == 1.0


def test_claude_version_parsing():
    assert claude_version("claude-haiku-4-5-20251001") == (4, 5)
    assert claude_version("claude-sonnet-4-20250514") == (4, 0)
    assert claude_version("claude-3-5-sonnet-20241022") == (3, 5)
    assert claude_version("claude-opus-5-5") == (5, 5)
    assert claude_version("claude-fable-5-1") == (5, 1)
    assert claude_version("gpt-4o") is None
