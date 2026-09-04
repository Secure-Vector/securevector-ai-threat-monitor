"""Tests for securevector.instrument against fake openai and anthropic modules."""

import asyncio
import sys
import types
from types import SimpleNamespace as NS

import pytest

from securevector.guard import AppTransport, GuardConfig, Verdict
from securevector.instrument import instrument
from securevector.tracing import Tracer, set_tracer


class FakeTransport(AppTransport):
    def __init__(self):
        super().__init__(GuardConfig())
        self.posts = []

    def _post(self, path, body):
        self.posts.append((path, body))
        return {}

    def analyze(self, text, direction, *, session_id, request_id):
        return Verdict(False, 0, "clean")


def spans(t):
    out = []
    for path, body in t.posts:
        if path == "/v1/traces":
            out.extend(body["resourceSpans"][0]["scopeSpans"][0]["spans"])
    return out


def attr(span, key):
    for a in span["attributes"]:
        if a["key"] == key:
            v = a["value"]
            return int(v["intValue"]) if "intValue" in v else v.get("stringValue")
    return None


def event_attr(span, name, key):
    for e in span["events"]:
        if e["name"] == name:
            return attr(e, key)
    return None


# --------------------------------------------------------------------------- #
# Fake provider modules                                                       #
# --------------------------------------------------------------------------- #


def _module(name):
    m = types.ModuleType(name)
    sys.modules[name] = m
    return m


def make_fake_openai():
    class Completions:
        def create(self, **kw):
            if kw.get("fail"):
                raise RuntimeError("rate limited")
            if kw.get("stream"):
                assert kw["stream_options"] == {"include_usage": True}
                return iter([
                    NS(model="gpt-4o", choices=[NS(delta=NS(content="hel"), finish_reason=None)], usage=None),
                    NS(model="gpt-4o", choices=[NS(delta=NS(content="lo"), finish_reason="stop")], usage=None),
                    NS(model="gpt-4o", choices=[], usage=NS(prompt_tokens=7, completion_tokens=2)),
                ])
            return NS(model="gpt-4o-2024", usage=NS(prompt_tokens=7, completion_tokens=3),
                      choices=[NS(message=NS(content="hello"), finish_reason="stop")])

    class AsyncCompletions:
        async def create(self, **kw):
            return NS(model="gpt-4o", usage=NS(prompt_tokens=1, completion_tokens=1),
                      choices=[NS(message=NS(content="async hello"), finish_reason="stop")])

    class Responses:
        def create(self, **kw):
            return NS(model="gpt-4.1", usage=NS(input_tokens=4, output_tokens=6), output_text="resp", status="completed")

    root = _module("openai")
    _module("openai.resources")
    _module("openai.resources.chat")
    chat = _module("openai.resources.chat.completions")
    chat.Completions, chat.AsyncCompletions = Completions, AsyncCompletions
    responses = _module("openai.resources.responses")
    responses.Responses = Responses
    responses.AsyncResponses = None

    class OpenAI:
        def __init__(self):
            self.chat = NS(completions=Completions())
            self.responses = Responses()

    class AsyncOpenAI:
        def __init__(self):
            self.chat = NS(completions=AsyncCompletions())

    root.OpenAI, root.AsyncOpenAI = OpenAI, AsyncOpenAI
    return root


def make_fake_anthropic():
    class Messages:
        def create(self, **kw):
            if kw.get("stream"):
                return iter([
                    NS(type="message_start", message=NS(model="claude-3-5", usage=NS(input_tokens=11))),
                    NS(type="content_block_delta", delta=NS(text="Hi ")),
                    NS(type="content_block_delta", delta=NS(text="there")),
                    NS(type="message_delta", delta=NS(stop_reason="end_turn"), usage=NS(output_tokens=4)),
                ])
            return NS(model="claude-3-5", usage=NS(input_tokens=11, output_tokens=4, cache_read_input_tokens=5),
                      content=[NS(text="Hi there")], stop_reason="end_turn")

    class AsyncMessages:
        async def create(self, **kw):
            return NS(model="claude-3-5", usage=NS(input_tokens=1, output_tokens=1),
                      content=[NS(text="a")], stop_reason="end_turn")

    root = _module("anthropic")
    _module("anthropic.resources")
    messages = _module("anthropic.resources.messages")
    messages.Messages, messages.AsyncMessages = Messages, AsyncMessages

    class Anthropic:
        def __init__(self):
            self.messages = Messages()

    root.Anthropic = Anthropic
    return root


