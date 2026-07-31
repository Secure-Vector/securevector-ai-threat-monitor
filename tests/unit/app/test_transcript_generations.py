"""Tests for transcript-derived Generation spans (agent-observability §2).

Covers the LLM-turn reconstruction that fills the "where's the LLM input/
output?" gap: round-trip grouping (one generation per requestId, NOT per
streamed record — so tokens aren't multiplied), the store_text privacy gate,
secret redaction + 200-char cap on previews, and cost application.
"""

from __future__ import annotations

import json
import os

import pytest

from securevector.app.server.routes.transcript_generations import (
    PREVIEW_CAP,
    apply_cost,
    build_generations,
    build_generations_codex,
)


def _write_transcript(projects_dir, session_id, records):
    """Write a CC-style transcript at <projects>/<slug>/<session>.jsonl."""
    slug = projects_dir / "-Users-x-proj"
    slug.mkdir(parents=True, exist_ok=True)
    path = slug / f"{session_id}.jsonl"
    with path.open("w", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec) + "\n")
    return path


def _asst(request_id, model, text, usage, *, stop=None, ts="2026-07-15T10:00:00.000Z"):
    return {
        "type": "assistant",
        "requestId": request_id,
        "timestamp": ts,
        "message": {
            "role": "assistant",
            "model": model,
            "usage": usage,
            "stop_reason": stop,
            "content": [{"type": "text", "text": text}] if text else [],
        },
    }


def _user(text, ts="2026-07-15T09:59:59.000Z"):
    return {"type": "user", "timestamp": ts, "message": {"role": "user", "content": text}}


@pytest.fixture(autouse=True)
def _claude_home(tmp_path, monkeypatch):
    """Point the walker at a temp CLAUDE_HOME/projects dir."""
    home = tmp_path / "claude"
    (home / "projects").mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_HOME", str(home))
    return home


def test_missing_transcript_returns_empty(_claude_home):
    assert build_generations("no-such-session", store_text=True) == []


def test_one_generation_per_request_id_not_per_record(_claude_home):
    """A round-trip streamed as 3 records with identical usage must collapse to
    ONE generation — otherwise tokens are triple-counted."""
    projects = _claude_home / "projects"
    usage = {"input_tokens": 100, "output_tokens": 40}
    _write_transcript(projects, "s1", [
        _user("hello there"),
        _asst("req-A", "claude-x", "part one", usage),
        _asst("req-A", "claude-x", "part two", usage),
        _asst("req-A", "claude-x", "part three", usage, stop="end_turn"),
    ])
    gens = build_generations("s1", store_text=True)
    assert len(gens) == 1
    g = gens[0]
    # Usage counted ONCE, not summed across the 3 records.
    assert g["input_tokens"] == 100
    assert g["output_tokens"] == 40
    # Text blocks concatenated; terminal stop_reason wins.
    assert "part one" in g["output_preview"]
    assert "part three" in g["output_preview"]
    assert g["stop_reason"] == "end_turn"
    # The driving prompt is attached as input.
    assert g["input_preview"] == "hello there"
    assert g["input_is_tool_result"] is False


def test_separate_request_ids_are_separate_generations(_claude_home):
    projects = _claude_home / "projects"
    u = {"input_tokens": 10, "output_tokens": 5}
    _write_transcript(projects, "s2", [
        _user("q1"),
        _asst("req-1", "m", "a1", u),
        _user("q2"),
        _asst("req-2", "m", "a2", u),
    ])
    gens = build_generations("s2", store_text=True)
    assert len(gens) == 2
    assert gens[0]["input_preview"] == "q1"
    assert gens[1]["input_preview"] == "q2"


def test_store_text_off_omits_previews_but_keeps_metadata(_claude_home):
    projects = _claude_home / "projects"
    _write_transcript(projects, "s3", [
        _user("secret prompt text"),
        _asst("r", "m", "some answer", {"input_tokens": 7, "output_tokens": 3}),
    ])
    gens = build_generations("s3", store_text=False)
    assert len(gens) == 1
    g = gens[0]
    # Previews withheld (None => UI shows "text preview off").
    assert g["input_preview"] is None
    assert g["output_preview"] is None
    # Metadata still present.
    assert g["input_tokens"] == 7
    assert g["output_tokens"] == 3
    assert g["model"] == "m"


def test_preview_is_redacted_and_capped(_claude_home):
    projects = _claude_home / "projects"
    leak = "my key is sk_live_" + "A" * 40
    long_out = "X" * (PREVIEW_CAP + 100)
    _write_transcript(projects, "s4", [
        _user(leak),
        _asst("r", "m", long_out, {"input_tokens": 1, "output_tokens": 1}),
    ])
    g = build_generations("s4", store_text=True)[0]
    # Secret redacted in the input preview.
    assert "sk_live_AAAA" not in g["input_preview"]
    assert "****" in g["input_preview"]
    # Output capped at PREVIEW_CAP and flagged truncated.
    assert len(g["output_preview"]) == PREVIEW_CAP
    assert g["output_truncated"] is True


