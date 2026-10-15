"""
Native approvals: the page asks, the operating system confirms.

A decision route (the `require_person` set in services/decisions.py) checks
the UI token and the caller as before, then holds the request here as a
confirmation instead of applying it. The route answers 202 with
{confirmation_id, method, summary, expires_in}. Nothing changes until the
person confirms:

- Desktop shell: the shell registered a prompt with `attach_shell` when it
  started the server in this process. A daemon thread drains a queue and
  calls the prompt with the time left; the result comes back through
  `resolve_shell` in process, never over HTTP. On macOS the prompt is
  LocalAuthentication (Touch ID or the account password), else an alert
  whose default button is Cancel (desktop_shell.py).
- Windows and Linux desktop: the "code" method. The shell shows the code in
  a dialog of its own (text only; Return just closes it) and the page asks
  for it, as in web-only mode.
- Web only: a six-digit code is printed to the terminal that started the app
  (only when that is a terminal, so it never lands in a redirected file). On
  macOS a notification also shows it. The page posts it to
  /api/confirmations/{id}/code: single use, 5 attempts, 120 s.

On confirm the original request is replayed through the app in process,
with a scope key a client cannot send, so the same handler and the same
audit apply it. Every confirmation writes audit rows: created, then
confirmed, denied or expired, with the method (touch_id, dialog, code).

The summary the person sees is built from the request itself (route
parameters and body fields), never from text the page sends.

`SV_NATIVE_APPROVALS=0` turns this off only while pytest is loaded; anywhere
else it is ignored with a warning.

Known limits:
- Windows and Linux never decide through a dialog: pywebview has no
  dialog whose default button is Cancel, so the person types the code shown
  in the shell's dialog (pywebview has no plain message dialog either; the
  confirmation dialog is used for display and its answer is ignored). On
  macOS any answer within 700 ms of the prompt is discarded and the prompt is
  shown once more; at expiry the alert is closed only when it is the current
  modal window, otherwise its late answer is discarded.
- A process allowed to control the computer (macOS Accessibility, or any
  input injection on Windows and Linux) can click a dialog. Touch ID and the
  account password are not clickable that way.
- In web-only mode the code is printed to the terminal; anything that can
  read that terminal (a tmux or screen capture, a terminal log) can read the
  code. On Linux the code is never passed to notify-send, whose arguments
  other processes can read.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import hashlib
import hmac
import json
import logging
import math
import os
import queue
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional
from urllib.parse import parse_qsl

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

TTL_SECONDS = 120.0
MAX_ATTEMPTS = 5
MAX_PENDING = 20
MAX_PENDING_PER_ROUTE = 3
# Wrong codes across all confirmations before the code path pauses.
FAIL_LIMIT = 20
FAIL_WINDOW = 600.0
LOCKOUT_TEXT = "Too many wrong codes were entered on this computer. Wait 10 minutes."

SCOPE_KEY = "sv.confirmation"
METHOD_SHELL = "shell"
METHOD_CODE = "code"

# The confirming method of the request being applied, read by decisions.audit.
current_method: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "sv_confirmation_method", default=None)

_KEY = secrets.token_bytes(32)
_lock = threading.Lock()
_store: dict = {}
_fails: list = []
_locked_out = {"value": False}
_shell: Optional[Callable[..., tuple]] = None
# Windows and Linux desktop: the shell shows the code in its own dialog.
_code_display: Optional[Callable[[str, str], None]] = None
_shell_queue: "queue.Queue[str]" = queue.Queue()
_shell_thread: Optional[threading.Thread] = None
_ignored_warned = {"value": False}
_own_loop_writes = threading.Lock()

_COPY_SCOPE = ("type", "asgi", "http_version", "method", "scheme", "server", "client",
               "root_path", "path", "raw_path", "query_string", "headers")


def _flag_off() -> bool:
    raw = os.environ.get("SV_NATIVE_APPROVALS", "").strip().lower()
    return raw in ("0", "false", "off", "no")


def enabled() -> bool:
    """On, unless the flag turns it off inside a pytest run."""
    if not _flag_off():
        return True
    if "pytest" in sys.modules:
        return False
    if not _ignored_warned["value"]:
        _ignored_warned["value"] = True
        logger.warning("SV_NATIVE_APPROVALS=0 was ignored: it only applies to tests.")
    return True


def warn_if_off() -> None:
    if not _flag_off():
        return
    if "pytest" in sys.modules:
        logger.warning("SV_NATIVE_APPROVALS is off: decisions apply on the page's request alone. "
                       "This setting is for tests only.")
    else:
        _ignored_warned["value"] = True
        logger.warning("SV_NATIVE_APPROVALS=0 was ignored: it only applies to tests.")


@dataclass
class Confirmation:
    id: str
    route: str
    summary: str
    method: str
    created: float
    expires: float
    key: str = ""
    attempts: int = 0
    status: str = "pending"  # pending | applying | applying_denial | confirmed | denied | expired
    how: Optional[str] = None
    result: Optional[dict] = None
    code_digest: Optional[bytes] = None
    scope: Optional[dict] = field(default=None, repr=False)
    body: bytes = field(default=b"", repr=False)
    app: Any = field(default=None, repr=False)
    loop: Any = field(default=None, repr=False)


class ConfirmationPending(HTTPException):
    """Raised by `gate`; answered as 202 with the confirmation's id."""

    def __init__(self, conf: Confirmation):
        left = max(0, math.ceil(conf.expires - time.monotonic()))
        self.payload = {"confirmation_id": conf.id, "method": conf.method, "summary": conf.summary,
                        "expires_in": left}
        super().__init__(status_code=202, detail=self.payload)


