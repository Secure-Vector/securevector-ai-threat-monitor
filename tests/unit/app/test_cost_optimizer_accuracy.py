"""Accuracy tests for the Cost Optimizer: hand-computed ground truths.

The behavioural suite (test_cost_optimizer.py) asserts detectors fire and the
partition reconciles. THIS suite asserts the numbers themselves: sessions are
constructed so every bucket figure and dollar value can be derived by hand
from the appendix's formulas, and the scanner must reproduce them exactly.
A lower-bound estimator that drifts is not "roughly right", it is broken —
the headline number must survive an invoice comparison.
"""

from __future__ import annotations

import pytest

from securevector.app.services.cost_optimizer import (
    CACHE_READ_DISCOUNT,
    CACHE_WRITE_PREMIUM,
    THRESHOLDS,
    CostOptimizerService,
    analyze_session,
    prompt_tokens,
)

# anthropic list-price shape: $3/M in, $15/M out
PRICING = {"claude-x": ("anthropic", 3.0, 15.0)}
IN_RATE, OUT_RATE = 3.0, 15.0
READ_DISC = CACHE_READ_DISCOUNT["anthropic"]      # 0.10
WRITE_PREM = CACHE_WRITE_PREMIUM["anthropic"]     # 1.25
NET_CACHE = 1.0 - READ_DISC - (WRITE_PREM - 1.0)  # 0.65


def _gen(inp=0, read=0, create=0, out=0, model="claude-x", ts=None, **kw):
    g = {"model": model, "input_tokens": inp, "cache_read_tokens": read,
         "cache_creation_tokens": create, "output_tokens": out, "called_at": ts,
         "tools_called": [], "tool_results": []}
    g.update(kw)
    return g


def _ts(i):
    return f"2026-08-01T10:{(i * 30) // 60:02d}:{(i * 30) % 60:02d}.000Z"


# ---------------------------------------------------------------------------
# cache bucket: exact token and dollar values
# ---------------------------------------------------------------------------

def test_cache_bucket_exact_value():
    """4 turns, prompt 2000/2500/3000/3500, everything billed fresh.

    fresh_i = 500 for i>=1; avoidable_i = in_i - fresh_i = prompt_(i-1):
      turn1: 2000, turn2: 2500, turn3: 3000  -> 7500 tokens
    value = 7500 * 3.0/M * (1 - 0.10 - 0.25) = 7500 * 3.0 * 0.65 / 1e6
    """
    gens = [_gen(inp=2000 + 500 * i, ts=_ts(i)) for i in range(4)]
    a = analyze_session(gens, PRICING)
    assert a["cache_bucket"]["tokens"] == 2000 + 2500 + 3000 == 7500
    expected_value = 7500 * IN_RATE * NET_CACHE / 1_000_000
    assert a["cache_bucket"]["est_value_usd"] == pytest.approx(expected_value, rel=1e-9)


def test_cache_bucket_zero_when_prefix_below_minimum():
    # prompt_prev < 1024 on every step -> no legal cache -> no claimed waste
    gens = [_gen(inp=300 + 200 * i, ts=_ts(i)) for i in range(4)]
    a = analyze_session(gens, PRICING)
    assert a["cache_bucket"]["tokens"] == 0
    assert a["cache_bucket"]["est_value_usd"] == 0


def test_observed_cache_aware_cost_exact():
    """One generation: 1000 in, 5000 read, 2000 create, 400 out.

    est = (1000*3 + 5000*3*0.1 + 2000*3*1.25 + 400*15) / 1e6
        = (3000 + 1500 + 7500 + 6000) / 1e6 = 0.018
    headline = (1000*3 + 400*15) / 1e6 = 0.009
    """
    gens = [_gen(inp=1000, read=5000, create=2000, out=400, ts=_ts(0))]
    a = analyze_session(gens, PRICING)
    assert a["observed"]["est_cost_usd"] == pytest.approx(0.018, rel=1e-9)
    assert a["observed"]["headline_est_cost_usd"] == pytest.approx(0.009, rel=1e-9)
    assert a["observed"]["total_tokens"] == 1000 + 5000 + 2000 + 400


