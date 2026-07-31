"""Cross-harness validation for the agent-observability features.

Every harness — the CLI agents (Claude Code, Codex, Cursor, Copilot) AND the
SDK frameworks (LangChain, LangGraph, CrewAI, Hermes) — writes to the same
tool_call_audit table, so the traces list, the per-trace waterfall, and the
blocked-action ledger must aggregate ALL of them correctly. This guards
against a feature that silently only works for one runtime.

Generation capture is transcript-derived and Claude-Code-only today; the key
invariant tested here is that a NON-claude-code trace still returns its tool
spans (no generations, no crash).
"""

from __future__ import annotations

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.custom_tools import CustomToolsRepository

# Every runtime the app can attribute a call to — CLI harnesses + SDK frameworks.
ALL_HARNESSES = [
    "claude-code", "codex", "cursor", "copilot-cli",
    "langchain", "langgraph", "crewai", "hermes",
]


async def _repo(tmp_path) -> CustomToolsRepository:
    db = DatabaseConnection(tmp_path / "xh.db")
    await run_migrations(db)
    return CustomToolsRepository(db)


async def _seed(repo, rt, sid, tool, action, *, risk=None, reason=None):
    await repo.log_tool_call_audit(
        tool, tool, action, risk=risk, reason=reason, runtime_kind=rt, session_id=sid,
    )


@pytest.mark.asyncio
async def test_every_harness_produces_a_trace(tmp_path):
    """One session per harness → one trace per harness in the traces list."""
    repo = await _repo(tmp_path)
    for rt in ALL_HARNESSES:
        await _seed(repo, rt, f"sess-{rt}", "Bash", "allow")
    runs = await repo.get_trace_runs(window_days=7, limit=100)
    seen = {r["runtime_kind"] for r in runs}
    for rt in ALL_HARNESSES:
        assert rt in seen, f"{rt} missing from the traces list"


@pytest.mark.asyncio
async def test_blocked_ledger_spans_all_harnesses(tmp_path):
    """A blocked call from any harness lands in the ledger, attributed."""
    repo = await _repo(tmp_path)
    for rt in ALL_HARNESSES:
        await _seed(repo, rt, f"sess-{rt}", "Bash", "block",
                    risk="delete", reason=f"deny from {rt}")
    led = await repo.get_blocked_ledger(window_days=7)
    assert led["summary"]["blocked_total"] == len(ALL_HARNESSES)
    # Each harness's distinct reason shows up.
    reasons = {r["reason"] for r in led["by_reason"]}
    for rt in ALL_HARNESSES:
        assert f"deny from {rt}" in reasons


@pytest.mark.asyncio
async def test_sdk_framework_trace_has_spans_no_generations(tmp_path):
    """An SDK-framework session still yields tool spans (generation capture is
    Claude-Code-only, but must never break other runtimes)."""
    repo = await _repo(tmp_path)
    for rt in ["langchain", "langgraph", "crewai", "hermes"]:
        await _seed(repo, rt, f"sess-{rt}", "search_web", "allow")
        await _seed(repo, rt, f"sess-{rt}", "run_python", "block", reason="policy")
    runs = await repo.get_trace_runs(window_days=7, limit=100)
    for r in runs:
        spans = await repo.get_trace_spans(r["trace_id"])
        assert spans, f"{r['runtime_kind']} trace has no spans"
        # These are the raw tool rows — every one names a real tool (never blank).
        assert all(s["function_name"] for s in spans)


@pytest.mark.asyncio
async def test_trace_spans_carry_session_id_for_generation_lookup(tmp_path):
    """get_trace_spans must expose session_id so the generation walker can find
    the transcript (the fix that unblocked LLM I/O capture)."""
    repo = await _repo(tmp_path)
    await _seed(repo, "claude-code", "sess-cc", "Bash", "allow")
    runs = await repo.get_trace_runs(window_days=7, limit=10)
    spans = await repo.get_trace_spans(runs[0]["trace_id"])
    assert spans[0].get("session_id") == "sess-cc"