async def pending_response(_request: Any, exc: ConfirmationPending) -> JSONResponse:
    return JSONResponse(exc.payload, status_code=202)


# --- summaries, from the request itself -------------------------------------------------

_SECRET_KEY = re.compile(r"key|token|secret|password|credential|auth", re.I)


def _label(harness: Any) -> str:
    if not harness or harness == "all":
        return "all agents"
    from securevector.app.services.config_trust_scan import HARNESS_LABELS

    return HARNESS_LABELS.get(str(harness), str(harness)[:40])


def _value(key: str, value: Any) -> str:
    if _SECRET_KEY.search(key):
        return "(hidden)"
    if isinstance(value, bool):
        return "on" if value else "off"
    if value is None:
        return "default"
    if isinstance(value, (list, tuple)):
        return f"{len(value)} {'item' if len(value) == 1 else 'items'}"
    if isinstance(value, dict):
        return f"{len(value)} fields"
    text = str(value).replace("\n", " ")
    return text if len(text) <= 60 else text[:57] + "..."


def _changes(data: dict, skip: tuple = ()) -> str:
    items = [(k, v) for k, v in data.items() if k not in skip]
    parts = [f"{k} to {_value(k, v)}" for k, v in items[:5]]
    if len(items) > 5:
        parts.append(f"{len(items) - 5} more")
    return ", ".join(parts) or "no fields"


def _seg(m: "re.Match", name: str) -> str:
    return str(m.group(name))[:80]


def _count(data: dict, key: str = "ids") -> int:
    value = data.get(key)
    return len(value) if isinstance(value, list) else 0


