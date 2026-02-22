"""
CostRecorder service — extracts token usage from LLM proxy responses
and records costs asynchronously.

This service MUST NEVER raise exceptions — all errors are logged and swallowed
to ensure cost recording never breaks the proxy response flow.
"""

import json
import logging
import time
from typing import Optional

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.repositories.costs import CostsRepository

logger = logging.getLogger(__name__)

# Cache discount rates: what fraction of the full input rate applies to cached tokens.
# OpenAI: 50% (0.5x), Anthropic cache_read: ~10% (0.1x), Gemini: ~25% (0.25x)
# Sources: provider pricing pages. Others have no cache discount (1.0x = full rate).
CACHE_DISCOUNT: dict[str, float] = {
    "openai": 0.5,
    "anthropic": 0.1,
    "gemini": 0.25,
}

# Map versioned model IDs to canonical pricing keys.
# Add entries here when providers release versioned variants.
MODEL_ID_ALIASES: dict[str, str] = {
    # OpenAI versioned → canonical
    "gpt-4o-2024-11-20": "gpt-4o",
    "gpt-4o-2024-08-06": "gpt-4o",
    "gpt-4o-2024-05-13": "gpt-4o",
    "gpt-4o-mini-2024-07-18": "gpt-4o-mini",
    "gpt-4-turbo-2024-04-09": "gpt-4-turbo",
    "gpt-4-turbo-preview": "gpt-4-turbo",
    "gpt-3.5-turbo-0125": "gpt-3.5-turbo",
    "gpt-3.5-turbo-1106": "gpt-3.5-turbo",
    "o1-2024-12-17": "o1",
    "o1-mini-2024-09-12": "o1-mini",
    "o3-mini-2025-01-31": "o3-mini",
    # Anthropic versioned → canonical
    "claude-3-5-sonnet-20241022": "claude-3-5-sonnet-20241022",  # keep as-is (in pricing table)
    "claude-3-5-haiku-20241022": "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229": "claude-3-opus-20240229",
    # Gemini variants → canonical
    "gemini-2.0-flash-001": "gemini-2.0-flash",
    "gemini-2.0-flash-exp": "gemini-2.0-flash",
    "gemini-1.5-pro-001": "gemini-1.5-pro",
    "gemini-1.5-pro-002": "gemini-1.5-pro",
    "gemini-1.5-flash-001": "gemini-1.5-flash",
    "gemini-1.5-flash-002": "gemini-1.5-flash",
    # Mistral versioned
    "mistral-large-2402": "mistral-large-latest",
    "mistral-large-2407": "mistral-large-latest",
    "mistral-large-2411": "mistral-large-latest",
    "mistral-small-2402": "mistral-small-latest",
    "mistral-small-2409": "mistral-small-latest",
    # Cohere versioned
    "command-r-plus": "command-r-plus-08-2024",
    "command-r": "command-r-08-2024",
}


