"""Generation spans derived from agent transcripts (agent-observability §2).

The trace waterfall (traces.py) shows one span per *enforced tool call* — the
security view. But an agent session is really a sequence of **generations**
(LLM turns) with tool calls hanging off them. Users asked "where's the LLM
input/output?": the answer is that our hooks only ever saw tool inputs and
scanned prompts, never the model's own turns.

Claude Code (like ``/cost``) persists every turn to
``<CLAUDE_HOME>/projects/<slug>/<session-id>.jsonl`` — model, token ``usage``,
and the message content. We already read this file for the Cost & Tokens
page. Here we read it again to reconstruct **Generation spans** and merge them
into the trace, giving the standard Session -> Trace -> Span hierarchy with the
LLM turns finally visible.

Privacy: this is the same 200-char-redacted-preview contract as everywhere
else. Token/model/cost metadata is always returned; the input/output *text*
preview is included ONLY when the local ``store_text_content`` setting is on,
and even then it is secret-redacted and capped at 200 characters. Model
*thinking* blocks are never surfaced.

Read-only, local file, no writes, no migration.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

from securevector.app.utils.redaction import redact_secrets

# Preview cap — mirrors the plugin-side args_preview 200-char policy so the
# "never store the full body" contract is identical across tool spans and
# generation spans.
PREVIEW_CAP = 200


def _claude_projects_dir() -> Path:
    """Resolve the Claude Code projects dir, honoring CLAUDE_HOME.

    Same resolution as hooks_claude_code.CLAUDE_PROJECTS_DIR and detection's
    _harness_dir — a dev/sandbox run points HOME at a fake home but CLAUDE_HOME
    at the real ~/.claude, and the walker must read the same home the rest of
    the app detects against.
    """
    home = (
        Path(os.environ["CLAUDE_HOME"]).expanduser()
        if os.environ.get("CLAUDE_HOME")
        else Path.home() / ".claude"
    )
    return home / "projects"


def _find_transcript(session_id: str) -> Optional[Path]:
    """Locate ``<projects>/*/<session_id>.jsonl`` for a Claude Code session.

    Transcripts are filed under a per-cwd slug directory, so we glob across
    slugs for the session-id filename. Returns the first match or None.
    """
    if not session_id:
        return None
    root = _claude_projects_dir()
    if not root.is_dir():
        return None
    # Filename is exactly the session id; glob the one level of slug dirs.
    for hit in root.glob(f"*/{session_id}.jsonl"):
        return hit
    return None


def _text_of(content) -> str:
    """Extract the human-visible text from a message ``content`` field.

    Assistant content is a list of blocks (thinking / text / tool_use); we keep
    only ``text`` blocks — thinking is intentionally never surfaced, and
    tool_use args are already shown as their own tool spans. User content is
    either a plain string (a typed prompt) or a list (tool_result blocks).
    Returns '' when there is no plain text (e.g. a pure tool-result turn).
    """
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for blk in content:
        if not isinstance(blk, dict):
            continue
        if blk.get("type") == "text":
            t = blk.get("text")
            if isinstance(t, str) and t:
                parts.append(t)
    return "\n".join(parts)


def _tool_uses_of(content) -> list[str]:
    """Names of the tools an assistant turn asked to call (``tool_use`` blocks).

    A ``stop_reason`` of ``tool_use`` says the model ended its turn to call a
    tool — this pulls out *which* tool(s), so an LLM run can show "→ Bash"
    instead of a bare "tool use". MCP tools are namespaced ``mcp__server__tool``
    in the transcript; we surface the raw name and let the UI shorten it.
    """
    if not isinstance(content, list):
        return []
    names = []
    for blk in content:
        if isinstance(blk, dict) and blk.get("type") == "tool_use":
            n = blk.get("name")
            if isinstance(n, str) and n:
                names.append(n)
    return names


def _tool_use_pairs(content) -> list[tuple]:
    """``(tool_use_id, name)`` for each tool_use block — the key that lets us
    match a tool's *result* (which references the id) back to the call."""
    out = []
    if isinstance(content, list):
        for blk in content:
            if isinstance(blk, dict) and blk.get("type") == "tool_use":
                i, n = blk.get("id"), blk.get("name")
                if i and isinstance(n, str):
                    out.append((i, n))
    return out


