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


# --- Estimated model time (duration_ms from the feeding record) -------------

def _cc_gen_after(_claude_home, sid, user_ts, asst_ts):
    projects = _claude_home / "projects"
    recs = [_asst("req-D", "claude-x", "hi", {"input_tokens": 1, "output_tokens": 1}, ts=asst_ts)]
    if user_ts is not False:
        u = _user("go", ts=user_ts) if user_ts else {"type": "user", "message": {"role": "user", "content": "go"}}
        recs.insert(0, u)
    _write_transcript(projects, sid, recs)
    gens = build_generations(sid, store_text=False)
    assert len(gens) == 1
    return gens[0]


def test_estimated_duration_normal_gap(_claude_home):
    g = _cc_gen_after(_claude_home, "d1", "2026-07-15T10:00:00.000Z", "2026-07-15T10:00:03.500Z")
    assert g["duration_ms"] == 3500
    assert g["duration_estimated"] is True


def test_estimated_duration_from_tool_result_record(_claude_home):
    projects = _claude_home / "projects"
    usage = {"input_tokens": 1, "output_tokens": 1}
    _write_transcript(projects, "d5", [
        _user("go", ts="2026-07-15T10:00:00.000Z"),
        _asst("req-1", "claude-x", "a", usage, ts="2026-07-15T10:00:02.000Z"),
        {"type": "user", "timestamp": "2026-07-15T10:00:10.000Z",
         "message": {"role": "user", "content": [
             {"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}},
        _asst("req-2", "claude-x", "b", usage, ts="2026-07-15T10:00:11.000Z"),
    ])
    gens = build_generations("d5", store_text=False)
    assert [g["duration_ms"] for g in gens] == [2000, 1000]


def test_estimated_duration_negative_gap_is_none(_claude_home):
    g = _cc_gen_after(_claude_home, "d2", "2026-07-15T10:00:05.000Z", "2026-07-15T10:00:00.000Z")
    assert g.get("duration_ms") is None
    assert "duration_estimated" not in g


def test_estimated_duration_over_30_min_is_none(_claude_home):
    g = _cc_gen_after(_claude_home, "d3", "2026-07-15T10:00:00.000Z", "2026-07-15T10:30:00.001Z")
    assert g.get("duration_ms") is None
    g = _cc_gen_after(_claude_home, "d3b", "2026-07-15T10:00:00.000Z", "2026-07-15T10:30:00.000Z")
    assert g["duration_ms"] == 30 * 60 * 1000


def test_estimated_duration_missing_timestamp_is_none(_claude_home):
    g = _cc_gen_after(_claude_home, "d4", None, "2026-07-15T10:00:03.000Z")
    assert g.get("duration_ms") is None
    g = _cc_gen_after(_claude_home, "d4b", False, "2026-07-15T10:00:03.000Z")
    assert g.get("duration_ms") is None


def test_codex_estimated_duration_from_user_and_tool_output(tmp_path, monkeypatch):
    codex = tmp_path / "codex"
    (codex / "sessions").mkdir(parents=True)
    monkeypatch.setenv("CODEX_HOME", str(codex))
    sid = "codex-dur"
    usage = {"input_tokens": 10, "output_tokens": 5}
    _write_codex_rollout(codex, sid, [
        {"type": "turn_context", "payload": {"model": "gpt-5.5"}},
        {"type": "response_item", "timestamp": "2026-06-02T18:28:00Z",
         "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "go"}]}},
        {"type": "event_msg", "timestamp": "2026-06-02T18:28:04Z",
         "payload": {"type": "token_count", "info": {"last_token_usage": usage}}},
        {"type": "response_item", "timestamp": "2026-06-02T18:28:09Z",
         "payload": {"type": "function_call_output", "call_id": "c1", "output": "ok"}},
        {"type": "event_msg", "timestamp": "2026-06-02T18:28:10Z",
         "payload": {"type": "token_count", "info": {"last_token_usage": usage}}},
        {"type": "event_msg", "timestamp": "2026-06-02T18:28:08Z",
         "payload": {"type": "token_count", "info": {"last_token_usage": usage}}},
    ])
    gens = build_generations_codex(sid, store_text=False)
    assert [g.get("duration_ms") for g in gens] == [4000, 1000, None]
    assert gens[0]["duration_estimated"] is True


def test_turn_start_prompt_or_tool_result(_claude_home):
    """Each transcript turn says what fed it, so a person's pause before a
    prompt is never read as tool time."""
    projects = _claude_home / "projects"
    usage = {"input_tokens": 1, "output_tokens": 1}
    _write_transcript(projects, "ts1", [
        _user("go", ts="2026-07-15T10:00:00.000Z"),
        _asst("req-1", "claude-x", "a", usage, ts="2026-07-15T10:00:02.000Z"),
        {"type": "user", "timestamp": "2026-07-15T10:00:10.000Z",
         "message": {"role": "user", "content": [
             {"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}},
        _asst("req-2", "claude-x", "b", usage, ts="2026-07-15T10:00:11.000Z"),
        _user("next", ts="2026-07-15T10:06:00.000Z"),
        _asst("req-3", "claude-x", "c", usage, ts="2026-07-15T10:06:02.000Z"),
    ])
    gens = build_generations("ts1", store_text=False)
    assert [g.get("turn_start") for g in gens] == ["prompt", "tool_result", "prompt"]


def test_turn_start_absent_without_a_feeding_record(_claude_home):
    g = _cc_gen_after(_claude_home, "ts2", False, "2026-07-15T10:00:03.000Z")
    assert "turn_start" not in g
    # Known even when the duration is not (no timestamp on the prompt).
    g = _cc_gen_after(_claude_home, "ts3", None, "2026-07-15T10:00:03.000Z")
    assert g["turn_start"] == "prompt"
    assert g.get("duration_ms") is None


def test_codex_turn_start_from_user_message_and_tool_output(tmp_path, monkeypatch):
    codex = tmp_path / "codex"
    (codex / "sessions").mkdir(parents=True)
    monkeypatch.setenv("CODEX_HOME", str(codex))
    sid = "codex-ts"
    usage = {"input_tokens": 10, "output_tokens": 5}
    _write_codex_rollout(codex, sid, [
        {"type": "turn_context", "payload": {"model": "gpt-5.5"}},
        {"type": "response_item", "timestamp": "2026-06-02T18:28:00Z",
         "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "go"}]}},
        {"type": "event_msg", "timestamp": "2026-06-02T18:28:04Z",
         "payload": {"type": "token_count", "info": {"last_token_usage": usage}}},
        {"type": "response_item", "timestamp": "2026-06-02T18:28:09Z",
         "payload": {"type": "function_call_output", "call_id": "c1", "output": "ok"}},
        {"type": "event_msg", "timestamp": "2026-06-02T18:28:10Z",
         "payload": {"type": "token_count", "info": {"last_token_usage": usage}}},
        {"type": "response_item", "timestamp": "2026-06-02T18:28:12Z",
         "payload": {"type": "custom_tool_call_output", "call_id": "c2", "output": "ok"}},
        {"type": "event_msg", "timestamp": "2026-06-02T18:28:13Z",
         "payload": {"type": "token_count", "info": {"last_token_usage": usage}}},
        {"type": "event_msg", "timestamp": "2026-06-02T18:28:14Z",
         "payload": {"type": "token_count", "info": {"last_token_usage": usage}}},
    ])
    gens = build_generations_codex(sid, store_text=False)
    assert [g.get("turn_start") for g in gens] == ["prompt", "tool_result", "tool_result", None]


def _codex_env(tmp_path, monkeypatch):
    codex = tmp_path / "codex"
    (codex / "sessions").mkdir(parents=True)
    monkeypatch.setenv("CODEX_HOME", str(codex))
    return codex


def _cx(ts, ptype=None, rtype="response_item", **payload):
    rec = {"type": rtype, "timestamp": f"2026-06-02T18:{ts}Z"}
    if ptype:
        payload["type"] = ptype
    rec["payload"] = payload
    return rec


def _cx_tokens(ts, out, total):
    return _cx(ts, "token_count", rtype="event_msg", info={
        "last_token_usage": {"input_tokens": 10, "output_tokens": out},
        "total_token_usage": {"input_tokens": total, "output_tokens": total}})


def _codex_tool_turn():
    """Codex's real record order for one prompt that makes two tool calls and
    then answers (synthetic content): the token_count for a call arrives only
    AFTER the output of the tool that call asked for."""
    user = [{"type": "input_text", "text": "go"}]
    say = [{"type": "output_text", "text": "ok"}]
    return [
        {"type": "turn_context", "payload": {"model": "gpt-5.5"}},
        _cx("23:23.817", "message", role="user", content=user),
        _cx("23:25.796", "reasoning"),
        _cx("23:26.105", "message", role="assistant", content=say),
        _cx("23:27.000", "custom_tool_call", call_id="c1", name="exec"),
        _cx("23:27.031", rtype="token_usage_record"),
        _cx("23:27.120", "custom_tool_call_output", call_id="c1", output="x"),
        _cx_tokens("23:27.121", 128, 100),
        _cx("23:29.000", "custom_tool_call", call_id="c2", name="exec"),
        _cx("23:29.045", rtype="token_usage_record"),
        _cx("23:29.083", "custom_tool_call_output", call_id="c2", output="x"),
        _cx_tokens("23:29.085", 84, 200),
        _cx("23:31.042", "message", role="assistant", content=say),
        _cx("23:31.078", rtype="token_usage_record"),
        _cx_tokens("23:31.079", 75, 300),
    ]


def test_codex_call_timed_from_its_own_records(tmp_path, monkeypatch):
    codex = _codex_env(tmp_path, monkeypatch)
    _write_codex_rollout(codex, "cx-order", _codex_tool_turn())
    gens = build_generations_codex("cx-order", store_text=False)
    assert len(gens) == 3
    # Model end is the call's token_usage_record, not its later token_count.
    assert [g["called_at"] for g in gens] == [
        "2026-06-02T18:23:27.031Z", "2026-06-02T18:23:29.045Z", "2026-06-02T18:23:31.078Z"]
    # Start: the prompt, then each tool output that fed the next call.
    assert [g["duration_ms"] for g in gens] == [3214, 1925, 1995]
    assert all(1500 <= g["duration_ms"] <= 3500 for g in gens), "about 2 s each, never ~1 ms"
    assert [g["turn_start"] for g in gens] == ["prompt", "tool_result", "tool_result"]


def test_codex_repeated_token_count_is_one_generation(tmp_path, monkeypatch):
    codex = _codex_env(tmp_path, monkeypatch)
    recs = _codex_tool_turn()
    # The last call's usage reported twice (same running total), plus a zero.
    recs.append(_cx_tokens("23:31.090", 75, 300))
    recs.append(_cx_tokens("23:31.095", 0, 300))
    _write_codex_rollout(codex, "cx-dup", recs)
    gens = build_generations_codex("cx-dup", store_text=False)
    assert len(gens) == 3


def test_meta_user_records_are_not_prompts(_claude_home):
    """isMeta records and Claude Code's command/caveat wrappers are not typed
    prompts: they leave the turn's start as it was."""
    projects = _claude_home / "projects"
    usage = {"input_tokens": 1, "output_tokens": 1}
    tool_result = {"type": "user", "timestamp": "2026-07-15T10:00:10.000Z",
                   "message": {"role": "user", "content": [
                       {"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}}
    meta = {"type": "user", "isMeta": True, "timestamp": "2026-07-15T10:00:10.500Z",
            "message": {"role": "user", "content": "<local-command-caveat>x</local-command-caveat>"}}
    wrapper = _user("<command-name>/clear</command-name>", ts="2026-07-15T10:00:10.600Z")
    _write_transcript(projects, "meta1", [
        _user("go", ts="2026-07-15T10:00:00.000Z"),
        _asst("req-1", "claude-x", "a", usage, ts="2026-07-15T10:00:02.000Z"),
        tool_result, meta, wrapper,
        _asst("req-2", "claude-x", "b", usage, ts="2026-07-15T10:00:11.000Z"),
        _user("next", ts="2026-07-15T10:05:00.000Z"),
        _asst("req-3", "claude-x", "c", usage, ts="2026-07-15T10:05:02.000Z"),
    ])
    gens = build_generations("meta1", store_text=False)
    assert [g.get("turn_start") for g in gens] == ["prompt", "tool_result", "prompt"]


def test_claude_tool_use_names_keep_repeats(_claude_home):
    projects = _claude_home / "projects"
    usage = {"input_tokens": 1, "output_tokens": 1}
    rec = _asst("req-1", "claude-x", "", usage, ts="2026-07-15T10:00:02.000Z")
    rec["message"]["content"] = [
        {"type": "tool_use", "id": "a", "name": "Bash", "input": {"command": "secret"}},
        {"type": "tool_use", "id": "b", "name": "Bash", "input": {"command": "secret"}},
        {"type": "tool_use", "id": "c", "name": "Read", "input": {}},
    ]
    _write_transcript(projects, "names1", [_user("go", ts="2026-07-15T10:00:00.000Z"), rec])
    g = build_generations("names1", store_text=False)[0]
    assert g["tool_use_names"] == ["Bash", "Bash", "Read"]
    assert g["tools_called"] == ["Bash", "Read"]
    assert "secret" not in json.dumps(g)


def test_codex_tool_use_names_use_the_hook_name(tmp_path, monkeypatch):
    codex = _codex_env(tmp_path, monkeypatch)
    recs = _codex_tool_turn()
    recs.insert(-1, _cx("23:31.050", "function_call", call_id="c3", name="apply_patch", arguments="secret"))
    _write_codex_rollout(codex, "cx-names", recs)
    gens = build_generations_codex("cx-names", store_text=False)
    assert [g["tool_use_names"] for g in gens] == [["Bash"], ["Bash"], ["apply_patch"]]
    assert all(g["tools_called"] == [] for g in gens), "tools_called unchanged for Codex"
    assert "secret" not in json.dumps(gens)


def test_codex_fallback_end_prefers_the_usage_record(tmp_path, monkeypatch):
    codex = _codex_env(tmp_path, monkeypatch)
    _write_codex_rollout(codex, "cx-fb", [
        {"type": "turn_context", "payload": {"model": "gpt-5.5"}},
        _cx("28:00.000", "message", role="user", content=[{"type": "input_text", "text": "go"}]),
        _cx("28:02.000", rtype="token_usage_record"),
        _cx("28:05.000", "custom_tool_call_output", call_id="c1", output="x"),
        _cx_tokens("28:05.001", 10, 100),
    ])
    g = build_generations_codex("cx-fb", store_text=False)[0]
    assert g["called_at"] == "2026-06-02T18:28:02.000Z"
