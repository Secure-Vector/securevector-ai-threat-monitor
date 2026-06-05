"""Agent-run trace identity — the shared run-boundary rule.

Run-boundary rule (v1): **one agent run == one runtime session.**

``trace_id`` is a deterministic, runtime-namespaced SHA-256 of the runtime's
own session id, so every tool-call / scan / cost row emitted within a single
agent session shares one stable id — *without* the plugin hooks having to
compute any trace semantics themselves. The hooks only forward the
``session_id`` they already receive on stdin; the backend derives the trace.

Properties this guarantees:
  - **Deterministic** — the same (runtime_kind, session_id) always maps to the
    same trace_id, so rows written across separate hook invocations within one
    run correlate without coordination.
  - **Runtime-namespaced** — a "claude-code" session and a "codex" session that
    happened to share a session string can never collide.
  - **Metadata only** — trace_id is NEVER part of the tamper-evident
    tool_call_audit hash chain (same precedent as device_id / runtime_kind).

Rows that arrive without a session id get ``trace_id = None`` and render as
**orphan single-span runs** — history is never lost, just ungrouped. A
time-gap heuristic for runtimes that don't supply a session id is deferred
(see active-agent-observability story #141, open questions).

Consumed by: the tool_call_audit write path (story #141), and the
``/api/traces`` + ``/api/graph/agent-tool`` read routes (stories #142 / #143).
"""

import hashlib
from typing import Optional

# Length of the hex trace_id. 32 hex chars = 128 bits — collision-safe for the
# per-device row volumes this groups, and short enough to read in the UI.
_TRACE_ID_LEN = 32


def derive_trace_id(
    runtime_kind: Optional[str], session_id: Optional[str]
) -> Optional[str]:
    """Derive the stable per-run trace_id, or None when ungroupable.

    Args:
        runtime_kind: Which agent runtime emitted the run ("claude-code",
            "codex", "openclaw", …). Namespaces the hash so identical session
            strings from different runtimes never collide. Falsy → "unknown".
        session_id: The runtime's own session identifier. Falsy → returns None
            (the row becomes an orphan single-span run).

    Returns:
        A 32-char hex string, or None when ``session_id`` is falsy.
    """
    if not session_id:
        return None
    namespace = (runtime_kind or "unknown").strip().lower()
    digest = hashlib.sha256(f"{namespace}:{session_id}".encode("utf-8")).hexdigest()
    return digest[:_TRACE_ID_LEN]