# ---------------------------------------------------------------------------
# compaction bucket: the counterfactual formula, verbatim
# ---------------------------------------------------------------------------

def test_compaction_bucket_exact_value():
    """Constant growth: prompt_i = 2000 + 1000*i, 15 turns, k=10, s=2000.

    excess_i (i>=k) = max(0, prompt_(i-k) - prompt_0 - s)
      i=10: p0=2000    -> max(0, 2000-2000-2000) = 0
      i=11: p1=3000    -> 0 ... i=12: p2=4000 -> 0
      i=13: p3=5000    -> 1000
      i=14: p4=6000    -> 2000            total = 3000 tokens
    value = 3000 * in_rate * read_discount / 1e6 (post-cache-fix rate)
    """
    k, s = THRESHOLDS["compaction_keep_turns"], THRESHOLDS["compaction_summary_tokens"]
    assert (k, s) == (10, 2000), "test derivation assumes the published thresholds"
    gens = [_gen(inp=2000 + 1000 * i, ts=_ts(i)) for i in range(15)]
    a = analyze_session(gens, PRICING)
    assert a["compaction_bucket"]["tokens"] == 3000
    expected = 3000 * IN_RATE * READ_DISC / 1_000_000
    assert a["compaction_bucket"]["est_value_usd"] == pytest.approx(expected, rel=1e-9)


def test_segmentation_resets_the_counterfactual():
    """A compaction (prompt shrink) cuts the segment: the second segment's
    counter restarts, so a session that already compacts is NOT charged
    compaction waste it didn't incur."""
    gens = [_gen(inp=2000 + 1000 * i, ts=_ts(i)) for i in range(12)]
    gens += [_gen(inp=2500 + 500 * i, ts=_ts(12 + i)) for i in range(5)]  # post-compact
    a = analyze_session(gens, PRICING)
    assert len(a["segments"]) == 2
    # segment 2 has only 5 turns < k -> zero compaction waste from it
    assert a["segments"][1]["compaction_tokens"] == 0


# ---------------------------------------------------------------------------
# duplicates and the report-level partition
# ---------------------------------------------------------------------------

def test_duplicate_value_exact():
    """3 identical requests (same input_hash), 40000 prompt + 2000 out each —
    sized to clear the 50K-token noise floor. Waste = the 2 beyond the first:
    tokens = 2*(40000+2000); dollars = 2 * (40000*3 + 2000*15)/1e6."""
    gens = [
        _gen(inp=40000, out=2000, ts=_ts(i), input_hash="h", request_id=f"r{i}")
        for i in range(3)
    ]
    svc = CostOptimizerService()
    report = svc._analyze(
        [{"session_id": "s", "harness": "claude-code", "trace_id": "t", "gens": gens}],
        PRICING, 30, {"claude_code": 1, "codex": 0}, False)
    dup = next(f for f in report["findings"] if f["type"] == "duplicate_llm")
    assert dup["tokens_wasted"] == 2 * 42000
    assert dup["est_value_usd"] == pytest.approx(
        round(2 * (40000 * IN_RATE + 2000 * OUT_RATE) / 1_000_000, 2))


