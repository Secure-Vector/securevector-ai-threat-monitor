"""Model-run tracing for any Python agent.

Every model call becomes a *generation* span and lands in the local app's
Traces page next to the ``@guard`` tool calls of the same run: model, tokens,
cost, input and output previews, duration and a verdict.

Two ways in::

    from securevector import guard, instrument

    instrument()                        # OpenAI and Anthropic clients, zero code

    with guard.generation(model="anthropic.claude-3-5-sonnet", provider="bedrock",
                          input=messages) as gen:           # any other provider
        r = bedrock.converse(...)
        gen.end(output=r["output"]["message"],
                usage={"input": r["usage"]["inputTokens"],
                       "output": r["usage"]["outputTokens"]})

Spans are encoded as OTLP/HTTP JSON with the OpenTelemetry GenAI semantic
convention attributes and posted in batches to ``POST /v1/traces`` on the app.
The same endpoint accepts traces from any OpenTelemetry exporter, so an agent
that is already instrumented needs none of this module.

Only the standard library is used. Fail-open: if the app is down the model
call runs unchanged and one warning is logged per process.
"""

from __future__ import annotations

import atexit
import contextvars
import hashlib
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .guard import (
    PREVIEW_LIMIT,
    RUNTIME_KIND,
    SCAN_LIMIT,
    AppTransport,
    GuardBlocked,
    GuardConfig,
    _session,
    _to_text,
    _transport,
    current_session,
    redact,
)

__all__ = ["Span", "Tracer", "Generation", "generation", "encode_otlp", "normalize_usage",
           "current_generation_span", "identity", "get_tracer"]

log = logging.getLogger("securevector.tracing")

FLUSH_INTERVAL_S = 0.2
FLUSH_MAX_SPANS = 200

# --------------------------------------------------------------------------- #
# Identity: who and what this run is                                          #
# --------------------------------------------------------------------------- #

_identity: contextvars.ContextVar[Dict[str, Any]] = contextvars.ContextVar(
    "securevector_identity", default={}
)
_current_generation: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "securevector_generation", default=None
)
# The last generation that ended in this context. An agent loop runs a tool
# after the model call that asked for it has returned, so a tool call links to
# this span when no generation is open. Cleared when the session ends.
_last_generation: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "securevector_last_generation", default=None
)


def identity() -> Dict[str, Any]:
    """The identity set by ``guard.session(...)``: user_id, tags, metadata."""
    return dict(_identity.get())


def current_generation_span() -> Optional[str]:
    """Span id of the model turn a tool call belongs to: the generation open
    in this context, else the most recent one that ended in this session."""
    return _current_generation.get() or _last_generation.get()


def trace_id_for(session_id: str) -> str:
    """Deterministic 32-hex OTel trace id for a session, so spans flushed in
    different batches (or from different processes) share one trace."""
    return hashlib.sha256(f"{RUNTIME_KIND}:{session_id}".encode("utf-8")).hexdigest()[:32]


def new_span_id() -> str:
    return uuid.uuid4().hex[:16]


# --------------------------------------------------------------------------- #
# Span model and OTLP JSON encoding                                           #
# --------------------------------------------------------------------------- #


@dataclass
class Span:
    trace_id: str
    span_id: str
    name: str
    kind: str = "generation"  # generation | tool
    parent_span_id: Optional[str] = None
    start_ns: int = 0
    end_ns: int = 0
    attributes: Dict[str, Any] = field(default_factory=dict)
    events: List[Dict[str, Any]] = field(default_factory=list)
    status_error: Optional[str] = None


