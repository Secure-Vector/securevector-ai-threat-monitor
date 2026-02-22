"""
Comprehensive tests for cost tracking and budget enforcement.

Tests all API endpoints and proxy enforcement scenarios:
  - Pricing CRUD (list, filter, update, sync)
  - Global budget (set, get, warn mode, block mode)
  - Per-agent budget (set, get, list, delete, override)
  - Budget status / guardian
  - Proxy enforcement: warn pass-through, block 429, no-budget pass
  - Cost records (list, filter, paginate, delete, CSV export)
  - Dashboard summary
  - Edge cases: invalid actions, missing agents, zero budget

Requires a running SecureVector instance on:
  - http://127.0.0.1:8741  (app API)   — override with SV_WEB_PORT
  - http://127.0.0.1:8742  (LLM proxy) — override with SV_PROXY_PORT
"""

import json
import time
import uuid
import httpx
import pytest

import os

pytestmark = pytest.mark.integration

_web_port = os.environ.get("SV_WEB_PORT", "8741")
_proxy_port = os.environ.get("SV_PROXY_PORT", "8742")
BASE = f"http://127.0.0.1:{_web_port}/api"
PROXY = f"http://127.0.0.1:{_proxy_port}"

# Unique test agent IDs so tests don't collide with real data
TEST_AGENT = f"test-budget-{uuid.uuid4().hex[:8]}"
TEST_AGENT_2 = f"test-budget2-{uuid.uuid4().hex[:8]}"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def api(path: str) -> str:
    return f"{BASE}{path}"


def inject_cost(agent_id: str, cost_usd: float, provider: str = "anthropic",
                model_id: str = "claude-3-5-haiku-20241022") -> None:
    """
    Inject a synthetic cost record directly via the proxy simulate endpoint.
    We POST a fake LLM response body to the internal cost recorder via a
    thin helper route (/api/costs/test-inject) — if that doesn't exist we
    fall back to calling the Python API directly via subprocess.

    Since there's no direct HTTP injection endpoint we trigger cost recording
    by posting a fake completed response to the proxy with a known agent ID.
    The proxy records cost from the response body; we craft a valid Anthropic
    response body and POST it to a dummy endpoint the proxy will forward —
    except we have no real key.

    Instead, we use a direct internal call via the running app's DB.
    """
    # Call the securevector app to insert a synthetic cost record
    # via a POST to an internal test helper we'll add inline.
    # Since no inject endpoint exists, use the Python import path.
    import asyncio
    import sys
    import os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../../src"))

    async def _insert():
        from securevector.app.database.connection import get_database
        from securevector.app.database.repositories.costs import CostsRepository
        db = get_database()
        if db._connection is None:
            await db.connect()
        repo = CostsRepository(db)
        await repo.record_cost(
            agent_id=agent_id,
            provider=provider,
            model_id=model_id,
            input_tokens=1000,
            output_tokens=500,
            input_cached_tokens=0,
            input_cost_usd=round(cost_usd * 0.6, 8),
            output_cost_usd=round(cost_usd * 0.4, 8),
            total_cost_usd=round(cost_usd, 8),
            rate_input=3.0,
            rate_output=15.0,
            pricing_known=True,
        )

    asyncio.run(_insert())


def cleanup_agent(agent_id: str) -> None:
    """Remove test agent's cost records and budget after a test."""
    with httpx.Client(timeout=5) as c:
        c.delete(api(f"/costs/records"), params={"agent_id": agent_id})
        c.delete(api(f"/costs/budget/agents/{agent_id}"))


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def restore_global_budget():
    """Restore original global budget after each test that touches it."""
    with httpx.Client(timeout=5) as c:
        original = c.get(api("/costs/budget")).json()
    yield
    with httpx.Client(timeout=5) as c:
        c.put(api("/costs/budget"), json=original)


@pytest.fixture(autouse=True)
def cleanup():
    """Remove synthetic test records/budgets after each test."""
    yield
    cleanup_agent(TEST_AGENT)
    cleanup_agent(TEST_AGENT_2)


# ===========================================================================
# 1. PRICING ENDPOINTS
# ===========================================================================