@pytest.fixture
def providers(monkeypatch):
    saved = {k: v for k, v in sys.modules.items() if k.split(".")[0] in ("openai", "anthropic")}
    for k in saved:
        del sys.modules[k]
    openai = make_fake_openai()
    anthropic = make_fake_anthropic()
    t = FakeTransport()
    tr = Tracer(GuardConfig(), t)
    set_tracer(tr)
    yield NS(openai=openai, anthropic=anthropic, t=t, tr=tr)
    set_tracer(None)
    for k in [k for k in sys.modules if k.split(".")[0] in ("openai", "anthropic")]:
        del sys.modules[k]
    sys.modules.update(saved)


# --------------------------------------------------------------------------- #
# Tests                                                                       #
# --------------------------------------------------------------------------- #


def test_instrument_openai_chat_records_generation(providers):
    assert instrument("openai") == ["openai"]
    client = providers.openai.OpenAI()
    r = client.chat.completions.create(model="gpt-4o", messages=[{"role": "user", "content": "hi"}])
    assert r.choices[0].message.content == "hello", "the original result is returned untouched"
    providers.tr.flush()
    (span,) = spans(providers.t)
    assert attr(span, "gen_ai.system") == "openai"
    assert attr(span, "gen_ai.request.model") == "gpt-4o"
    assert attr(span, "gen_ai.response.model") == "gpt-4o-2024"
    assert attr(span, "gen_ai.usage.input_tokens") == 7
    assert attr(span, "gen_ai.usage.output_tokens") == 3
    assert '"content": "hi"' in event_attr(span, "gen_ai.content.prompt", "gen_ai.prompt")
    assert event_attr(span, "gen_ai.content.completion", "gen_ai.completion") == "hello"


def test_instrument_is_idempotent_and_reports_missing_and_unknown(providers):
    assert instrument() == ["openai", "anthropic"]
    assert instrument() == []
    assert instrument("bogus") == []


def test_instrument_openai_stream_closes_span_when_exhausted(providers):
    instrument("openai")
    client = providers.openai.OpenAI()
    chunks = list(client.chat.completions.create(model="gpt-4o", messages=[], stream=True))
    assert len(chunks) == 3
    providers.tr.flush()
    (span,) = spans(providers.t)
    assert attr(span, "gen_ai.usage.input_tokens") == 7
    assert attr(span, "gen_ai.usage.output_tokens") == 2
    assert event_attr(span, "gen_ai.content.completion", "gen_ai.completion") == "hello"


def test_instrument_openai_responses_api(providers):
    instrument("openai")
    client = providers.openai.OpenAI()
    client.responses.create(model="gpt-4.1", input="q")
    providers.tr.flush()
    (span,) = spans(providers.t)
    assert attr(span, "gen_ai.usage.input_tokens") == 4 and attr(span, "gen_ai.usage.output_tokens") == 6
    assert event_attr(span, "gen_ai.content.completion", "gen_ai.completion") == "resp"


def test_instrument_async_openai(providers):
    instrument("openai")
    client = providers.openai.AsyncOpenAI()
    r = asyncio.run(client.chat.completions.create(model="gpt-4o", messages=[]))
    assert r.choices[0].message.content == "async hello"
    providers.tr.flush()
    (span,) = spans(providers.t)
    assert attr(span, "gen_ai.usage.output_tokens") == 1


def test_instrument_anthropic_sync_and_stream(providers):
    assert instrument("anthropic") == ["anthropic"]
    client = providers.anthropic.Anthropic()
    client.messages.create(model="claude-3-5", messages=[{"role": "user", "content": "x"}])
    list(client.messages.create(model="claude-3-5", messages=[], stream=True))
    providers.tr.flush()
    s1, s2 = spans(providers.t)
    assert attr(s1, "gen_ai.usage.input_tokens") == 11 and attr(s1, "gen_ai.usage.output_tokens") == 4
    assert attr(s1, "gen_ai.usage.cache_read.input_tokens") == 5
    assert event_attr(s1, "gen_ai.content.completion", "gen_ai.completion") == "Hi there"
    assert attr(s2, "gen_ai.usage.input_tokens") == 11 and attr(s2, "gen_ai.usage.output_tokens") == 4
    assert event_attr(s2, "gen_ai.content.completion", "gen_ai.completion") == "Hi there"


def test_provider_error_is_recorded_and_re_raised(providers):
    instrument("openai")
    with pytest.raises(RuntimeError):
        providers.openai.OpenAI().chat.completions.create(model="m", messages=[], fail=True)
    providers.tr.flush()
    (span,) = spans(providers.t)
    assert attr(span, "error.type") == "RuntimeError"
