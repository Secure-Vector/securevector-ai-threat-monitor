"""The Hermes directory plugin (plugins/hermes): payload builder, hook safety,
and the app pricing its records end to end. No network: urlopen is mocked."""

from __future__ import annotations

import os
import sys
import threading

import pytest
import pytest_asyncio
from fastapi import FastAPI

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import init_database_schema
from securevector.app.server.routes import costs as costs_routes
from securevector.plugins.hermes import cost as hcost
from securevector.plugins import hermes as hplugin

# A real Hermes 0.22.4 post_api_request (usage plus the call's model/provider).
SAMPLE_022 = {
    "input_tokens": 159180, "output_tokens": 2190,
    "cache_read_tokens": 136688, "cache_write_tokens": 22451,
    "model": "us.anthropic.claude-haiku-4-5-20251001-v1:0", "provider": "bedrock",
}


def _kwargs_022(**extra):
    usage = {k: SAMPLE_022[k] for k in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")}
    kw = dict(usage=usage, model=SAMPLE_022["model"], provider=SAMPLE_022["provider"],
              session_id="20261102_101500_abc", api_request_id="turn-1:api:1", turn_id="turn-1")
    kw.update(extra)
    return kw


def _kwargs_018():
    """Hermes 0.18 shape (conversation_loop.py:4110): usage is asdict(CanonicalUsage)
    where input_tokens is the uncached part, plus prompt_tokens/total_tokens."""
    usage = {"input_tokens": 41, "output_tokens": 2190, "cache_read_tokens": 136688,
             "cache_write_tokens": 22451, "reasoning_tokens": 0, "request_count": 1,
             "prompt_tokens": 159180, "total_tokens": 161370}
    return dict(task_id="t", turn_id="turn-9", api_request_id="turn-9:api:3", session_id="s18",
                platform="cli", model="claude-haiku-4-5", provider="anthropic", base_url="",
                api_mode="anthropic_messages", api_call_count=3, api_duration=1.0, started_at=0.0,
                ended_at=1.0, finish_reason="stop", message_count=4,
                response_model="claude-haiku-4-5-20251001", response={}, usage=usage,
                assistant_message=None, assistant_content_chars=10, assistant_tool_call_count=0)


def test_payload_from_the_022_sample():
    rec = hcost.build_record(_kwargs_022())
    assert rec == {
        "agent_id": "hermes", "runtime_kind": "hermes", "provider": "bedrock",
        "model_id": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        "input_tokens": 159180, "output_tokens": 2190,
        "input_cached_tokens": 136688, "input_cache_write_tokens": 22451,
        "input_includes_cached": True,
        "session_id": "20261102_101500_abc", "request_id": "turn-1:api:1",
    }
    for key in ("input_tokens", "output_tokens", "input_cached_tokens", "input_cache_write_tokens"):
        assert type(rec[key]) is int


def test_payload_from_the_018_shape_uses_prompt_total_and_response_model():
    rec = hcost.build_record(_kwargs_018())
    assert rec["input_tokens"] == 159180  # prompt_tokens, not the uncached 41
    assert rec["input_cached_tokens"] == 136688
    assert rec["input_cache_write_tokens"] == 22451
    assert rec["model_id"] == "claude-haiku-4-5-20251001"
    assert rec["request_id"] == "turn-9:api:3"


def test_uncached_input_without_prompt_tokens_adds_the_cache_back():
    rec = hcost.build_record({"usage": {"input_tokens": 41, "output_tokens": 5,
                                        "cache_read_tokens": 1000, "cache_write_tokens": 200},
                              "model": "m", "provider": "p"})
    assert rec["input_tokens"] == 1241


def test_alternate_field_names():
    usage = {"input_tokens": 500, "completion_tokens": 7,
             "input_token_details": {"cache_read": 300}, "cache_creation_tokens": 100}
    rec = hcost.build_record({"usage": usage, "model": "m", "provider": "p"})
    assert (rec["input_tokens"], rec["output_tokens"]) == (500, 7)
    assert (rec["input_cached_tokens"], rec["input_cache_write_tokens"]) == (300, 100)
    usage = {"prompt_tokens": 90, "output_tokens": 1,
             "prompt_tokens_details": {"cached_tokens": 60}, "cache_creation_input_tokens": 10}
    rec = hcost.build_record({"usage": usage, "model": "m", "provider": "p"})
    assert (rec["input_tokens"], rec["input_cached_tokens"], rec["input_cache_write_tokens"]) == (90, 60, 10)


def test_missing_fields():
    assert hcost.build_record({}) is None
    assert hcost.build_record({"usage": None}) is None
    assert hcost.build_record({"usage": {"input_tokens": 0, "output_tokens": 0}}) is None
    rec = hcost.build_record({"usage": {"input_tokens": "12", "output_tokens": True}})
    assert rec["provider"] == "unknown" and rec["model_id"] == "unknown"
    assert rec["input_tokens"] == 12 and rec["output_tokens"] == 0
    assert "session_id" not in rec and "request_id" not in rec


def test_request_id_falls_back_to_turn_and_counter_and_is_truncated():
    a = hcost.build_record({"usage": {"output_tokens": 1}, "turn_id": "T"})
    b = hcost.build_record({"usage": {"output_tokens": 1}, "turn_id": "T"})
    assert a["request_id"].startswith("T:") and a["request_id"] != b["request_id"]
    long = hcost.build_record({"usage": {"output_tokens": 1}, "api_request_id": "x" * 500,
                               "session_id": "s" * 500})
    assert len(long["request_id"]) == 200 and len(long["session_id"]) == 200


def test_register_adds_the_cost_audit_and_session_hooks():
    seen = []

    class Ctx:
        def register_hook(self, name, cb):
            seen.append((name, cb))

    hplugin.register(Ctx())
    assert [n for n, _ in seen] == [
        "post_api_request", "post_tool_call", "on_session_start", "on_session_end", "on_session_finalize",
    ]
    assert seen[0][1] is hcost.on_post_api_request
    # post_llm_call covers the same calls once per turn; never registered.
    assert "post_llm_call" not in [n for n, _ in seen]


@pytest.fixture
def captured(monkeypatch):
    """Run the POST inline and capture the request instead of sending it."""
    sent = []

    class Resp:
        def read(self, n=-1):
            return b""

        def close(self):
            pass

    def fake_open(self_or_req, req=None, timeout=None):
        sent.append((req if req is not None else self_or_req, timeout))
        return Resp()

    monkeypatch.setattr(hcost.urllib.request, "urlopen", lambda req, timeout=None: fake_open(req, None, timeout))
    monkeypatch.setattr(hcost.urllib.request.OpenerDirector, "open", fake_open)

    monkeypatch.delenv("SECUREVECTOR_API_KEY", raising=False)
    return sent


@pytest.fixture(autouse=True)
def fake_registry(monkeypatch):
    """A stand-in for hermes_cli.plugins so the real Hermes is never imported."""
    import types

    manager = types.SimpleNamespace(_hooks={})
    pkg = types.ModuleType("hermes_cli")
    mod = types.ModuleType("hermes_cli.plugins")
    mod.get_plugin_manager = lambda: manager
    pkg.plugins = mod
    monkeypatch.setitem(sys.modules, "hermes_cli", pkg)
    monkeypatch.setitem(sys.modules, "hermes_cli.plugins", mod)
    yield manager
    hcost.drain(1.0)


def test_hook_posts_json_to_the_endpoint(captured, monkeypatch):
    import json

    monkeypatch.setenv("SECUREVECTOR_ENGINE_ENDPOINT", "http://127.0.0.1:9999/")
    hcost.on_post_api_request(**_kwargs_022())
    hcost.drain(1.0)
    assert len(captured) == 1
    req, timeout = captured[0]
    assert req.full_url == "http://127.0.0.1:9999/api/costs/track"
    assert req.get_method() == "POST" and timeout == hcost.TIMEOUT_SECONDS
    assert json.loads(req.data)["input_cache_write_tokens"] == 22451


def test_default_endpoint(monkeypatch):
    monkeypatch.delenv("SECUREVECTOR_ENGINE_ENDPOINT", raising=False)
    assert hcost.endpoint() == "http://127.0.0.1:8741"


def test_hook_never_raises(monkeypatch, captured):
    def boom(*a, **k):
        raise OSError("connection refused")

    monkeypatch.setattr(hcost.urllib.request.OpenerDirector, "open", boom)
    hcost.on_post_api_request(**_kwargs_022())  # network error swallowed
    hcost.drain(1.0)
    monkeypatch.setattr(hcost, "build_record", boom)
    hcost.on_post_api_request(**_kwargs_022())  # builder error swallowed
    hcost.on_post_api_request(usage=object())  # junk usage


def test_sends_run_on_one_daemon_worker(captured):
    for _ in range(5):
        hcost.on_post_api_request(**_kwargs_022())
    worker = hcost._worker
    assert worker is not None and worker.daemon and worker.name == "securevector-cost"
    hcost.drain(1.0)
    assert len(captured) == 5


def test_exit_drain_flushes_pending_at_interpreter_exit(tmp_path):
    """A record queued just before exit is still sent: atexit drains it."""
    import subprocess
    from pathlib import Path

    out = tmp_path / "sent.txt"
    src = Path(hcost.__file__).resolve().parents[3]
    code = (
        "import time\n"
        "from securevector.plugins.hermes import cost\n"
        f"def slow(url, body):\n    time.sleep(0.2); open({str(out)!r}, 'a').write('x')\n"
        "cost._post = slow\n"
        "cost._enqueue('http://127.0.0.1:1/x', {})\n"
    )
    env = {**os.environ, "PYTHONPATH": str(src)}
    subprocess.run([sys.executable, "-c", code], env=env, timeout=20, check=True)
    assert out.read_text() == "x"


def test_exit_drain_never_hangs(monkeypatch):
    import time

    release = threading.Event()
    monkeypatch.setattr(hcost, "_post", lambda url, body: release.wait(10))
    hcost._enqueue("http://127.0.0.1:1/x", {})
    t0 = time.monotonic()
    hcost.drain(0.3)
    assert time.monotonic() - t0 < 1.0
    release.set()
    hcost.drain(1.0)


def _sdk_callback():
    def cost_hook(**kw):
        pass
    cost_hook.__module__ = "securevector_sdk_hermes.costs"
    return cost_hook


def test_silent_when_the_sdk_cost_hook_is_registered(captured, fake_registry):
    fake_registry._hooks["post_api_request"] = [hcost.on_post_api_request, _sdk_callback()]
    hcost.on_post_api_request(**_kwargs_022())
    hcost.drain(1.0)
    assert captured == []


def test_records_when_only_the_sdk_module_is_imported(captured, fake_registry, monkeypatch):
    # Library install() without the cost hook: module present, no hook registered.
    monkeypatch.setitem(sys.modules, "securevector_sdk_hermes.plugin", object())
    fake_registry._hooks["post_api_request"] = [hcost.on_post_api_request]
    hcost.on_post_api_request(**_kwargs_022())
    hcost.drain(1.0)
    assert len(captured) == 1


def _fake_sdk_config(monkeypatch, enabled):
    import types

    cfg_mod = types.ModuleType("securevector_sdk_hermes.config")

    class Config:
        @staticmethod
        def from_env():
            return types.SimpleNamespace(enabled=enabled)

    cfg_mod.Config = Config
    monkeypatch.setitem(sys.modules, "securevector_sdk_hermes", types.ModuleType("securevector_sdk_hermes"))
    monkeypatch.setitem(sys.modules, "securevector_sdk_hermes.plugin", types.ModuleType("securevector_sdk_hermes.plugin"))
    monkeypatch.setitem(sys.modules, "securevector_sdk_hermes.config", cfg_mod)
    monkeypatch.setattr(hcost, "_sdk_hooks_from_registry", lambda: None)


def test_fallback_without_registry_defers_to_an_enabled_sdk(captured, monkeypatch):
    _fake_sdk_config(monkeypatch, enabled=True)
    hcost.on_post_api_request(**_kwargs_022())
    hcost.drain(1.0)
    assert captured == []


def test_fallback_without_registry_records_when_sdk_disabled(captured, monkeypatch):
    _fake_sdk_config(monkeypatch, enabled=False)  # SECUREVECTOR_SDK_DISABLED=1
    hcost.on_post_api_request(**_kwargs_022())
    hcost.drain(1.0)
    assert len(captured) == 1


def test_fallback_without_registry_and_no_sdk_records(captured, monkeypatch):
    monkeypatch.setattr(hcost, "_sdk_hooks_from_registry", lambda: None)
    monkeypatch.delitem(sys.modules, "securevector_sdk_hermes.plugin", raising=False)
    hcost.on_post_api_request(**_kwargs_022())
    hcost.drain(1.0)
    assert len(captured) == 1


def test_provider_slugs_map_to_pricing_providers():
    assert hcost.canon_provider("Google") == "gemini"
    assert hcost.canon_provider("xai") == "grok"
    assert hcost.canon_provider("openai-codex") == "openai"
    assert hcost.canon_provider("bedrock") == "bedrock"
    assert hcost.canon_provider(None) == "unknown"


# --- end to end: the app prices the plugin's record -------------------------

@pytest_asyncio.fixture
async def db(tmp_path):
    conn = DatabaseConnection(tmp_path / "costs.db")
    await init_database_schema(conn)
    return conn


@pytest.mark.asyncio
async def test_app_prices_the_022_record_end_to_end(db, monkeypatch):
    import httpx

    monkeypatch.setattr(costs_routes, "get_database", lambda: db)
    app = FastAPI()
    app.include_router(costs_routes.router, prefix="/api")
    body = hcost.build_record(_kwargs_022())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8741") as c:
        r = await c.post("/api/costs/track", json=body)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["pricing_known"] is True
    uncached = 159180 - 136688 - 22451
    assert uncached == 41
    # Haiku 4.5: $1 in, $5 out, cache reads 0.10x, cache writes 1.25x; us. adds 10%.
    expected = 1.1 * (uncached * 1.0 + 2190 * 5.0 + 136688 * 0.10 + 22451 * 1.25) / 1e6
    assert out["total_cost_usd"] == pytest.approx(expected, abs=1e-8)


@pytest.mark.asyncio
@pytest.mark.parametrize("slug, model", [
    ("google", "gemini-3.5-flash"),
    ("vertex_ai", "gemini-3.5-flash"),
    ("xai", "grok-4.5"),
    ("azure", "gpt-5.6-sol"),
    ("openai-codex", "gpt-5.6-sol"),
])
async def test_hermes_provider_slugs_price_in_the_app(db, monkeypatch, slug, model):
    import httpx

    monkeypatch.setattr(costs_routes, "get_database", lambda: db)
    app = FastAPI()
    app.include_router(costs_routes.router, prefix="/api")
    body = hcost.build_record({"usage": {"input_tokens": 1000, "output_tokens": 100},
                               "model": model, "provider": slug, "api_request_id": slug})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8741") as c:
        r = await c.post("/api/costs/track", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["pricing_known"] is True and r.json()["total_cost_usd"] > 0


@pytest.mark.parametrize("url, sent", [
    ("http://127.0.0.1:9999", True), ("http://localhost:9999", True), ("http://[::1]:9999", True),
    ("https://engine.example.com", True), ("http://engine.example.com", False),
])
def test_api_key_goes_only_over_https_or_loopback(captured, monkeypatch, url, sent):
    monkeypatch.setenv("SECUREVECTOR_API_KEY", "k-123")
    hcost._post(url + "/api/costs/track", {"x": 1})
    assert len(captured) == 1
    req, _ = captured[0]
    assert (req.get_header("Authorization") == "Bearer k-123") is sent
    if not sent:
        assert req.get_header("Authorization") is None