def test_tool_result_turn_marks_input_is_tool_result(_claude_home):
    projects = _claude_home / "projects"
    _write_transcript(projects, "s5", [
        _user("do the thing"),
        _asst("r1", "m", "", {"input_tokens": 5, "output_tokens": 2}, stop="tool_use"),
        # A tool_result user turn carries no plain text.
        {"type": "user", "timestamp": "2026-07-15T10:01:00.000Z",
         "message": {"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}},
        _asst("r2", "m", "done", {"input_tokens": 6, "output_tokens": 2}),
    ])
    gens = build_generations("s5", store_text=True)
    assert len(gens) == 2
    # Second generation was driven by a tool result, not a human prompt.
    assert gens[1]["input_is_tool_result"] is True
    assert gens[1]["input_preview"] == ""  # honest empty, not the stale prompt


def test_generation_captures_tool_use_names(_claude_home):
    """A tool_use stop records WHICH tools the run asked to call — deduped,
    order-preserving, MCP tools kept as their raw namespaced name (UI shortens).
    """
    projects = _claude_home / "projects"
    usage = {"input_tokens": 20, "output_tokens": 8}
    asst = {
        "type": "assistant", "requestId": "req-T",
        "timestamp": "2026-07-15T10:00:00.000Z",
        "message": {
            "role": "assistant", "model": "claude-opus-4-8", "usage": usage,
            "stop_reason": "tool_use",
            "content": [
                {"type": "text", "text": "let me check"},
                {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}},
                {"type": "tool_use", "name": "Bash", "input": {"command": "pwd"}},
                {"type": "tool_use", "name": "mcp__chrome__computer", "input": {}},
            ],
        },
    }
    _write_transcript(projects, "st", [_user("go"), asst])
    g = build_generations("st", store_text=True)[0]
    assert g["stop_reason"] == "tool_use"
    # Bash collapsed to one; MCP tool kept raw for the UI to shorten.
    assert g["tools_called"] == ["Bash", "mcp__chrome__computer"]


def test_synthetic_model_records_are_not_llm_runs(_claude_home):
    """Claude Code's system-injected turns carry model "<synthetic>" and zero
    usage — they are not real API calls and must not appear as LLM runs."""
    projects = _claude_home / "projects"
    _write_transcript(projects, "ssyn", [
        _user("go"),
        _asst("req-real", "claude-opus-4-8", "hi", {"input_tokens": 5, "output_tokens": 2}, stop="end_turn"),
        _asst("req-syn", "<synthetic>", "", {"input_tokens": 0, "output_tokens": 0}, stop="stop_sequence"),
    ])
    gens = build_generations("ssyn", store_text=True)
    assert [g["model"] for g in gens] == ["claude-opus-4-8"]


def test_generation_captures_tool_results(_claude_home):
    """Pillar 3: the tool_result blocks in the user turn AFTER a run are matched
    back to that run's calls by tool_use_id, with error flag + redacted preview.
    """
    projects = _claude_home / "projects"
    asst = {
        "type": "assistant", "requestId": "req-R",
        "timestamp": "2026-07-15T10:00:00.000Z",
        "message": {
            "role": "assistant", "model": "claude-opus-4-8",
            "usage": {"input_tokens": 5, "output_tokens": 3},
            "stop_reason": "tool_use",
            "content": [
                {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "ls"}},
                {"type": "tool_use", "id": "toolu_2", "name": "Read", "input": {"path": "x"}},
            ],
        },
    }
    user_results = {
        "type": "user", "timestamp": "2026-07-15T10:00:05.000Z",
        "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_1", "content": "file1\nfile2"},
            {"type": "tool_result", "tool_use_id": "toolu_2", "content": "boom", "is_error": True},
        ]},
    }
    # A trailing assistant turn so the results-bearing user turn isn't the last line.
    tail = _asst("req-S", "m", "done", {"input_tokens": 2, "output_tokens": 1}, stop="end_turn")
    _write_transcript(projects, "str", [_user("go"), asst, user_results, tail])
    gens = build_generations("str", store_text=True)
    g = gens[0]
    results = {r["name"]: r for r in g["tool_results"]}
    assert set(results) == {"Bash", "Read"}
    assert results["Bash"]["preview"] == "file1\nfile2"
    assert results["Bash"]["is_error"] is False
    assert results["Read"]["is_error"] is True