class CostRecorder:
    """
    Records LLM request costs by extracting token usage from proxy responses.

    Usage:
        recorder = CostRecorder(db)
        asyncio.create_task(recorder.record(provider, agent_id, response_body))
    """

    def __init__(self, db: DatabaseConnection):
        self._db = db
        self._repo = CostsRepository(db)
        self._pricing_cache: dict[str, tuple[float, float]] = {}  # "{provider}/{model_id}" → (input_rate, output_rate)
        self._cache_loaded = False
        self._cache_loaded_at: float = 0.0
        self._cache_ttl: float = 300.0  # Refresh pricing cache every 5 minutes

    async def _ensure_cache(self) -> None:
        """Load pricing cache from DB on first use or after TTL expiry."""
        if self._cache_loaded and (time.monotonic() - self._cache_loaded_at) < self._cache_ttl:
            return
        try:
            entries = await self._repo.list_pricing()
            self._pricing_cache = {
                f"{e.provider}/{e.model_id}": (e.input_per_million, e.output_per_million)
                for e in entries
            }
            self._cache_loaded = True
            self._cache_loaded_at = time.monotonic()
            logger.debug(f"Loaded {len(self._pricing_cache)} pricing entries into cache")
        except Exception as e:
            logger.warning(f"Failed to load pricing cache: {e}")

    async def refresh_pricing_cache(self) -> None:
        """Force reload of pricing cache from DB."""
        self._cache_loaded = False
        await self._ensure_cache()

    def _normalize_model_id(self, model_id: str) -> str:
        """Map versioned model IDs to canonical pricing keys."""
        if not model_id:
            return model_id
        return MODEL_ID_ALIASES.get(model_id, model_id)

    def extract_tokens(
        self, response_body: bytes, provider: str
    ) -> tuple[str, int, int, int]:
        """
        Extract (model_id, input_tokens, output_tokens, input_cached_tokens) from a provider response body.

        Returns ("", 0, 0, 0) on any parse error — never raises.

        Provider response formats:
        - OpenAI/Groq/Mistral/Cohere: usage.prompt_tokens + usage.completion_tokens + model
          Cached: usage.prompt_tokens_details.cached_tokens (Chat) or usage.input_tokens_details.cached_tokens (Responses API)
        - Anthropic: usage.input_tokens + usage.output_tokens + model
          Cached: usage.cache_read_input_tokens
        - Gemini: usageMetadata.promptTokenCount + usageMetadata.candidatesTokenCount + modelVersion
          Cached: usageMetadata.cachedContentTokenCount
        - Ollama: prompt_eval_count + eval_count + model (no cache)
        """
        try:
            if not response_body:
                return "", 0, 0, 0

            data = json.loads(response_body)

            # OpenAI Responses API SSE event: data may be wrapped in {"response": {...}}
            # e.g. {"type":"response.completed","response":{"model":"gpt-4o","usage":{...}}}
            if "response" in data and isinstance(data.get("response"), dict):
                inner = data["response"]
                if "model" in inner or "usage" in inner:
                    data = inner

            # Anthropic format
            if provider == "anthropic":
                usage = data.get("usage", {})
                model_id = data.get("model", "")
                input_tokens = int(usage.get("input_tokens", 0))
                output_tokens = int(usage.get("output_tokens", 0))
                input_cached_tokens = int(usage.get("cache_read_input_tokens", 0))
                return model_id, input_tokens, output_tokens, input_cached_tokens

            # Gemini format
            if provider == "gemini":
                metadata = data.get("usageMetadata", {})
                model_id = data.get("modelVersion", data.get("model", ""))
                input_tokens = int(metadata.get("promptTokenCount", 0))
                output_tokens = int(metadata.get("candidatesTokenCount", 0))
                input_cached_tokens = int(metadata.get("cachedContentTokenCount", 0))
                return model_id, input_tokens, output_tokens, input_cached_tokens

            # Ollama format
            if provider == "ollama":
                model_id = data.get("model", "")
                input_tokens = int(data.get("prompt_eval_count", 0))
                output_tokens = int(data.get("eval_count", 0))
                return model_id, input_tokens, output_tokens, 0

            # OpenAI-compatible (openai, groq, mistral, cohere, and default)
            # Handles both Chat Completions (prompt_tokens/completion_tokens)
            # and Responses API (input_tokens/output_tokens)
            usage = data.get("usage", {})
            model_id = data.get("model", "")
            input_tokens = int(
                usage.get("prompt_tokens") or usage.get("input_tokens") or 0
            )
            output_tokens = int(
                usage.get("completion_tokens") or usage.get("output_tokens") or 0
            )
            # Cached tokens: Chat Completions uses prompt_tokens_details.cached_tokens
            # Responses API uses input_tokens_details.cached_tokens
            prompt_details = usage.get("prompt_tokens_details") or usage.get("input_tokens_details") or {}
            input_cached_tokens = int(prompt_details.get("cached_tokens", 0))
            return model_id, input_tokens, output_tokens, input_cached_tokens

        except Exception as e:
            logger.debug(f"Token extraction failed for provider={provider}: {e}")
            return "", 0, 0, 0

    async def record(
        self,
        provider: str,
        agent_id: str,
        response_body: bytes,
        request_id: Optional[str] = None,
    ) -> None:
        """
        Extract tokens from response body and record cost asynchronously.

        This method NEVER raises. All errors are logged and swallowed.
        """
        try:
            await self._ensure_cache()

            model_id, input_tokens, output_tokens, input_cached_tokens = self.extract_tokens(response_body, provider)

            if not model_id and input_tokens == 0 and output_tokens == 0:
                # Nothing to record
                return

            # Normalize model ID for pricing lookup
            canonical_id = self._normalize_model_id(model_id)
            cache_key = f"{provider}/{canonical_id}"

            rate_input: Optional[float] = None
            rate_output: Optional[float] = None
            pricing_known = False

            if cache_key in self._pricing_cache:
                rate_input, rate_output = self._pricing_cache[cache_key]
                pricing_known = True
            else:
                # Try without provider prefix (some Groq models use bare model IDs)
                for key, rates in self._pricing_cache.items():
                    if key.endswith(f"/{canonical_id}"):
                        rate_input, rate_output = rates
                        pricing_known = True
                        break

            # Calculate costs (rates are per million tokens).
            # Cached tokens are billed at a provider-specific discount.
            if pricing_known and rate_input is not None and rate_output is not None:
                cache_rate = CACHE_DISCOUNT.get(provider, 1.0)
                uncached_tokens = max(0, input_tokens - input_cached_tokens)
                input_cost = (uncached_tokens / 1_000_000) * rate_input
                input_cost += (input_cached_tokens / 1_000_000) * rate_input * cache_rate
                output_cost = (output_tokens / 1_000_000) * rate_output
            else:
                input_cost = 0.0
                output_cost = 0.0

            total_cost = input_cost + output_cost

            await self._repo.record_cost(
                agent_id=agent_id,
                provider=provider,
                model_id=model_id or canonical_id,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                input_cached_tokens=input_cached_tokens,
                input_cost_usd=round(input_cost, 8),
                output_cost_usd=round(output_cost, 8),
                total_cost_usd=round(total_cost, 8),
                rate_input=rate_input,
                rate_output=rate_output,
                pricing_known=pricing_known,
                request_id=request_id,
            )

        except Exception as e:
            logger.debug(f"CostRecorder.record() failed silently: {e}")