def _tool_results_of(content) -> list[tuple]:
    """``(tool_use_id, text, is_error)`` for each tool_result block in a user
    turn — what the tools RETURNED (Pillar 3). Result content is a plain string
    or a list of text blocks; both are flattened to text."""
    out = []
    if not isinstance(content, list):
        return out
    for blk in content:
        if not (isinstance(blk, dict) and blk.get("type") == "tool_result"):
            continue
        c = blk.get("content")
        if isinstance(c, list):
            c = "\n".join(
                b.get("text", "") for b in c
                if isinstance(b, dict) and b.get("type") == "text"
            )
        out.append((blk.get("tool_use_id"), c if isinstance(c, str) else "", bool(blk.get("is_error"))))
    return out


def _preview(text: str) -> tuple[str, bool]:
    """Redact secrets, then cap at PREVIEW_CAP. Returns (preview, truncated)."""
    if not text:
        return "", False
    redacted, _ = redact_secrets(text, direction="outgoing")
    truncated = len(redacted) > PREVIEW_CAP
    return (redacted[:PREVIEW_CAP], truncated)


def build_generations(session_id: str, *, store_text: bool) -> list[dict]:
    """Reconstruct Generation spans for one Claude Code session.

    One generation = one API round-trip (all assistant records sharing a
    ``requestId``), NOT one transcript record. Claude Code writes a transcript
    line per streamed content block, and every line for a round-trip repeats
    the SAME ``usage`` block — so emitting per-record would show one turn as
    many spans and multiply its token count. We group by ``requestId``, take
    the usage once, concatenate the text blocks, and keep the earliest
    timestamp.

    Each generation carries model, token counts, timestamp, and (gated on
    ``store_text``) a redacted 200-char preview of the model's text output plus
    the prompt that drove it. Returns [] when the transcript can't be found or
    read — the trace still renders its tool spans; generations are additive.
    """
    path = _find_transcript(session_id)
    if path is None:
        return []

    gens: list[dict] = []
    # Accumulator for the round-trip currently being assembled.
    cur: Optional[dict] = None
    cur_out_parts: list[str] = []
    cur_tools: list[str] = []  # tool names this round-trip asked to call
    cur_tool_ids: dict = {}    # tool_use_id -> name, to match returned results
    # The just-flushed generation + its id->name map: the tool_result blocks in
    # the NEXT user turn belong to it (it made the calls).
    last_gen: Optional[dict] = None
    last_gen_ids: dict = {}

    def _flush() -> None:
        nonlocal cur, cur_out_parts, cur_tools, cur_tool_ids, last_gen, last_gen_ids
        if cur is None:
            return
        out_text = "\n".join(p for p in cur_out_parts if p)
        gen = cur["gen"]
        if store_text:
            inp_prev, inp_trunc = _preview(cur["input_text"])
            out_prev, out_trunc = _preview(out_text)
            gen["input_preview"] = inp_prev
            gen["output_preview"] = out_prev
            gen["input_truncated"] = inp_trunc
            gen["output_truncated"] = out_trunc
        # De-dupe tool names, preserving first-seen order (a tool called twice
        # in one turn shows once; token/cost stay on the run, not per tool).
        seen: set = set()
        gen["tools_called"] = [t for t in cur_tools if not (t in seen or seen.add(t))]
        # Claude Code writes synthetic assistant records (system-injected turns)
        # with model "<synthetic>" and zero usage — not real API calls, so they
        # must not appear as LLM runs (they render as junk "0→0 tok" rows).
        if gen.get("model") != "<synthetic>":
            gens.append(gen)
        last_gen = gen
        last_gen_ids = cur_tool_ids
        cur = None
        cur_out_parts = []
        cur_tools = []
        cur_tool_ids = {}

    # The prompt that drove a generation is the most-recent preceding user
    # message. tool-result-only user turns leave a marker so the input box
    # reads honestly ("responding to a tool result") rather than blank.
    last_user_text = ""
    last_user_was_tool = False
    try:
        with path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msg = rec.get("message") or {}
                role = msg.get("role")
                if role == "user" and rec.get("type") == "user":
                    _flush()  # a user turn ends any open round-trip
                    content = msg.get("content")
                    # Tool results belong to the LLM run that just flushed — it
                    # made the calls (matched by tool_use_id). This is Pillar 3:
                    # "what the tool returned", captured, not guessed.
                    results = _tool_results_of(content)
                    if results and last_gen is not None:
                        tr = []
                        for tid, text, is_err in results:
                            entry = {"name": last_gen_ids.get(tid), "is_error": is_err}
                            if store_text:
                                prev, trunc = _preview(text)
                                entry["preview"] = prev
                                entry["truncated"] = trunc
                            tr.append(entry)
                        if tr:
                            last_gen["tool_results"] = tr
                    txt = _text_of(content)
                    if txt:
                        last_user_text = txt
                        last_user_was_tool = False
                    else:
                        last_user_text = ""
                        last_user_was_tool = True
                    continue
                if role != "assistant":
                    continue
                usage = msg.get("usage")
                if not isinstance(usage, dict):
                    continue

                rid = rec.get("requestId")
                # New round-trip? Flush the previous, open a fresh accumulator.
                # A missing requestId is treated as its own singleton group.
                if cur is None or rid is None or cur["rid"] != rid:
                    _flush()
                    cur = {
                        "rid": rid,
                        "input_text": last_user_text,
                        "gen": {
                            "span_kind": "generation",
                            "model": msg.get("model") or "unknown",
                            "input_tokens": int(usage.get("input_tokens") or 0),
                            "output_tokens": int(usage.get("output_tokens") or 0),
                            "cache_read_tokens": int(usage.get("cache_read_input_tokens") or 0),
                            "cache_creation_tokens": int(usage.get("cache_creation_input_tokens") or 0),
                            "stop_reason": msg.get("stop_reason"),
                            "called_at": rec.get("timestamp"),
                            "request_id": rid,
                            # Cost is filled in by the caller (needs pricing).
                            "cost": None,
                            # Previews are metadata-gated; default to the honest
                            # "not stored" marker, filled only when store_text.
                            "input_preview": None,
                            "output_preview": None,
                            "input_truncated": False,
                            "output_truncated": False,
                            "input_is_tool_result": last_user_was_tool,
                            # Filled from the following user turn's tool_result
                            # blocks (Pillar 3 — what the tools returned).
                            "tool_results": [],
                        },
                    }
                    cur_out_parts = []
                # Accumulate this record's text + tool_use requests (name + id, so
                # the returned result can be matched back); keep the latest
                # stop_reason (the terminal record carries the real one).
                cur_out_parts.append(_text_of(msg.get("content")))
                cur_tools.extend(_tool_uses_of(msg.get("content")))
                for _i, _n in _tool_use_pairs(msg.get("content")):
                    cur_tool_ids[_i] = _n
                sr = msg.get("stop_reason")
                if sr:
                    cur["gen"]["stop_reason"] = sr
            _flush()
    except OSError:
        return []
    return gens


