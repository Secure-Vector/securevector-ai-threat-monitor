"""Trace text posture: redact first, then cap.

Every piece of free text a trace stores locally (tool arguments, verdict
reasons, LLM input and output previews) goes through ``sanitize_trace_text``
at the repository boundary, so the guarantee holds no matter which producer
wrote the span: the bundled plugins, the OTLP ingest, the SDK decorator, the
LLM proxy or a transcript import. Producers may redact too; this pass is the
one that cannot be skipped.

Order matters: secrets are scrubbed on the FULL text before the cap is
applied, so a credential that straddles the cap boundary is caught rather
than cut in half and stored as a partial key.

The cap is 8 KB per field (5.3.0; previously 200 characters). Traces stay on
the device, so the local copy is allowed to be useful for debugging; the cap
exists to keep system prompts and large file reads from bloating the local
database. The cloud fleet feed is unaffected: it never carries these fields.
"""

from __future__ import annotations

from typing import Optional, Tuple

from securevector.app.utils.redaction import redact_secrets

# Per-field cap on stored trace text. Matches the SIEM full-tier per-field cap
# so a local trace and a full-tier SIEM record carry the same amount of text.
TRACE_TEXT_CAP = 8192


def sanitize_trace_text(
    text: Optional[object],
    *,
    direction: str = "outgoing",
    cap: int = TRACE_TEXT_CAP,
) -> Tuple[Optional[str], bool]:
    """Redact secrets in ``text`` and cap it. Returns ``(text, truncated)``.

    ``None`` stays ``None`` (the "not stored" marker the UI relies on).
    ``direction`` follows :func:`redact_secrets`: "outgoing" for tool
    arguments and prompts, "incoming" for tool results, "llm_response" for
    model output.
    """
    if text is None:
        return None, False
    s = text if isinstance(text, str) else str(text)
    if not s:
        return s, False
    redacted, _ = redact_secrets(s, direction=direction)
    if len(redacted) > cap:
        return redacted[:cap], True
    return redacted, False