def test_tool_results_omit_preview_when_store_text_off(_claude_home):
    projects = _claude_home / "projects"
    asst = {
        "type": "assistant", "requestId": "req-R2", "timestamp": "2026-07-15T10:00:00.000Z",
        "message": {"role": "assistant", "model": "m", "usage": {"input_tokens": 1, "output_tokens": 1},
                    "stop_reason": "tool_use",
                    "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}]},
    }
    user = {"type": "user", "timestamp": "2026-07-15T10:00:05.000Z",
            "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "secret"}]}}
    tail = _asst("req-S2", "m", "ok", {"input_tokens": 1, "output_tokens": 1}, stop="end_turn")
    _write_transcript(projects, "str2", [_user("go"), asst, user, tail])
    g = build_generations("str2", store_text=False)[0]
    assert g["tool_results"][0]["name"] == "Bash"
    assert "preview" not in g["tool_results"][0]  # content withheld when store_text off


def test_generation_without_tools_has_empty_tools_called(_claude_home):
    projects = _claude_home / "projects"
    _write_transcript(projects, "snt", [
        _user("hi"),
        _asst("r", "m", "hello", {"input_tokens": 3, "output_tokens": 1}, stop="end_turn"),
    ])
    g = build_generations("snt", store_text=True)[0]
    assert g["tools_called"] == []


def _write_codex_rollout(codex_home, session_id, records):
    """Write a Codex-style rollout jsonl under sessions/YYYY/MM/DD/."""
    day = codex_home / "sessions" / "2026" / "06" / "02"
    day.mkdir(parents=True, exist_ok=True)
    path = day / f"rollout-2026-06-02T13-28-39-{session_id}.jsonl"
    with path.open("w", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec) + "\n")
    return path


def test_codex_generations_parsed_from_rollout(tmp_path, monkeypatch):
    """Codex's rollout format (token_count events + turn_context model +
    output_text) reconstructs generations, one per model turn."""
    codex = tmp_path / "codex"
    (codex / "sessions").mkdir(parents=True)
    monkeypatch.setenv("CODEX_HOME", str(codex))
    sid = "019e8998-4900-7221-818e-d5c8ca660081"
    _write_codex_rollout(codex, sid, [
        {"type": "session_meta", "payload": {"id": sid}},
        {"type": "turn_context", "payload": {"model": "gpt-5.5"}},
        {"type": "response_item", "timestamp": "2026-06-02T18:28:00Z",
         "payload": {"type": "message", "role": "user",
                     "content": [{"type": "input_text", "text": "read the file"}]}},
        {"type": "response_item", "timestamp": "2026-06-02T18:28:01Z",
         "payload": {"type": "message", "role": "assistant",
                     "content": [{"type": "output_text", "text": "Reading it now."}]}},
        {"type": "event_msg", "timestamp": "2026-06-02T18:28:02Z",
         "payload": {"type": "token_count", "info": {"last_token_usage": {
             "input_tokens": 11425, "cached_input_tokens": 9088, "output_tokens": 132}}}},
    ])
    gens = build_generations_codex(sid, store_text=True)
    assert len(gens) == 1
    g = gens[0]
    assert g["model"] == "gpt-5.5"
    assert g["input_tokens"] == 11425 - 9088   # fresh = total − cached
    assert g["cache_read_tokens"] == 9088
    assert g["output_tokens"] == 132
    assert g["output_preview"] == "Reading it now."
    assert g["input_preview"] == "read the file"


def test_codex_missing_rollout_returns_empty(tmp_path, monkeypatch):
    codex = tmp_path / "codex"
    (codex / "sessions").mkdir(parents=True)
    monkeypatch.setenv("CODEX_HOME", str(codex))
    assert build_generations_codex("no-such", store_text=True) == []


def test_codex_zero_output_turns_skipped(tmp_path, monkeypatch):
    """A token_count with no output (e.g. a tool-only step) isn't a generation."""
    codex = tmp_path / "codex"
    (codex / "sessions").mkdir(parents=True)
    monkeypatch.setenv("CODEX_HOME", str(codex))
    sid = "abc"
    _write_codex_rollout(codex, sid, [
        {"type": "turn_context", "payload": {"model": "gpt-5.5"}},
        {"type": "event_msg", "payload": {"type": "token_count", "info": {
            "last_token_usage": {"input_tokens": 10, "output_tokens": 0}}}},
    ])
    assert build_generations_codex(sid, store_text=True) == []


def test_apply_cost_fills_known_model_only(_claude_home):
    gens = [
        {"model": "priced", "input_tokens": 1_000_000, "output_tokens": 1_000_000, "cost": None},
        {"model": "unpriced", "input_tokens": 500, "output_tokens": 500, "cost": None},
    ]
    apply_cost(gens, {"priced": (3.0, 15.0)})
    assert gens[0]["cost"] == pytest.approx(18.0)  # 3 + 15
    # Unknown model stays None (UI shows "—", never a wrong $0).
    assert gens[1]["cost"] is None