# (methods, path pattern under /api, text from the match and the data)
_ROUTES: tuple = (
    ("PUT", r"/settings$", lambda m, d: f"Change settings: {_changes(d)}"),
    ("PUT", r"/settings/llm$", lambda m, d: f"Change AI review settings: {_changes(d)}"),
    ("PUT", r"/settings/delegation$", lambda m, d: f"Change the delegation policy: {_changes(d)}"),
    ("PUT", r"/settings/cloud/mode$", lambda m, d: f"Change cloud mode: {_changes(d)}"),
    ("POST", r"/settings/cloud/credentials$", lambda m, d: "Connect SecureVector Cloud with new credentials"),
    ("DELETE", r"/settings/cloud/credentials$", lambda m, d: "Remove the SecureVector Cloud credentials"),
    ("POST", r"/v1/cloud-forwarding$", lambda m, d: f"Change cloud forwarding: {_changes(d)}"),
    ("PUT", r"/tool-permissions/overrides/(?P<tool>[^/]+)$",
     lambda m, d: f"Set {_seg(m, 'tool')} to {_value('action', d.get('action'))} for {_label(d.get('runtime_kind'))}"),
    ("DELETE", r"/tool-permissions/overrides/(?P<tool>[^/]+)$",
     lambda m, d: f"Remove the {_seg(m, 'tool')} rule for {_label(d.get('runtime_kind'))}"),
    ("POST", r"/tool-permissions/custom$",
     lambda m, d: f"Add custom tool {_value('tool_id', d.get('tool_id') or d.get('name'))}: "
                  f"{_changes(d, ('tool_id', 'name'))}"),
    ("PUT PATCH", r"/tool-permissions/custom/(?P<tool>[^/]+)$",
     lambda m, d: f"Change custom tool {_seg(m, 'tool')}: {_changes(d)}"),
    ("DELETE", r"/tool-permissions/custom/(?P<tool>[^/]+)$", lambda m, d: f"Delete custom tool {_seg(m, 'tool')}"),
    ("DELETE", r"/tool-permissions/call-audit$", lambda m, d: f"Delete {_count(d)} tool call audit entries"),
    ("PATCH", r"/egress/policy$", lambda m, d: f"Change the network egress policy: {_changes(d)}"),
    ("POST", r"/egress/denylist$", lambda m, d: f"Block network access to {_value('host', d.get('host'))}"),
    ("POST", r"/egress/denylist/remove$", lambda m, d: f"Unblock network access to {_value('host', d.get('host'))}"),
    ("POST", r"/egress/grants$",
     lambda m, d: f"Allow network access to {_value('host', d.get('host'))}: {_changes(d, ('host',))}"),
    ("POST", r"/egress/promote$", lambda m, d: f"Always allow network access to {_value('host', d.get('host'))}"),
    ("PUT", r"/costs/budget$", lambda m, d: f"Change the cost budget: {_changes(d)}"),
    ("PUT", r"/costs/budget/agents/(?P<a>[^/]+)$", lambda m, d: f"Change the budget for {_seg(m, 'a')}: {_changes(d)}"),
    ("DELETE", r"/costs/budget/agents/(?P<a>[^/]+)$", lambda m, d: f"Remove the budget for {_seg(m, 'a')}"),
    ("DELETE", r"/costs/records$", lambda m, d: f"Delete cost records: {_changes(d)}"),
    ("PUT", r"/costs/run-limits$", lambda m, d: f"Change run limits: {_changes(d)}"),
    ("POST", r"/costs/run-limits/exempt$", lambda m, d: f"Change run limit exemptions: {_changes(d)}"),
    ("POST", r"/rules/(?P<r>[^/]+)/toggle$", lambda m, d: f"Change rule {_seg(m, 'r')}: {_changes(d)}"),
    ("PUT", r"/rules/(?P<r>[^/]+)/override$", lambda m, d: f"Override rule {_seg(m, 'r')}: {_changes(d)}"),
    ("DELETE", r"/rules/(?P<r>[^/]+)/override$", lambda m, d: f"Remove the override for rule {_seg(m, 'r')}"),
    ("POST", r"/rules/custom$", lambda m, d: f"Add custom rule {_value('name', d.get('name'))}: {_changes(d, ('name',))}"),
    ("PUT", r"/rules/custom/(?P<r>[^/]+)$", lambda m, d: f"Change custom rule {_seg(m, 'r')}: {_changes(d)}"),
    ("DELETE", r"/rules/custom/(?P<r>[^/]+)$", lambda m, d: f"Delete custom rule {_seg(m, 'r')}"),
    ("POST", r"/rules/sync/apply$", lambda m, d: f"Apply synced rules: {_changes(d)}"),
    ("DELETE", r"/threat-intel$", lambda m, d: f"Delete {_count(d)} recorded threats"),
    ("DELETE", r"/threat-intel/(?P<t>[^/]+)$", lambda m, d: f"Delete recorded threat {_seg(m, 't')}"),
    ("POST", r"/threat-intel/(?P<t>[^/]+)/disposition$", lambda m, d: f"Mark threat {_seg(m, 't')}: {_changes(d)}"),
    ("POST", r"/proxy/stop$", lambda m, d: "Stop the SecureVector proxy"),
    ("POST", r"/proxy/revert$", lambda m, d: "Revert the SecureVector proxy setup"),
    ("POST", r"/siem-forwarders$", lambda m, d: f"Add a SIEM forwarder: {_changes(d)}"),
    ("PUT", r"/siem-forwarders/global-settings$", lambda m, d: f"Change SIEM settings: {_changes(d)}"),
    ("PUT", r"/siem-forwarders/(?P<f>[^/]+)$", lambda m, d: f"Change SIEM forwarder {_seg(m, 'f')}: {_changes(d)}"),
    ("DELETE", r"/siem-forwarders/(?P<f>[^/]+)$", lambda m, d: f"Delete SIEM forwarder {_seg(m, 'f')}"),
    ("POST", r"/siem-forwarders/(?P<f>[^/]+)/reset-breaker$", lambda m, d: f"Reset SIEM forwarder {_seg(m, 'f')}"),
    ("POST", r"/skill-permissions$", lambda m, d: f"Add a skill permission: {_changes(d)}"),
    ("POST", r"/skill-permissions/import$", lambda m, d: f"Import skill permissions: {_changes(d)}"),
    ("POST", r"/skill-permissions/publishers$", lambda m, d: f"Add a trusted skill publisher: {_changes(d)}"),
    ("DELETE", r"/skill-permissions/publishers/(?P<p>[^/]+)$",
     lambda m, d: f"Remove trusted skill publisher {_seg(m, 'p')}"),
    ("POST", r"/skill-permissions/reset$", lambda m, d: "Reset all skill permissions"),
    ("PUT", r"/skill-permissions/policy-config$", lambda m, d: f"Change the skill policy: {_changes(d)}"),
    ("PUT", r"/skill-permissions/(?P<p>[^/]+)$", lambda m, d: f"Change skill permission {_seg(m, 'p')}: {_changes(d)}"),
    ("DELETE", r"/skill-permissions/(?P<p>[^/]+)$", lambda m, d: f"Delete skill permission {_seg(m, 'p')}"),
    ("POST", r"/terminals/tasks/(?P<t>[^/]+)/rung/release$",
     lambda m, d: f"Release the step-up for session {_seg(m, 't')}"),
    ("POST", r"/terminals/tasks/(?P<t>[^/]+)/rung/feedback$",
     lambda m, d: (f"Mark the step-up for session {_seg(m, 't')} as not needed" if d.get("feedback")
                   else f"Clear the not needed mark for session {_seg(m, 't')}")),
    ("POST", r"/terminals/tasks/(?P<t>[^/]+)/drift/feedback$",
     lambda m, d: f"Mark session {_seg(m, 't')} as looks normal"),
    ("POST", r"/terminals/tasks/(?P<t>[^/]+)/worktree/remove$",
     lambda m, d: f"Remove the worktree of session {_seg(m, 't')}"
                  + (", including changed files" if d.get("confirm") else "")),
    ("POST", r"/terminals/rungs/modes/(?P<h>[^/]+)$",
     lambda m, d: (f"Turn automatic actions on for {_label(m.group('h'))}" if d.get("mode") == "active"
                   else f"Turn automatic actions off for {_label(m.group('h'))}" if d.get("mode") == "shadow"
                   else f"End the observe period early for {_label(m.group('h'))}")),
    ("POST", r"/terminals/delegations/(?P<x>[^/]+)/release$",
     lambda m, d: f"Hand the held result of delegation {_seg(m, 'x')} to its task"),
    ("POST", r"/terminals/delegations/(?P<x>[^/]+)/discard$",
     lambda m, d: f"Discard the held result of delegation {_seg(m, 'x')}"),
    ("POST", r"/terminals/config-trust/pins$",
     lambda m, d: f"Trust the {_value('target', d.get('target') or 'setup')} config of {_label(d.get('harness'))}"
                  + (f": {_value('key', d.get('key'))}" if d.get("key") else "")),
    ("POST", r"/terminals/config-trust/pins/batch$", lambda m, d: _batch_summary(d)),
    ("POST", r"/jit/requests/(?P<r>[^/]+)/approve$", lambda m, d: f"Allow held tool call {_seg(m, 'r')}"),
    ("POST", r"/jit/requests/(?P<r>[^/]+)/deny$", lambda m, d: f"Deny held tool call {_seg(m, 'r')}"),
    ("POST", r"/hooks/(?P<h>[^/]+)/install$", lambda m, d: f"Install the Guard for {_label(m.group('h'))}"),
    ("POST", r"/hooks/(?P<h>[^/]+)/uninstall$", lambda m, d: f"Remove the Guard for {_label(m.group('h'))}"),
    ("POST", r"/hooks/install$", lambda m, d: "Install the Guard for OpenClaw"),
    ("POST", r"/hooks/uninstall$", lambda m, d: "Remove the Guard for OpenClaw"),
)