def test_strip_is_derived_not_computed(tmp_path, monkeypatch):
    """modeled = observed - buckets, to the cent, and the repeated-context
    findings sum exactly to the compaction bucket (partition, not stacking)."""
    import securevector.app.services.cost_optimizer as co
    monkeypatch.setattr(co, "get_app_data_dir", lambda: tmp_path)
    sessions = [{
        "session_id": f"s{j}", "harness": "claude-code", "trace_id": f"t{j}",
        "gens": [_gen(inp=3000 + 900 * i, out=200, ts=_ts(i)) for i in range(16)],
    } for j in range(3)]
    svc = CostOptimizerService()
    report = svc._analyze(sessions, PRICING, 30, {"claude_code": 3, "codex": 0}, False)

    a = report["buckets"]["cache"]["est_value_usd"]
    b = report["buckets"]["compaction"]["est_value_usd"]
    assert report["modeled"]["est_cost_usd"] == pytest.approx(
        report["observed"]["est_cost_usd"] - a - b, abs=0.011)
    assert report["modeled"]["total_tokens"] == (
        report["observed"]["total_tokens"] - report["buckets"]["compaction"]["tokens"])

    rc_tokens = sum(f["tokens_wasted"] for f in report["findings"]
                    if f["type"] == "repeated_context")
    assert rc_tokens == report["buckets"]["compaction"]["tokens"]
    # attribution findings never enter the bucket totals
    assert all(f["bucket"] != "cache" or f["type"] == "low_cache_utilization"
               for f in report["findings"])


def test_unpriced_model_never_invents_dollars():
    gens = [_gen(inp=9000 + 5000 * i, model="mystery", ts=_ts(i)) for i in range(14)]
    a = analyze_session(gens, {})
    assert a["observed"]["est_cost_usd"] == 0
    assert a["cache_bucket"]["est_value_usd"] == 0
    assert a["compaction_bucket"]["est_value_usd"] == 0
    assert a["cache_bucket"]["tokens"] > 0  # tokens are still facts


# ---------------------------------------------------------------------------
# hit rate: definitional
# ---------------------------------------------------------------------------

def test_hit_rate_definition():
    """reads / (reads + fresh) over eligible turns (first turn excluded)."""
    gens = [
        _gen(inp=1000, ts=_ts(0)),
        _gen(inp=200, read=1800, ts=_ts(1)),
        _gen(inp=300, read=1700, ts=_ts(2)),
    ]
    a = analyze_session(gens, PRICING)
    reads, fresh = 1800 + 1700, 200 + 300
    assert a["cache_hit"]["reads"] == reads
    assert a["cache_hit"]["fresh"] == fresh
    assert CostOptimizerService._hit_rate(a["cache_hit"]) == pytest.approx(
        reads / (reads + fresh))


# ---------------------------------------------------------------------------
# the rebuild's counting: interleaved requests must not double count
# ---------------------------------------------------------------------------

