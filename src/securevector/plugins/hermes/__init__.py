"""SecureVector plugin for Hermes Agent (directory plugin).

Hermes imports this package from ``~/.hermes/plugins/securevector`` and calls
``register(ctx)``. One hook is registered: ``post_api_request``, which fires
once per model API call with that call's token usage. Each call becomes one
record in SecureVector Cost Tracking. ``post_llm_call`` is not used: it covers
the same calls once per turn and would count them twice.

Standard library only. The hook never raises and never blocks the turn: the
POST runs in a daemon thread with a short timeout.
"""

from __future__ import annotations

import logging

from .cost import on_post_api_request

log = logging.getLogger(__name__)


def register(ctx) -> None:
    ctx.register_hook("post_api_request", on_post_api_request)
    log.info("SecureVector cost tracking attached to Hermes")