def _batch_summary(data: dict) -> str:
    items = data.get("items") if isinstance(data.get("items"), list) else []
    n = len(items)
    names = sorted({_label(i.get("harness")) for i in items if isinstance(i, dict)})
    who = f" ({', '.join(names[:4])})" if names else ""
    return f"Trust the changed config of {n} agent {'tool' if n == 1 else 'tools'}{who}"


def _data(body: bytes, query: bytes) -> dict:
    data: dict = {}
    try:
        parsed = json.loads(body) if body else {}
    except ValueError:
        parsed = {}
    if isinstance(parsed, dict):
        data.update(parsed)
    try:
        for k, v in parse_qsl((query or b"").decode("latin-1")):
            data.setdefault(k, v)
    except Exception:  # noqa: BLE001
        pass
    return data


def describe(method: str, path: str, body: bytes = b"", query: bytes = b"") -> str:
    """What the person is asked to confirm, from the route and the body."""
    data = _data(body, query)
    sub = path[4:] if path.startswith("/api/") else path
    for methods, pattern, text in _ROUTES:
        if method.upper() not in methods.split():
            continue
        m = re.fullmatch(pattern.rstrip("$"), sub)
        if m:
            return text(m, data)
    return f"{method.upper()} {path[:80]}: {_changes(data)}"