def _codex_sessions_dir() -> Path:
    """Resolve the Codex sessions dir, honoring CODEX_HOME (mirrors hooks_codex)."""
    home = (
        Path(os.environ["CODEX_HOME"]).expanduser()
        if os.environ.get("CODEX_HOME")
        else Path.home() / ".codex"
    )
    return home / "sessions"


def _find_codex_rollout(session_id: str) -> Optional[Path]:
    """Locate a Codex rollout jsonl for a session.

    Codex files sessions at ``<CODEX_HOME>/sessions/<YYYY>/<MM>/<DD>/
    rollout-<ISO>-<session_id>.jsonl`` — the session id is the trailing uuid in
    the filename. rglob across the date dirs for a name containing the id.
    """
    if not session_id:
        return None
    root = _codex_sessions_dir()
    if not root.is_dir():
        return None
    for hit in root.rglob(f"rollout-*{session_id}*.jsonl"):
        return hit
    return None


def build_generations_codex(session_id: str, *, store_text: bool) -> list[dict]:
    """Reconstruct Generation spans for one Codex session from its rollout.

    Codex's transcript differs from Claude Code's: token usage rides on
    separate ``token_count`` events (``info.last_token_usage`` = the turn's
    delta), the model lives on ``turn_context`` records, and assistant text is
    in ``output_text`` content blocks. One generation = one model turn (the run
    of assistant text since the previous token_count). Same privacy contract:
    metadata always; redacted 200-char preview only when store_text is on.
    """
    path = _find_codex_rollout(session_id)
    if path is None:
        return []

    gens: list[dict] = []
    model = "unknown"
    last_user_text = ""
    last_user_was_tool = False
    pending_out: list[str] = []

    def _emit(usage: dict) -> None:
        nonlocal pending_out
        out_text = "\n".join(p for p in pending_out if p)
        inp = int(usage.get("input_tokens") or 0)
        cached = int(usage.get("cached_input_tokens") or 0)
        gen = {
            "span_kind": "generation",
            "model": model,
            # Codex reports total input incl. cache; fresh input = input - cached
            # (keeps the figure comparable to Claude Code's fresh-input count).
            "input_tokens": max(0, inp - cached),
            "output_tokens": int(usage.get("output_tokens") or 0),
            "cache_read_tokens": cached,
            "cache_creation_tokens": 0,
            "stop_reason": None,
            "called_at": None,  # stamped from the record timestamp below
            "request_id": None,
            "cost": None,
            "input_preview": None,
            "output_preview": None,
            "input_truncated": False,
            "output_truncated": False,
            "input_is_tool_result": last_user_was_tool,
            # Codex records tool calls as separate function_call items, not
            # inline blocks — not yet correlated here, so empty for now.
            "tools_called": [],
            "tool_results": [],
        }
        if store_text:
            ip, it = _preview(last_user_text)
            op, ot = _preview(out_text)
            gen["input_preview"] = ip
            gen["output_preview"] = op
            gen["input_truncated"] = it
            gen["output_truncated"] = ot
        gens.append(gen)
        pending_out = []

    try:
        with path.open("r", encoding="utf-8") as fh:
            last_ts = None
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = rec.get("timestamp")
                if isinstance(ts, str):
                    last_ts = ts
                payload = rec.get("payload") or {}
                ptype = payload.get("type")
                if rec.get("type") == "turn_context" and payload.get("model"):
                    model = payload.get("model")
                    continue
                if ptype == "message":
                    role = payload.get("role")
                    text = _codex_text(payload.get("content"))
                    if role == "assistant":
                        if text:
                            pending_out.append(text)
                    elif role == "user":
                        if text:
                            last_user_text = text
                            last_user_was_tool = False
                        else:
                            last_user_text = ""
                            last_user_was_tool = True
                    continue
                if ptype == "token_count":
                    usage = (payload.get("info") or {}).get("last_token_usage")
                    if isinstance(usage, dict) and int(usage.get("output_tokens") or 0) > 0:
                        _emit(usage)
                        if last_ts:
                            gens[-1]["called_at"] = last_ts
    except OSError:
        return []
    return gens


def _codex_text(content) -> str:
    """Extract text from a Codex message ``content`` (list of output_text /
    input_text blocks, or a bare string)."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for blk in content:
        if isinstance(blk, dict) and blk.get("type") in ("output_text", "input_text", "text"):
            t = blk.get("text")
            if isinstance(t, str) and t:
                parts.append(t)
    return "\n".join(parts)


def apply_cost(gens: list[dict], pricing_by_model: dict[str, tuple[float, float]]) -> None:
    """Fill each generation's ``cost`` (USD) from a model->(in,out) price map.

    ``pricing_by_model`` maps a model id to (input_per_million,
    output_per_million). Cost counts fresh input + output tokens; cached-read
    tokens are billed at a fraction upstream but we keep the estimate simple
    and conservative (fresh in/out only), matching the Cost & Tokens page's
    headline. Leaves cost None when the model isn't in the price table so the
    UI shows "—" rather than a wrong $0.00.
    """
    for g in gens:
        price = pricing_by_model.get(g.get("model") or "")
        if not price:
            continue
        in_per_m, out_per_m = price
        cost = (
            g["input_tokens"] / 1_000_000 * in_per_m
            + g["output_tokens"] / 1_000_000 * out_per_m
        )
        g["cost"] = round(cost, 6)
