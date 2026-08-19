"""Tests for the Cost / Token Optimizer (issue #202).

Covers the appendix's detection logic: segmentation, the cache / compaction
waste partition (buckets must reconcile — total avoidable = A + B is asserted
here, so any detector change that breaks the partition is a build error),
retry/duplicate detection off the new analysis hashes, Codex abstention, the
noise floor, receipt abstention below the minimum window, and the privacy
contract (no prompt text ever reaches the report).
"""

from __future__ import annotations

import asyncio
import json

import pytest

import securevector.app.services.cost_optimizer as co
from securevector.app.services.cost_optimizer import (
    CostOptimizerService,
    THRESHOLDS,
    analyze_session,
    detect_duplicates,
    detect_excessive_output,
    detect_retry_loops,
    prompt_tokens,
    segment_generations,
)

PRICING = {"claude-x": ("anthropic", 3.0, 15.0)}


def _gen(inp=0, read=0, create=0, out=100, model="claude-x", ts=None, **kw):
    g = {
        "model": model,
        "input_tokens": inp,
        "cache_read_tokens": read,
        "cache_creation_tokens": create,
        "output_tokens": out,
        "called_at": ts,
        "tools_called": [],
        "tool_results": [],
    }
    g.update(kw)
    return g


def _ts(i, step=30):
    return f"2026-08-01T10:{(i * step) // 60:02d}:{(i * step) % 60:02d}.000Z"


# ---------------------------------------------------------------------------
# segmentation
# ---------------------------------------------------------------------------

def test_segments_cut_on_model_change():
    gens = [_gen(inp=1000), _gen(inp=1200), _gen(inp=1400, model="other"), _gen(inp=1600, model="other")]
    assert segment_generations(gens) == [[0, 1], [2, 3]]


def test_segments_cut_on_prompt_shrink_beyond_jitter():
    # 5000 -> 2000 is a compaction; 5000 -> 4800 is jitter
    gens = [_gen(inp=5000), _gen(inp=4800), _gen(inp=2000), _gen(inp=2200)]
    assert segment_generations(gens) == [[0, 1], [2, 3]]


# ---------------------------------------------------------------------------
# cache bucket (A)
# ---------------------------------------------------------------------------

def test_cache_bucket_counts_carried_tokens_billed_full():
    # Growing prompt, everything billed as fresh input, no caching at all:
    # carried context beyond growth is avoidable.
    gens = [_gen(inp=2000 + 500 * i, ts=_ts(i)) for i in range(5)]
    a = analyze_session(gens, PRICING)
    # each turn i>=1: avoidable = in_i - fresh_i = prompt_prev
    expected = sum(2000 + 500 * i for i in range(4))
    assert a["cache_bucket"]["tokens"] == expected
    assert a["cache_bucket"]["est_value_usd"] > 0


def test_cache_bucket_zero_when_caching_is_healthy():
    # Stable prefix served from cache: only fresh growth is billed as input.
    gens = [_gen(inp=500, read=0, ts=_ts(0))]
    for i in range(1, 5):
        gens.append(_gen(inp=500, read=500 * i, ts=_ts(i)))
    a = analyze_session(gens, PRICING)
    assert a["cache_bucket"]["tokens"] == 0


def test_cache_bucket_respects_ttl_gap():
    # A gap beyond the TTL makes the miss unavoidable, not waste.
    gens = [
        _gen(inp=3000, ts="2026-08-01T10:00:00.000Z"),
        _gen(inp=3500, ts="2026-08-01T11:00:00.000Z"),  # 1h later
    ]
    a = analyze_session(gens, PRICING)
    assert a["cache_bucket"]["tokens"] == 0


def test_cache_bucket_respects_min_cacheable_prefix():
    gens = [_gen(inp=200, ts=_ts(0)), _gen(inp=400, ts=_ts(1))]
    a = analyze_session(gens, PRICING)
    assert a["cache_bucket"]["tokens"] == 0