# --- lifecycle --------------------------------------------------------------------------


def _digest(conf_id: str, code: str) -> bytes:
    return hmac.new(_KEY, f"{conf_id}:{code}".encode(), hashlib.sha256).digest()


def _request_key(scope: dict, body: bytes) -> str:
    h = hashlib.sha256()
    for part in (scope.get("method", ""), scope.get("path", ""), scope.get("query_string", b"")):
        h.update(part if isinstance(part, bytes) else str(part).encode())
        h.update(b"\0")
    h.update(body or b"")
    return h.hexdigest()


def _clear(conf: Confirmation) -> None:
    conf.scope, conf.body, conf.app = None, b"", None


def _expire_locked(now: float) -> list:
    """Mark what has expired; returns those so the caller writes their rows
    after releasing the lock."""
    expired = []
    for conf in _store.values():
        if conf.status == "pending" and now >= conf.expires:
            conf.status = "expired"
            _clear(conf)
            expired.append(conf)
    # Forget finished ones after a while so the store stays small.
    for cid in [c.id for c in _store.values() if c.status in ("confirmed", "denied", "expired")
                and now - c.expires > TTL_SECONDS * 5]:
        _store.pop(cid, None)
    return expired


@contextlib.contextmanager
def _locked(now: Optional[float] = None):
    """The store lock with expiry applied; expiry rows are written once the
    lock is released."""
    expired: list = []
    try:
        with _lock:
            expired = _expire_locked(time.monotonic() if now is None else now)
            yield
    finally:
        for conf in expired:
            _write_soon(conf, lambda c=conf: _audit(c, "confirmation_expired"))


def get(conf_id: str) -> Optional[Confirmation]:
    with _locked():
        return _store.get(conf_id)


def view(conf: Confirmation) -> dict:
    status = "pending" if conf.status in ("applying", "applying_denial") else conf.status
    out = {"id": conf.id, "status": status, "method": conf.method, "summary": conf.summary}
    if status == "confirmed":
        out["result"] = conf.result
        out["confirmed_by"] = conf.how
    return out


def create(request: Any, body: bytes, summary: str, *, now: Optional[float] = None) -> Confirmation:
    return _create(request, body, summary, now=now)[0]


def _create(request: Any, body: bytes, summary: str, *, now: Optional[float] = None) -> tuple:
    """Hold the request as a confirmation. A request that matches one still
    pending returns that one (no second prompt, no second code). In web mode
    the code is shown on the computer here and only its keyed digest is kept."""
    now = time.monotonic() if now is None else now
    scope = getattr(request, "scope", None) or {}
    key = _request_key(scope, body)
    route = f"{scope.get('method', '')} {scope.get('path', '')}"
    with _locked(now):
        pending = [c for c in _store.values() if c.status == "pending"]
        for c in pending:
            if c.key == key:
                return c, False
        if len(pending) >= MAX_PENDING or sum(1 for c in pending if c.route == route) >= MAX_PENDING_PER_ROUTE:
            raise HTTPException(status_code=429, detail="Too many confirmations are waiting. Answer or let them expire.")
        conf = Confirmation(
            id=secrets.token_urlsafe(18), route=route, summary=summary[:200], key=key,
            method=METHOD_SHELL if _shell is not None else METHOD_CODE,
            created=now, expires=now + TTL_SECONDS,
            scope={k: (list(scope[k]) if k == "headers" else scope[k]) for k in _COPY_SCOPE if k in scope},
            body=body, app=scope.get("app"),
        )
        if "state" in scope:
            conf.scope["state"] = dict(scope["state"])
        try:
            conf.loop = asyncio.get_running_loop()
        except RuntimeError:
            conf.loop = None
        code = None
        if conf.method == METHOD_CODE:
            code = f"{secrets.randbelow(10 ** 6):06d}"
            conf.code_digest = _digest(conf.id, code)
        _store[conf.id] = conf
    if code is not None:
        show_code(code, conf.summary)
    else:
        _shell_queue.put(conf.id)
    return conf, True


