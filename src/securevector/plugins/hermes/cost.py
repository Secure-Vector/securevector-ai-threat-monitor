"""Turn a Hermes ``post_api_request`` hook call into a SecureVector cost record.

Hermes passes ``usage`` as a dict of token buckets (``CanonicalUsage`` in
``agent/usage_pricing.py``): ``input_tokens``, ``output_tokens``,
``cache_read_tokens``, ``cache_write_tokens``, ``reasoning_tokens``, plus
``prompt_tokens`` (input + cache read + cache write) and ``total_tokens``.
In that shape ``input_tokens`` is the uncached part only. Other builds and
samples report ``input_tokens`` as the full prompt, so the total is worked
out from whichever fields are present (see ``_prompt_total``).

The record always carries the full prompt in ``input_tokens`` with
``input_includes_cached`` set, so the app subtracts cache reads and writes
exactly once.
"""

from __future__ import annotations

import atexit
import itertools
import json
import logging
import os
import queue
import sys
import threading
import urllib.parse
import urllib.request
from typing import Any, Optional

log = logging.getLogger(__name__)

AGENT_ID = "hermes"
# The installer rewrites this default to the app's own address when it copies
# the plugin; SECUREVECTOR_ENGINE_ENDPOINT overrides it at run time.
DEFAULT_ENDPOINT = "http://127.0.0.1:8741"
TRACK_PATH = "/api/costs/track"
TIMEOUT_SECONDS = 2.0
_ID_MAX = 200
_TOKEN_MAX = 10**12

_counter = itertools.count(1)
_LOOPBACK = {"127.0.0.1", "localhost", "::1"}
EXIT_DRAIN_SECONDS = 1.0
_QUEUE_MAX = 1000

# Hermes provider slug -> the app's pricing provider key (model_pricing.yml).
# xAI models price under grok, distinct from groq the inference host. Unmapped
# slugs (bedrock, openrouter, ...) pass through lowercased.
_PROVIDER_CANON = {
    "openai": "openai",
    "openai-codex": "openai",
    "azure": "openai",
    "azure_openai": "openai",
    "anthropic": "anthropic",
    "gemini": "gemini",
    "google": "gemini",
    "google_genai": "gemini",
    "google_vertexai": "gemini",
    "vertex_ai": "gemini",
    "vertexai": "gemini",
    "groq": "groq",
    "xai": "grok",
    "grok": "grok",
    "mistral": "mistral",
    "mistralai": "mistral",
    "cohere": "cohere",
    "deepseek": "deepseek",
    "perplexity": "perplexity",
    "minimax": "minimax",
    "ollama": "ollama",
}


def canon_provider(raw: Any) -> str:
    slug = _text(raw).lower()
    if not slug:
        return "unknown"
    return _PROVIDER_CANON.get(slug, slug)


def _get(obj: Any, name: str) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _int(value: Any) -> int:
    """A non-negative int, or 0. Bools and junk count as 0."""
    if isinstance(value, bool) or value is None:
        return 0
    try:
        n = int(value)
    except (TypeError, ValueError, OverflowError):
        return 0
    return min(max(n, 0), _TOKEN_MAX)


def _first(usage: Any, names: tuple, details: tuple = ()) -> int:
    """First positive count among top-level ``names``, then ``details`` paths."""
    for name in names:
        n = _int(_get(usage, name))
        if n:
            return n
    for parent, child in details:
        n = _int(_get(_get(usage, parent), child))
        if n:
            return n
    return 0


_DETAIL_PARENTS = ("input_token_details", "input_tokens_details", "prompt_tokens_details")


def _cache_reads(usage: Any) -> int:
    return _first(
        usage,
        ("cache_read_tokens", "cache_read_input_tokens", "cached_tokens", "input_cached_tokens"),
        tuple((p, c) for p in _DETAIL_PARENTS for c in ("cache_read", "cached_tokens")),
    )


def _cache_writes(usage: Any) -> int:
    return _first(
        usage,
        ("cache_write_tokens", "cache_creation_tokens", "cache_creation_input_tokens",
         "input_cache_write_tokens"),
        tuple((p, c) for p in _DETAIL_PARENTS
              for c in ("cache_creation", "cache_write", "cache_creation_tokens", "cache_write_tokens")),
    )


