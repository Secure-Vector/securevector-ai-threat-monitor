"""``instrument()``: make the OpenAI and Anthropic Python clients emit
generation spans without touching the calling code.

    from securevector import instrument
    instrument()                 # patches whichever of openai, anthropic is installed

Each ``create`` call opens a generation span (model, prompt preview), and
closes it with the response's usage, finish reason and output preview.
Streaming responses are wrapped so the span closes when the stream is
exhausted. Patching is idempotent and fail-open: an error inside the
instrumentation never reaches the caller, and the original call always runs.
"""

from __future__ import annotations

import functools
import importlib
import logging
from typing import Any, Callable, Dict, List, Optional

from .guard import GuardBlocked
from .tracing import Generation, _get

__all__ = ["instrument"]

log = logging.getLogger("securevector.instrument")

_MARK = "_securevector_patched"


# --------------------------------------------------------------------------- #
# Result extraction, one small function per provider shape                    #
# --------------------------------------------------------------------------- #


def _openai_chat_result(r: Any) -> Dict[str, Any]:
    choice = (_get(r, "choices") or [None])[0]
    msg = _get(choice, "message")
    return {"output": _get(msg, "content"), "usage": _get(r, "usage"),
            "finish_reason": _get(choice, "finish_reason"), "response_model": _get(r, "model")}


def _openai_responses_result(r: Any) -> Dict[str, Any]:
    return {"output": _get(r, "output_text"), "usage": _get(r, "usage"),
            "finish_reason": _get(r, "status"), "response_model": _get(r, "model")}


def _anthropic_result(r: Any) -> Dict[str, Any]:
    blocks = _get(r, "content") or []
    text = "".join(str(_get(b, "text") or "") for b in blocks) if isinstance(blocks, list) else blocks
    return {"output": text, "usage": _get(r, "usage"),
            "finish_reason": _get(r, "stop_reason"), "response_model": _get(r, "model")}


class _StreamState:
    """Accumulates what a streamed response reveals chunk by chunk."""

    def __init__(self) -> None:
        self.text: List[str] = []
        self.usage: Any = None
        self.input_tokens: Optional[int] = None
        self.finish_reason: Optional[str] = None
        self.model: Optional[str] = None

    def result(self) -> Dict[str, Any]:
        usage = self.usage
        if usage is None and self.input_tokens is not None:
            usage = {"input": self.input_tokens, "output": 0}
        elif self.input_tokens is not None and isinstance(usage, dict) and not usage.get("input"):
            usage = {**usage, "input": self.input_tokens}
        return {"output": "".join(self.text), "usage": usage,
                "finish_reason": self.finish_reason, "response_model": self.model}


def _openai_chat_chunk(st: _StreamState, chunk: Any) -> None:
    if _get(chunk, "usage") is not None:
        st.usage = _get(chunk, "usage")
    st.model = _get(chunk, "model") or st.model
    choice = (_get(chunk, "choices") or [None])[0]
    delta = _get(choice, "delta")
    piece = _get(delta, "content")
    if piece:
        st.text.append(str(piece))
    if _get(choice, "finish_reason"):
        st.finish_reason = _get(choice, "finish_reason")


def _openai_responses_chunk(st: _StreamState, event: Any) -> None:
    kind = _get(event, "type") or ""
    if kind == "response.output_text.delta":
        st.text.append(str(_get(event, "delta") or ""))
    elif kind == "response.completed":
        resp = _get(event, "response")
        st.usage = _get(resp, "usage")
        st.model = _get(resp, "model")
        st.finish_reason = _get(resp, "status")


def _anthropic_chunk(st: _StreamState, event: Any) -> None:
    kind = _get(event, "type") or ""
    if kind == "message_start":
        msg = _get(event, "message")
        st.model = _get(msg, "model")
        st.input_tokens = int(_get(_get(msg, "usage"), "input_tokens") or 0)
    elif kind == "content_block_delta":
        piece = _get(_get(event, "delta"), "text")
        if piece:
            st.text.append(str(piece))
    elif kind == "message_delta":
        out = _get(_get(event, "usage"), "output_tokens")
        st.usage = {"input": st.input_tokens or 0, "output": int(out or 0)}
        st.finish_reason = _get(_get(event, "delta"), "stop_reason") or st.finish_reason


# --------------------------------------------------------------------------- #
# Stream proxies                                                              #
# --------------------------------------------------------------------------- #


class _SyncStream:
    def __init__(self, inner: Any, gen: Generation, on_chunk: Callable[[_StreamState, Any], None]):
        self._inner, self._gen, self._on_chunk, self._st = inner, gen, on_chunk, _StreamState()

    def __iter__(self):
        try:
            for chunk in self._inner:
                try:
                    self._on_chunk(self._st, chunk)
                except Exception:  # noqa: BLE001
                    pass
                yield chunk
        except BaseException as exc:
            self._gen.end(error=exc, **self._st.result())
            raise
        self._gen.end(**self._st.result())

    def __enter__(self):
        return self

    def __exit__(self, *a):
        close = getattr(self._inner, "close", None)
        if close:
            close()
        self._gen.end(**self._st.result())

    def __getattr__(self, name):
        return getattr(self._inner, name)