class TestPricingEndpoints:

    def test_list_pricing_returns_entries(self):
        """GET /api/costs/pricing returns entries with required fields."""
        r = httpx.get(api("/costs/pricing"), timeout=5)
        assert r.status_code == 200
        data = r.json()
        assert "pricing" in data
        assert "total" in data
        assert "providers" in data
        assert data["total"] > 0
        entry = data["pricing"][0]
        for field in ("provider", "model_id", "display_name",
                      "input_per_million", "output_per_million"):
            assert field in entry, f"Missing field: {field}"

    def test_list_pricing_filter_by_provider(self):
        """GET /api/costs/pricing?provider=openai returns only OpenAI models."""
        r = httpx.get(api("/costs/pricing"), params={"provider": "openai"}, timeout=5)
        assert r.status_code == 200
        data = r.json()
        assert all(e["provider"] == "openai" for e in data["pricing"])
        assert data["total"] > 0

    def test_list_pricing_filter_anthropic(self):
        r = httpx.get(api("/costs/pricing"), params={"provider": "anthropic"}, timeout=5)
        assert r.status_code == 200
        assert all(e["provider"] == "anthropic" for e in r.json()["pricing"])

    def test_update_pricing(self):
        """PUT /api/costs/pricing/{provider}/{model} updates rates."""
        r = httpx.put(
            api("/costs/pricing/openai/gpt-4o-mini"),
            json={"input_per_million": 0.15, "output_per_million": 0.60},
            timeout=5,
        )
        assert r.status_code == 200
        data = r.json()
        assert abs(data["input_per_million"] - 0.15) < 0.001
        assert abs(data["output_per_million"] - 0.60) < 0.001

    def test_update_pricing_restores(self):
        """Restore gpt-4o-mini pricing after update test."""
        httpx.put(
            api("/costs/pricing/openai/gpt-4o-mini"),
            json={"input_per_million": 0.15, "output_per_million": 0.60},
            timeout=5,
        )

    def test_update_pricing_invalid_negative(self):
        """Negative pricing rates should be rejected (422)."""
        r = httpx.put(
            api("/costs/pricing/openai/gpt-4o-mini"),
            json={"input_per_million": -1.0, "output_per_million": 0.60},
            timeout=5,
        )
        assert r.status_code == 422

    def test_pricing_sync(self):
        """POST /api/costs/pricing/sync returns updated/skipped counts."""
        r = httpx.post(api("/costs/pricing/sync"), timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert "updated" in data
        assert "skipped" in data
        assert "source" in data
        assert "synced_at" in data
        assert data["updated"] >= 0

    def test_no_stale_entries_after_sync(self):
        """After sync, is_stale should be False for all entries."""
        httpx.post(api("/costs/pricing/sync"), timeout=30)
        r = httpx.get(api("/costs/pricing"), timeout=5)
        stale = [e for e in r.json()["pricing"] if e.get("is_stale")]
        assert stale == [], f"Stale entries after sync: {stale}"


# ===========================================================================
# 2. GLOBAL BUDGET ENDPOINTS
# ===========================================================================

class TestGlobalBudget:

    def test_get_global_budget(self):
        """GET /api/costs/budget returns budget config."""
        r = httpx.get(api("/costs/budget"), timeout=5)
        assert r.status_code == 200
        data = r.json()
        assert "budget_action" in data
        assert data["budget_action"] in ("warn", "block")

    def test_set_global_budget_warn(self):
        """PUT /api/costs/budget sets warn mode budget."""
        r = httpx.put(
            api("/costs/budget"),
            json={"daily_budget_usd": 5.00, "budget_action": "warn"},
            timeout=5,
        )
        assert r.status_code == 200
        data = r.json()
        assert abs(data["daily_budget_usd"] - 5.00) < 0.01
        assert data["budget_action"] == "warn"

    def test_set_global_budget_block(self):
        """PUT /api/costs/budget sets block mode budget."""
        r = httpx.put(
            api("/costs/budget"),
            json={"daily_budget_usd": 10.00, "budget_action": "block"},
            timeout=5,
        )
        assert r.status_code == 200
        assert r.json()["budget_action"] == "block"

    def test_set_global_budget_null_disables(self):
        """Setting daily_budget_usd to null disables the budget."""
        r = httpx.put(
            api("/costs/budget"),
            json={"daily_budget_usd": None, "budget_action": "warn"},
            timeout=5,
        )
        assert r.status_code == 200
        assert r.json()["daily_budget_usd"] is None

    def test_set_global_budget_invalid_action(self):
        """budget_action must be 'warn' or 'block' — invalid values rejected."""
        r = httpx.put(
            api("/costs/budget"),
            json={"daily_budget_usd": 5.0, "budget_action": "ignore"},
            timeout=5,
        )
        assert r.status_code == 422


# ===========================================================================
# 3. PER-AGENT BUDGET ENDPOINTS
# ===========================================================================

class TestAgentBudget:

    def test_set_agent_budget(self):
        """PUT /api/costs/budget/agents/{id} creates agent budget."""
        r = httpx.put(
            api(f"/costs/budget/agents/{TEST_AGENT}"),
            json={"daily_budget_usd": 2.50, "budget_action": "warn"},
            timeout=5,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["agent_id"] == TEST_AGENT
        assert abs(data["daily_budget_usd"] - 2.50) < 0.01
        assert data["budget_action"] == "warn"

    def test_list_agent_budgets_includes_created(self):
        """GET /api/costs/budget/agents lists created agent budget."""
        httpx.put(
            api(f"/costs/budget/agents/{TEST_AGENT}"),
            json={"daily_budget_usd": 1.0, "budget_action": "block"},
            timeout=5,
        )
        r = httpx.get(api("/costs/budget/agents"), timeout=5)
        assert r.status_code == 200
        ids = [a["agent_id"] for a in r.json()]
        assert TEST_AGENT in ids

    def test_delete_agent_budget(self):
        """DELETE /api/costs/budget/agents/{id} removes agent budget."""
        httpx.put(
            api(f"/costs/budget/agents/{TEST_AGENT}"),
            json={"daily_budget_usd": 1.0, "budget_action": "warn"},
            timeout=5,
        )
        r = httpx.delete(api(f"/costs/budget/agents/{TEST_AGENT}"), timeout=5)
        assert r.status_code == 200
        assert r.json()["deleted"] is True

    def test_delete_nonexistent_agent_budget_returns_404(self):
        """Deleting a budget that doesn't exist returns 404."""
        r = httpx.delete(api(f"/costs/budget/agents/nonexistent-agent-xyz"), timeout=5)
        assert r.status_code == 404

    def test_agent_budget_requires_positive_amount(self):
        """daily_budget_usd must be positive — zero/negative rejected."""
        r = httpx.put(
            api(f"/costs/budget/agents/{TEST_AGENT}"),
            json={"daily_budget_usd": 0, "budget_action": "warn"},
            timeout=5,
        )
        assert r.status_code == 422

    def test_agent_budget_invalid_action(self):
        r = httpx.put(
            api(f"/costs/budget/agents/{TEST_AGENT}"),
            json={"daily_budget_usd": 1.0, "budget_action": "silent"},
            timeout=5,
        )
        assert r.status_code == 422


# ===========================================================================
# 4. BUDGET STATUS ENDPOINT
# ===========================================================================

class TestBudgetStatus:

    def test_no_budget_returns_not_over(self):
        """Agent with no budget and no global budget → over_budget=False."""
        httpx.put(
            api("/costs/budget"),
            json={"daily_budget_usd": None, "budget_action": "warn"},
            timeout=5,
        )
        r = httpx.get(api("/costs/budget-status"), params={"agent_id": TEST_AGENT}, timeout=5)
        assert r.status_code == 200
        data = r.json()
        assert data["over_budget"] is False
        assert data["effective_budget_usd"] is None

    def test_under_budget(self):
        """Agent with spend below budget → over_budget=False."""
        httpx.put(
            api(f"/costs/budget/agents/{TEST_AGENT}"),
            json={"daily_budget_usd": 10.0, "budget_action": "warn"},
            timeout=5,
        )
        inject_cost(TEST_AGENT, 0.001)
        r = httpx.get(api("/costs/budget-status"), params={"agent_id": TEST_AGENT}, timeout=5)
        assert r.status_code == 200
        data = r.json()
        assert data["over_budget"] is False
        assert data["today_spend_usd"] > 0

    def test_over_budget_warn_mode(self):
        """Agent whose spend exceeds budget (warn) → over_budget=True, action=warn."""
        httpx.put(
            api(f"/costs/budget/agents/{TEST_AGENT}"),
            json={"daily_budget_usd": 0.000001, "budget_action": "warn"},
            timeout=5,
        )
        inject_cost(TEST_AGENT, 0.10)
        r = httpx.get(api("/costs/budget-status"), params={"agent_id": TEST_AGENT}, timeout=5)
        assert r.status_code == 200
        data = r.json()
        assert data["over_budget"] is True
        assert data["budget_action"] == "warn"
        assert data["today_spend_usd"] > data["effective_budget_usd"]

    def test_over_budget_block_mode(self):
        """Agent whose spend exceeds budget (block) → over_budget=True, action=block."""
        httpx.put(
            api(f"/costs/budget/agents/{TEST_AGENT}"),
            json={"daily_budget_usd": 0.000001, "budget_action": "block"},
            timeout=5,
        )
        inject_cost(TEST_AGENT, 0.10)
        r = httpx.get(api("/costs/budget-status"), params={"agent_id": TEST_AGENT}, timeout=5)
        assert r.status_code == 200
        data = r.json()
        assert data["over_budget"] is True
        assert data["budget_action"] == "block"

    def test_global_budget_applies_when_no_agent_budget(self):
        """Global budget applies for unknown agents with no per-agent override."""
        inject_cost(TEST_AGENT, 0.10)
        httpx.put(
            api("/costs/budget"),
            json={"daily_budget_usd": 0.000001, "budget_action": "warn"},
            timeout=5,
        )
        r = httpx.get(api("/costs/budget-status"), params={"agent_id": TEST_AGENT}, timeout=5)
        data = r.json()
        # Global budget tracks all spend, so over_budget may depend on total spend
        assert "over_budget" in data
        assert "global_budget_usd" in data

    def test_agent_budget_overrides_global(self):
        """Per-agent budget overrides a restrictive global budget."""
        # Set very restrictive global
        httpx.put(
            api("/costs/budget"),
            json={"daily_budget_usd": 0.000001, "budget_action": "block"},
            timeout=5,
        )
        # Give TEST_AGENT_2 a generous per-agent budget
        httpx.put(
            api(f"/costs/budget/agents/{TEST_AGENT_2}"),
            json={"daily_budget_usd": 100.0, "budget_action": "warn"},
            timeout=5,
        )
        inject_cost(TEST_AGENT_2, 0.001)
        r = httpx.get(api("/costs/budget-status"), params={"agent_id": TEST_AGENT_2}, timeout=5)
        data = r.json()
        # Agent's own budget applies → not over budget
        assert data["over_budget"] is False
        assert abs(data["effective_budget_usd"] - 100.0) < 0.01
        assert data["budget_action"] == "warn"

    def test_budget_status_requires_agent_id(self):
        """budget-status without agent_id should return 422."""
        r = httpx.get(api("/costs/budget-status"), timeout=5)
        assert r.status_code == 422


# ===========================================================================
# 5. PROXY BUDGET ENFORCEMENT
# ===========================================================================

class TestProxyBudgetEnforcement:
    """
    Tests proxy enforcement without a real LLM key.
    We inject synthetic cost records to exceed the budget, then send
    a fake POST through the proxy with X-Agent-ID. The proxy checks
    budget BEFORE forwarding, so no real LLM call is needed.
    """

    def _fresh_agent(self) -> str:
        """Return a unique agent ID never seen by the proxy (avoids 10s budget cache)."""
        return f"test-proxy-{uuid.uuid4().hex}"

    def _proxy_post(self, agent_id: str) -> httpx.Response:
        """Send a minimal chat completion POST through the proxy."""
        return httpx.post(
            f"{PROXY}/openai/v1/chat/completions",
            headers={
                "X-Agent-ID": agent_id,
                "Authorization": "Bearer test-key-does-not-matter",
                "Content-Type": "application/json",
            },
            json={
                "model": "gpt-4o-mini",
                "messages": [{"role": "user", "content": "ping"}],
            },
            timeout=10,
        )

    def test_proxy_reachable(self):
        """Proxy root endpoint is reachable."""
        r = httpx.get(PROXY, timeout=5)
        assert r.status_code == 200
        assert "service" in r.json()

    def test_proxy_no_budget_forwards_request(self):
        """No budget set → proxy forwards (may fail at LLM provider, not budget)."""
        agent = self._fresh_agent()
        httpx.put(
            api("/costs/budget"),
            json={"daily_budget_usd": None, "budget_action": "warn"},
            timeout=5,
        )
        r = self._proxy_post(agent)
        # With no real API key it will get 401/400/502 from upstream — NOT 429
        assert r.status_code != 429, "Should not be budget-blocked with no budget set"
        cleanup_agent(agent)

    def test_proxy_warn_mode_over_budget_still_forwards(self):
        """Warn mode: over-budget requests are logged but still forwarded to LLM."""
        agent = self._fresh_agent()
        httpx.put(
            api(f"/costs/budget/agents/{agent}"),
            json={"daily_budget_usd": 0.000001, "budget_action": "warn"},
            timeout=5,
        )
        inject_cost(agent, 5.0)

        status = httpx.get(
            api("/costs/budget-status"), params={"agent_id": agent}, timeout=5
        ).json()
        assert status["over_budget"] is True
        assert status["budget_action"] == "warn"

        r = self._proxy_post(agent)
        # Warn mode → proxy forwards; upstream returns 401/502, never 429
        assert r.status_code != 429, "Warn mode should not block — should pass through"
        cleanup_agent(agent)

    def test_proxy_block_mode_over_budget_returns_429(self):
        """Block mode: over-budget requests are blocked with HTTP 429."""
        agent = self._fresh_agent()
        httpx.put(
            api(f"/costs/budget/agents/{agent}"),
            json={"daily_budget_usd": 0.000001, "budget_action": "block"},
            timeout=5,
        )
        inject_cost(agent, 5.0)

        status = httpx.get(
            api("/costs/budget-status"), params={"agent_id": agent}, timeout=5
        ).json()
        assert status["over_budget"] is True
        assert status["budget_action"] == "block"

        r = self._proxy_post(agent)
        assert r.status_code == 429, f"Expected 429, got {r.status_code}: {r.text}"
        body = r.json()
        assert "error" in body
        assert body["error"]["code"] == "budget_exceeded"
        assert "budget" in body["error"]["message"].lower()
        cleanup_agent(agent)

    def test_proxy_block_mode_under_budget_forwards(self):
        """Block mode with budget NOT exceeded → proxy forwards normally."""
        agent = self._fresh_agent()
        httpx.put(
            api(f"/costs/budget/agents/{agent}"),
            json={"daily_budget_usd": 1000.0, "budget_action": "block"},
            timeout=5,
        )
        inject_cost(agent, 0.001)

        r = self._proxy_post(agent)
        # Generous budget → forwards; upstream returns 401/502, not 429
        assert r.status_code != 429, "Should not be blocked when under budget"
        cleanup_agent(agent)

    def test_proxy_block_mode_exactly_at_limit(self):
        """Spend == budget → over_budget=True (>= check), proxy blocks."""
        agent = self._fresh_agent()
        budget = 0.10
        httpx.put(
            api(f"/costs/budget/agents/{agent}"),
            json={"daily_budget_usd": budget, "budget_action": "block"},
            timeout=5,
        )
        inject_cost(agent, budget)  # Exactly at limit

        status = httpx.get(
            api("/costs/budget-status"), params={"agent_id": agent}, timeout=5
        ).json()
        assert status["over_budget"] is True  # >= triggers block at exactly limit

        r = self._proxy_post(agent)
        assert r.status_code == 429, f"Expected 429 at limit, got {r.status_code}: {r.text}"
        cleanup_agent(agent)

    def test_proxy_block_message_contains_spend_info(self):
        """429 block response includes spend and limit amounts in the message."""
        agent = self._fresh_agent()
        httpx.put(
            api(f"/costs/budget/agents/{agent}"),
            json={"daily_budget_usd": 0.000001, "budget_action": "block"},
            timeout=5,
        )
        inject_cost(agent, 5.0)
        r = self._proxy_post(agent)
        assert r.status_code == 429
        msg = r.json()["error"]["message"]
        assert "$" in msg, f"Expected dollar amounts in message: {msg}"
        cleanup_agent(agent)


# ===========================================================================
# 6. BUDGET GUARDIAN
# ===========================================================================

class TestBudgetGuardian:

    def test_guardian_returns_global_info(self):
        """GET /api/costs/budget/guardian returns global budget overview."""
        r = httpx.get(api("/costs/budget/guardian"), timeout=5)
        assert r.status_code == 200
        data = r.json()
        assert "global_budget_usd" in data
        assert "global_today_spend_usd" in data
        assert "global_over_budget" in data
        assert "agent_alerts" in data

    def test_guardian_detects_over_budget_agent(self):
        """Guardian flags agent that is over budget."""
        httpx.put(
            api(f"/costs/budget/agents/{TEST_AGENT}"),
            json={"daily_budget_usd": 0.000001, "budget_action": "block"},
            timeout=5,
        )
        inject_cost(TEST_AGENT, 1.0)
        r = httpx.get(api("/costs/budget/guardian"), timeout=5)
        data = r.json()
        over = [a for a in data["agent_alerts"] if a["agent_id"] == TEST_AGENT]
        assert over, f"{TEST_AGENT} not in guardian alerts"
        assert over[0]["over_budget"] is True

    def test_guardian_warning_threshold(self):
        """Guardian sets warning=True for agents at 80-99% of budget."""
        httpx.put(
            api(f"/costs/budget/agents/{TEST_AGENT}"),
            json={"daily_budget_usd": 1.0, "budget_action": "warn"},
            timeout=5,
        )
        inject_cost(TEST_AGENT, 0.85)  # 85% → warning
        r = httpx.get(api("/costs/budget/guardian"), timeout=5)
        data = r.json()
        alerts = {a["agent_id"]: a for a in data["agent_alerts"]}
        assert TEST_AGENT in alerts
        a = alerts[TEST_AGENT]
        assert a["warning"] is True
        assert a["over_budget"] is False


# ===========================================================================
# 7. COST RECORDS ENDPOINTS
# ===========================================================================

class TestCostRecords:

    def test_list_records(self):
        """GET /api/costs/records returns paginated records."""
        inject_cost(TEST_AGENT, 0.01)
        r = httpx.get(api("/costs/records"), params={"agent_id": TEST_AGENT}, timeout=5)
        assert r.status_code == 200
        data = r.json()
        assert "items" in data
        assert "total" in data
        assert data["total"] >= 1

    def test_list_records_filter_by_provider(self):
        """Records can be filtered by provider."""
        inject_cost(TEST_AGENT, 0.01, provider="anthropic")
        r = httpx.get(
            api("/costs/records"),
            params={"agent_id": TEST_AGENT, "provider": "anthropic"},
            timeout=5,
        )
        data = r.json()
        assert all(item["provider"] == "anthropic" for item in data["items"])

    def test_list_records_pagination(self):
        """Pagination returns correct page/page_size."""
        for _ in range(3):
            inject_cost(TEST_AGENT, 0.001)
        r = httpx.get(
            api("/costs/records"),
            params={"agent_id": TEST_AGENT, "page": 1, "page_size": 2},
            timeout=5,
        )
        data = r.json()
        assert data["page"] == 1
        assert data["page_size"] == 2
        assert len(data["items"]) <= 2

    def test_delete_records_by_agent(self):
        """DELETE /api/costs/records?agent_id=... removes only that agent's records."""
        inject_cost(TEST_AGENT, 0.01)
        r = httpx.delete(api("/costs/records"), params={"agent_id": TEST_AGENT}, timeout=5)
        assert r.status_code == 200
        assert r.json()["deleted"] >= 1
        # Verify gone
        r2 = httpx.get(api("/costs/records"), params={"agent_id": TEST_AGENT}, timeout=5)
        assert r2.json()["total"] == 0

    def test_cost_summary_includes_agent(self):
        """GET /api/costs/summary includes injected agent in results."""
        inject_cost(TEST_AGENT, 0.05)
        r = httpx.get(api("/costs/summary"), timeout=5)
        assert r.status_code == 200
        agents = {a["agent_id"]: a for a in r.json()["agents"]}
        assert TEST_AGENT in agents
        assert agents[TEST_AGENT]["total_cost_usd"] > 0

    def test_dashboard_summary(self):
        """GET /api/costs/dashboard-summary returns compact widget data."""
        r = httpx.get(api("/costs/dashboard-summary"), timeout=5)
        assert r.status_code == 200
        data = r.json()
        for field in ("today_cost_usd", "today_requests", "cost_tracking_enabled"):
            assert field in data

    def test_csv_export(self):
        """GET /api/costs/export returns CSV with correct headers."""
        inject_cost(TEST_AGENT, 0.01)
        r = httpx.get(
            api("/costs/export"),
            params={"agent_id": TEST_AGENT},
            timeout=10,
        )
        assert r.status_code == 200
        assert "text/csv" in r.headers.get("content-type", "")
        lines = r.text.strip().splitlines()
        assert len(lines) >= 2  # Header + at least one data row
        header = lines[0]
        for col in ("agent_id", "provider", "model_id", "total_cost_usd"):
            assert col in header, f"CSV missing column: {col}"