def test_cache_value_zero_for_provider_without_discount():
    # Unknown provider conventions: tokens may count, value must not be claimed.
    pricing = {"claude-x": ("unknown-vendor", 3.0, 15.0)}
    gens = [_gen(inp=2000 + 500 * i, ts=_ts(i)) for i in range(5)]
    a = analyze_session(gens, pricing)
    assert a["cache_bucket"]["est_value_usd"] == 0


# ---------------------------------------------------------------------------
# compaction bucket (B) + reconciliation
# ---------------------------------------------------------------------------

def test_compaction_bucket_only_after_keep_window():
    k = THRESHOLDS["compaction_keep_turns"]
    gens = [_gen(inp=2000 + 1000 * i, ts=_ts(i)) for i in range(k)]
    a = analyze_session(gens, PRICING)
    assert a["compaction_bucket"]["tokens"] == 0  # session shorter than k

    gens = [_gen(inp=2000 + 1000 * i, ts=_ts(i)) for i in range(k + 5)]
    a = analyze_session(gens, PRICING)
    assert a["compaction_bucket"]["tokens"] > 0


def test_buckets_reconcile_total_avoidable_is_a_plus_b():
    """The comparison strip is derived: modeled = observed - (A + B). The
    partition must hold in the report itself."""
    svc = CostOptimizerService()
    sessions = [{
        "session_id": "s1", "harness": "claude-code", "trace_id": "t1",
        "gens": [_gen(inp=2000 + 800 * i, ts=_ts(i)) for i in range(18)],
    }]
    report = svc._analyze(sessions, PRICING, 30, {"claude_code": 1, "codex": 0}, False)
    a = report["buckets"]["cache"]["est_value_usd"]
    b = report["buckets"]["compaction"]["est_value_usd"]
    assert report["modeled"]["est_cost_usd"] == pytest.approx(
        report["observed"]["est_cost_usd"] - a - b, abs=0.02
    )
    assert report["modeled"]["total_tokens"] == (
        report["observed"]["total_tokens"] - report["buckets"]["compaction"]["tokens"]
    )
    # lower-bound honesty: the modeled side never exceeds observed
    assert report["modeled"]["est_cost_usd"] <= report["observed"]["est_cost_usd"]
    assert report["modeled"]["total_tokens"] <= report["observed"]["total_tokens"]


# ---------------------------------------------------------------------------
# retry / duplicate / output detectors
# ---------------------------------------------------------------------------

def test_retry_loop_needs_error_and_three_repeats():
    call = {"name": "Bash", "args_hash": "abc"}
    err = {"name": "Bash", "is_error": True}
    ok = {"name": "Bash", "is_error": False}
    gens = [
        _gen(tool_calls=[call], tool_results=[err]),
        _gen(tool_calls=[call], tool_results=[err]),
        _gen(tool_calls=[call], tool_results=[ok]),
    ]
    loops = detect_retry_loops(gens)
    assert len(loops) == 1 and loops[0]["turns"] == [0, 1, 2]

    # two repeats: not a loop
    assert detect_retry_loops(gens[:2]) == []
    # no error in between: polling, not retrying
    gens_ok = [_gen(tool_calls=[call], tool_results=[ok]) for _ in range(4)]
    assert detect_retry_loops(gens_ok) == []


def test_retry_loop_excludes_idempotent_tools():
    call = {"name": "Read", "args_hash": "abc"}
    err = {"name": "Read", "is_error": True}
    gens = [_gen(tool_calls=[call], tool_results=[err]) for _ in range(4)]
    assert detect_retry_loops(gens) == []


def test_duplicates_need_identical_hash_and_no_tool_call_between():
    gens = [
        _gen(input_hash="h1", request_id="r1"),
        _gen(input_hash="h1", request_id="r2"),
        _gen(input_hash="h1", request_id="r3", tool_calls=[{"name": "Bash", "args_hash": "x"}]),
        _gen(input_hash="h1", request_id="r4"),
    ]
    dups = detect_duplicates(gens)
    # r1->r2 duplicate, r2->r3 duplicate (r2 had no tool calls), r3->r4 broken
    # by r3's tool call
    assert len(dups) == 1 and dups[0]["turns"] == [0, 1, 2]