class _AsyncStream:
    def __init__(self, inner: Any, gen: Generation, on_chunk: Callable[[_StreamState, Any], None]):
        self._inner, self._gen, self._on_chunk, self._st = inner, gen, on_chunk, _StreamState()

    async def __aiter__(self):
        try:
            async for chunk in self._inner:
                try:
                    self._on_chunk(self._st, chunk)
                except Exception:  # noqa: BLE001
                    pass
                yield chunk
        except BaseException as exc:
            self._gen.end(error=exc, **self._st.result())
            raise
        self._gen.end(**self._st.result())

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        self._gen.end(**self._st.result())

    def __getattr__(self, name):
        return getattr(self._inner, name)


# --------------------------------------------------------------------------- #
# Patching                                                                    #
# --------------------------------------------------------------------------- #


def _open(provider: str, kw: Dict[str, Any]) -> Optional[Generation]:
    """Start a generation for one call; None means 'do not instrument this call'."""
    try:
        gen = Generation(model=kw.get("model"), provider=provider,
                         input=kw.get("messages") or kw.get("input") or kw.get("prompt"))
        return gen.start()
    except GuardBlocked:
        raise
    except Exception as exc:  # noqa: BLE001
        log.debug("instrumentation skipped a call: %s", exc)
        return None


def _patch(cls: Any, attr: str, provider: str, extract: Callable[[Any], Dict[str, Any]],
           on_chunk: Callable[[_StreamState, Any], None], *, is_async: bool,
           inject_usage: bool = False) -> bool:
    orig = getattr(cls, attr, None)
    if orig is None or getattr(orig, _MARK, False):
        return False

    if is_async:
        @functools.wraps(orig)
        async def wrapper(self, *a, **kw):
            if kw.get("stream") and inject_usage:
                kw.setdefault("stream_options", {"include_usage": True})
            gen = _open(provider, kw)
            if gen is None:
                return await orig(self, *a, **kw)
            try:
                result = await orig(self, *a, **kw)
            except BaseException as exc:
                gen.end(error=exc)
                raise
            if kw.get("stream"):
                return _AsyncStream(result, gen, on_chunk)
            try:
                gen.end(**extract(result))
            except Exception:  # noqa: BLE001
                gen.end()
            return result
    else:
        @functools.wraps(orig)
        def wrapper(self, *a, **kw):
            if kw.get("stream") and inject_usage:
                kw.setdefault("stream_options", {"include_usage": True})
            gen = _open(provider, kw)
            if gen is None:
                return orig(self, *a, **kw)
            try:
                result = orig(self, *a, **kw)
            except BaseException as exc:
                gen.end(error=exc)
                raise
            if kw.get("stream"):
                return _SyncStream(result, gen, on_chunk)
            try:
                gen.end(**extract(result))
            except Exception:  # noqa: BLE001
                gen.end()
            return result

    setattr(wrapper, _MARK, True)
    setattr(cls, attr, wrapper)
    return True


def _patch_openai() -> bool:
    chat = importlib.import_module("openai.resources.chat.completions")
    done = _patch(chat.Completions, "create", "openai", _openai_chat_result, _openai_chat_chunk,
                  is_async=False, inject_usage=True)
    done |= _patch(chat.AsyncCompletions, "create", "openai", _openai_chat_result, _openai_chat_chunk,
                   is_async=True, inject_usage=True)
    try:
        responses = importlib.import_module("openai.resources.responses")
    except ImportError:
        responses = None
    if responses is not None:
        done |= _patch(getattr(responses, "Responses", None), "create", "openai",
                       _openai_responses_result, _openai_responses_chunk, is_async=False)
        done |= _patch(getattr(responses, "AsyncResponses", None), "create", "openai",
                       _openai_responses_result, _openai_responses_chunk, is_async=True)
    return done


def _patch_anthropic() -> bool:
    messages = importlib.import_module("anthropic.resources.messages")
    done = _patch(messages.Messages, "create", "anthropic", _anthropic_result, _anthropic_chunk,
                  is_async=False)
    done |= _patch(messages.AsyncMessages, "create", "anthropic", _anthropic_result, _anthropic_chunk,
                   is_async=True)
    return done


_PATCHERS: Dict[str, Callable[[], bool]] = {"openai": _patch_openai, "anthropic": _patch_anthropic}


def instrument(*providers: str) -> List[str]:
    """Patch the named provider clients (default: every supported one that is
    installed). Returns the providers patched on this call; a second call
    returns an empty list. Unknown or missing providers are skipped."""
    names = providers or tuple(_PATCHERS)
    patched: List[str] = []
    for name in names:
        patcher = _PATCHERS.get(name)
        if patcher is None:
            log.warning("instrument(): unknown provider %r (supported: %s)", name, ", ".join(_PATCHERS))
            continue
        try:
            if patcher():
                patched.append(name)
        except ImportError:
            log.debug("instrument(): %s is not installed, skipped", name)
        except Exception as exc:  # noqa: BLE001
            log.warning("instrument(): could not patch %s (%s); calls run unrecorded", name, exc)
    return patched