def is_replay(request: Any) -> bool:
    """True only for the in-process replay of a confirmed request. The scope
    key cannot arrive from a client: the server builds scope itself, and a
    header of the same name is a header, not a scope key."""
    scope = getattr(request, "scope", None)
    if not isinstance(scope, dict):
        return False
    cid = scope.get(SCOPE_KEY)
    if not isinstance(cid, str):
        return False
    with _lock:
        conf = _store.get(cid)
        return conf is not None and conf.status == "applying"


async def gate(request: Any, summary: Optional[str] = None) -> None:
    """Called by a decision route after its checks. Raises ConfirmationPending
    unless this is the confirmed replay or the flag is off."""
    if not enabled() or is_replay(request):
        return
    scope = getattr(request, "scope", None)
    if not isinstance(scope, dict) or scope.get("type") != "http":
        raise HTTPException(status_code=403, detail="Not confirmed")
    body = await request.body()
    text = summary or describe(scope.get("method", ""), scope.get("path", ""), body, scope.get("query_string", b""))
    conf, new = _create(request, body, text)
    if new:
        await _audit(conf, "confirmation_created")
    raise ConfirmationPending(conf)


async def _replay(conf: Confirmation) -> dict:
    scope = dict(conf.scope or {})
    scope[SCOPE_KEY] = conf.id
    body = conf.body
    done = asyncio.Event()
    sent = {"body": False}
    out = {"status": 500, "headers": [], "chunks": []}

    async def receive():
        if not sent["body"]:
            sent["body"] = True
            return {"type": "http.request", "body": body, "more_body": False}
        await done.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.start":
            out["status"] = int(message["status"])
            out["headers"] = message.get("headers") or []
        elif message["type"] == "http.response.body":
            out["chunks"].append(message.get("body", b""))

    try:
        await conf.app(scope, receive, send)
    finally:
        done.set()
    raw = b"".join(out["chunks"])
    try:
        data = json.loads(raw) if raw else None
    except ValueError:
        data = {"detail": raw.decode("utf-8", "replace")[:500]}
    return {"status_code": out["status"], "body": data}


async def apply(conf: Confirmation, how: str) -> bool:
    """Apply a pending confirmation once, through the original route."""
    with _locked():
        if conf.status != "pending" or conf.app is None:
            return False
        conf.status = "applying"
        conf.how = how
    token = current_method.set(how)
    try:
        result = await _replay(conf)
    except Exception:  # noqa: BLE001 - reported to the page as a failed apply
        logger.warning("Confirmed change could not be applied", exc_info=True)
        result = {"status_code": 500, "body": {"detail": "The change could not be applied."}}
    finally:
        current_method.reset(token)
    await _audit(conf, "confirmation_confirmed", method=how)
    with _lock:
        conf.status = "confirmed"
        conf.result = result
        _clear(conf)
    return True


def _mark_denied(conf_id: str, how: Optional[str]) -> Optional[Confirmation]:
    with _lock:
        conf = _store.get(conf_id)
        if conf is None or conf.status != "pending":
            return None
        conf.status = "denied"
        conf.how = how
        _clear(conf)
        return conf


def deny(conf_id: str, how: Optional[str] = None) -> bool:
    """Deny from any thread. The audit row is written even when the server's
    loop is closing (it then runs on a short-lived loop of its own)."""
    conf = _mark_denied(conf_id, how)
    if conf is None:
        return False
    _write_soon(conf, lambda: _audit(conf, "confirmation_denied", method=how), wait=True)
    return True


async def deny_async(conf_id: str, how: Optional[str] = None) -> bool:
    conf = _mark_denied(conf_id, how)
    if conf is None:
        return False
    await _audit(conf, "confirmation_denied", method=how)
    return True


def _write_soon(conf: Confirmation, make: Callable[[], Any], wait: bool = False) -> None:
    """Run an audit coroutine: on the running loop, on the confirmation's
    loop, or failing both on a loop of its own in a short-lived thread."""
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is not None:
        running.create_task(make())
        return
    loop = conf.loop
    if loop is not None and not loop.is_closed() and loop.is_running():
        fut = asyncio.run_coroutine_threadsafe(make(), loop)
        if not wait:
            return
        try:
            fut.result(timeout=5)
            return
        except Exception:  # noqa: BLE001 - the loop is going away; write on our own
            fut.cancel()
    # No server loop to use: write on a loop of our own, one at a time, so
    # two such writes never overlap.
    with _own_loop_writes:
        t = threading.Thread(target=lambda: asyncio.run(make()), daemon=True)
        t.start()
        t.join(5)


