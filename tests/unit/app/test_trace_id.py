"""Unit tests for the agent-run trace_id derivation (story #141)."""

from __future__ import annotations

from securevector.app.utils.trace_id import derive_trace_id


def test_deterministic():
    assert derive_trace_id("claude-code", "sess-1") == derive_trace_id("claude-code", "sess-1")


def test_runtime_namespaced():
    """Same session string from different runtimes must not collide."""
    assert derive_trace_id("claude-code", "sess-1") != derive_trace_id("codex", "sess-1")


def test_runtime_kind_case_insensitive():
    assert derive_trace_id("Claude-Code", "s") == derive_trace_id("claude-code", "s")


def test_none_session_returns_none():
    assert derive_trace_id("claude-code", None) is None
    assert derive_trace_id("claude-code", "") is None


def test_missing_runtime_falls_back_to_unknown_namespace():
    assert derive_trace_id(None, "s") == derive_trace_id("unknown", "s")


def test_shape_is_32_hex():
    tid = derive_trace_id("claude-code", "sess-1")
    assert tid is not None
    assert len(tid) == 32
    assert all(c in "0123456789abcdef" for c in tid)