def test_duplicates_dedupe_transport_retries_by_request_id():
    gens = [
        _gen(input_hash="h1", request_id="r1"),
        _gen(input_hash="h1", request_id="r1"),  # same request: transport retry
    ]
    assert detect_duplicates(gens) == []


def test_excessive_output_abstains_below_group_minimum():
    sessions = [{
        "session_id": "s", "harness": "claude-code",
        "gens": [_gen(inp=500, out=100) for _ in range(5)] + [_gen(inp=500, out=9000)],
    }]
    assert detect_excessive_output(sessions) == []


def test_excessive_output_flags_outlier_with_enough_history():
    gens = [_gen(inp=500, out=100) for _ in range(25)]
    gens.append(_gen(inp=500, out=1000, stop_reason="max_tokens"))
    sessions = [{"session_id": "s", "harness": "claude-code", "gens": gens}]
    hits = detect_excessive_output(sessions)
    assert len(hits) == 1
    assert hits[0]["turn"] == 25 and hits[0]["hit_max_tokens"] is True


# ---------------------------------------------------------------------------
# report-level behaviour
# ---------------------------------------------------------------------------

def _big_wasteful_session(sid="s1"):
    return {
        "session_id": sid, "harness": "claude-code", "trace_id": "t-" + sid,
        "gens": [_gen(inp=5000 + 4000 * i, ts=_ts(i)) for i in range(16)],
    }


def test_findings_are_attributable_and_ranked():
    svc = CostOptimizerService()
    report = svc._analyze([_big_wasteful_session()], PRICING, 30,
                          {"claude_code": 1, "codex": 0}, False)
    assert report["findings"], "a wasteful session must produce findings"
    for f in report["findings"]:
        if f.get("observation_only"):
            continue
        assert f["session_id"], "every finding names a session"
        assert f["turns"], "every finding names its turns"
    values = [f.get("est_value_usd") or 0 for f in report["findings"]]
    assert values == sorted(values, reverse=True)


def test_noise_floor_suppresses_small_findings():
    svc = CostOptimizerService()
    small = {
        "session_id": "tiny", "harness": "claude-code", "trace_id": "t",
        "gens": [_gen(inp=1200 + 50 * i, out=20, ts=_ts(i)) for i in range(6)],
    }
    report = svc._analyze([small], PRICING, 30, {"claude_code": 1, "codex": 0}, False)
    assert report["findings"] == []


def test_codex_capability_note_present():
    svc = CostOptimizerService()
    codex = {
        "session_id": "cx", "harness": "codex", "trace_id": "t",
        "gens": [_gen(inp=2000 + 500 * i, ts=_ts(i)) for i in range(8)],
    }
    report = svc._analyze([codex], PRICING, 30, {"claude_code": 0, "codex": 1}, False)
    notes = report["capability_notes"]
    assert notes and notes[0]["harness"] == "codex"
    assert "retry_loop" in notes[0]["abstained"]


def test_unpriced_model_yields_tokens_without_dollars():
    svc = CostOptimizerService()
    sess = {
        "session_id": "s", "harness": "claude-code", "trace_id": "t",
        "gens": [_gen(inp=8000 + 6000 * i, model="mystery", ts=_ts(i)) for i in range(14)],
    }
    report = svc._analyze([sess], {}, 30, {"claude_code": 1, "codex": 0}, False)
    assert "mystery" in report["observed"]["unpriced_models"]
    assert report["observed"]["est_cost_usd"] == 0
    assert report["buckets"]["cache"]["tokens"] > 0
    assert report["buckets"]["cache"]["est_value_usd"] == 0


# ---------------------------------------------------------------------------
# receipts
# ---------------------------------------------------------------------------

def test_receipts_abstain_below_minimum_window(tmp_path, monkeypatch):
    monkeypatch.setattr(co, "get_app_data_dir", lambda: tmp_path)
    svc = CostOptimizerService()
    report = svc._analyze([_big_wasteful_session()], PRICING, 30,
                          {"claude_code": 1, "codex": 0}, False)
    pending = report["receipts"]["pending"]
    assert any(p["status"] == "insufficient" and p["reason"] == "not enough sessions yet"
               for p in pending)
    assert report["receipts"]["resolved"] == []