def _any_value(v: Any) -> Dict[str, Any]:
    if isinstance(v, bool):
        return {"boolValue": v}
    if isinstance(v, int):
        return {"intValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, (list, tuple)):
        return {"arrayValue": {"values": [_any_value(x) for x in v]}}
    return {"stringValue": _to_text(v) if not isinstance(v, str) else v}


def _kv(attrs: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [{"key": k, "value": _any_value(v)} for k, v in attrs.items() if v is not None]


_SPAN_KIND = {"generation": 3, "tool": 1}  # CLIENT, INTERNAL


def encode_otlp(spans: List[Span], service_name: str = RUNTIME_KIND,
                resource: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """OTLP/HTTP JSON ``ExportTraceServiceRequest`` for one batch."""
    res_attrs = {"service.name": service_name, **(resource or {})}
    out = []
    for s in spans:
        span: Dict[str, Any] = {
            "traceId": s.trace_id,
            "spanId": s.span_id,
            "name": s.name,
            "kind": _SPAN_KIND.get(s.kind, 1),
            "startTimeUnixNano": str(s.start_ns),
            "endTimeUnixNano": str(s.end_ns or s.start_ns),
            "attributes": _kv(s.attributes),
            "events": [
                {"timeUnixNano": str(e.get("time_ns") or s.end_ns or s.start_ns),
                 "name": e["name"], "attributes": _kv(e.get("attributes") or {})}
                for e in s.events
            ],
        }
        if s.parent_span_id:
            span["parentSpanId"] = s.parent_span_id
        if s.status_error:
            span["status"] = {"code": 2, "message": s.status_error}
        out.append(span)
    return {
        "resourceSpans": [{
            "resource": {"attributes": _kv(res_attrs)},
            "scopeSpans": [{
                "scope": {"name": "securevector", "version": "5.3.0"},
                "spans": out,
            }],
        }]
    }


# --------------------------------------------------------------------------- #
# Tracer: buffer and flush                                                    #
# --------------------------------------------------------------------------- #


class Tracer:
    """Per-process span buffer. Flushes at most every 200 ms, on 200 spans,
    and at interpreter exit. Never raises."""

    def __init__(self, cfg: Optional[GuardConfig] = None, transport: Optional[AppTransport] = None):
        self.cfg = cfg or GuardConfig.from_env()
        self.transport = transport or _transport(self.cfg)
        self._buf: List[Span] = []
        self._lock = threading.Lock()
        self._timer: Optional[threading.Timer] = None
        atexit.register(self.flush)

    def record(self, span: Span) -> None:
        if not self.cfg.enabled:
            return
        with self._lock:
            self._buf.append(span)
            full = len(self._buf) >= FLUSH_MAX_SPANS
            if self._timer is None and not full:
                self._timer = threading.Timer(FLUSH_INTERVAL_S, self.flush)
                self._timer.daemon = True
                self._timer.start()
        if full:
            self.flush()

    def flush(self) -> int:
        """Send everything buffered. Returns the number of spans sent."""
        with self._lock:
            spans, self._buf = self._buf, []
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
        if not spans:
            return 0
        body = encode_otlp(spans)
        try:
            self.transport._post("/v1/traces", body)
        except Exception as exc:  # noqa: BLE001 - tracing must never break the agent
            self.transport._warn_once(exc)
            return 0
        return len(spans)


_tracer: Optional[Tracer] = None
_tracer_lock = threading.Lock()


def get_tracer() -> Tracer:
    global _tracer
    with _tracer_lock:
        if _tracer is None:
            _tracer = Tracer()
        return _tracer


def set_tracer(tracer: Optional[Tracer]) -> None:
    """Test hook: replace the process tracer."""
    global _tracer
    with _tracer_lock:
        _tracer = tracer


# --------------------------------------------------------------------------- #
# Usage normalisation                                                         #
# --------------------------------------------------------------------------- #


def _get(obj: Any, *names: str) -> Any:
    for n in names:
        if obj is None:
            return None
        if isinstance(obj, dict):
            v = obj.get(n)
        else:
            v = getattr(obj, n, None)
        if v is not None:
            return v
    return None


def normalize_usage(usage: Any) -> Dict[str, int]:
    """Accept the plain ``{"input","output","cache_read"}`` shape, the OpenAI
    usage object (``prompt_tokens`` ...), the Anthropic one (``input_tokens``
    ...) and Bedrock's (``inputTokens`` ...). Returns ints, missing as 0."""
    if usage is None:
        return {"input": 0, "output": 0, "cache_read": 0}
    inp = _get(usage, "input", "input_tokens", "prompt_tokens", "inputTokens")
    out = _get(usage, "output", "output_tokens", "completion_tokens", "outputTokens")
    cached = _get(usage, "cache_read", "input_cached", "cache_read_input_tokens", "cacheReadInputTokens")
    if cached is None:
        details = _get(usage, "prompt_tokens_details", "input_tokens_details")
        cached = _get(details, "cached_tokens")
    return {"input": int(inp or 0), "output": int(out or 0), "cache_read": int(cached or 0)}


# --------------------------------------------------------------------------- #
# Generation span                                                             #
# --------------------------------------------------------------------------- #


def _content(value: Any) -> str:
    text = _to_text(value)
    return text[:SCAN_LIMIT]


class Generation:
    """One model call. Use as a context manager, sync or async."""

    def __init__(self, model: Optional[str], provider: Optional[str] = None, input: Any = None, *,
                 name: Optional[str] = None, mode: Optional[str] = None,
                 tracer: Optional[Tracer] = None, operation: str = "chat"):
        self.model = model or "unknown"
        self.provider = provider
        self.input = input
        self.name = name or f"{operation} {self.model}"
        self.operation = operation
        self.tracer = tracer or get_tracer()
        self.cfg = self.tracer.cfg
        self.mode = mode if mode in ("observe", "enforce") else self.cfg.mode
        self.span_id = new_span_id()
        self.session_id = current_session()
        self.request_id = uuid.uuid4().hex[:16]
        self.span: Optional[Span] = None
        self._ended = False
        self._token: Optional[contextvars.Token] = None
        self.verdict = None

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> "Generation":
        if not self.cfg.enabled:
            return self
        prompt = _content(self.input) if self.input is not None else ""
        if self.mode == "enforce" and prompt:
            v = self.tracer.transport.analyze(prompt, "outgoing",
                                              session_id=self.session_id, request_id=self.request_id)
            self.verdict = v
            if v is not None and v.finding and v.risk_score >= self.cfg.threat_risk_threshold:
                raise GuardBlocked(self.name, v.reason, v.risk_score)
        ident = identity()
        attrs: Dict[str, Any] = {
            "gen_ai.operation.name": self.operation,
            "gen_ai.request.model": self.model,
            "session.id": self.session_id,
            "securevector.request_id": self.request_id,
        }
        if self.provider:
            attrs["gen_ai.system"] = self.provider
        if ident.get("user_id"):
            attrs["user.id"] = ident["user_id"]
        if ident.get("tags"):
            attrs["session.tags"] = list(ident["tags"])
        for k, v in (ident.get("metadata") or {}).items():
            attrs[f"session.metadata.{k}"] = v
        self.span = Span(
            trace_id=trace_id_for(self.session_id), span_id=self.span_id, name=self.name,
            kind="generation", parent_span_id=_current_generation.get(),
            start_ns=time.time_ns(), attributes=attrs,
        )
        if prompt:
            self.span.events.append({"name": "gen_ai.content.prompt", "time_ns": self.span.start_ns,
                                     "attributes": {"gen_ai.prompt": redact(prompt, SCAN_LIMIT)}})
        self._token = _current_generation.set(self.span_id)
        return self

    def end(self, output: Any = None, usage: Any = None, *, finish_reason: Optional[str] = None,
            response_model: Optional[str] = None, error: Optional[BaseException] = None) -> None:
        """Close the span. Safe to call more than once; later calls are ignored."""
        if self._ended or self.span is None:
            return
        self._ended = True
        s = self.span
        s.end_ns = time.time_ns()
        u = normalize_usage(usage)
        s.attributes["gen_ai.usage.input_tokens"] = u["input"]
        s.attributes["gen_ai.usage.output_tokens"] = u["output"]
        if u["cache_read"]:
            s.attributes["gen_ai.usage.cache_read.input_tokens"] = u["cache_read"]
        if response_model:
            s.attributes["gen_ai.response.model"] = response_model
        if finish_reason:
            s.attributes["gen_ai.response.finish_reasons"] = [finish_reason]
        if output is not None:
            s.events.append({"name": "gen_ai.content.completion", "time_ns": s.end_ns,
                             "attributes": {"gen_ai.completion": redact(_content(output), SCAN_LIMIT)}})
        if error is not None:
            s.status_error = f"{error.__class__.__name__}: {error}"[:PREVIEW_LIMIT]
            s.attributes["error.type"] = error.__class__.__name__
        if self._token is not None:
            try:
                _current_generation.reset(self._token)
            except ValueError:  # ended in a different context (async task); fall back
                _current_generation.set(None)
            self._token = None
        _last_generation.set(self.span_id)
        self.tracer.record(s)

    # -- context manager protocol -----------------------------------------

    def __enter__(self) -> "Generation":
        return self.start()

    def __exit__(self, exc_type, exc, tb) -> None:
        self.end(error=exc if exc is not None and not isinstance(exc, GuardBlocked) else None)

    async def __aenter__(self) -> "Generation":
        return self.start()

    async def __aexit__(self, exc_type, exc, tb) -> None:
        self.__exit__(exc_type, exc, tb)


def generation(model: Optional[str] = None, provider: Optional[str] = None, input: Any = None, *,
               name: Optional[str] = None, mode: Optional[str] = None,
               tracer: Optional[Tracer] = None) -> Generation:
    """Open a generation span for one model call. See the module docstring."""
    return Generation(model, provider, input, name=name, mode=mode, tracer=tracer)


# Re-exported so guard.session can set identity without importing this module
# at import time (guard imports nothing from tracing).
def set_identity(user_id: Optional[str], tags: Optional[List[str]], metadata: Optional[Dict[str, Any]]):
    """Called by ``guard.session``: stamp the identity and start with no
    previous model turn, so tool calls never link across sessions."""
    ident = _identity.set({
        k: v for k, v in (("user_id", user_id), ("tags", tags), ("metadata", metadata)) if v
    })
    return ident, _last_generation.set(None)


def reset_identity(token) -> None:
    ident, last = token
    _identity.reset(ident)
    try:
        _last_generation.reset(last)
    except ValueError:  # session left in a different context
        _last_generation.set(None)


_ = _session  # keep the import explicit: session ids live in guard