def _global_locked(now: float) -> bool:
    _fails[:] = [t for t in _fails if now - t < FAIL_WINDOW]
    locked = len(_fails) >= FAIL_LIMIT
    if not locked:
        _locked_out["value"] = False
    return locked


def _announce_lockout() -> None:
    try:
        print(f"\n  SecureVector: {LOCKOUT_TEXT}\n", flush=True)
    except Exception:  # noqa: BLE001
        pass


async def submit_code(conf_id: str, code: str) -> dict:
    now = time.monotonic()
    lockout_started = False
    with _locked(now):
        if _global_locked(now):
            raise HTTPException(status_code=429, detail=LOCKOUT_TEXT)
        conf = _store.get(conf_id)
        if conf is None:
            raise HTTPException(status_code=404, detail="No such confirmation")
        if conf.method != METHOD_CODE or conf.code_digest is None:
            raise HTTPException(status_code=409, detail="This confirmation is answered on the computer")
        if conf.status != "pending":
            raise HTTPException(status_code=409, detail="Not confirmed" if conf.status != "confirmed"
                                else "Already confirmed")
        ok = isinstance(code, str) and bool(re.fullmatch(r"\d{6}", code)) and hmac.compare_digest(
            conf.code_digest, _digest(conf.id, code))
        left = None
        if not ok:
            conf.attempts += 1
            _fails.append(now)
            left = MAX_ATTEMPTS - conf.attempts
            if left <= 0:
                conf.status = "denied"
                conf.how = METHOD_CODE
                _clear(conf)
            if _global_locked(now) and not _locked_out["value"]:
                _locked_out["value"] = True
                lockout_started = True
    if not ok:
        if left <= 0:
            await _audit(conf, "confirmation_denied", method=METHOD_CODE)
        if lockout_started:
            _announce_lockout()
            await _audit(conf, "confirmation_lockout", method=METHOD_CODE, reason=LOCKOUT_TEXT)
            raise HTTPException(status_code=429, detail=LOCKOUT_TEXT)
        if left <= 0:
            raise HTTPException(status_code=429, detail="Not confirmed: too many wrong codes")
        raise HTTPException(status_code=400, detail=f"Wrong code. {left} tries left.")
    await apply(conf, METHOD_CODE)
    return view(conf)


# --- the desktop shell channel (in process only) ----------------------------------------


def attach_shell(prompt: Optional[Callable[..., tuple]] = None,
                 show_code: Optional[Callable[[str, str], None]] = None) -> None:
    """The desktop shell registers in process; there is no HTTP route.
    macOS registers `prompt(summary, timeout) -> (ok, how)` and confirmations
    use the "shell" method. Windows and Linux register `show_code(code,
    summary)` instead: confirmations use the "code" method and the shell
    shows the code in a dialog (text only; its buttons decide nothing)."""
    global _shell, _shell_thread, _code_display
    _shell = prompt
    _code_display = show_code
    if prompt is not None and (_shell_thread is None or not _shell_thread.is_alive()):
        _shell_thread = threading.Thread(target=_drain, name="sv-confirmations", daemon=True)
        _shell_thread.start()


def detach_shell() -> None:
    global _shell, _code_display
    _shell = None
    _code_display = None


def _drain() -> None:
    while True:
        conf_id = _shell_queue.get()
        prompt = _shell
        conf = get(conf_id)
        if prompt is None or conf is None or conf.status != "pending":
            continue
        remaining = max(0.0, conf.expires - time.monotonic())
        try:
            ok, how = prompt(conf.summary, remaining)
        except Exception:  # noqa: BLE001 - a failed prompt is a no
            logger.warning("Confirmation prompt failed", exc_info=True)
            ok, how = False, None
        resolve_shell(conf_id, bool(ok), how)


def resolve_shell(conf_id: str, ok: bool, how: Optional[str]) -> None:
    conf = get(conf_id)  # an answer after expiry finds it expired
    if conf is None or conf.status != "pending":
        return
    if conf.loop is None or conf.loop.is_closed():
        deny(conf_id, how)
        return
    if not ok:
        asyncio.run_coroutine_threadsafe(_declined(conf, how), conf.loop)
        return
    asyncio.run_coroutine_threadsafe(apply(conf, how or "dialog"), conf.loop)


async def _declined(conf: Confirmation, how: Optional[str]) -> None:
    """The person said no in the shell: the row first, then the status the
    page reads."""
    with _lock:
        if conf.status != "pending":
            return
        conf.status = "applying_denial"
    await _audit(conf, "confirmation_denied", method=how)
    with _lock:
        conf.status = "denied"
        conf.how = how
        _clear(conf)