# ---------------------------------------------------------------------------
# end-to-end scan over real transcript files
# ---------------------------------------------------------------------------

SECRET_MARKER = "hunter2-super-secret-prompt-content"


def _write_cc_transcript(claude_home, session_id, n_turns=16):
    slug = claude_home / "projects" / "-Users-x-proj"
    slug.mkdir(parents=True, exist_ok=True)
    path = slug / f"{session_id}.jsonl"
    with path.open("w", encoding="utf-8") as fh:
        for i in range(n_turns):
            user = {
                "type": "user",
                "timestamp": _ts(i * 2),
                "message": {"role": "user", "content": f"{SECRET_MARKER} turn {i}"},
            }
            asst = {
                "type": "assistant", "requestId": f"req-{i}", "timestamp": _ts(i * 2 + 1),
                "message": {
                    "role": "assistant", "model": "claude-x",
                    "usage": {"input_tokens": 5000 + 4000 * i, "output_tokens": 300},
                    "stop_reason": "end_turn",
                    "content": [{"type": "text", "text": f"answer {i}"}],
                },
            }
            fh.write(json.dumps(user) + "\n")
            fh.write(json.dumps(asst) + "\n")
    return path


@pytest.fixture()
def optimizer_env(tmp_path, monkeypatch):
    claude_home = tmp_path / "claude"
    (claude_home / "projects").mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_HOME", str(claude_home))
    codex_home = tmp_path / "codex"
    (codex_home / "sessions").mkdir(parents=True)
    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setattr(co, "get_app_data_dir", lambda: data_dir)
    return claude_home


def test_scan_end_to_end_writes_report_and_leaks_no_text(optimizer_env):
    _write_cc_transcript(optimizer_env, "sess-e2e")
    svc = CostOptimizerService()
    report = asyncio.run(svc._scan(None, window_days=30))
    assert report["scanned"]["claude_code"] == 1
    assert report["observed"]["total_tokens"] > 0
    assert report["findings"], "the wasteful transcript must produce findings"
    # privacy: no prompt text, no transcript paths in the report
    dumped = json.dumps(report)
    assert SECRET_MARKER not in dumped
    assert "projects" not in dumped and str(optimizer_env) not in dumped


def test_scan_degrades_without_db(optimizer_env):
    """db=None must degrade to unpriced token-only findings, never crash."""
    _write_cc_transcript(optimizer_env, "sess-nodb")
    svc = CostOptimizerService()
    report = asyncio.run(svc._scan(None, window_days=30))
    assert report["observed"]["est_cost_usd"] == 0
    assert report["buckets"]["compaction"]["tokens"] >= 0


def test_consent_and_prefs_roundtrip(optimizer_env):
    svc = CostOptimizerService()
    assert svc.consented() is None
    svc.record_consent()
    assert svc.consented() is not None
    prefs = svc.set_prefs(billing_mode="subscription", recommend_enabled=True)
    assert prefs["billing_mode"] == "subscription"
    assert prefs["recommend_enabled"] is True
    # unknown keys are dropped, consent survives
    svc.set_prefs(nonsense=1)
    assert svc.get_prefs().get("nonsense") is None
    assert svc.consented() is not None


# ---------------------------------------------------------------------------
# analysis fields from the transcript rebuild
# ---------------------------------------------------------------------------

def test_rebuild_analysis_fields_are_hashes_not_text(optimizer_env):
    from securevector.app.server.routes.transcript_generations import build_generations
    _write_cc_transcript(optimizer_env, "sess-hash")
    gens = build_generations("sess-hash", store_text=False, with_analysis=True)
    assert gens
    for g in gens:
        h = g.get("input_hash")
        assert h is None or (len(h) == 16 and SECRET_MARKER not in h)
        assert g.get("input_preview") is None  # store_text off stays off
    # default callers see no analysis fields at all
    plain = build_generations("sess-hash", store_text=False)
    assert "input_hash" not in plain[0] and "tool_calls" not in plain[0]
