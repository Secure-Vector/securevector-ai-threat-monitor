"""One decorator that puts any Python function under SecureVector.

    from securevector import guard

    @guard
    def search_web(query: str) -> str:
        ...

    @guard(tool_id="db.query", mode="enforce")
    async def run_sql(sql: str) -> list[dict]:
        ...

Every call is scanned on the way in (arguments, as user-to-tool text) and on
the way out (return value, as fetched context heading back to the model), and
lands as one row in the running local app: Tool Activity, Agent Runs and the
tamper-evident audit chain, grouped by session.

Fail-open by default. If the app is not running the wrapped function still
runs and nothing is raised; one warning is logged per process. In
``mode="enforce"`` a finding on the arguments stops the call with
:class:`GuardBlocked`; a finding on the output is always recorded, never
raised, because the result already exists.

Configuration is read once from the environment, using the same variable
names as the framework SDKs:

    SECUREVECTOR_ENGINE_ENDPOINT / SECUREVECTOR_SDK_APP_URL  app or self-hosted engine URL
    SECUREVECTOR_SDK_MODE            observe (default) | enforce
    SECUREVECTOR_SDK_RISK_THRESHOLD  risk_score at or above which enforce blocks (70)
    SECUREVECTOR_SDK_TIMEOUT_MS      per-request timeout (3000)
    SECUREVECTOR_SDK_AGENT_ID        agent name shown in the app
    SECUREVECTOR_SDK_DISABLED        1 turns the decorator into a no-op
    SECUREVECTOR_API_KEY             forwarded as a bearer token to a self-hosted engine

Only the standard library is used, so importing this module costs nothing.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import functools
import inspect
import json
import logging
import os
import re
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, replace
from typing import Any, Callable, Dict, Iterator, Optional

__all__ = ["guard", "GuardBlocked", "GuardConfig", "session"]

log = logging.getLogger("securevector.guard")

DEFAULT_APP_URL = "http://127.0.0.1:8741"
RUNTIME_KIND = "python"
PREVIEW_LIMIT = 500
SCAN_LIMIT = 102400  # the app's /analyze body cap

# Keep obvious secrets out of the preview we send. The app redacts too.
_REDACTIONS = [
    (re.compile(r"AKIA[A-Z0-9]{16}"), "AKIA[REDACTED]"),
    (re.compile(r"ghp_[A-Za-z0-9]{36}"), "ghp_[REDACTED]"),
    (re.compile(r"sk-[A-Za-z0-9]{20,}"), "sk-[REDACTED]"),
    (re.compile(r"(?i)(password\"?\s*[:=]\s*\")[^\"]+(\")"), r"\1[REDACTED]\2"),
]


class GuardBlocked(RuntimeError):
    """Raised in enforce mode when the arguments of a guarded call are a finding."""

    def __init__(self, tool_id: str, reason: str, risk_score: int):
        super().__init__(f"SecureVector blocked {tool_id}: {reason}")
        self.tool_id = tool_id
        self.reason = reason
        self.risk_score = risk_score


def _truthy(val: str) -> bool:
    return str(val).strip().lower() in ("1", "true", "yes", "on")


@dataclass
class GuardConfig:
    base_url: str = DEFAULT_APP_URL
    mode: str = "observe"
    timeout_ms: int = 3000
    threat_risk_threshold: int = 70
    agent_id: str = ""
    enabled: bool = True
    api_key: str = ""

    @classmethod
    def from_env(cls, **overrides: Any) -> "GuardConfig":
        cfg = cls(
            base_url=os.environ.get("SECUREVECTOR_ENGINE_ENDPOINT")
            or os.environ.get("SECUREVECTOR_SDK_APP_URL", DEFAULT_APP_URL),
            mode=os.environ.get("SECUREVECTOR_SDK_MODE", "observe").strip().lower(),
            timeout_ms=int(os.environ.get("SECUREVECTOR_SDK_TIMEOUT_MS", "3000")),
            threat_risk_threshold=int(os.environ.get("SECUREVECTOR_SDK_RISK_THRESHOLD", "70")),
            agent_id=os.environ.get("SECUREVECTOR_SDK_AGENT_ID", ""),
            enabled=not _truthy(os.environ.get("SECUREVECTOR_SDK_DISABLED", "")),
            api_key=os.environ.get("SECUREVECTOR_API_KEY", ""),
        )
        for key, value in overrides.items():
            if value is not None and hasattr(cfg, key):
                setattr(cfg, key, value)
        if cfg.mode not in ("observe", "enforce"):
            cfg.mode = "observe"
        cfg.base_url = cfg.base_url.rstrip("/")
        return cfg


@dataclass
class Verdict:
    finding: bool
    risk_score: int
    reason: str


class AppTransport:
    """Minimal HTTP client for the two routes the decorator needs."""

    def __init__(self, cfg: GuardConfig):
        self.cfg = cfg
        self._warned = False

    def _post(self, path: str, body: Dict[str, Any]) -> Any:
        data = json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.cfg.api_key:
            headers["Authorization"] = f"Bearer {self.cfg.api_key}"
        req = urllib.request.Request(self.cfg.base_url + path, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=self.cfg.timeout_ms / 1000.0) as resp:  # noqa: S310
            raw = resp.read()
        return json.loads(raw.decode("utf-8")) if raw else None

    def _warn_once(self, exc: Exception) -> None:
        if not self._warned:
            self._warned = True
            log.warning(
                "SecureVector app not reachable at %s (%s); guarded calls run unscanned. "
                "Start it with `securevector-app` or set SECUREVECTOR_ENGINE_ENDPOINT.",
                self.cfg.base_url,
                exc.__class__.__name__,
            )

    def analyze(self, text: str, direction: str, *, session_id: str, request_id: str) -> Optional[Verdict]:
        """Return a Verdict, or None when the app could not be reached."""
        if not text:
            return Verdict(False, 0, "empty")
        body = {
            "text": text[:SCAN_LIMIT],
            "direction": direction,
            "source": RUNTIME_KIND,
            "session_id": session_id[:64],
            "request_id": request_id[:64],
        }
        try:
            res = self._post("/analyze", body)
        except (urllib.error.URLError, OSError, ValueError) as exc:
            self._warn_once(exc)
            return None
        if not isinstance(res, dict):
            return Verdict(False, 0, "no-result")
        risk = int(res.get("risk_score") or 0)
        is_threat = bool(res.get("is_threat", False))
        has_secret = bool(res.get("redacted_text")) or res.get("action_taken") in ("redact", "block")
        reason = res.get("threat_type") or ("secret" if has_secret else "clean")
        return Verdict(is_threat or has_secret, risk, f"{direction} {reason} risk={risk}")

    def record_audit(self, **fields: Any) -> None:
        body = {"is_essential": False, **fields}
        try:
            self._post("/api/tool-permissions/call-audit", body)
        except Exception as exc:  # never let audit failure break the agent
            log.debug("audit post failed: %s", exc)


# --------------------------------------------------------------------------- #
# Session context                                                             #
# --------------------------------------------------------------------------- #

_session: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("securevector_session", default=None)
_process_session = f"py-{uuid.uuid4().hex[:12]}"


def current_session() -> str:
    return _session.get() or _process_session


@contextlib.contextmanager
def session(session_id: str) -> Iterator[str]:
    """Group every guarded call inside the block under one run in the app."""
    token = _session.set(str(session_id))
    try:
        yield str(session_id)
    finally:
        _session.reset(token)


# --------------------------------------------------------------------------- #
# Previews                                                                    #
# --------------------------------------------------------------------------- #

def redact(text: object, limit: int = PREVIEW_LIMIT) -> str:
    if not text:
        return ""
    s = str(text)
    for pattern, repl in _REDACTIONS:
        s = pattern.sub(repl, s)
    return s[:limit]


def _to_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        return repr(value)


def _args_text(fn: Callable[..., Any], args: tuple, kwargs: dict) -> str:
    try:
        bound = inspect.signature(fn).bind_partial(*args, **kwargs)
        named = dict(bound.arguments)
    except (TypeError, ValueError):
        named = {"args": list(args), **kwargs}
    named.pop("self", None)
    named.pop("cls", None)
    return _to_text(named)


# --------------------------------------------------------------------------- #
# The decorator                                                               #
# --------------------------------------------------------------------------- #

_default_transport: Optional[AppTransport] = None


def _transport(cfg: GuardConfig) -> AppTransport:
    global _default_transport
    if _default_transport is None or _default_transport.cfg is not cfg:
        _default_transport = AppTransport(cfg)
    return _default_transport


class _Guard:
    def __init__(self, fn: Callable[..., Any], tool_id: str, cfg: GuardConfig,
                 transport: AppTransport, scan_output: bool):
        self.fn = fn
        self.tool_id = tool_id
        self.cfg = cfg
        self.transport = transport
        self.scan_output = scan_output

    def _blocks(self, verdict: Optional[Verdict]) -> bool:
        return (
            verdict is not None
            and verdict.finding
            and self.cfg.mode == "enforce"
            and verdict.risk_score >= self.cfg.threat_risk_threshold
        )

    def before(self, args: tuple, kwargs: dict) -> Dict[str, Any]:
        sid, rid = current_session(), uuid.uuid4().hex[:16]
        text = _args_text(self.fn, args, kwargs)
        ctx = {"session_id": sid, "request_id": rid, "preview": redact(text), "verdict": None}
        if not self.cfg.enabled:
            return ctx
        verdict = self.transport.analyze(text, "outgoing", session_id=sid, request_id=rid)
        ctx["verdict"] = verdict
        if self._blocks(verdict):
            self._audit(ctx, "block", verdict.reason, verdict.risk_score)
            raise GuardBlocked(self.tool_id, verdict.reason, verdict.risk_score)
        return ctx

    def after(self, ctx: Dict[str, Any], result: Any) -> None:
        if not self.cfg.enabled:
            return
        verdict: Optional[Verdict] = ctx["verdict"]
        out: Optional[Verdict] = None
        if self.scan_output:
            out = self.transport.analyze(
                _to_text(result), "incoming", session_id=ctx["session_id"], request_id=ctx["request_id"]
            )
        findings = [v for v in (verdict, out) if v is not None and v.finding]
        if findings:
            worst = max(findings, key=lambda v: v.risk_score)
            self._audit(ctx, "log_only", worst.reason, worst.risk_score)
        else:
            self._audit(ctx, "allow", None, None)

    def failed(self, ctx: Dict[str, Any], exc: BaseException) -> None:
        if self.cfg.enabled:
            self._audit(ctx, "allow", f"raised {exc.__class__.__name__}", None)

    def _audit(self, ctx: Dict[str, Any], action: str, reason: Optional[str], risk: Optional[int]) -> None:
        self.transport.record_audit(
            tool_id=self.tool_id,
            function_name=self.fn.__name__,
            runtime_kind=RUNTIME_KIND,
            action=action,
            risk=str(risk) if risk is not None else None,
            reason=reason,
            args_preview=ctx["preview"],
            session_id=ctx["session_id"],
            request_id=ctx["request_id"],
        )


def guard(
    fn: Optional[Callable[..., Any]] = None,
    *,
    tool_id: Optional[str] = None,
    mode: Optional[str] = None,
    scan_output: bool = True,
    config: Optional[GuardConfig] = None,
    transport: Optional[AppTransport] = None,
) -> Any:
    """Decorate a sync or async function so every call is scanned and audited.

    ``tool_id`` defaults to the function name. ``mode`` overrides the
    environment for this one function. ``scan_output=False`` skips the
    return-value scan for functions whose output is large or binary.
    """

    def decorate(func: Callable[..., Any]) -> Callable[..., Any]:
        cfg = config or GuardConfig.from_env()
        if mode in ("observe", "enforce") and mode != cfg.mode:
            cfg = replace(cfg, mode=mode)
        g = _Guard(func, tool_id or func.__name__, cfg, transport or _transport(cfg), scan_output)

        if inspect.iscoroutinefunction(func):
            @functools.wraps(func)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                ctx = await asyncio.to_thread(g.before, args, kwargs)
                try:
                    result = await func(*args, **kwargs)
                except BaseException as exc:
                    await asyncio.to_thread(g.failed, ctx, exc)
                    raise
                await asyncio.to_thread(g.after, ctx, result)
                return result

            async_wrapper.__securevector_guard__ = g  # type: ignore[attr-defined]
            return async_wrapper

        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            ctx = g.before(args, kwargs)
            try:
                result = func(*args, **kwargs)
            except BaseException as exc:
                g.failed(ctx, exc)
                raise
            g.after(ctx, result)
            return result

        wrapper.__securevector_guard__ = g  # type: ignore[attr-defined]
        return wrapper

    return decorate(fn) if fn is not None else decorate


guard.session = session  # type: ignore[attr-defined]
