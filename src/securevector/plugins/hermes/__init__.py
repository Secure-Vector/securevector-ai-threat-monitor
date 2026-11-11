"""SecureVector plugin for Hermes Agent (directory plugin).

Hermes imports this package from ``$HERMES_HOME/plugins/securevector`` and
calls ``register(ctx)``. Hooks:

- ``post_api_request``: fires once per model API call with that call's token
  usage. Each call becomes one record in SecureVector Cost Tracking.
  ``post_llm_call`` is not used: it covers the same calls once per turn and
  would count them twice.
- ``post_tool_call``: one tool-call audit row per call.
- ``on_session_start`` / ``on_session_end`` / ``on_session_finalize``: session
  start, turn end and session end markers (see ``audit.py``).

Standard library only. Observe only: no hook returns a value, never raises
and never blocks the turn. Sends run on one background worker with a short
timeout.
"""

from __future__ import annotations

import logging

from . import audit
from .cost import on_post_api_request

log = logging.getLogger(__name__)

HOOKS = (
    ("post_api_request", on_post_api_request),
    ("post_tool_call", audit.on_post_tool_call),
    ("on_session_start", audit.on_session_start),
    ("on_session_end", audit.on_session_end),
    ("on_session_finalize", audit.on_session_finalize),
)


def register(ctx) -> None:
    for name, callback in HOOKS:
        try:
            ctx.register_hook(name, callback)
        except Exception as exc:  # one hook a Hermes build lacks must not drop the rest
            log.debug("SecureVector hook %s not registered: %s", name, exc)
    log.info("SecureVector cost tracking and tool-call audit attached to Hermes")