def test_interleaved_request_counted_once(tmp_path, monkeypatch):
    """Claude Code can split one request's records with a tool_result user
    record (interleaved tool use); the later records repeat the SAME
    requestId and usage. That request must be ONE generation with its usage
    counted once — real sessions showed ~3% inflation before this held."""
    import json as _json

    home = tmp_path / "claude"
    slug = home / "projects" / "-x"
    slug.mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_HOME", str(home))
    usage = {"input_tokens": 2, "output_tokens": 375,
             "cache_read_input_tokens": 55001, "cache_creation_input_tokens": 877}
    recs = [
        {"type": "user", "message": {"role": "user", "content": "go"}},
        {"type": "assistant", "requestId": "req-A", "timestamp": "2026-08-01T10:00:00.000Z",
         "message": {"role": "assistant", "model": "claude-x", "usage": usage,
                     "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}}]}},
        {"type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}},
        {"type": "assistant", "requestId": "req-A", "timestamp": "2026-08-01T10:00:01.000Z",
         "message": {"role": "assistant", "model": "claude-x", "usage": usage,
                     "stop_reason": "end_turn",
                     "content": [{"type": "text", "text": "done"}]}},
    ]
    with (slug / "sess-interleave.jsonl").open("w") as fh:
        for r in recs:
            fh.write(_json.dumps(r) + "\n")

    from securevector.app.server.routes.transcript_generations import build_generations
    gens = build_generations("sess-interleave", store_text=False, with_analysis=True)
    assert len(gens) == 1, "one requestId = one generation"
    g = gens[0]
    assert g["cache_read_tokens"] == 55001 and g["output_tokens"] == 375
    assert g["stop_reason"] == "end_turn"  # continuation's terminal reason kept
    assert g["tools_called"] == ["Bash"]   # tools from the first half kept


def test_receipt_carries_the_outcome_check():
    """A resolved receipt must show output volume before/after — proof the
    saving never came out of the model's answers."""
    import inspect
    from securevector.app.services.cost_optimizer import CostOptimizerService
    src = inspect.getsource(CostOptimizerService._update_receipts)
    assert "output_before_avg" in src and "output_after_avg" in src


def test_optimizer_is_pure_algorithm_no_model_calls():
    """Locked principle: optimization is SecureVector's own deterministic
    algorithm. No LLM, no inference provider, no network client anywhere in
    the analysis path — the same transcripts always produce the same report.
    (Provider NAMES appear as pricing-table keys; what is banned is importing
    anything that could call a model or the network.)"""
    import ast as _ast
    from pathlib import Path
    import securevector.app.services.cost_optimizer as co
    import securevector.app.services.run_limits as rl
    BANNED = {"httpx", "requests", "aiohttp", "urllib", "socket", "http",
              "openai", "anthropic", "ollama"}
    BANNED_LOCAL = {"llm_review", "guardian_service", "cloud_proxy"}
    for mod in (co, rl):
        tree = _ast.parse(Path(mod.__file__).read_text())
        for node in _ast.walk(tree):
            names = []
            if isinstance(node, _ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, _ast.ImportFrom) and node.module:
                names = [node.module]
            for n in names:
                root = n.split(".")[0]
                leaf = n.split(".")[-1]
                assert root not in BANNED, f"{mod.__name__} imports {n}"
                assert leaf not in BANNED_LOCAL, f"{mod.__name__} imports {n}"


def test_subagent_transcripts_are_counted(tmp_path, monkeypatch):
    """Claude Code writes spawned agents to <session>/subagents/agent-*.jsonl.
    That usage is real usage the account pays for — third-party counters
    include it, so the scan must too, as its own stream (never merged into
    the parent's sequence, which would corrupt segmentation)."""
    import asyncio
    import json as _json

    import securevector.app.services.cost_optimizer as co

    home = tmp_path / "claude"
    slug = home / "projects" / "-x"
    slug.mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_HOME", str(home))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-none"))
    monkeypatch.setattr(co, "get_app_data_dir", lambda: tmp_path / "data")
    (tmp_path / "data").mkdir()

    def _write(path, n, base_rid):
        with path.open("w") as fh:
            for i in range(n):
                fh.write(_json.dumps({"type": "user", "message": {"role": "user", "content": f"q{i}"}}) + "\n")
                fh.write(_json.dumps({
                    "type": "assistant", "requestId": f"{base_rid}-{i}",
                    "timestamp": f"2026-08-01T10:00:{i:02d}.000Z",
                    "message": {"role": "assistant", "model": "claude-x",
                                "usage": {"input_tokens": 1000, "output_tokens": 100},
                                "content": [{"type": "text", "text": "a"}]}}) + "\n")

    _write(slug / "sess-main.jsonl", 3, "main")
    subdir = slug / "sess-main" / "subagents"
    subdir.mkdir(parents=True)
    _write(subdir / "agent-abc.jsonl", 5, "sub")

    svc = co.CostOptimizerService()
    report = asyncio.run(svc._scan(None, window_days=3650))
    assert report["scanned"]["claude_code"] == 1
    assert report["scanned"]["claude_code_subagents"] == 1
    # 8 generations total: 3 main + 5 subagent, all counted exactly once
    assert report["observed"]["input_tokens"] == 8 * 1000
    assert report["observed"]["output_tokens"] == 8 * 100
    sub = [s for s in report["session_summaries"] if ":" in s["session_id"]]
    assert len(sub) == 1 and sub[0]["turns"] == 5
