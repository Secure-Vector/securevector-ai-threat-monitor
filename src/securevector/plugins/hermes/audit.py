"""Tool-call audit rows and session markers from Hermes hooks.

Observe only: every callback returns None, so Hermes never reads a block
directive or a changed value from this plugin. Each row goes through the
same bounded worker queue as the cost records (``cost._enqueue``).

Hooks (hermes-agent 0.18.0, ``hermes_cli/plugins.py`` VALID_HOOKS):

- ``post_tool_call``: one ``/api/tool-permissions/call-audit`` row per call.
- ``on_session_start``: a new session, ``__session_start__``.
- ``on_session_end``: fires at the end of every ``run_conversation`` (one
  turn), so it writes ``__turn_end__``.
- ``on_session_finalize``: the session closes (CLI exit, ``/new``, gateway
  expiry), so it writes ``__session_end__``.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Optional

from . import cost

log = logging.getLogger(__name__)

RUNTIME_KIND = "hermes"
AUDIT_PATH = "/api/tool-permissions/call-audit"
# Same cap as the other Guard plugins; the app redacts and caps again on write.
ARGS_PREVIEW_LIMIT = 8192
# Arguments are cut to this size before serialising and redacting, so a huge
# file write never costs a full copy and scan on the Hermes thread.
_PRE_CAP = 65536
_PRE_CAP_ITEMS = 200
_PRE_CAP_DEPTH = 6
_NAME_MAX = 200
_REQUEST_ID_MAX = 64

# The secret patterns the OpenCode plugin masks (plugins/opencode/lib/redact.js).
_SECRET_PATTERNS = [
    re.compile(r"\bsk-proj-[A-Za-z0-9_-]{20,}"),
    re.compile(r"\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b"),
    re.compile(r"(?:sk|pk)-[A-Za-z0-9_-]{20,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\b(?:aws_secret_access_key\s*[:=]\s*['\"]?)[A-Za-z0-9/+=]{40}\b", re.IGNORECASE),
    re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
    re.compile(
        r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----[\s\S]{1,8192}?"
        r"-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----"
    ),
    re.compile(
        r"([\"']?(?:password|secret|token|api[_-]?key|bearer|auth[_-]?token|access[_-]?token|client[_-]?secret)"
        r"[\"']?\s*[:=]\s*[\"']?)[^\"'\s,}\]]{6,}",
        re.IGNORECASE,
    ),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),
    re.compile(r"\bnpm_[A-Za-z0-9]{36}\b"),
    re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}"),
    re.compile(r"\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}"),
]


def _mask(m: "re.Match") -> str:
    prefix = m.group(1) if m.re.groups else None
    return f"{prefix}[REDACTED]" if prefix else "[REDACTED]"


def redact(text: Any) -> str:
    """Secrets masked, then capped at ``ARGS_PREVIEW_LIMIT``. '' for non-text."""
    if not isinstance(text, str) or not text:
        return ""
    out = text
    for pat in _SECRET_PATTERNS:
        out = pat.sub(_mask, out)
    return out[:ARGS_PREVIEW_LIMIT]


def _precap(value: Any, depth: int = 0) -> Any:
    if isinstance(value, str):
        return value[:_PRE_CAP]
    if depth >= _PRE_CAP_DEPTH:
        return str(type(value).__name__)
    if isinstance(value, dict):
        return {str(k)[:200]: _precap(v, depth + 1) for k, v in list(value.items())[:_PRE_CAP_ITEMS]}
    if isinstance(value, (list, tuple)):
        return [_precap(v, depth + 1) for v in list(value)[:_PRE_CAP_ITEMS]]
    return value


def args_preview(args: Any) -> Optional[str]:
    try:
        if args is None:
            return None
        text = args if isinstance(args, str) else json.dumps(_precap(args), default=str)
        return redact(text[:_PRE_CAP]) or None
    except Exception:
        return None


def _text(value: Any, limit: int) -> Optional[str]:
    if isinstance(value, str) and value.strip():
        return value.strip()[:limit]
    return None


def build_tool_row(kwargs: dict) -> Optional[dict]:
    """The call-audit body for one ``post_tool_call``, or None without a name."""
    name = _text(kwargs.get("tool_name"), _NAME_MAX)
    if not name:
        return None
    return {
        "tool_id": name,
        "function_name": name,
        "action": "allow",
        "risk": None,
        "reason": None,
        "is_essential": False,
        "args_preview": args_preview(kwargs.get("args")),
        "runtime_kind": RUNTIME_KIND,
        "session_id": _text(kwargs.get("session_id"), cost._ID_MAX),
        "request_id": _text(kwargs.get("tool_call_id"), _REQUEST_ID_MAX),
    }


def build_marker(marker: str, kwargs: dict, what: str) -> Optional[dict]:
    """A lifecycle row (``__session_start__`` and so on), or None without a
    session id: a marker with no session cannot end or start anything."""
    sid = _text(kwargs.get("session_id"), cost._ID_MAX)
    if not sid:
        return None
    return {
        "tool_id": marker,
        "function_name": marker,
        "action": "log_only",
        "risk": None,
        "reason": f"SecureVector: Hermes {what}",
        "is_essential": False,
        "args_preview": f"session_id={sid}"[:200],
        "runtime_kind": RUNTIME_KIND,
        "session_id": sid,
    }


_SDK_TOOL_HOOKS = ("pre_tool_call", "post_tool_call")


def _sdk_audits_tools() -> bool:
    """The securevector-sdk-hermes plugin writes its own audit rows when its
    tool hook is registered; stay silent then so a call is not listed twice."""
    found = [cost._sdk_hooks_from_registry(h) for h in _SDK_TOOL_HOOKS]
    if any(found):
        return True
    if all(f is None for f in found):
        return cost._sdk_plugin_enabled()
    return False


def _sdk_has(hook_name: str) -> bool:
    """The SDK registered its own callback for this hook (registry check)."""
    return bool(cost._sdk_hooks_from_registry(hook_name))


def _send(body: Optional[dict]) -> None:
    if body is not None:
        cost._enqueue(cost.endpoint() + AUDIT_PATH, body)


def on_post_tool_call(**kwargs: Any) -> None:
    """Hermes ``post_tool_call`` callback. Never raises, returns None."""
    try:
        if _sdk_audits_tools():
            return
        _send(build_tool_row(kwargs))
    except Exception as exc:
        log.debug("SecureVector audit hook skipped: %s", exc)


def on_session_start(**kwargs: Any) -> None:
    try:
        if not _sdk_has("on_session_start"):
            _send(build_marker("__session_start__", kwargs, "session started"))
    except Exception as exc:
        log.debug("SecureVector session hook skipped: %s", exc)


def on_session_end(**kwargs: Any) -> None:
    # Hermes fires this once per turn (end of run_conversation).
    try:
        if not _sdk_has("on_session_end"):
            _send(build_marker("__turn_end__", kwargs, "turn ended"))
    except Exception as exc:
        log.debug("SecureVector session hook skipped: %s", exc)


def on_session_finalize(**kwargs: Any) -> None:
    try:
        if not _sdk_has("on_session_finalize"):
            _send(build_marker("__session_end__", kwargs, "session ended"))
    except Exception as exc:
        log.debug("SecureVector session hook skipped: %s", exc)
