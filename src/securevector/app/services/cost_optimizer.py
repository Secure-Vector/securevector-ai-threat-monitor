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
    "receipt_min_sessions": 10,      # this much "after" evidence
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
        allowed = {"billing_mode", "recommend_enabled"}
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
        scanned = {"claude_code": 0, "codex": 0}
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
            buckets["cache"]["tokens"] += a["cache_bucket"]["tokens"]
            buckets["cache"]["est_value_usd"] += a["cache_bucket"]["est_value_usd"]
            buckets["compaction"]["tokens"] += a["compaction_bucket"]["tokens"]
            buckets["compaction"]["est_value_usd"] += a["compaction_bucket"]["est_value_usd"]
            hit_reads += a["cache_hit"]["reads"]
            hit_fresh += a["cache_hit"]["fresh"]

            times = [t for t in (_parse_ts(g.get("called_at")) for g in gens) if t]
            if len(times) >= 2:
                mins = max((times[-1] - times[0]).total_seconds() / 60.0, 1.0)
                rates_by_harness.setdefault(sess["harness"], []).append(len(gens) / mins)
            session_summaries.append({
                "session_id": sess["session_id"],
                "harness": sess["harness"],
                "turns": len(gens),
                "started_at": times[0].isoformat() if times else None,
                "ended_at": times[-1].isoformat() if times else None,
                "prompt_tokens": a["observed"]["prompt_tokens"],
                "hit_rate": self._hit_rate(a["cache_hit"]),
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
                "beyond_trace_cap": len(gens) > TRACE_VIEW_CAP,
                "session_turns": len(gens),
            }

            # 1. repeated context / missing compaction (bucket: compaction)
            for si, seg in enumerate(a["segments"]):
                if seg["compaction_tokens"] and above_floor(
                    seg["compaction_tokens"], seg["compaction_value"] or None
                ):
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
                                f"Compact this session's context: keep the last "
                                f"{THRESHOLDS['compaction_keep_turns']} turns plus a summary of at most "
                                f"{THRESHOLDS['compaction_summary_tokens']} tokens. This is a quality "
                                f"tradeoff, not a free win — dropped context is dropped."
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
                        "change": (
                            "Trim or summarize this tool result before it enters context "
                            "(head/tail the file read, aggregate the command output) — "
                            "every later turn pays for it again."
                        ),
                    },
                })

            # 3. low cache utilisation (bucket: cache)
            hr = self._hit_rate(a["cache_hit"])
            if (
                hr is not None
                and a["cache_hit"]["eligible_turns"] >= THRESHOLDS["cache_min_turns"]
                and hr < THRESHOLDS["cache_hit_bad"]
                and above_floor(a["cache_bucket"]["tokens"],
                                a["cache_bucket"]["est_value_usd"] or None)
            ):
                findings.append({
                    **base, "type": "low_cache_utilization", "bucket": "cache",
                    "segment": None,
                    "turns": [0, len(gens) - 1],
                    "tokens_wasted": a["cache_bucket"]["tokens"],
                    "est_value_usd": self._rounded(a["cache_bucket"]["est_value_usd"]),
                    "confidence": "high",
                    "evidence": {
                        "observed": (
                            f"cache hit rate {hr:.0%} across {a['cache_hit']['eligible_turns']} "
                            f"eligible turns (threshold {THRESHOLDS['cache_hit_bad']:.0%}); "
                            f"carried context paid the full input rate instead of the "
                            f"cache-read rate"
                        ),
                        "hit_rate": round(hr, 3),
                        "cache_churn_tokens": a["cache_churn_tokens"] or None,
                        "sample_turns": self._sample_turns(gens, [0, len(gens) - 1]),
                    },
                    "recommendation": {
                        "change": (
                            "Stabilize the prompt prefix: keep static context (system "
                            "prompt, tool definitions, reference files) byte-identical "
                            "across turns so the provider can serve it at the cache-read "
                            "rate. Diff the first turns where reads collapse to find the "
                            "drifting block."
                        ),
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
                            "change": (
                                "Fail fast: after two identical failures, change the "
                                "arguments or stop — each retry re-bills the whole context."
                            ),
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
                            "change": "Deduplicate the request at the harness layer — the "
                                      "identical input produced an identical bill.",
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
                            "change": (
                                "Review this session's loop: the shape (rate + repetition) "
                                "is the cost axis of a runaway run. Consider the per-run "
                                "caps under Cost Settings once enforcement ships."
                            ),
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
                    "change": (
                        "Potential only: cap or tighten the output for this call shape "
                        "if the long answers aren't intentional."
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
                    "change": (
                        "Run an evaluation before changing anything: routing these calls "
                        "to a cheaper family model trades quality for cost, and this "
                        "finding carries no verdict on that tradeoff."
                    ),
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

        report = {
            "version": REPORT_VERSION,
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
            "findings": findings,
            "capability_notes": capability_notes,
            "metrics": metrics,
            "thresholds": THRESHOLDS,
            "session_summaries": session_summaries,
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
        # direction per metric: True = lower is better
        metric_map = {
            "low_cache_utilization": ("cache_hit_rate", False),
            "repeated_context": ("avg_prompt_slope", True),
            "duplicate_llm": ("duplicate_turns", True),
            "retry_loop": ("retry_turns", True),
        }
        for t in open_types:
            first_seen.setdefault(t, now)

        summaries = report.get("session_summaries", [])
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
            enough = (
                len(after) >= THRESHOLDS["receipt_min_sessions"]
                and after_days >= THRESHOLDS["receipt_min_days"]
                and before
            )
            if not enough:
                if t in open_types:
                    receipts_out["pending"].append({
                        "type": t,
                        "status": "insufficient",
                        "reason": "not enough sessions yet",
                        "after_sessions": len(after),
                        "after_days": round(after_days, 1),
                        "needed_sessions": THRESHOLDS["receipt_min_sessions"],
                        "needed_days": THRESHOLDS["receipt_min_days"],
                    })
                continue
            b_val = self._window_metric(metric, before)
            a_val = self._window_metric(metric, after)
            if b_val is None or a_val is None:
                continue
            improved = (a_val < b_val) if lower_better else (a_val > b_val)
            prior = resolved.get(t)
            if improved and t not in open_types:
                receipt = {
                    "type": t, "metric": metric,
                    "before": round(b_val, 3), "after": round(a_val, 3),
                    "before_sessions": len(before), "after_sessions": len(after),
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
        if metric == "cache_hit_rate":
            vals = [s["hit_rate"] for s in sessions if s.get("hit_rate") is not None]
            return statistics.mean(vals) if vals else None
        if metric == "avg_prompt_slope":
            vals = [
                s["prompt_tokens"] / s["turns"] for s in sessions
                if s.get("turns") and s.get("prompt_tokens")
            ]
            return statistics.mean(vals) if vals else None
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