def _prompt_total(usage: Any, reads: int, writes: int) -> int:
    """Full prompt size, cache included.

    ``prompt_tokens`` is the full prompt where present. Without it,
    ``input_tokens`` is taken as the full prompt when it is at least the cache
    total, otherwise as the uncached part with the cache added back.
    """
    prompt = _int(_get(usage, "prompt_tokens"))
    raw_input = _int(_get(usage, "input_tokens"))
    if prompt:
        total = prompt
    elif raw_input >= reads + writes:
        total = raw_input
    else:
        total = raw_input + reads + writes
    return max(total, reads + writes)


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def build_record(kwargs: dict) -> Optional[dict]:
    """The ``/api/costs/track`` body for one hook call, or None when there is
    no usage to record."""
    usage = kwargs.get("usage")
    if not usage:
        return None
    reads = _cache_reads(usage)
    writes = _cache_writes(usage)
    total = _prompt_total(usage, reads, writes)
    output = _first(usage, ("output_tokens", "completion_tokens"))
    if total == 0 and output == 0:
        return None

    model = _text(kwargs.get("response_model")) or _text(kwargs.get("model")) or "unknown"
    provider = canon_provider(kwargs.get("provider"))
    record = {
        "agent_id": AGENT_ID,
        "runtime_kind": AGENT_ID,
        "provider": provider,
        "model_id": model,
        "input_tokens": int(total),
        "output_tokens": int(output),
        "input_cached_tokens": int(reads),
        "input_cache_write_tokens": int(writes),
        "input_includes_cached": True,
    }
    session_id = _text(kwargs.get("session_id"))
    if session_id:
        record["session_id"] = session_id[:_ID_MAX]
    request_id = _text(kwargs.get("api_request_id"))
    if not request_id:
        turn_id = _text(kwargs.get("turn_id"))
        if turn_id:
            request_id = f"{turn_id}:{next(_counter)}"
    if request_id:
        record["request_id"] = request_id[:_ID_MAX]
    return record


def endpoint() -> str:
    raw = (os.environ.get("SECUREVECTOR_ENGINE_ENDPOINT") or "").strip() or DEFAULT_ENDPOINT
    return raw.rstrip("/")


def _post(url: str, body: dict) -> None:
    try:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in ("http", "https"):
            return
        headers = {"Content-Type": "application/json"}
        api_key = (os.environ.get("SECUREVECTOR_API_KEY") or "").strip()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        req = urllib.request.Request(
            url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST",
        )
        if (parsed.hostname or "") in _LOOPBACK:
            # The local app is never reached through a proxy.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            resp = opener.open(req, timeout=TIMEOUT_SECONDS)
        else:
            resp = urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS)
        try:
            resp.read(0)
        finally:
            resp.close()
    except Exception as exc:  # cost tracking must never affect the agent
        log.debug("SecureVector cost post failed: %s", exc)


_SDK_PREFIX = "securevector_sdk_hermes"


def _callback_module(cb: Any) -> str:
    target = getattr(cb, "func", cb)  # functools.partial
    owner = getattr(target, "__self__", None)  # bound method
    mod = getattr(target, "__module__", None) or (type(owner).__module__ if owner is not None else "")
    return mod or ""


def _sdk_hooks_from_registry(hook_name: str = "post_api_request") -> Optional[bool]:
    """True/False when Hermes's hook registry can be read
    (``PluginManager._hooks`` in hermes_cli/plugins.py), None when it cannot."""
    try:
        from hermes_cli.plugins import get_plugin_manager

        hooks = getattr(get_plugin_manager(), "_hooks", None)
        if not isinstance(hooks, dict):
            return None
        callbacks = hooks.get(hook_name) or []
        return any(_callback_module(cb).startswith(_SDK_PREFIX) for cb in callbacks)
    except Exception:
        return None


def _sdk_tracks_cost() -> bool:
    """The securevector-sdk-hermes plugin posts cost itself when its
    ``post_api_request`` hook is registered; stay silent then so a call is
    not recorded twice."""
    found = _sdk_hooks_from_registry()
    if found is not None:
        return found
    return _sdk_plugin_enabled()


def _sdk_plugin_enabled() -> bool:
    """Without a readable registry: whether the SDK plugin is loaded and on."""
    if _SDK_PREFIX + ".plugin" not in sys.modules:
        return False
    try:
        from securevector_sdk_hermes.config import Config

        return bool(Config.from_env().enabled)
    except Exception:
        return False


# One worker drains a bounded queue; atexit gives pending sends a short,
# bounded window so Hermes exit is never held up.
_queue: "queue.Queue" = queue.Queue(maxsize=_QUEUE_MAX)
_worker: Optional[threading.Thread] = None
_worker_lock = threading.Lock()
_STOP = object()


def _run_worker() -> None:
    while True:
        item = _queue.get()
        try:
            if item is _STOP:
                if _queue.empty():
                    return
                continue  # more queued after the stop marker: keep sending
            _post(*item)
        except Exception:
            pass
        finally:
            _queue.task_done()


def _enqueue(url: str, record: dict) -> None:
    global _worker
    try:
        _queue.put_nowait((url, record))
    except queue.Full:
        log.debug("SecureVector cost queue full; record dropped")
        return
    with _worker_lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_run_worker, name="securevector-cost", daemon=True)
            _worker.start()


def drain(timeout: float = EXIT_DRAIN_SECONDS) -> None:
    """Let queued sends finish for at most ``timeout`` seconds in total."""
    global _worker
    with _worker_lock:
        worker = _worker
    if worker is None or not worker.is_alive():
        return
    try:
        _queue.put_nowait(_STOP)
    except queue.Full:
        pass
    worker.join(timeout)
    with _worker_lock:
        if _worker is worker and not worker.is_alive():
            _worker = None


atexit.register(drain)


def on_post_api_request(**kwargs: Any) -> None:
    """Hermes ``post_api_request`` callback. Never raises."""
    try:
        if _sdk_tracks_cost():
            return
        record = build_record(kwargs)
        if record is None:
            return
        _enqueue(endpoint() + TRACK_PATH, record)
    except Exception as exc:
        log.debug("SecureVector cost hook skipped: %s", exc)
