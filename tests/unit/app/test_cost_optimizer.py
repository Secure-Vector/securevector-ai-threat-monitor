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
from datetime import datetime, timedelta, timezone

import pytest

from securevector.app.services import cost_optimizer as co
from securevector.app.services.cost_optimizer import (
    CostOptimizerService,
    THRESHOLDS,
    analyze_session,
    detect_duplicates,
    detect_excessive_output,
    detect_retry_loops,
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


# Two days ago, so seeded transcripts always fall inside a 30-day window.
_SEED_DAY = (datetime.now(timezone.utc) - timedelta(days=2)).date().isoformat()


def _ts(i, step=30):
    return f"{_SEED_DAY}T10:{(i * step) // 60:02d}:{(i * step) % 60:02d}.000Z"


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


def test_modeled_lossless_sits_between_modeled_and_observed():
    """The headline promise: only lossless fixes (tool-result trim + cache
    rate). It must never claim more than the full-compaction ceiling and
    never exceed what was observed; its token delta equals the carry
    attribution, clamped to the compaction bucket."""
    svc = CostOptimizerService()
    sessions = [{
        "session_id": "s1", "harness": "claude-code", "trace_id": "t1",
        "gens": [_gen(inp=2000 + 800 * i, ts=_ts(i)) for i in range(18)],
    }]
    report = svc._analyze(sessions, PRICING, 30, {"claude_code": 1, "codex": 0}, False)
    ll = report["modeled_lossless"]
    assert report["modeled"]["total_tokens"] <= ll["total_tokens"] <= report["observed"]["total_tokens"]
    assert report["modeled"]["est_cost_usd"] <= ll["est_cost_usd"] <= report["observed"]["est_cost_usd"]
    carry = sum(
        f["tokens_wasted"] for f in report["findings"] if f["type"] == "tool_result_carry"
    )
    expected = min(carry, report["buckets"]["compaction"]["tokens"])
    assert report["observed"]["total_tokens"] - ll["total_tokens"] == expected


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


# ---------------------------------------------------------------------------
# session activity: live/stale detection + the tail context parse (v5.2.x)
# ---------------------------------------------------------------------------

def _usage_line(input_tok, cache_read, cache_write=0, out=25):
    return json.dumps({
        "type": "assistant",
        "message": {"usage": {
            "input_tokens": input_tok,
            "cache_read_input_tokens": cache_read,
            "cache_creation_input_tokens": cache_write,
            "output_tokens": out,
        }},
    })


def test_tail_context_tokens_reads_newest_usage(tmp_path):
    p = tmp_path / "s.jsonl"
    lines = [
        json.dumps({"type": "user", "message": {"content": "hi"}}),
        _usage_line(1000, 0),
        _usage_line(5, 120000, 3000),  # newest wins: 5 + 120000 + 3000
    ]
    p.write_text("\n".join(lines), encoding="utf-8")
    assert co._tail_context_tokens(p) == 123005


def test_tail_context_tokens_skips_junk_and_handles_missing(tmp_path):
    p = tmp_path / "s.jsonl"
    p.write_text('not json\n{"type":"user"}\n', encoding="utf-8")
    assert co._tail_context_tokens(p) is None
    assert co._tail_context_tokens(tmp_path / "absent.jsonl") is None


def test_session_activity_flags_live_and_tails_only_recent(tmp_path, monkeypatch):
    import os
    import time as _time

    live = tmp_path / "live-session.jsonl"
    live.write_text(_usage_line(10, 90000) + "\n", encoding="utf-8")
    stale = tmp_path / "stale-session.jsonl"
    stale.write_text(_usage_line(10, 50000) + "\n", encoding="utf-8")
    old = tmp_path / "old-session.jsonl"
    old.write_text(_usage_line(10, 70000) + "\n", encoding="utf-8")
    now = _time.time()
    os.utime(stale, (now - 1800, now - 1800))   # ended 30 min ago: recap window
    os.utime(old, (now - 7200, now - 7200))     # two hours old: no tail parse

    monkeypatch.setattr(
        co.InstantAuditService, "_discover",
        staticmethod(lambda days: [
            ("claude-code", p.stem, p) for p in (live, stale, old)
        ]))
    act = co.CostOptimizerService().session_activity(7)
    by_id = {r["session_id"]: r for r in act["sessions"]}

    assert by_id["live-session"]["active"] is True
    assert by_id["live-session"]["context_tokens_now"] == 90010
    assert by_id["stale-session"]["active"] is False
    assert by_id["stale-session"]["context_tokens_last"] == 50010
    assert by_id["old-session"]["active"] is False
    assert "context_tokens_last" not in by_id["old-session"]
    assert "context_tokens_now" not in by_id["old-session"]


# ---------------- live advisor (Guardian) ----------------


def _rec(usage_ctx=None, tool_use=None, tool_result=None, model=None, ts=None):
    msg = {}
    if usage_ctx is not None:
        msg["usage"] = {"input_tokens": usage_ctx, "cache_read_input_tokens": 0,
                        "cache_creation_input_tokens": 0}
    content = []
    if tool_use:
        content.append({"type": "tool_use", "id": tool_use.get("id", "t1"),
                        "name": tool_use["name"], "input": tool_use.get("input", {})})
    if tool_result:
        content.append({"type": "tool_result",
                        "tool_use_id": tool_result.get("tool_use_id", "t1"),
                        "content": tool_result.get("content", ""),
                        "is_error": tool_result.get("is_error", False)})
    if content:
        msg["content"] = content
    rec = {"type": "assistant" if usage_ctx is not None else "user",
           "message": msg}
    if model:
        rec["message"]["model"] = model
    if ts:
        rec["timestamp"] = ts
    return rec


def test_analyze_live_tail_compact_stages_follow_thresholds():
    # 200K window default: 60% = 120K, 75% = 150K, 90% = 180K
    for ctx, stage in [(100_000, "quiet"), (130_000, "heads_up"),
                       (155_000, "act_now"), (185_000, "last_call")]:
        out = co.analyze_live_tail([_rec(usage_ctx=ctx, model="claude-fable-5")])
        assert out["compact_stage"] == stage, (ctx, stage, out)
        assert out["context_tokens_now"] == ctx
        assert out["context_window"] == 200_000
    # thresholds are user-tunable prefs
    out = co.analyze_live_tail([_rec(usage_ctx=110_000)],
                               {"stage_heads_up": 50})
    assert out["compact_stage"] == "heads_up"
    # a [1m] model uses the long-context window: 155K is quiet there
    out = co.analyze_live_tail([_rec(usage_ctx=155_000, model="claude-x[1m]")])
    assert out["context_window"] == 1_000_000
    assert out["compact_stage"] == "quiet"


def test_analyze_live_tail_flags_oversized_result_and_duplicates():
    recs = [
        _rec(usage_ctx=40_000, tool_use={"id": "a", "name": "Bash",
                                         "input": {"cmd": "ls"}}),
        _rec(tool_result={"tool_use_id": "a", "content": "x" * 12_000}),
    ]
    out = co.analyze_live_tail(recs)
    carry = [a for a in out["advisories"] if a["type"] == "tool_result_carry"]
    assert carry and carry[0]["tool"] == "Bash"
    assert carry[0]["tokens"] == 3000  # chars/4 estimate

    dup = [_rec(usage_ctx=40_000,
                tool_use={"id": f"d{i}", "name": "WebFetch", "input": {"u": "same"}})
           for i in range(3)]
    out = co.analyze_live_tail(dup)
    kinds = {a["type"]: a for a in out["advisories"]}
    assert kinds["duplicate_calls"]["tool"] == "WebFetch"
    assert kinds["duplicate_calls"]["count"] == 3


def test_analyze_live_tail_flags_resend_growth_and_failure_loop():
    recs = [_rec(usage_ctx=40_000), _rec(usage_ctx=95_000)]
    out = co.analyze_live_tail(recs)
    growth = [a for a in out["advisories"] if a["type"] == "resend_growth"]
    assert growth and growth[0]["from_tokens"] == 40_000
    assert growth[0]["to_tokens"] == 95_000

    fails = [_rec(tool_result={"content": "boom", "is_error": True})
             for _ in range(4)]
    out = co.analyze_live_tail(fails)
    loop = [a for a in out["advisories"] if a["type"] == "failure_loop"]
    assert loop and loop[0]["streak"] == 4
    # a success in between resets the streak
    ok = fails[:2] + [_rec(tool_result={"content": "fine"})] + fails[:2]
    out = co.analyze_live_tail(ok)
    assert not [a for a in out["advisories"] if a["type"] == "failure_loop"]


def test_live_advisor_only_reads_live_claude_code_and_respects_off(
        tmp_path, monkeypatch):
    import os
    import time as _time

    live = tmp_path / "live-a.jsonl"
    live.write_text(_usage_line(10, 160_000) + "\n", encoding="utf-8")
    stale = tmp_path / "stale-b.jsonl"
    stale.write_text(_usage_line(10, 160_000) + "\n", encoding="utf-8")
    now = _time.time()
    os.utime(stale, (now - 1800, now - 1800))

    monkeypatch.setattr(
        co.InstantAuditService, "_discover",
        staticmethod(lambda days: [
            ("claude-code", "live-a", live),
            ("claude-code", "stale-b", stale),
            ("codex", "codex-c", live),
        ]))
    monkeypatch.setattr(co, "get_app_data_dir", lambda: tmp_path)
    svc = co.CostOptimizerService()
    out = svc.live_advisor()
    sids = [s["session_id"] for s in out["sessions"]]
    assert sids == ["live-a"]   # stale and non-claude-code stay out
    assert out["sessions"][0]["compact_stage"] == "act_now"  # 160K of 200K
    assert out["enabled"] is True and out["sounds_enabled"] is True
    assert out["thresholds"]["stage_act_now"] == 75

    # the off switch empties the watch without touching files
    svc.set_prefs(live_advisor_enabled=False)
    out = svc.live_advisor()
    assert out["enabled"] is False and out["sessions"] == []


def test_live_prefs_are_persisted_and_shape_thresholds(tmp_path, monkeypatch):
    monkeypatch.setattr(co, "get_app_data_dir", lambda: tmp_path)
    svc = co.CostOptimizerService()
    svc.set_prefs(live_sounds_enabled=False, stage_heads_up=50,
                  stage_act_now=70, stage_last_call=85, big_result_tokens=4000)
    out = svc.live_advisor()
    assert out["sounds_enabled"] is False
    assert out["thresholds"]["stage_heads_up"] == 50
    assert out["thresholds"]["stage_act_now"] == 70
    assert out["thresholds"]["stage_last_call"] == 85
    assert out["thresholds"]["big_result_tokens"] == 4000


def test_live_duplicate_detector_ignores_idempotent_polling_tools():
    # Polling a background command or re-reading a file is normal work, not
    # waste: the same exclusion detect_retry_loops applies.
    for tool in ("BashOutput", "Read", "Grep"):
        recs = [_rec(usage_ctx=40_000,
                     tool_use={"id": f"p{i}", "name": tool, "input": {"x": 1}})
                for i in range(4)]
        out = co.analyze_live_tail(recs)
        assert not [a for a in out["advisories"] if a["type"] == "duplicate_calls"], tool
    # a non-idempotent tool repeated identically still flags
    recs = [_rec(usage_ctx=40_000,
                 tool_use={"id": f"w{i}", "name": "WebFetch", "input": {"u": "x"}})
            for i in range(3)]
    out = co.analyze_live_tail(recs)
    assert [a for a in out["advisories"] if a["type"] == "duplicate_calls"]


def test_estimate_turns_is_tail_bounded_and_reasonable(tmp_path):
    small = tmp_path / "small.jsonl"
    small.write_text("a\nb\nc\n", encoding="utf-8")
    assert co._estimate_turns(small) == 3          # small files counted exactly
    assert co._estimate_turns(tmp_path / "gone.jsonl") is None
    empty = tmp_path / "empty.jsonl"
    empty.write_text("", encoding="utf-8")
    assert co._estimate_turns(empty) == 0

    # large file: estimated from a bounded probe, never a full read
    big = tmp_path / "big.jsonl"
    line = "x" * 999 + "\n"
    big.write_text(line * 2000, encoding="utf-8")  # 2000 records, 2MB
    est = co._estimate_turns(big, probe_bytes=65536)
    assert 1800 <= est <= 2200                     # within 10% of the truth


def test_long_session_turn_count_is_labelled_an_estimate(tmp_path, monkeypatch):
    import time as _time
    live = tmp_path / "long-a.jsonl"
    live.write_text(("x" * 400 + "\n") * 500 + _usage_line(10, 30_000) + "\n",
                    encoding="utf-8")
    _time.time()
    monkeypatch.setattr(
        co.InstantAuditService, "_discover",
        staticmethod(lambda days: [("claude-code", "long-a", live)]))
    monkeypatch.setattr(co, "get_app_data_dir", lambda: tmp_path)
    row = co.CostOptimizerService().live_advisor()["sessions"][0]
    # never presented as an exact count: the field name says estimate
    assert "turns" not in row and row["turns_est"] > 200
    adv = [a for a in row["advisories"] if a["type"] == "long_session"][0]
    assert "turns" not in adv and adv["turns_est"] > 200


def test_daily_series_is_exact_and_clamped_to_window(optimizer_env):
    _write_cc_transcript(optimizer_env, "sess-daily")
    report = asyncio.run(CostOptimizerService()._scan(None, window_days=30))
    daily = report["daily"]
    assert daily, "a scanned window must produce a daily series"
    dates = [d["date"] for d in daily]
    assert dates == sorted(dates)               # ordered, one entry per day
    assert len(dates) == len(set(dates))
    assert all(isinstance(d["tokens"], int) and d["tokens"] > 0 for d in daily)
    # the series is a subset of the window and sums to no more than the total
    assert sum(d["tokens"] for d in daily) <= report["observed"]["total_tokens"]
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).date().isoformat()
    assert all(d["date"] >= cutoff for d in daily)


def test_inverted_stage_thresholds_are_sorted_not_obeyed_backwards():
    # A user typing 80 / 50 / 90 into Settings must not get backwards advice.
    th = {"stage_heads_up": 80, "stage_act_now": 50, "stage_last_call": 90}
    out = co.analyze_live_tail([_rec(usage_ctx=110_000)], th)  # 55% of 200K
    assert out["compact_stage"] == "heads_up"                  # 50 is the floor
    out = co.analyze_live_tail([_rec(usage_ctx=170_000)], th)  # 85%
    assert out["compact_stage"] == "act_now"                   # 80 is the middle
    out = co.analyze_live_tail([_rec(usage_ctx=185_000)], th)  # 92.5%
    assert out["compact_stage"] == "last_call"
