"""Cost / Token Optimizer — scan agent transcripts, explain *why* sessions
cost what they did, and say *what to change* (issue #202, v5.2.0).

Follows the Instant Audit service pattern exactly: a module singleton with a
single-flight background scan over the on-disk harness transcripts, a JSON
report + consent file in the app data dir, and hard caps that are always
disclosed rather than silently applied.

Analysis model (see the issue #202 appendix — build from this, not a naive
version):

- Sessions are cut into **segments** at any prompt-token shrink beyond jitter
  (a compaction / context eviction) or a model change. Within a segment,
  ``prompt_i = input + cache_read + cache_creation``, ``fresh_i`` is prompt
  growth and ``carried_i = prompt_i - fresh_i`` is re-sent context.
- Waste partitions into two non-overlapping buckets so findings sum instead of
  stacking: **cache** (carried tokens billed at the full input rate that an
  achievable caching policy would have served at the cache-read rate) and
  **compaction** (carried tokens beyond a "keep last k turns + summary"
  counterfactual, valued at the cache-read rate — what remains after fixing
  cache). The comparison strip is *derived* from these buckets, never computed
  separately.
- Every estimator is a lower bound. Tokens are ground truth; dollars are
  tokens x list-price rates and are always labelled estimates. No
  extrapolation beyond the observed window, ever.

Privacy: the scan reads full transcript text but the report carries only
aggregate numbers, hashes, model ids, tool names and session/turn references —
never prompt text, never tool arguments, never file paths from inside
sessions.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import statistics
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from securevector.app.server.routes.transcript_generations import (
    build_generations,
    build_generations_codex,
)
from securevector.app.services.instant_audit import InstantAuditService
from securevector.app.utils.platform import get_app_data_dir
from securevector.app.utils.trace_id import derive_trace_id

logger = logging.getLogger(__name__)

REPORT_FILENAME = "cost_optimizer_report.json"
PREFS_FILENAME = "cost_optimizer_prefs.json"
STATE_FILENAME = "cost_optimizer_state.json"
REPORT_VERSION = 1

# Scan caps — disclosed in report["scanned"], never silent.
MAX_SESSIONS_PER_HARNESS = 300
DEFAULT_WINDOW_DAYS = 30

# A transcript touched this recently is a LIVE session: the agent is (or was
# seconds ago) mid-conversation, so its next turns can still be made cheaper.
ACTIVE_SESSION_SECONDS = 300

# The traces waterfall keeps only the most recent N generations; findings that
# reference turns beyond it must say so (acceptance #5).
TRACE_VIEW_CAP = 1500

# --- cache economics (list-price conventions; provider-conditional) ---------
# Read discount: fraction of the input rate a cache read costs.
CACHE_READ_DISCOUNT = {"openai": 0.5, "anthropic": 0.1, "gemini": 0.25}
# Write premium: multiple of the input rate a cache write costs (5-min TTL
# convention). OpenAI-style automatic caching has no write premium.
CACHE_WRITE_PREMIUM = {"anthropic": 1.25}
# Providers' minimum cacheable prefix (tokens) — below it a miss is not waste.
MIN_CACHEABLE_PREFIX = 1024
# Default cache TTL: an inter-turn gap longer than this makes the miss
# unavoidable, not waste.
CACHE_TTL_SECONDS = 300

# --- published thresholds (operators can disagree with a number) ------------
THRESHOLDS = {
    "segment_shrink_jitter": 0.85,   # prompt shrink below 85% of prev = compaction
    "compaction_keep_turns": 10,     # counterfactual: keep last k turns
    "compaction_summary_tokens": 2000,  # + a summary of at most s tokens
    "cache_hit_bad": 0.50,           # hit rate below this is flagged
    "cache_min_turns": 5,            # need this many turns to judge a hit rate
    "retry_min_repeats": 3,          # identical tool calls to count as a retry loop
    "excessive_output_multiple": 4,  # out > 4x group median
    "excessive_output_min_group": 20,  # abstain below this group size
    "right_sizing_max_output": 200,  # "tiny output" for model right-sizing
    "loop_calls_per_min": 30,        # cold-start rate threshold
    "loop_repetition_ratio": 0.5,    # cold-start repetition threshold
    "noise_floor_tokens": 50_000,    # findings below both floors are dropped
    "noise_floor_usd": 1.0,
    "receipt_min_days": 7,           # like-for-like receipt windows need
    "receipt_min_sessions": 10,      # this many sessions on EACH side
    # a receipt is proof: it must never be a faulty comparison. Windows must
    # hold comparable work (median session length within this factor) and the
    # improvement must clear noise (this relative change) before we resolve.
    "receipt_max_volume_skew": 3.0,
    "receipt_min_improvement": 0.15,
}

# Tools whose repetition is normal polling, not a retry loop.
IDEMPOTENT_TOOLS = {
    "git status", "Read", "Glob", "Grep", "LS", "TodoRead", "BashOutput",
    "TaskOutput", "ListMcpResourcesTool",
}

CHARS_PER_TOKEN = 4  # only ever used to apportion, never to bill


# ---------------------------------------------------------------------------
# timestamp helpers
# ---------------------------------------------------------------------------

def _parse_ts(ts: Optional[str]) -> Optional[datetime]:
    if not isinstance(ts, str) or not ts:
        return None
    try:
        if ts.endswith("Z"):
            return datetime.fromisoformat(ts[:-1]).replace(tzinfo=timezone.utc)
        dt = datetime.fromisoformat(ts)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        try:
            return datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        except ValueError:
            return None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# pure analysis helpers (unit-testable without a DB or filesystem)
# ---------------------------------------------------------------------------

def prompt_tokens(gen: dict) -> int:
    """Total prompt tokens the provider processed for one generation."""
    return (
        int(gen.get("input_tokens") or 0)
        + int(gen.get("cache_read_tokens") or 0)
        + int(gen.get("cache_creation_tokens") or 0)
    )


def segment_generations(gens: list[dict]) -> list[list[int]]:
    """Cut a session's generation indexes into segments.

    A new segment starts on a model change (tokenizer switch makes deltas
    incommensurable) or a prompt shrink beyond jitter (a compaction or context
    eviction — evidence *for* the repeated-context counterfactual, not noise).
    """
    segments: list[list[int]] = []
    cur: list[int] = []
    prev_prompt = None
    prev_model = None
    for i, g in enumerate(gens):
        p = prompt_tokens(g)
        model = g.get("model")
        if cur and (
            model != prev_model
            or (prev_prompt and p < prev_prompt * THRESHOLDS["segment_shrink_jitter"])
        ):
            segments.append(cur)
            cur = []
        cur.append(i)
        prev_prompt = p
        prev_model = model
    if cur:
        segments.append(cur)
    return segments


def _rates_for(model: str, pricing: dict) -> Optional[dict]:
    """model -> {provider, in_rate, out_rate, read_discount, write_premium}.

    ``pricing`` maps model_id -> (provider, input_per_million,
    output_per_million). Returns None for unpriced models — dollar figures are
    then omitted (never guessed); token figures don't need pricing.
    """
    row = pricing.get(model or "")
    if not row:
        return None
    provider, in_rate, out_rate = row
    return {
        "provider": provider,
        "in_rate": float(in_rate),
        "out_rate": float(out_rate),
        "read_discount": CACHE_READ_DISCOUNT.get(provider, 1.0),
        "write_premium": CACHE_WRITE_PREMIUM.get(provider, 1.0),
    }


def analyze_session(gens: list[dict], pricing: dict) -> dict:
    """Segment one session and compute its waste buckets + core metrics.

    Returns a dict of per-session aggregates the detectors and the comparison
    strip both build on — one source of truth, so the strip and the findings
    list can never disagree.
    """
    segs = segment_generations(gens)
    out = {
        "segments": [],
        "observed": {
            "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
            "cache_creation_tokens": 0, "prompt_tokens": 0, "total_tokens": 0,
            "est_cost_usd": 0.0, "headline_est_cost_usd": 0.0, "priced": True,
        },
        "cache_bucket": {"tokens": 0, "est_value_usd": 0.0},
        "compaction_bucket": {"tokens": 0, "est_value_usd": 0.0},
        "cache_hit": {"reads": 0, "fresh": 0, "eligible_turns": 0},
        "cache_churn_tokens": 0,
    }
    k = THRESHOLDS["compaction_keep_turns"]
    s_budget = THRESHOLDS["compaction_summary_tokens"]

    for g in gens:
        obs = out["observed"]
        obs["input_tokens"] += int(g.get("input_tokens") or 0)
        obs["output_tokens"] += int(g.get("output_tokens") or 0)
        obs["cache_read_tokens"] += int(g.get("cache_read_tokens") or 0)
        obs["cache_creation_tokens"] += int(g.get("cache_creation_tokens") or 0)
        obs["prompt_tokens"] += prompt_tokens(g)
        r = _rates_for(g.get("model"), pricing)
        if r is None:
            obs["priced"] = False
        else:
            in_t = int(g.get("input_tokens") or 0)
            out_t = int(g.get("output_tokens") or 0)
            read_t = int(g.get("cache_read_tokens") or 0)
            create_t = int(g.get("cache_creation_tokens") or 0)
            # Cache-aware list-price estimate (the optimizer's observed figure).
            obs["est_cost_usd"] += (
                in_t * r["in_rate"]
                + read_t * r["in_rate"] * r["read_discount"]
                + create_t * r["in_rate"] * r["write_premium"]
                + out_t * r["out_rate"]
            ) / 1_000_000
            # The Cost & Tokens headline convention (fresh input + output only).
            obs["headline_est_cost_usd"] += (
                in_t * r["in_rate"] + out_t * r["out_rate"]
            ) / 1_000_000
    out["observed"]["total_tokens"] = (
        out["observed"]["prompt_tokens"] + out["observed"]["output_tokens"]
    )

    for seg in segs:
        seg_info = {
            "turns": [seg[0], seg[-1]],
            "cache_tokens": 0, "cache_value": 0.0,
            "compaction_tokens": 0, "compaction_value": 0.0,
            "slope": 0.0, "breakeven_turn": None,
        }
        prompts = [prompt_tokens(gens[i]) for i in seg]
        if len(seg) >= 2:
            seg_info["slope"] = (prompts[-1] - prompts[0]) / (len(seg) - 1)
        cum_excess_value = 0.0
        for pos in range(1, len(seg)):
            i = seg[pos]
            g = gens[i]
            r = _rates_for(g.get("model"), pricing)
            p_prev, p_cur = prompts[pos - 1], prompts[pos]
            fresh = max(0, p_cur - p_prev)
            in_t = int(g.get("input_tokens") or 0)
            read_t = int(g.get("cache_read_tokens") or 0)

            # ---- cache bucket: carried tokens billed at the full input rate
            # that a *legal* caching policy would have read from cache.
            avoidable = max(0, in_t - fresh)
            if avoidable:
                if p_prev < MIN_CACHEABLE_PREFIX:
                    avoidable = 0  # below the provider's cacheable minimum
                else:
                    t_prev = _parse_ts(gens[seg[pos - 1]].get("called_at"))
                    t_cur = _parse_ts(g.get("called_at"))
                    if t_prev and t_cur and (t_cur - t_prev).total_seconds() > CACHE_TTL_SECONDS:
                        avoidable = 0  # gap beyond TTL: miss unavoidable
            if avoidable:
                seg_info["cache_tokens"] += avoidable
                if r:
                    # Net saving per token: full rate -> read rate, minus the
                    # amortized write premium. Clamped at zero so a provider
                    # with no discount never yields a claimed saving.
                    net = max(0.0, 1.0 - r["read_discount"] - (r["write_premium"] - 1.0))
                    seg_info["cache_value"] += avoidable * r["in_rate"] * net / 1_000_000

            # cache hit-rate inputs (turns after the first, TTL gaps excluded)
            t_prev = _parse_ts(gens[seg[pos - 1]].get("called_at"))
            t_cur = _parse_ts(g.get("called_at"))
            ttl_gap = bool(
                t_prev and t_cur and (t_cur - t_prev).total_seconds() > CACHE_TTL_SECONDS
            )
            if not ttl_gap:
                out["cache_hit"]["reads"] += read_t
                out["cache_hit"]["fresh"] += in_t
                out["cache_hit"]["eligible_turns"] += 1

            # ---- compaction bucket: carried context beyond "keep the initial
            # context + a summary + the last k turns". excess depends only on
            # prompt_(i-k): everything older than the kept window minus the
            # summary budget and the session's own baseline.
            if pos >= k:
                excess = max(0, prompts[pos - k] - prompts[0] - s_budget)
                if excess:
                    seg_info["compaction_tokens"] += excess
                    if r:
                        # Valued at the cache-read rate: what remains after the
                        # cache bucket is fixed (partition, not stacking).
                        seg_info["compaction_value"] += (
                            excess * r["in_rate"] * r["read_discount"] / 1_000_000
                        )
                        cum_excess_value += (
                            excess * r["in_rate"] * r["read_discount"] / 1_000_000
                        )
                        if seg_info["breakeven_turn"] is None:
                            one_pass = (
                                p_cur * r["in_rate"]
                                + s_budget * r["out_rate"]
                            ) / 1_000_000
                            if cum_excess_value > one_pass:
                                seg_info["breakeven_turn"] = i
        out["cache_bucket"]["tokens"] += seg_info["cache_tokens"]
        out["cache_bucket"]["est_value_usd"] += seg_info["cache_value"]
        out["compaction_bucket"]["tokens"] += seg_info["compaction_tokens"]
        out["compaction_bucket"]["est_value_usd"] += seg_info["compaction_value"]
        out["segments"].append(seg_info)

    # cache churn: repeated cache writes whose reads never materialize.
    total_create = out["observed"]["cache_creation_tokens"]
    total_read = out["observed"]["cache_read_tokens"]
    if total_create > MIN_CACHEABLE_PREFIX and total_read < total_create * 0.5:
        out["cache_churn_tokens"] = total_create
    return out


def detect_retry_loops(gens: list[dict]) -> list[dict]:
    """Groups of >= retry_min_repeats identical (tool, args_hash) calls with an
    error result between repeats, idempotent read/polling tools excluded.
    Claude Code only — Codex generations carry no correlated tool calls."""
    seen: dict[tuple, list[int]] = {}
    errored: set[tuple] = set()
    for i, g in enumerate(gens):
        for call in g.get("tool_calls") or []:
            name, ah = call.get("name"), call.get("args_hash")
            if not name or not ah or name in IDEMPOTENT_TOOLS:
                continue
            seen.setdefault((name, ah), []).append(i)
        for res in g.get("tool_results") or []:
            if res.get("is_error") and res.get("name"):
                for key in seen:
                    if key[0] == res.get("name"):
                        errored.add(key)
    out = []
    for (name, ah), turns in seen.items():
        if len(turns) >= THRESHOLDS["retry_min_repeats"] and (name, ah) in errored:
            out.append({"tool": name, "args_hash": ah, "turns": turns})
    return out


def detect_duplicates(gens: list[dict]) -> list[dict]:
    """Near-identical consecutive generations (transport retries deduped by
    request_id upstream in the rebuild's grouping). Exact: same model + same
    input_hash + no tool call in between. Waste = everything beyond the first."""
    out = []
    run: list[int] = []
    for i in range(1, len(gens)):
        a, b = gens[i - 1], gens[i]
        same = (
            a.get("model") == b.get("model")
            and b.get("input_hash") is not None
            and a.get("input_hash") == b.get("input_hash")
            and not (a.get("tool_calls") or a.get("tools_called"))
            and a.get("request_id") != b.get("request_id")
        )
        if same:
            if not run:
                run = [i - 1]
            run.append(i)
        elif run:
            out.append({"turns": run})
            run = []
    if run:
        out.append({"turns": run})
    return out


def detect_excessive_output(all_sessions: list[dict]) -> list[dict]:
    """Output tokens far above the median for that call shape, grouped by
    (model, has-tools, bucketed input size); abstains below n=20 per group."""
    groups: dict[tuple, list[tuple]] = {}
    for sess in all_sessions:
        for i, g in enumerate(sess["gens"]):
            p = prompt_tokens(g)
            bucket = 0
            while p > 1000:
                p //= 4
                bucket += 1
            key = (g.get("model"), bool(g.get("tools_called")), bucket)
            groups.setdefault(key, []).append(
                (sess["session_id"], sess["harness"], i, int(g.get("output_tokens") or 0),
                 g.get("stop_reason"))
            )
    out = []
    for key, rows in groups.items():
        if len(rows) < THRESHOLDS["excessive_output_min_group"]:
            continue
        med = statistics.median(r[3] for r in rows)
        if med <= 0:
            continue
        for sid, harness, i, out_t, stop in rows:
            if out_t > med * THRESHOLDS["excessive_output_multiple"]:
                out.append({
                    "session_id": sid, "harness": harness, "turn": i,
                    "output_tokens": out_t, "group_median": med,
                    "group_n": len(rows), "hit_max_tokens": stop == "max_tokens",
                })
    return out


def detect_abnormal_loop(gens: list[dict], baseline: Optional[dict]) -> Optional[dict]:
    """Session *shape* scoring: sustained call rate and repetition ratio
    against the agent's own baseline, global constants as cold-start fallback."""
    times = [t for t in (_parse_ts(g.get("called_at")) for g in gens) if t]
    if len(times) < 10:
        return None
    # peak calls/min over a 3-minute sliding window
    peak_rate = 0.0
    j = 0
    for i in range(len(times)):
        while times[i] - times[j] > timedelta(minutes=3):
            j += 1
        span = max((times[i] - times[j]).total_seconds(), 60.0)
        peak_rate = max(peak_rate, (i - j + 1) / (span / 60.0))
    # repetition ratio over tool calls
    calls = [
        (c.get("name"), c.get("args_hash"))
        for g in gens for c in (g.get("tool_calls") or [])
    ]
    rep_ratio = 1.0 - (len(set(calls)) / len(calls)) if calls else 0.0

    if baseline and baseline.get("rate_mean") is not None and baseline.get("rate_stdev"):
        z = (peak_rate - baseline["rate_mean"]) / baseline["rate_stdev"]
        if z > 3 and rep_ratio > THRESHOLDS["loop_repetition_ratio"]:
            return {
                "peak_calls_per_min": round(peak_rate, 1),
                "repetition_ratio": round(rep_ratio, 2),
                "z_score": round(z, 1), "basis": "agent-baseline",
            }
        return None
    if (
        peak_rate > THRESHOLDS["loop_calls_per_min"]
        and rep_ratio > THRESHOLDS["loop_repetition_ratio"]
    ):
        return {
            "peak_calls_per_min": round(peak_rate, 1),
            "repetition_ratio": round(rep_ratio, 2),
            "z_score": None, "basis": "cold-start-constants",
        }
    return None


def attribute_tool_result_carry(gens: list[dict], pricing: dict) -> list[dict]:
    """Attribute compaction-bucket value back to the turns whose tool results
    were carried — a re-attribution for the Trace annotation, never a third
    pot (excluded from bucket totals)."""
    segs = segment_generations(gens)
    out = []
    for seg in segs:
        prompts = [prompt_tokens(gens[i]) for i in seg]
        for pos in range(len(seg) - 1):
            i = seg[pos]
            g = gens[i]
            results = [r for r in (g.get("tool_results") or []) if r.get("result_chars")]
            if not results:
                continue
            fresh_next = max(0, prompts[pos + 1] - prompts[pos])
            if fresh_next <= 0:
                continue
            total_chars = sum(r["result_chars"] for r in results)
            est_result_tokens = min(fresh_next, total_chars // CHARS_PER_TOKEN)
            if est_result_tokens <= 0:
                continue
            remaining = len(seg) - pos - 2
            if remaining <= 0:
                continue
            r_price = _rates_for(g.get("model"), pricing)
            carry_tokens = est_result_tokens * remaining
            carry_value = None
            if r_price:
                # cache-read rate when the turn shows cache reads, full input
                # rate otherwise — per-turn, conservative.
                value = 0.0
                for pos2 in range(pos + 2, len(seg)):
                    g2 = gens[seg[pos2]]
                    rr = _rates_for(g2.get("model"), pricing)
                    if not rr:
                        continue
                    rate = (
                        rr["in_rate"] * rr["read_discount"]
                        if int(g2.get("cache_read_tokens") or 0) > 0
                        else rr["in_rate"]
                    )
                    value += est_result_tokens * rate / 1_000_000
                carry_value = value
            largest = max(results, key=lambda r: r["result_chars"])
            out.append({
                "turn": i,
                "tool": largest.get("name"),
                "result_tokens_est": est_result_tokens,
                "carried_turns": remaining,
                "carry_tokens": carry_tokens,
                "est_value_usd": carry_value,
            })
    out.sort(key=lambda x: x["carry_tokens"], reverse=True)
    return out[:5]


def detect_right_sizing(all_sessions: list[dict], pricing: dict) -> Optional[dict]:
    """Tiny outputs and a single tool dispatch on the window's most expensive
    model. Ships as a raw observation + rate delta — never a claimed saving,
    never a verdict (a model swap trades quality for cost)."""
    models_seen = {}
    for sess in all_sessions:
        for g in sess["gens"]:
            r = _rates_for(g.get("model"), pricing)
            if r:
                models_seen[g["model"]] = r
    if len(models_seen) < 1:
        return None
    priciest = max(models_seen, key=lambda m: models_seen[m]["in_rate"])
    p_rate = models_seen[priciest]
    cheaper = {
        m: r for m, r in models_seen.items()
        if r["provider"] == p_rate["provider"] and r["in_rate"] < p_rate["in_rate"]
    }
    total, small = 0, 0
    sample = []
    for sess in all_sessions:
        for i, g in enumerate(sess["gens"]):
            if g.get("model") != priciest:
                continue
            total += 1
            if (
                int(g.get("output_tokens") or 0) < THRESHOLDS["right_sizing_max_output"]
                and len(g.get("tools_called") or []) <= 1
            ):
                small += 1
                if len(sample) < 5:
                    sample.append({"session_id": sess["session_id"],
                                   "harness": sess["harness"], "turn": i})
    if total < 20 or small / total < 0.3:
        return None
    result = {
        "model": priciest,
        "calls": total,
        "small_call_proportion": round(small / total, 2),
        "in_rate_per_million": p_rate["in_rate"],
        "sample_turns": sample,
    }
    if cheaper:
        alt = max(cheaper, key=lambda m: cheaper[m]["in_rate"])
        result["cheaper_family_model"] = alt
        result["cheaper_in_rate_per_million"] = cheaper[alt]["in_rate"]
    return result


# ---------------------------------------------------------------------------
# the service
# ---------------------------------------------------------------------------

def _tail_context_tokens(path: Path, tail_bytes: int = 262144) -> Optional[int]:
    """Context size being re-sent RIGHT NOW by a live claude-code session:
    the newest assistant record's input + cache-read + cache-write tokens.
    Reads only the file tail — cheap enough to run on every activity poll.
    Pure local file read; nothing leaves the machine."""
    try:
        size = path.stat().st_size
        with path.open("rb") as fh:
            fh.seek(max(0, size - tail_bytes))
            chunk = fh.read().decode("utf-8", errors="replace")
    except OSError:
        return None
    for line in reversed(chunk.splitlines()):
        line = line.strip()
        if not line or '"usage"' not in line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue  # first line of the tail window is usually truncated
        usage = (rec.get("message") or {}).get("usage") if isinstance(rec, dict) else None
        if not isinstance(usage, dict):
            continue
        ctx = (
            (usage.get("input_tokens") or 0)
            + (usage.get("cache_read_input_tokens") or 0)
            + (usage.get("cache_creation_input_tokens") or 0)
        )
        if ctx > 0:
            return int(ctx)
    return None


# -- live advisor (Guardian) --------------------------------------------------
# Tail-only analysis of LIVE claude-code transcripts so the Guardian can speak
# up while a session is still running. Pure local file reads; nothing leaves
# the machine, and nothing is ever written into a session. Advisory only:
# every alert the UI renders ends in a copy-paste fix the human applies.

LIVE_THRESHOLD_DEFAULTS = {
    "big_result_tokens": 2000,      # single tool result worth calling out
    "resend_floor_tokens": 50000,   # ignore resend growth below this
    "duplicate_calls": 3,           # identical calls within the recent window
    "failure_streak": 4,            # consecutive error tool results
    "long_session_turns": 200,
    "long_session_hours": 3,
    "stage_heads_up": 60,           # context fill %: gentle nudge
    "stage_act_now": 75,            # context fill %: compact at next stop
    "stage_last_call": 90,          # context fill %: auto-compact imminent
}


def _context_window(model: Optional[str]) -> int:
    """Model-name fallback for the fill % denominator. Unknown models assume
    200K, the common window for current Anthropic models; a [1m] suffix marks
    the long-context window. Evidence beats this lookup: see
    _effective_ceiling."""
    if model and "[1m]" in model:
        return 1_000_000
    return 200_000


def _compact_boundaries(records: list[dict]) -> list[tuple[int, str, int]]:
    """(index, trigger, pre_tokens) for every harness compaction in the tail.
    Read from the record, never inferred: Claude Code writes a system record
    with subtype "compact_boundary" whose compactMetadata carries the trigger
    ("auto" / "manual" / "refusal") and preTokens, the context size at the
    moment compaction fired."""
    out: list[tuple[int, str, int]] = []
    for i, rec in enumerate(records):
        if rec.get("type") == "system" and rec.get("subtype") == "compact_boundary":
            meta = rec.get("compactMetadata") or {}
            try:
                pre = int(meta.get("preTokens") or 0)
            except (TypeError, ValueError):
                pre = 0
            out.append((i, str(meta.get("trigger") or ""), pre))
    return out


def _effective_ceiling(model: Optional[str], records: list[dict],
                       ctx_peak: int) -> int:
    """The fill-% denominator, from evidence before assumption.

    1. An auto-triggered compact_boundary's preTokens IS the effective
       ceiling: the harness demonstrably compacts there, and autocompact is
       user-configurable per session (e.g. 600K on a 1M window), so the
       model's max is the wrong number whenever the two differ. The most
       recent auto trigger wins, because the setting can change mid-session.
    2. Otherwise the model-name lookup, raised to the observed context peak
       when the peak disproves it: a session once read "118% full" because
       the lookup said 200K and the session said otherwise. Fill therefore
       never exceeds 100.
    """
    auto = [pre for _, trig, pre in _compact_boundaries(records)
            if trig == "auto" and pre > 0]
    if auto:
        return max(auto[-1], 1)
    return max(_context_window(model), ctx_peak, 1)


def _tail_records(path: Path, tail_bytes: int = 524288) -> list[dict]:
    """Parsed JSONL records from the file tail, oldest first. The first line
    of the tail window is usually truncated; its JSON error skips it."""
    try:
        size = path.stat().st_size
        with path.open("rb") as fh:
            fh.seek(max(0, size - tail_bytes))
            chunk = fh.read().decode("utf-8", errors="replace")
    except OSError:
        return []
    records: list[dict] = []
    for line in chunk.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict):
            records.append(rec)
    return records


def _usage_ctx(rec: dict) -> int:
    usage = (rec.get("message") or {}).get("usage")
    if not isinstance(usage, dict):
        return 0
    return int(
        (usage.get("input_tokens") or 0)
        + (usage.get("cache_read_input_tokens") or 0)
        + (usage.get("cache_creation_input_tokens") or 0)
    )


def _content_items(rec: dict, kind: str) -> list[dict]:
    content = (rec.get("message") or {}).get("content")
    if not isinstance(content, list):
        return []
    return [c for c in content if isinstance(c, dict) and c.get("type") == kind]


def _approx_tokens(value) -> int:
    """Chars/4 estimate, the same heuristic the scan uses for tool results."""
    try:
        text = value if isinstance(value, str) else json.dumps(value)
    except (TypeError, ValueError):
        text = str(value)
    return max(0, len(text) // 4)


def _estimate_turns(path: Path, probe_bytes: int = 262144) -> Optional[int]:
    """Turn estimate from the file tail: average record length over the last
    256KB, extrapolated to the file size. The live endpoint stays tail-bounded
    (no full scan) however large the transcript grows; the long-session check
    only needs the order of magnitude, not an exact count."""
    try:
        size = path.stat().st_size
        if size == 0:
            return 0
        with path.open("rb") as fh:
            fh.seek(max(0, size - probe_bytes))
            chunk = fh.read(probe_bytes)
    except OSError:
        return None
    if size <= probe_bytes:
        return chunk.count(b"\n")
    lines = chunk.count(b"\n")
    if lines <= 1:
        return None  # one enormous record: no usable average
    avg = len(chunk) / lines
    return int(size / avg)


def _first_timestamp(path: Path) -> Optional[str]:
    try:
        with path.open("rb") as fh:
            head = fh.read(16384).decode("utf-8", errors="replace")
    except OSError:
        return None
    for line in head.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict) and rec.get("timestamp"):
            return str(rec["timestamp"])
    return None


def analyze_live_tail(records: list[dict], thresholds: Optional[dict] = None) -> dict:
    """Waste flags + compact staging for ONE live session, from tail records.

    Token counts taken from usage records are exact (they are what was
    billed); tool-result sizes are chars/4 estimates and the UI labels them
    "about". Compact staging follows the practice the design doc records:
    stage the advice (heads-up at 60%, act-now at 75%, last-call at 90%),
    never attach a savings figure to a compact nudge, and always pair it
    with a state-note-first workflow.
    """
    th = dict(LIVE_THRESHOLD_DEFAULTS)
    th.update({k: v for k, v in (thresholds or {}).items()
               if isinstance(v, (int, float)) and not isinstance(v, bool)})
    # The three stages must ascend whatever the user typed in Settings:
    # an inverted set would stage advice backwards.
    th["stage_heads_up"], th["stage_act_now"], th["stage_last_call"] = sorted(
        (th["stage_heads_up"], th["stage_act_now"], th["stage_last_call"]))

    model = None
    ctx_series: list[int] = []
    for rec in records:
        msg = rec.get("message") or {}
        if msg.get("model"):
            model = msg["model"]
        ctx = _usage_ctx(rec)
        if ctx > 0:
            ctx_series.append(ctx)

    advisories: list[dict] = []
    ctx_now = ctx_series[-1] if ctx_series else None
    window = _effective_ceiling(model, records, max(ctx_series, default=0))
    fill_pct = round(100.0 * ctx_now / window, 1) if ctx_now else None

    # 1. Oversized tool result in the recent turns
    tool_names: dict[str, str] = {}
    for rec in records:
        for item in _content_items(rec, "tool_use"):
            if item.get("id"):
                tool_names[item["id"]] = item.get("name") or "tool"
    biggest_tokens, biggest_tool = 0, None
    for rec in records:
        for item in _content_items(rec, "tool_result"):
            tok = _approx_tokens(item.get("content"))
            if tok > biggest_tokens:
                biggest_tokens = tok
                biggest_tool = tool_names.get(item.get("tool_use_id") or "", "tool")
    if biggest_tokens > th["big_result_tokens"]:
        advisories.append({
            "type": "tool_result_carry",
            "tokens": biggest_tokens,
            "tool": biggest_tool,
        })

    # 2. Context resend growth across the tail window
    if len(ctx_series) >= 2:
        first, last = ctx_series[0], ctx_series[-1]
        if last > th["resend_floor_tokens"] and last >= 2 * max(1, first):
            advisories.append({
                "type": "resend_growth",
                "from_tokens": first,
                "to_tokens": last,
            })

    # 3. Duplicate identical tool calls in the recent window
    recent_calls: list[tuple] = []
    for rec in records:
        for item in _content_items(rec, "tool_use"):
            try:
                key = (item.get("name"),
                       json.dumps(item.get("input"), sort_keys=True))
            except (TypeError, ValueError):
                key = (item.get("name"), None)
            recent_calls.append(key)
    recent_calls = recent_calls[-10:]
    for key in set(recent_calls):
        # Polling a background command or re-reading a file is normal work,
        # not waste: the same exclusion detect_retry_loops already applies.
        if key[0] in IDEMPOTENT_TOOLS:
            continue
        if key[0] and recent_calls.count(key) >= th["duplicate_calls"]:
            advisories.append({
                "type": "duplicate_calls",
                "tool": key[0],
                "count": recent_calls.count(key),
            })
            break

    # 4. Failure loop: consecutive tool results that errored
    streak = best_streak = 0
    for rec in records:
        items = _content_items(rec, "tool_result")
        if not items:
            continue
        if any(item.get("is_error") for item in items):
            streak += 1
            best_streak = max(best_streak, streak)
        else:
            streak = 0
    if best_streak >= th["failure_streak"]:
        advisories.append({"type": "failure_loop", "streak": best_streak})

    # 5. Compact staging from context fill
    stage = "quiet"
    if fill_pct is not None:
        if fill_pct >= th["stage_last_call"]:
            stage = "last_call"
        elif fill_pct >= th["stage_act_now"]:
            stage = "act_now"
        elif fill_pct >= th["stage_heads_up"]:
            stage = "heads_up"

    return {
        "model": model,
        "context_tokens_now": ctx_now,
        "context_window": window,
        "fill_pct": fill_pct,
        "compact_stage": stage,
        "advisories": advisories,
    }


# ------------------------------------------------------------ fix follow-up --
# What happens after "Copy" is the whole point of the Optimizer: a fix that
# never gets pasted saved nothing. We track three deliberately distinct states:
#
#   copied  - certain. We put the text on the clipboard ourselves.
#   pasted  - the text turned up as a user turn in a local transcript.
#   worked  - the condition that triggered the advice is gone, measured.
#
# Only "worked" is ever celebrated. Saying "you optimized" on the strength of a
# paste would be exactly the modelled-as-measured overclaim the rest of this
# module refuses to make. Detection reads the same local transcripts the live
# advisor already tails: no clipboard reads, no keystroke watching, nothing
# written into a session.

FIX_PASTE_WINDOW_SECONDS = 30 * 60       # stop looking for the paste
FIX_VERIFY_WINDOW_SECONDS = 2 * 60 * 60  # stop looking for the payoff
FIX_TAIL_SECONDS = 3 * 60 * 60           # transcripts recent enough to check
FIX_MIN_RECORDS_AFTER = 4                # judge nothing before this much work
FIX_CONTEXT_DROP = 0.65                  # a compact has to actually drop context
FIX_WIN_FRESH_SECONDS = 60 * 60          # how long a win stays in the payload
FIX_HISTORY_MAX = 40

# Fixes whose payoff is "context got smaller", not "the flag went away".
CONTEXT_FIXES = {"repeated_context", "compact", "resend_growth", "long_session"}


def _norm_text(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().lower()


def fix_fingerprint(text: str) -> str:
    """Privacy-safe handle for a snippet *we* generated. Derived only from our
    own copy templates, never from anything the user wrote."""
    return _norm_text(text)[:120]


def _user_text(rec: dict) -> str:
    if rec.get("type") != "user":
        return ""
    content = (rec.get("message") or {}).get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            str(c.get("text") or "") for c in content
            if isinstance(c, dict) and c.get("type") == "text")
    return ""


def _looks_pasted(user_text: str, fingerprint: str) -> bool:
    """Substring match first; word overlap as the fallback so a fix the user
    trimmed or topped-and-tailed before pasting still counts."""
    hay = _norm_text(user_text)
    if not hay or not fingerprint:
        return False
    if fingerprint in hay:
        return True
    words = {w for w in fingerprint.split() if len(w) > 3}
    if len(words) < 5:
        return False
    hits = sum(1 for w in words if w in hay)
    return hits / len(words) >= 0.7


def find_paste(records: list[dict], fingerprint: str,
               after: Optional[datetime]) -> Optional[int]:
    """Index of the first user turn at or after `after` carrying the copied
    text, or None if the user never pasted it into this session."""
    for idx, rec in enumerate(records):
        text = _user_text(rec)
        if not text:
            continue
        if after is not None:
            ts = _parse_ts(rec.get("timestamp"))
            if ts is not None and ts < after:
                continue
        if _looks_pasted(text, fingerprint):
            return idx
    return None


def fix_metrics(snapshot: dict) -> dict:
    """The slice of a live snapshot a fix is judged on."""
    return {
        "context_tokens": snapshot.get("context_tokens_now"),
        "fill_pct": snapshot.get("fill_pct"),
        "advisories": sorted({a.get("type") for a in snapshot.get("advisories") or []
                              if a.get("type")}),
    }


def fix_worked(fix_type: str, before: dict, after: dict) -> bool:
    """Did the thing we complained about actually stop? Measured, per type."""
    before = before or {}
    after = after or {}
    # Compact nudges arrive staged (compact_heads_up / _act_now / _last_call);
    # all of them are judged the same way, on context actually shrinking.
    if fix_type in CONTEXT_FIXES or fix_type.startswith("compact"):
        was = before.get("context_tokens") or 0
        now = after.get("context_tokens") or 0
        return bool(was and now and now <= was * FIX_CONTEXT_DROP)
    return fix_type not in set(after.get("advisories") or [])


def fix_brief(fix: dict) -> dict:
    """UI-facing view. Carries numbers and status, never snippet text."""
    return {
        "id": fix.get("id"),
        "type": fix.get("type"),
        "label": fix.get("label"),
        "session_id": fix.get("session_id"),
        "status": fix.get("status"),
        "copied_at": fix.get("copied_at"),
        "pasted_at": fix.get("pasted_at"),
        "resolved_at": fix.get("resolved_at"),
        "before": fix.get("baseline"),
        "after": fix.get("after"),
    }


class CostOptimizerService:
    """Background transcript scan -> findings + comparison strip + receipts."""

    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self.progress: dict = {"phase": "idle", "done": 0, "total": 0}

    # -- paths ---------------------------------------------------------------

    def _report_path(self) -> Path:
        return get_app_data_dir() / REPORT_FILENAME

    def _prefs_path(self) -> Path:
        return get_app_data_dir() / PREFS_FILENAME

    def _state_path(self) -> Path:
        return get_app_data_dir() / STATE_FILENAME

    # -- prefs (consent, billing mode, recommend opt-in) ---------------------

    def get_prefs(self) -> dict:
        try:
            data = json.loads(self._prefs_path().read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except (OSError, json.JSONDecodeError):
            pass
        return {}

    def set_prefs(self, **updates) -> dict:
        prefs = self.get_prefs()
        allowed = {"billing_mode", "recommend_enabled",
                   "live_advisor_enabled", "live_sounds_enabled",
                   "stage_heads_up", "stage_act_now", "stage_last_call",
                   "big_result_tokens"}
        for key, value in updates.items():
            if key in allowed:
                prefs[key] = value
                prefs[f"{key}_set_at"] = _now_iso()
        path = self._prefs_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(prefs, indent=2), encoding="utf-8")
        return prefs

    def consented(self) -> Optional[str]:
        return self.get_prefs().get("consented_at")

    def record_consent(self) -> str:
        prefs = self.get_prefs()
        ts = _now_iso()
        prefs["consented_at"] = ts
        prefs["scope"] = "local-transcript-scan"
        path = self._prefs_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(prefs, indent=2), encoding="utf-8")
        return ts

    # -- report --------------------------------------------------------------

    @property
    def running(self) -> bool:
        return bool(self._task and not self._task.done())

    def read_report(self) -> Optional[dict]:
        try:
            data = json.loads(self._report_path().read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else None
        except (OSError, json.JSONDecodeError):
            return None

    def session_activity(self, window_days: int = DEFAULT_WINDOW_DAYS) -> dict:
        """Live/stale status per session in the window — a stat() sweep over
        the same transcript discovery the scan uses, plus a tail parse of
        each LIVE claude-code file for the context size being re-sent now.
        No model calls, no network: pure local filesystem reads."""
        now = time.time()
        rows: dict[str, dict] = {}
        for kind, sid, path in InstantAuditService._discover(window_days):
            try:
                mt = path.stat().st_mtime
            except OSError:
                continue
            active = (now - mt) <= ACTIVE_SESSION_SECONDS
            row = {
                "session_id": sid,
                "harness": kind,
                "active": active,
                "last_activity": datetime.fromtimestamp(mt, tz=timezone.utc)
                    .isoformat(),
            }
            if kind == "claude-code" and (now - mt) <= 3600:
                # Live files: the context being re-sent right now. Recently
                # ended files: the size the session FINISHED at, which is what
                # the Guardian's end-of-session recap talks about.
                ctx = _tail_context_tokens(path)
                if ctx is not None:
                    row["context_tokens_now" if active else "context_tokens_last"] = ctx
            rows[sid] = row
        return {
            "generated_at": _now_iso(),
            "active_window_seconds": ACTIVE_SESSION_SECONDS,
            "sessions": sorted(rows.values(),
                               key=lambda r: r["last_activity"], reverse=True),
        }

    def live_advisor(self) -> dict:
        """Per-live-session waste flags + compact staging for the Guardian.
        Only claude-code transcripts are tail-parseable; other harnesses show
        in session_activity but not here. Advisory only: nothing is ever
        sent into a session."""
        prefs = self.get_prefs()
        thresholds = {k: prefs[k] for k in LIVE_THRESHOLD_DEFAULTS if k in prefs}
        merged = dict(LIVE_THRESHOLD_DEFAULTS)
        merged.update({k: v for k, v in thresholds.items()
                       if isinstance(v, (int, float)) and not isinstance(v, bool)})
        enabled = prefs.get("live_advisor_enabled", True)
        now = time.time()
        sessions: list[dict] = []
        if enabled:
            for kind, sid, path in InstantAuditService._discover(7):
                if kind != "claude-code":
                    continue
                try:
                    mt = path.stat().st_mtime
                except OSError:
                    continue
                if (now - mt) > ACTIVE_SESSION_SECONDS:
                    continue
                records = _tail_records(path)
                if not records:
                    continue
                row = analyze_live_tail(records, thresholds)
                row["session_id"] = sid
                row["harness"] = kind
                row["last_activity"] = datetime.fromtimestamp(
                    mt, tz=timezone.utc).isoformat()
                turns = _estimate_turns(path)
                hours = None
                started = _first_timestamp(path)
                if started:
                    ts = _parse_ts(started)
                    if ts:
                        hours = round(
                            (datetime.now(timezone.utc) - ts).total_seconds()
                            / 3600, 1)
                if ((turns or 0) > merged["long_session_turns"]
                        or (hours or 0) > merged["long_session_hours"]):
                    row["advisories"].append({
                        "type": "long_session",
                        # Estimated from the file tail, never an exact count:
                        # the UI must not present it as one.
                        "turns_est": turns,
                        "hours": hours,
                    })
                row["turns_est"] = turns
                row["active_hours"] = hours
                sessions.append(row)
        # Follow-through runs even when the advisor is off: a fix copied
        # before the user muted the Guardian still deserves its receipt.
        try:
            fixes = self._advance_fixes(merged)
        except Exception:  # never let follow-through break the advisor
            logger.debug("could not advance copied fixes")
            fixes = {"pending": [], "wins": [], "recent": [], "verified": 0}
        return {
            "generated_at": _now_iso(),
            "enabled": bool(enabled),
            "sounds_enabled": bool(prefs.get("live_sounds_enabled", True)),
            "poll_seconds": 45,
            "thresholds": merged,
            "sessions": sorted(sessions,
                               key=lambda r: r["last_activity"], reverse=True),
            "fixes": fixes,
        }

    # -- fix follow-through ---------------------------------------------------

    def record_fix_copied(self, fix_type: str, fingerprint: str,
                          session_id: Optional[str] = None,
                          label: Optional[str] = None) -> dict:
        """Remember that a fix went to the clipboard so later sweeps can look
        for it. Stores a fingerprint of our own template, never user text."""
        state = self._read_state()
        fixes = [f for f in state.get("fixes", []) if isinstance(f, dict)]
        now = _now_iso()
        entry = None
        for f in fixes:
            # Re-copying the same fix restarts its clock rather than stacking a
            # second pending row that can never resolve.
            if (f.get("type") == fix_type
                    and f.get("session_id") == session_id
                    and f.get("status") in ("copied", "pasted")):
                f.update(copied_at=now, fingerprint=fingerprint,
                         status="copied", pasted_at=None, baseline=None,
                         after=None, label=label or f.get("label"))
                entry = f
                break
        if entry is None:
            entry = {
                "id": f"{fix_type}-{int(time.time() * 1000)}",
                "type": fix_type,
                "label": label,
                "session_id": session_id,
                "fingerprint": fingerprint,
                "status": "copied",
                "copied_at": now,
                "pasted_at": None,
                "resolved_at": None,
                "baseline": None,
                "after": None,
            }
            fixes.append(entry)
        state["fixes"] = fixes[-FIX_HISTORY_MAX:]
        self._write_state(state)
        return fix_brief(entry)

    def _fix_tails(self) -> dict:
        """Tail records for transcripts touched recently enough that a fix
        copied in the last couple of hours could still show up in them."""
        now = time.time()
        tails: dict[str, list[dict]] = {}
        for kind, sid, path in InstantAuditService._discover(7):
            if kind != "claude-code":
                continue
            try:
                if (now - path.stat().st_mtime) > FIX_TAIL_SECONDS:
                    continue
            except OSError:
                continue
            records = _tail_records(path)
            if records:
                tails[sid] = records
        return tails

    def _advance_fixes(self, thresholds: dict) -> dict:
        """Move pending fixes along: copied -> pasted -> worked. Fixes that go
        nowhere expire quietly; the Guardian never scolds for an unused fix."""
        state = self._read_state()
        fixes = [f for f in state.get("fixes", []) if isinstance(f, dict)]
        if not fixes:
            return {"pending": [], "wins": [], "recent": [], "verified": 0}
        pending = [f for f in fixes if f.get("status") in ("copied", "pasted")]
        if pending:
            tails = self._fix_tails()
            now = time.time()
            for fix in pending:
                try:
                    self._advance_fix(fix, tails, thresholds, now)
                except Exception:  # one bad row must not break the sweep
                    logger.debug("could not advance fix %s", fix.get("id"))
            state["fixes"] = fixes[-FIX_HISTORY_MAX:]
            self._write_state(state)

        cutoff = datetime.now(timezone.utc) - timedelta(
            seconds=FIX_WIN_FRESH_SECONDS)
        wins = []
        for f in fixes:
            if f.get("status") != "worked":
                continue
            ts = _parse_ts(f.get("resolved_at"))
            if ts is not None and ts >= cutoff:
                wins.append(fix_brief(f))
        return {
            "pending": [fix_brief(f) for f in fixes
                        if f.get("status") in ("copied", "pasted")],
            "wins": wins,
            "recent": [fix_brief(f) for f in fixes[-8:]][::-1],
            "verified": sum(1 for f in fixes if f.get("status") == "worked"),
        }

    def _advance_fix(self, fix: dict, tails: dict, thresholds: dict,
                     now: float) -> None:
        copied = _parse_ts(fix.get("copied_at"))
        age = now - (copied.timestamp() if copied else now)
        fingerprint = fix.get("fingerprint") or ""

        if fix.get("status") == "copied":
            sid = fix.get("session_id")
            # A fix copied off the findings wall has no session yet: it binds
            # to whichever live session the user actually pastes it into.
            pool = ([(sid, tails[sid])] if sid in tails
                    else [] if sid else list(tails.items()))
            for cand_sid, records in pool:
                idx = find_paste(records, fingerprint, copied)
                if idx is None:
                    continue
                fix["session_id"] = cand_sid
                fix["pasted_at"] = records[idx].get("timestamp") or _now_iso()
                fix["status"] = "pasted"
                # Baseline is measured at the moment the fix went in, not at
                # the moment it was copied: that is the honest "before".
                fix["baseline"] = fix_metrics(
                    analyze_live_tail(records[:idx + 1], thresholds))
                return
            if age > FIX_PASTE_WINDOW_SECONDS:
                fix["status"] = "no_paste"
                fix["resolved_at"] = _now_iso()
            return

        records = tails.get(fix.get("session_id"))
        if records is None:
            if age > FIX_VERIFY_WINDOW_SECONDS:
                fix["status"] = "no_change"
                fix["resolved_at"] = _now_iso()
            return
        idx = find_paste(records, fingerprint, copied)
        # If the paste has scrolled out of the tail window, everything still in
        # the tail is by definition after it.
        after = records[idx + 1:] if idx is not None else records
        if len(after) < FIX_MIN_RECORDS_AFTER:
            if age > FIX_VERIFY_WINDOW_SECONDS:
                fix["status"] = "no_change"
                fix["resolved_at"] = _now_iso()
            return
        post = fix_metrics(analyze_live_tail(after, thresholds))
        ftype = fix.get("type") or ""
        if fix_worked(ftype, fix.get("baseline") or {}, post):
            # A context drop the harness caused is not the user's win. If an
            # auto-triggered compact_boundary sits in the records after the
            # paste, the numbers moved on their own; celebrating them would
            # be the exact overclaim this feature exists to refuse. A manual
            # compact after the paste stays creditable: running /compact is
            # what the pasted fix asks for.
            harness_did_it = (
                (ftype in CONTEXT_FIXES or ftype.startswith("compact"))
                and any(trig == "auto"
                        for _, trig, _ in _compact_boundaries(after)))
            fix["status"] = "auto_compacted" if harness_did_it else "worked"
            fix["after"] = post
            fix["resolved_at"] = _now_iso()
        elif age > FIX_VERIFY_WINDOW_SECONDS:
            fix["status"] = "no_change"
            fix["after"] = post
            fix["resolved_at"] = _now_iso()

    def delete_report(self) -> bool:
        try:
            self._report_path().unlink(missing_ok=True)
            return True
        except OSError:
            return False

    def start(self, db, window_days: int = DEFAULT_WINDOW_DAYS) -> bool:
        if self.running:
            return False
        self.progress = {"phase": "discovering", "done": 0, "total": 0}
        self._task = asyncio.get_event_loop().create_task(self._run(db, window_days))
        return True

    async def _run(self, db, window_days: int) -> None:
        started = time.monotonic()
        try:
            report = await self._scan(db, window_days)
            report["duration_ms"] = int((time.monotonic() - started) * 1000)
            path = self._report_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(report, indent=2), encoding="utf-8")
            self.progress = {"phase": "done", "done": self.progress.get("done", 0),
                             "total": self.progress.get("total", 0)}
        except Exception as e:  # noqa: BLE001 — surfaced via progress, never raised
            logger.error("cost optimizer scan failed: %s", e)
            self.progress = {"phase": "error", "done": 0, "total": 0, "error": str(e)}

    # -- the scan ------------------------------------------------------------

    async def _scan(self, db, window_days: int) -> dict:
        # Pricing: model_id -> (provider, in_per_million, out_per_million).
        # Degrades to unpriced (token-only findings) when the DB is absent.
        pricing: dict = {}
        proxy_metered_seen = False
        if db is not None:
            try:
                from securevector.app.database.repositories.costs import CostsRepository
                repo = CostsRepository(db)
                for p in await repo.list_pricing():
                    pricing[p.model_id] = (
                        p.provider, p.input_per_million, p.output_per_million
                    )
                _, total_records = await repo.list_records(page=1, page_size=1)
                proxy_metered_seen = total_records > 0
            except Exception:  # noqa: BLE001
                pass

        sessions_meta = InstantAuditService._discover(window_days)
        self.progress = {"phase": "scanning", "done": 0, "total": len(sessions_meta)}

        all_sessions: list[dict] = []
        scanned = {"claude_code": 0, "codex": 0, "claude_code_subagents": 0}
        cutoff = time.time() - window_days * 86400
        for kind, sid, _path in sessions_meta:
            try:
                if kind == "claude-code":
                    gens = build_generations(sid, store_text=False, with_analysis=True)
                else:
                    gens = build_generations_codex(sid, store_text=False, with_analysis=True)
            except Exception:  # noqa: BLE001 — one bad transcript never kills the scan
                gens = []
            if gens:
                all_sessions.append({
                    "session_id": sid,
                    "harness": kind,
                    "gens": gens,
                    "trace_id": derive_trace_id(kind, sid),
                })
                scanned["claude_code" if kind == "claude-code" else "codex"] += 1
            # Subagent transcripts: Claude Code writes each spawned agent's
            # stream to <session>/subagents/agent-*.jsonl. That usage is real
            # usage the account pays for — third-party counters (ccusage)
            # include it, and so must we. Each file is its OWN context stream,
            # so it enters as its own session entry: merging it into the
            # parent's generation sequence would corrupt segmentation.
            if kind == "claude-code":
                subdir = _path.parent / sid / "subagents"
                if subdir.is_dir():
                    for sp in sorted(subdir.glob("agent-*.jsonl")):
                        try:
                            if sp.stat().st_mtime < cutoff:
                                continue
                            sgens = build_generations(
                                sid, store_text=False, with_analysis=True, path=sp)
                        except Exception:  # noqa: BLE001
                            sgens = []
                        if sgens:
                            all_sessions.append({
                                "session_id": f"{sid}:{sp.stem}",
                                "harness": kind,
                                "gens": sgens,
                                # subagent turns don't exist in the parent's
                                # trace waterfall: no deep link, no cap note
                                "trace_id": None,
                                "subagent": True,
                            })
                            scanned["claude_code_subagents"] += 1
            self.progress["done"] += 1
            await asyncio.sleep(0)

        return self._analyze(all_sessions, pricing, window_days, scanned,
                             proxy_metered_seen)

    # -- analysis over the scanned corpus ------------------------------------

    def _analyze(self, all_sessions: list[dict], pricing: dict,
                 window_days: int, scanned: dict, proxy_metered_seen: bool) -> dict:
        observed = {
            "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
            "cache_creation_tokens": 0, "prompt_tokens": 0, "total_tokens": 0,
            "est_cost_usd": 0.0, "headline_est_cost_usd": 0.0,
        }
        buckets = {
            "cache": {"tokens": 0, "est_value_usd": 0.0},
            "compaction": {"tokens": 0, "est_value_usd": 0.0},
        }
        unpriced_models: set = set()
        findings: list[dict] = []
        hit_reads = hit_fresh = 0
        session_summaries: list[dict] = []
        # Per-day observed prompt+output tokens across all sessions: the shape
        # behind the "already billed, window total" number. Exact counts from
        # usage records, bucketed by the generation's own timestamp (UTC).
        daily: dict[str, int] = {}
        window_start = datetime.now(timezone.utc) - timedelta(days=window_days)

        # per-agent (per-harness) loop baselines from history
        rates_by_harness: dict[str, list[float]] = {}

        for sess in all_sessions:
            gens = sess["gens"]
            a = analyze_session(gens, pricing)
            sess["analysis"] = a
            for key in ("input_tokens", "output_tokens", "cache_read_tokens",
                        "cache_creation_tokens", "prompt_tokens", "total_tokens"):
                observed[key] += a["observed"][key]
            observed["est_cost_usd"] += a["observed"]["est_cost_usd"]
            observed["headline_est_cost_usd"] += a["observed"]["headline_est_cost_usd"]
            for g in gens:
                if g.get("model") and g["model"] not in pricing:
                    unpriced_models.add(g["model"])
            # NOTE: bucket totals are accumulated at finding-append time
            # below, NOT here — the strip must reconcile with the RENDERED
            # findings list, so sub-noise-floor waste never enters the
            # headline while its explanation is hidden.
            hit_reads += a["cache_hit"]["reads"]
            hit_fresh += a["cache_hit"]["fresh"]

            for g in gens:
                ts = _parse_ts(g.get("called_at"))
                if ts and ts >= window_start:
                    day = ts.date().isoformat()
                    daily[day] = daily.get(day, 0) + prompt_tokens(g) \
                        + int(g.get("output_tokens") or 0)
            times = [t for t in (_parse_ts(g.get("called_at")) for g in gens) if t]
            if len(times) >= 2:
                mins = max((times[-1] - times[0]).total_seconds() / 60.0, 1.0)
                rates_by_harness.setdefault(sess["harness"], []).append(len(gens) / mins)
            res_total = sum(len(g.get("tool_results") or []) for g in gens)
            res_errors = sum(
                1 for g in gens for r in (g.get("tool_results") or []) if r.get("is_error"))
            mt = sum(1 for g in gens if g.get("stop_reason") == "max_tokens")
            session_summaries.append({
                "session_id": sess["session_id"],
                "harness": sess["harness"],
                "turns": len(gens),
                "started_at": times[0].isoformat() if times else None,
                "ended_at": times[-1].isoformat() if times else None,
                "prompt_tokens": a["observed"]["prompt_tokens"],
                "output_tokens": a["observed"]["output_tokens"],
                "hit_rate": self._hit_rate(a["cache_hit"]),
                # behavioral quality signals — the honest, model-free proxies
                # for "did the optimization hurt the work": failed tool calls,
                # session length, and truncated answers all rise when it does
                "tool_error_rate": (res_errors / res_total) if res_total else None,
                "max_tokens_share": (mt / len(gens)) if gens else None,
            })

        floor_t = THRESHOLDS["noise_floor_tokens"]
        floor_d = THRESHOLDS["noise_floor_usd"]

        def above_floor(tokens: int, value) -> bool:
            return tokens >= floor_t or (value is not None and value >= floor_d)

        for sess in all_sessions:
            gens, a = sess["gens"], sess["analysis"]
            base = {
                "session_id": sess["session_id"],
                "harness": sess["harness"],
                "trace_id": sess["trace_id"],
                "beyond_trace_cap": (
                    len(gens) > TRACE_VIEW_CAP and sess["trace_id"] is not None
                ),
                "session_turns": len(gens),
            }

            # 1. repeated context / missing compaction (bucket: compaction)
            for si, seg in enumerate(a["segments"]):
                if seg["compaction_tokens"] and above_floor(
                    seg["compaction_tokens"], seg["compaction_value"] or None
                ):
                    buckets["compaction"]["tokens"] += seg["compaction_tokens"]
                    buckets["compaction"]["est_value_usd"] += seg["compaction_value"]
                    findings.append({
                        **base, "type": "repeated_context", "bucket": "compaction",
                        "segment": si, "turns": seg["turns"],
                        "tokens_wasted": seg["compaction_tokens"],
                        "est_value_usd": self._rounded(seg["compaction_value"]),
                        "confidence": "high",
                        "evidence": {
                            "observed": (
                                f"prompt grew ~{int(seg['slope'])} tokens/turn across "
                                f"turns {seg['turns'][0]}–{seg['turns'][1]}; context older "
                                f"than the last {THRESHOLDS['compaction_keep_turns']} turns "
                                f"was re-sent every turn"
                            ),
                            "breakeven_turn": seg["breakeven_turn"],
                            "slope_tokens_per_turn": int(seg["slope"]),
                            "sample_turns": self._sample_turns(gens, seg["turns"]),
                        },
                        "recommendation": {
                            "change": (
                                "Shrink the context this session re-sends every turn, "
                                "without dropping what the agent still needs."
                            ),
                            "how": (
                                "Finish the task and start the next one in a fresh "
                                "session; or write a short state note to a file and "
                                "restart from it; or move heavy file exploration to "
                                "subagents so only their summary enters context."
                            ),
                            "risk": (
                                "A state note that skips a decision loses it; keep the "
                                "note to what the next session genuinely needs (task, "
                                "files in flight, next step)."
                            ),
                        },
                    })

            # 2. tool-result carry (attribution of the compaction bucket)
            carries = attribute_tool_result_carry(gens, pricing)
            for c in carries:
                if not above_floor(c["carry_tokens"], c["est_value_usd"]):
                    continue
                findings.append({
                    **base, "type": "tool_result_carry", "bucket": "attribution",
                    "segment": None, "turns": [c["turn"]],
                    "tokens_wasted": c["carry_tokens"],
                    "est_value_usd": self._rounded(c["est_value_usd"]),
                    # structured fields for the per-tool trim ledger: which
                    # tool produced the result, how big it was, how many
                    # turns re-billed it (the evidence string stays prose)
                    "tool": c["tool"],
                    "result_tokens_est": c["result_tokens_est"],
                    "carried_turns": c["carried_turns"],
                    "confidence": "medium",
                    "evidence": {
                        "observed": (
                            f"a ~{c['result_tokens_est']:,}-token {c['tool'] or 'tool'} result "
                            f"from turn {c['turn']} was re-billed on the following "
                            f"{c['carried_turns']} turns"
                        ),
                        "sample_turns": self._sample_turns(gens, [c["turn"], c["turn"]]),
                    },
                    "recommendation": {
                        "change": "Trim or summarize large tool results before they enter context.",
                        "how": (
                            "Read files with offset/limit instead of whole, pipe command "
                            "output through head, tail or grep, and ask the agent to keep "
                            "excerpts, not dumps. Every later turn pays for the full "
                            "result again."
                        ),
                        "risk": (
                            "An over-trimmed result can hide the exact line a later turn "
                            "needs, forcing a re-read."
                        ),
                    },
                })

            # 3. cache waste (bucket: cache). Renders whenever the avoidable
            # tokens clear the noise floor — the published hit-rate threshold
            # decides whether the wording says "chronic", not whether real
            # waste is shown (hidden waste must never reach the strip).
            hr = self._hit_rate(a["cache_hit"])
            if (
                a["cache_hit"]["eligible_turns"] >= THRESHOLDS["cache_min_turns"]
                and above_floor(a["cache_bucket"]["tokens"],
                                a["cache_bucket"]["est_value_usd"] or None)
            ):
                buckets["cache"]["tokens"] += a["cache_bucket"]["tokens"]
                buckets["cache"]["est_value_usd"] += a["cache_bucket"]["est_value_usd"]
                findings.append({
                    **base, "type": "low_cache_utilization", "bucket": "cache",
                    "segment": None,
                    "turns": [0, len(gens) - 1],
                    "tokens_wasted": a["cache_bucket"]["tokens"],
                    "est_value_usd": self._rounded(a["cache_bucket"]["est_value_usd"]),
                    "confidence": "high",
                    "evidence": {
                        "observed": (
                            (f"cache hit rate {hr:.0%} across {a['cache_hit']['eligible_turns']} "
                             f"eligible turns, chronically below the {THRESHOLDS['cache_hit_bad']:.0%} threshold; "
                             if hr is not None and hr < THRESHOLDS["cache_hit_bad"] else
                             (f"cache hit rate {hr:.0%} across {a['cache_hit']['eligible_turns']} "
                              f"eligible turns; " if hr is not None else ""))
                            + "carried context paid the full input rate instead of the "
                              "cache-read rate"
                        ),
                        "hit_rate": round(hr, 3),
                        "cache_churn_tokens": a["cache_churn_tokens"] or None,
                        "sample_turns": self._sample_turns(gens, [0, len(gens) - 1]),
                    },
                    "recommendation": {
                        "change": "Stabilize the prompt prefix so carried context bills at the cache-read rate.",
                        "how": (
                            "Keep static context (system prompt, tool definitions, "
                            "reference files) byte-identical across turns, and diff the "
                            "first turns where cache reads collapse to find the drifting "
                            "block."
                        ),
                        "risk": "None. A stable prefix changes nothing about the answers.",
                    },
                })

            # 4. retry / loop waste (Claude Code only)
            if sess["harness"] == "claude-code":
                for loop in detect_retry_loops(gens):
                    turns = loop["turns"]
                    # marginal cost only: separable when the repeated turns
                    # dispatched exactly this one tool
                    separable = all(
                        len(gens[t].get("tool_calls") or []) == 1 for t in turns[1:]
                    )
                    tokens = value = 0
                    if separable:
                        for t in turns[1:]:
                            g = gens[t]
                            tokens += int(g.get("input_tokens") or 0) + int(g.get("output_tokens") or 0)
                            r = _rates_for(g.get("model"), pricing)
                            if r:
                                value += (
                                    int(g.get("input_tokens") or 0) * r["in_rate"]
                                    + int(g.get("output_tokens") or 0) * r["out_rate"]
                                ) / 1_000_000
                    findings.append({
                        **base, "type": "retry_loop", "bucket": None,
                        "segment": None, "turns": turns,
                        "tokens_wasted": tokens if separable else 0,
                        "est_value_usd": self._rounded(value) if separable else None,
                        "confidence": "high" if separable else "medium",
                        "evidence": {
                            "observed": (
                                f"{loop['tool']} was called {len(turns)} times with identical "
                                f"arguments, with an error result between repeats"
                                + ("" if separable else
                                   "; these turns also advanced other work, so no cost is claimed")
                            ),
                            "tool": loop["tool"],
                            "repeats": len(turns),
                            "sample_turns": self._sample_turns(gens, [turns[0], turns[-1]]),
                        },
                        "recommendation": {
                            "change": "Fail fast instead of retrying the same failing call.",
                            "how": (
                                "After two identical failures, change the arguments or "
                                "stop; each retry re-bills the whole context."
                            ),
                            "risk": "None. Stopping a failing retry loop costs nothing.",
                        },
                    })

                # 5. duplicate LLM requests (Claude Code only)
                for dup in detect_duplicates(gens):
                    turns = dup["turns"]
                    tokens = value = 0
                    for t in turns[1:]:
                        g = gens[t]
                        tokens += prompt_tokens(g) + int(g.get("output_tokens") or 0)
                        r = _rates_for(g.get("model"), pricing)
                        if r:
                            value += (
                                int(g.get("input_tokens") or 0) * r["in_rate"]
                                + int(g.get("cache_read_tokens") or 0) * r["in_rate"] * r["read_discount"]
                                + int(g.get("output_tokens") or 0) * r["out_rate"]
                            ) / 1_000_000
                    if not above_floor(tokens, value or None):
                        continue
                    findings.append({
                        **base, "type": "duplicate_llm", "bucket": None,
                        "segment": None, "turns": turns,
                        "tokens_wasted": tokens,
                        "est_value_usd": self._rounded(value),
                        "confidence": "high",
                        "evidence": {
                            "observed": (
                                f"{len(turns)} consecutive requests with identical input on "
                                f"{gens[turns[0]].get('model')}; everything beyond the first "
                                f"is waste"
                            ),
                            "sample_turns": self._sample_turns(gens, [turns[0], turns[-1]]),
                        },
                        "recommendation": {
                            "change": "Deduplicate the request at the harness layer.",
                            "how": (
                                "Guard or cache the call site that fired twice: identical "
                                "input produced an identical bill."
                            ),
                            "risk": "None when the inputs are truly identical.",
                        },
                    })

                # 7. abnormal agent loops (Claude Code only — needs called_at)
                rates = rates_by_harness.get(sess["harness"], [])
                baseline = None
                if len(rates) >= 5:
                    baseline = {
                        "rate_mean": statistics.mean(rates),
                        "rate_stdev": statistics.stdev(rates) if len(rates) > 1 else None,
                    }
                shape = detect_abnormal_loop(gens, baseline)
                sess_tokens = a["observed"]["total_tokens"]
                if shape and sess_tokens >= floor_t:
                    findings.append({
                        **base, "type": "abnormal_loop", "bucket": None,
                        "segment": None, "turns": [0, len(gens) - 1],
                        "tokens_wasted": 0,
                        "est_value_usd": None,
                        "confidence": "medium",
                        "evidence": {
                            "observed": (
                                f"peak {shape['peak_calls_per_min']} calls/min with "
                                f"{shape['repetition_ratio']:.0%} repeated tool calls "
                                f"({shape['basis']})"
                            ),
                            **shape,
                            "sample_turns": self._sample_turns(gens, [0, len(gens) - 1]),
                        },
                        "recommendation": {
                            "change": "Review this session's loop shape.",
                            "how": (
                                "The rate plus repetition pattern is the cost axis of a "
                                "runaway run; consider the per-run caps under Cost "
                                "Settings once enforcement ships."
                            ),
                            "risk": "None. This is a review step; nothing changes until you act.",
                        },
                    })

        # 6. excessive output (cross-session grouping)
        for hit in detect_excessive_output(all_sessions):
            sess = next(
                (s for s in all_sessions if s["session_id"] == hit["session_id"]), None
            )
            if sess is None:
                continue
            g = sess["gens"][hit["turn"]]
            extra = hit["output_tokens"] - hit["group_median"]
            r = _rates_for(g.get("model"), pricing)
            value = extra * r["out_rate"] / 1_000_000 if r else None
            if not above_floor(int(extra), value):
                continue
            findings.append({
                "session_id": hit["session_id"], "harness": hit["harness"],
                "trace_id": sess["trace_id"],
                "beyond_trace_cap": len(sess["gens"]) > TRACE_VIEW_CAP,
                "session_turns": len(sess["gens"]),
                "type": "excessive_output", "bucket": None,
                "segment": None, "turns": [hit["turn"]],
                "tokens_wasted": int(extra),
                "est_value_usd": self._rounded(value),
                "confidence": "low",
                "potential_only": True,
                "evidence": {
                    "observed": (
                        f"output of {hit['output_tokens']:,} tokens vs a median of "
                        f"{int(hit['group_median']):,} for the same call shape "
                        f"(n={hit['group_n']})"
                        + ("; the turn hit max_tokens" if hit["hit_max_tokens"] else "")
                    ),
                    "sample_turns": self._sample_turns(sess["gens"],
                                                       [hit["turn"], hit["turn"]]),
                },
                "recommendation": {
                    "change": "Potential only: cap or tighten the output for this call shape.",
                    "how": (
                        "Set max_tokens on the request, or ask the agent for shorter "
                        "answers, if the long answers are not intentional."
                    ),
                    "risk": (
                        "A cap can truncate an answer mid-thought. Set it above your "
                        "longest wanted reply."
                    ),
                },
            })

        # 8. model right-sizing (observation, never a verdict)
        rs = detect_right_sizing(all_sessions, pricing)
        if rs:
            obs = (
                f"{rs['small_call_proportion']:.0%} of {rs['calls']} calls on "
                f"{rs['model']} produced under {THRESHOLDS['right_sizing_max_output']} output "
                f"tokens with at most one tool dispatch"
            )
            if rs.get("cheaper_family_model"):
                obs += (
                    f"; {rs['cheaper_family_model']} lists at "
                    f"${rs['cheaper_in_rate_per_million']:.2f}/M input vs "
                    f"${rs['in_rate_per_million']:.2f}/M"
                )
            findings.append({
                "session_id": None, "harness": None, "trace_id": None,
                "beyond_trace_cap": False, "session_turns": None,
                "type": "model_right_sizing", "bucket": None,
                "segment": None, "turns": [],
                "tokens_wasted": 0, "est_value_usd": None,
                "confidence": "low", "observation_only": True,
                "evidence": {"observed": obs, "sample_turns": rs["sample_turns"]},
                "recommendation": {
                    "change": "Run an evaluation before changing any model routing.",
                    "how": (
                        "Compare quality on a sample of these calls before routing them "
                        "to a cheaper family model; this finding carries no verdict on "
                        "that tradeoff."
                    ),
                    "risk": "Quality regression if you reroute without measuring first.",
                },
            })

        # rank: attributable value first, observations last
        findings.sort(key=lambda f: (
            -(f.get("est_value_usd") or 0.0), -(f.get("tokens_wasted") or 0)
        ))

        modeled = {
            "total_tokens": max(0, observed["total_tokens"] - buckets["compaction"]["tokens"]),
            "est_cost_usd": self._rounded(max(
                0.0,
                observed["est_cost_usd"]
                - buckets["cache"]["est_value_usd"]
                - buckets["compaction"]["est_value_usd"],
            )),
        }

        # The lossless counterfactual: only changes that drop no context —
        # trimming the oversized tool results the carry findings attribute
        # (a slice of the compaction bucket) plus cache-rate fixes. This is
        # the figure the UI headline promises; the full `modeled` figure
        # above additionally assumes compacting every long session and is
        # presented as a ceiling, never as the promise.
        carry_tok = min(
            sum(f["tokens_wasted"] for f in findings if f["type"] == "tool_result_carry"),
            buckets["compaction"]["tokens"],
        )
        carry_usd = min(
            sum((f["est_value_usd"] or 0.0) for f in findings
                if f["type"] == "tool_result_carry"),
            buckets["compaction"]["est_value_usd"],
        )
        modeled_lossless = {
            "total_tokens": max(0, observed["total_tokens"] - carry_tok),
            "est_cost_usd": self._rounded(max(
                0.0,
                observed["est_cost_usd"]
                - buckets["cache"]["est_value_usd"]
                - carry_usd,
            )),
        }

        capability_notes = []
        if scanned.get("codex"):
            capability_notes.append({
                "harness": "codex",
                "abstained": ["retry_loop", "duplicate_llm", "abnormal_loop"],
                "reason": (
                    "Codex transcripts carry no correlated tool calls, request ids or "
                    "stop reasons, so these detectors abstain rather than report "
                    "'no waste found'."
                ),
            })

        global_hit_rate = (
            hit_reads / (hit_reads + hit_fresh) if (hit_reads + hit_fresh) else None
        )
        metrics = {
            "cache_hit_rate": round(global_hit_rate, 3) if global_hit_rate is not None else None,
            "avg_prompt_slope": self._avg_slope(all_sessions),
            "duplicate_turns": sum(
                len(f["turns"]) - 1 for f in findings if f["type"] == "duplicate_llm"
            ),
            "retry_turns": sum(
                len(f["turns"]) - 1 for f in findings if f["type"] == "retry_loop"
            ),
        }

        try:
            from securevector import __version__ as app_version
        except Exception:  # noqa: BLE001
            app_version = None
        report = {
            "version": REPORT_VERSION,
            "app_version": app_version,
            "generated_at": _now_iso(),
            "window_days": window_days,
            "billing": {"proxy_metered_seen": proxy_metered_seen},
            "scanned": {
                **scanned,
                "sessions_capped": (
                    scanned["claude_code"] >= MAX_SESSIONS_PER_HARNESS
                    or scanned["codex"] >= MAX_SESSIONS_PER_HARNESS
                ),
                "caps": {"max_sessions_per_harness": MAX_SESSIONS_PER_HARNESS},
            },
            "observed": {
                **{k: observed[k] for k in (
                    "input_tokens", "output_tokens", "cache_read_tokens",
                    "cache_creation_tokens", "prompt_tokens", "total_tokens")},
                "est_cost_usd": self._rounded(observed["est_cost_usd"]),
                "headline_est_cost_usd": self._rounded(observed["headline_est_cost_usd"]),
                "unpriced_models": sorted(unpriced_models),
            },
            "buckets": {
                "cache": {
                    "tokens": buckets["cache"]["tokens"],
                    "est_value_usd": self._rounded(buckets["cache"]["est_value_usd"]),
                },
                "compaction": {
                    "tokens": buckets["compaction"]["tokens"],
                    "est_value_usd": self._rounded(buckets["compaction"]["est_value_usd"]),
                },
            },
            "modeled": modeled,
            "modeled_lossless": modeled_lossless,
            "findings": findings,
            "capability_notes": capability_notes,
            "metrics": metrics,
            "thresholds": THRESHOLDS,
            "session_summaries": session_summaries,
            "daily": [{"date": d, "tokens": daily[d]} for d in sorted(daily)],
        }
        report["receipts"] = self._update_receipts(report)
        return report

    # -- receipts: measured before/after once metrics move --------------------

    def _update_receipts(self, report: dict) -> dict:
        """Findings get a lifecycle: when the metric behind a finding type moves
        in the recommended direction across like-for-like windows, it resolves
        with a *measured* receipt; below the minimum window it abstains."""
        state = self._read_state()
        first_seen = state.setdefault("first_seen", {})
        resolved = state.setdefault("resolved", {})
        now = _now_iso()

        open_types = {f["type"] for f in report["findings"]}
        predicted = state.setdefault("predicted", {})
        # direction per metric: True = lower is better
        metric_map = {
            "low_cache_utilization": ("cache_hit_rate", False),
            "repeated_context": ("avg_prompt_slope", True),
            "duplicate_llm": ("duplicate_turns", True),
            "retry_loop": ("retry_turns", True),
        }
        for t in open_types:
            if t not in first_seen:
                first_seen[t] = now
                # freeze the prediction the moment the finding type first
                # appears: this is the number the receipt is later judged
                # against, so it must never be recomputed after the fact
                predicted[t] = {
                    "tokens": sum(f.get("tokens_wasted") or 0
                                  for f in report["findings"] if f["type"] == t),
                    "est_value_usd": round(sum(f.get("est_value_usd") or 0
                                               for f in report["findings"] if f["type"] == t), 2),
                }

        # Receipts compare like-for-like or not at all: one harness (mixing
        # harnesses lets a mix shift fake an improvement), symmetric minimum
        # window sizes, comparable workloads, and an improvement that clears
        # noise. Anything short of that stays PENDING with the precise reason
        # — a faulty comparison must never render as proof.
        summaries = [s for s in report.get("session_summaries", [])
                     if s.get("harness") == "claude-code"]
        receipts_out = {"resolved": [], "pending": []}
        for t, (metric, lower_better) in metric_map.items():
            seen_at = first_seen.get(t)
            if not seen_at:
                continue
            boundary = _parse_ts(seen_at)
            before = [s for s in summaries if s["ended_at"] and _parse_ts(s["ended_at"]) and _parse_ts(s["ended_at"]) < boundary]
            after = [s for s in summaries if s["started_at"] and _parse_ts(s["started_at"]) and _parse_ts(s["started_at"]) >= boundary]
            after_days = 0.0
            if after:
                ts = [_parse_ts(s["started_at"]) for s in after]
                after_days = (max(ts) - min(ts)).total_seconds() / 86400

            def _pend(status, reason):
                if t in open_types or status != "insufficient":
                    receipts_out["pending"].append({
                        "type": t, "status": status, "reason": reason,
                        "before_sessions": len(before),
                        "after_sessions": len(after),
                        "after_days": round(after_days, 1),
                        "needed_sessions": THRESHOLDS["receipt_min_sessions"],
                        "needed_days": THRESHOLDS["receipt_min_days"],
                    })

            if (len(after) < THRESHOLDS["receipt_min_sessions"]
                    or after_days < THRESHOLDS["receipt_min_days"]
                    or len(before) < THRESHOLDS["receipt_min_sessions"]):
                _pend("insufficient", "not enough sessions yet")
                continue
            # comparable workloads: median session length within a bounded
            # factor, else the metric moved because the WORK changed
            b_turns = statistics.median(x["turns"] for x in before if x.get("turns"))
            a_turns = statistics.median(x["turns"] for x in after if x.get("turns"))
            if b_turns and a_turns:
                skew = max(b_turns, a_turns) / max(1, min(b_turns, a_turns))
                if skew > THRESHOLDS["receipt_max_volume_skew"]:
                    _pend("not_comparable",
                          f"the before/after windows hold different work "
                          f"(median session length differs {skew:.1f}x); "
                          f"no comparison will be shown")
                    continue
            b_val = self._window_metric(metric, before)
            a_val = self._window_metric(metric, after)
            if b_val is None or a_val is None:
                continue
            # the improvement must clear noise before it may be called proof
            rel = abs(a_val - b_val) / abs(b_val) if b_val else 0.0
            direction_ok = (a_val < b_val) if lower_better else (a_val > b_val)
            improved = direction_ok and rel >= THRESHOLDS["receipt_min_improvement"]
            if direction_ok and not improved and t not in open_types:
                _pend("below_noise",
                      f"metric moved the right way but only {rel:.0%}, below the "
                      f"{THRESHOLDS['receipt_min_improvement']:.0%} resolution "
                      f"threshold; still watching")
                continue
            prior = resolved.get(t)
            if improved and t not in open_types:
                def _avg(rows, key, digits=0):
                    vals = [r.get(key) for r in rows if r.get(key) is not None]
                    if not vals:
                        return None
                    m = statistics.median(vals)  # outlier-robust, like the metric
                    return round(m, digits) if digits else round(m)
                def _quality(rows):
                    return {
                        "output_avg": _avg(rows, "output_tokens"),
                        "turns_avg": _avg(rows, "turns"),
                        "tool_error_rate": _avg(rows, "tool_error_rate", 4),
                        "max_tokens_share": _avg(rows, "max_tokens_share", 4),
                    }
                receipt = {
                    "type": t, "metric": metric,
                    "before": round(b_val, 3), "after": round(a_val, 3),
                    "before_sessions": len(before), "after_sessions": len(after),
                    # the promise this receipt is judged against, frozen when
                    # the finding first appeared (always labelled estimate)
                    "predicted": predicted.get(t),
                    # outcome check: optimization touches re-sent context, never
                    # the model's answers — the receipt shows output volume held
                    "output_before_avg": _avg(before, "output_tokens"),
                    "output_after_avg": _avg(after, "output_tokens"),
                    # behavioral quality signals, measured, model-free: if the
                    # optimization hurt the work these move the wrong way
                    "quality_before": _quality(before),
                    "quality_after": _quality(after),
                    "resolved_at": prior.get("resolved_at", now) if prior else now,
                    "measured": True,
                }
                resolved[t] = receipt
                receipts_out["resolved"].append(receipt)
            elif prior and t in open_types:
                # regression: a resolved finding that backslides returns to the
                # list with its history intact
                prior["reopened_at"] = now
                receipts_out["pending"].append({
                    "type": t, "status": "reopened", "history": prior,
                })
                resolved.pop(t, None)

        state["last_scan_at"] = now
        self._write_state(state)
        return receipts_out

    def _window_metric(self, metric: str, sessions: list[dict]) -> Optional[float]:
        # medians throughout: a single outlier session must never manufacture
        # (or hide) a receipt
        if metric == "cache_hit_rate":
            vals = [s["hit_rate"] for s in sessions if s.get("hit_rate") is not None]
            return statistics.median(vals) if vals else None
        if metric == "avg_prompt_slope":
            vals = [
                s["prompt_tokens"] / s["turns"] for s in sessions
                if s.get("turns") and s.get("prompt_tokens")
            ]
            return statistics.median(vals) if vals else None
        # duplicate_turns / retry_turns are per-scan counts, not per-session —
        # approximate with turns-weighted presence; abstain (None) otherwise.
        return None

    def _read_state(self) -> dict:
        try:
            data = json.loads(self._state_path().read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def _write_state(self, state: dict) -> None:
        try:
            path = self._state_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(state, indent=2), encoding="utf-8")
        except OSError:  # state is best-effort; the report must still ship
            logger.warning("could not persist cost optimizer state")

    # -- small utilities ------------------------------------------------------

    @staticmethod
    def _hit_rate(cache_hit: dict) -> Optional[float]:
        denom = cache_hit["reads"] + cache_hit["fresh"]
        return cache_hit["reads"] / denom if denom else None

    @staticmethod
    def _avg_slope(all_sessions: list[dict]) -> Optional[float]:
        slopes = [
            seg["slope"]
            for s in all_sessions
            for seg in s.get("analysis", {}).get("segments", [])
            if seg.get("slope")
        ]
        return round(statistics.mean(slopes), 1) if slopes else None

    @staticmethod
    def _rounded(value) -> Optional[float]:
        return round(value, 2) if isinstance(value, (int, float)) else None

    @staticmethod
    def _sample_turns(gens: list[dict], turn_range: list[int]) -> list[dict]:
        """Turn references a UI can match against the trace waterfall: the
        generation ordinal plus request_id/called_at (stable identities —
        the waterfall's display index shifts with tool spans)."""
        out = []
        for i in {turn_range[0], turn_range[-1]}:
            if 0 <= i < len(gens):
                out.append({
                    "gen_index": i,
                    "request_id": gens[i].get("request_id"),
                    "called_at": gens[i].get("called_at"),
                })
        return sorted(out, key=lambda x: x["gen_index"])


_service: Optional[CostOptimizerService] = None


def get_cost_optimizer_service() -> CostOptimizerService:
    global _service
    if _service is None:
        _service = CostOptimizerService()
    return _service