# --- the code, web-only mode ------------------------------------------------------------


def _applescript_text(text: str) -> str:
    return text.replace("\\", "\\\\").replace('"', '\\"')


def show_code(code: str, summary: str) -> None:
    """Show the code on this computer: the terminal that started the app (a
    terminal only, never a redirected file) and, on macOS, a notification.
    The code is never passed to the logger."""
    try:
        if sys.stdout is not None and sys.stdout.isatty():
            print(f"\n  SecureVector confirmation code: {code}\n  For: {summary}\n", flush=True)
    except Exception:  # noqa: BLE001
        pass
    display = _code_display
    if display is not None:
        threading.Thread(target=_display_code, args=(display, code, summary), daemon=True).start()
    else:
        threading.Thread(target=_notify, args=(code, summary), daemon=True).start()


def code_text(code: str, summary: str) -> str:
    return f"SecureVector confirmation code: {code}. Type it on the page to allow: {summary}"


def _display_code(display: Callable[[str, str], None], code: str, summary: str) -> None:
    try:
        display(code, summary)
    except Exception:  # noqa: BLE001 - the terminal copy still stands; never log the code
        logger.debug("Showing the confirmation code failed")


def _notify(code: str, summary: str) -> None:
    try:
        if sys.platform == "darwin" and shutil.which("osascript"):
            # The script goes in on stdin so the code is not in the argument list.
            script = (f'display notification "{_applescript_text(summary)}" '
                      f'with title "SecureVector code {code}"')
            subprocess.run(["osascript", "-"], input=script.encode(), timeout=10,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        elif sys.platform.startswith("linux") and shutil.which("notify-send"):
            # Arguments are readable by other processes: no code here.
            subprocess.run(["notify-send", "SecureVector needs a confirmation code",
                            "Enter the code printed in the terminal that started SecureVector."],
                           timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    except Exception:  # noqa: BLE001 - the terminal copy still stands
        logger.debug("Confirmation notification failed")


# --- audit ------------------------------------------------------------------------------


def _database():
    from securevector.app.database.connection import get_database

    return get_database()


async def _audit(conf: Confirmation, decision: str, method: Optional[str] = None,
                 reason: Optional[str] = None) -> None:
    try:
        from securevector.app.services import decisions

        await decisions.audit(_database(), decision, session_id=None, klass="confirmation",
                              tool_id=conf.route[:120], request_id=conf.id, method=method,
                              reason=reason or conf.summary)
    except Exception:  # noqa: BLE001 - best effort, like every decision row
        logger.debug("Confirmation audit failed", exc_info=True)


# --- routes -----------------------------------------------------------------------------

router = APIRouter(prefix="/confirmations", tags=["Confirmations"])


class CodeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(..., min_length=6, max_length=6)


@router.get("/{conf_id}")
async def confirmation_status(conf_id: str, x_sv_ui_token: Optional[str] = Header(None)):
    from securevector.app.server.routes.jit_access import _require_ui_token

    _require_ui_token(x_sv_ui_token)
    conf = get(conf_id)
    if conf is None:
        raise HTTPException(status_code=404, detail="No such confirmation")
    return view(conf)


@router.post("/{conf_id}/code")
async def confirmation_code(conf_id: str, body: CodeBody, request: Request,
                            x_sv_ui_token: Optional[str] = Header(None)):
    from securevector.app.server.routes.jit_access import _require_ui_token
    from securevector.app.services import decisions

    _require_ui_token(x_sv_ui_token)
    await decisions.refuse_governed_caller(request)
    return await submit_code(conf_id, body.code)


@router.post("/{conf_id}/cancel")
async def confirmation_cancel(conf_id: str, request: Request, x_sv_ui_token: Optional[str] = Header(None)):
    """The page's Cancel: the confirmation is denied and cannot be answered."""
    from securevector.app.server.routes.jit_access import _require_ui_token
    from securevector.app.services import decisions

    _require_ui_token(x_sv_ui_token)
    await decisions.refuse_governed_caller(request)
    conf = get(conf_id)
    if conf is None:
        raise HTTPException(status_code=404, detail="No such confirmation")
    await deny_async(conf_id, "page")
    return view(conf)


def install(app: Any) -> None:
    """The 202 answer and the routes the page uses."""
    app.add_exception_handler(ConfirmationPending, pending_response)
    app.include_router(router, prefix="/api")
