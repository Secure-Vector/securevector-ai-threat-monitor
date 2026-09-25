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

import hashlib
import json
import re
import os
from pathlib import Path
from datetime import datetime
from typing import Optional

from securevector.app.utils.trace_text import TRACE_TEXT_CAP, sanitize_trace_text

# Preview cap: the shared 8 KB trace-text cap (5.3.0), the same one tool
# spans use, so tool and generation spans carry the same amount of text.
PREVIEW_CAP = TRACE_TEXT_CAP


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


# Claude Code's own wrappers in user records: slash-command echoes, local
# command output, and the caveat it injects around them. Not a typed prompt.
_CC_WRAPPER_PREFIXES = (
    "<command-name>", "<command-message>", "<command-args>",
    "<local-command-stdout>", "<local-command-stderr>", "<local-command-caveat>",
)


def _is_meta_user_record(rec: dict, text: str) -> bool:
    """A user record Claude Code wrote itself (isMeta, or a command/caveat
    wrapper), as opposed to a prompt a person typed."""
    if rec.get("isMeta"):
        return True
    return text.lstrip().startswith(_CC_WRAPPER_PREFIXES)


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


def _sha16(text: str) -> Optional[str]:
    """Stable 16-hex content identity for duplicate/retry detection.

    A hash, never the text: the Cost Optimizer needs to know that two inputs
    (or two tool calls) were *identical* without carrying the content itself,
    so the analysis fields stay inside the same privacy contract as metadata.
    Empty text hashes to None so "no input" never collides with itself as a
    'duplicate'.
    """
    if not text:
        return None
    return hashlib.sha256(text.encode("utf-8", "ignore")).hexdigest()[:16]


# Shell tools whose ``description`` is narration beside the command.
_SHELL_TOOL_NAMES = {"Bash", "bash", "shell", "exec", "exec_command", "local_shell",
                     "run_shell_command", "container.exec", "run_terminal_cmd"}


def _args_hash(args, tool: Optional[str] = None) -> Optional[str]:
    """Canonical hash of a tool_use ``input`` dict (sorted keys, volatile keys
    stripped) — the identity for "same tool called with the same arguments".
    Timestamp-ish keys are dropped so a retry that only differs in a client
    timestamp still counts as identical. For a shell tool (``tool`` in
    _SHELL_TOOL_NAMES) ``description`` is dropped too: it is narration ("Run
    check.py (run 3)"), not what ran. Other tools (MCP) keep it."""
    if not isinstance(args, dict):
        return None
    cleaned = {
        k: v for k, v in args.items()
        if k not in ("timestamp", "ts", "time", "request_id", "requestId")
        and not (k == "description" and tool in _SHELL_TOOL_NAMES)
    }
    try:
        canon = json.dumps(cleaned, sort_keys=True, separators=(",", ":"), default=str)
    except (TypeError, ValueError):
        return None
    return _sha16(canon)


def _command_text(args) -> Optional[str]:
    """The shell command a tool_use ran (Bash ``command``, exec ``cmd``)."""
    if not isinstance(args, dict):
        return None
    cmd = args.get("command", args.get("cmd"))
    if isinstance(cmd, list):
        cmd = " ".join(str(c) for c in cmd)
    return cmd if isinstance(cmd, str) and cmd.strip() else None


def _cmd_kind(args) -> Optional[str]:
    """'read' / 'write' / None for a shell call, from its command. A class,
    never the text, so the analysis fields stay hashes and flags."""
    cmd = _command_text(args)
    if not cmd:
        return None
    from securevector.app.services.run_health import (  # lazy: avoids an import cycle
        command_of, is_read_only_command, is_write_command,
    )
    cmd = command_of(json.dumps({"command": cmd})) or cmd
    if is_write_command(cmd):
        return "write"
    if is_read_only_command(cmd):
        return "read"
    return None


_SEARCH_WORDS = {"grep", "rg", "egrep", "fgrep", "ag"}


def _search_use_ids(content) -> set:
    """tool_use ids whose command is a search (grep / rg), or a Grep tool."""
    out = set()
    if isinstance(content, list):
        for blk in content:
            if not (isinstance(blk, dict) and blk.get("type") == "tool_use" and blk.get("id")):
                continue
            if blk.get("name") in ("Grep", "grep"):
                out.add(blk["id"])
                continue
            cmd = _command_text(blk.get("input"))
            if cmd:
                words = cmd.replace("bash -lc", "").strip().strip("'\"").split()
                if words and (words[0] in _SEARCH_WORDS or words[:2] == ["git", "grep"]):
                    out.add(blk["id"])
    return out


def _tool_use_calls(content) -> list[dict]:
    """``{"name", "args_hash", "cmd_kind"}`` per tool_use block — full args
    are hashed and discarded, never retained. Only built when the caller
    asks for analysis fields (the trace waterfall doesn't need them)."""
    out = []
    if isinstance(content, list):
        for blk in content:
            if isinstance(blk, dict) and blk.get("type") == "tool_use":
                n = blk.get("name")
                if isinstance(n, str) and n:
                    call = {"name": n, "args_hash": _args_hash(blk.get("input"), n), "id": blk.get("id")}
                    kind = _cmd_kind(blk.get("input"))
                    if kind:
                        call["cmd_kind"] = kind
                    out.append(call)
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


_NO_MATCH_RE = re.compile(r"^\s*(?:Error:\s*)?Exit code 1\s*$")


# The Guard's deny reason, as both plugins emit it (REASON_PREFIX in
# plugins/{claude-code,codex}/hooks/pre-tool-use.js): "SecureVector Guard:
# <reason>". The harness shows it as the tool result, on its own or behind
# its hook banner ("PreToolUse:Bash hook error: ..."). Only the start of the
# result counts, so a command whose output merely mentions the Guard is
# still an ordinary failure.
_DENY_RE = re.compile(r"^\s*(?:[^\n]{0,120}?PreToolUse[^\n]{0,80}?:\s*)?SecureVector Guard:")


def _looks_denied(text: str) -> bool:
    """A tool result that is the Guard's refusal rather than the tool failing."""
    return bool(_DENY_RE.match((text or "")[:200]))


# A gap longer than this between the record that fed a turn and the turn
# itself is someone away from the keyboard, not model time.
_MAX_ESTIMATED_TURN_MS = 30 * 60 * 1000


def _parse_ts(ts) -> Optional[datetime]:
    if not isinstance(ts, str) or not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt


def _estimated_duration_ms(fed_at, called_at) -> Optional[int]:
    """Model time for a transcript turn: its record timestamp minus the
    timestamp of the record that fed it (the prompt or the tool result).
    None when either is missing or unparseable, the gap is negative, or it is
    longer than 30 minutes."""
    a = _parse_ts(fed_at)
    b = _parse_ts(called_at)
    if a is None or b is None:
        return None
    if (a.tzinfo is None) != (b.tzinfo is None):
        return None
    ms = int(round((b - a).total_seconds() * 1000))
    if ms < 0 or ms > _MAX_ESTIMATED_TURN_MS:
        return None
    return ms


def _stamp_estimated_duration(gen: dict, fed_at, fed_by: Optional[str] = None) -> None:
    """Additive: set duration_ms (+ duration_estimated) only when known, and
    turn_start ("prompt" | "tool_result"): which record fed this turn. A turn
    fed by a prompt means the gap before it was the person, not a tool."""
    if fed_by in ("prompt", "tool_result"):
        gen["turn_start"] = fed_by
    ms = _estimated_duration_ms(fed_at, gen.get("called_at"))
    if ms is not None:
        gen["duration_ms"] = ms
        gen["duration_estimated"] = True


def _preview(text: str) -> tuple[str, bool]:
    """Redact secrets, then cap at PREVIEW_CAP. Returns (preview, truncated)."""
    if not text:
        return "", False
    out, truncated = sanitize_trace_text(text, direction="outgoing", cap=PREVIEW_CAP)
    return (out or "", truncated)


def build_generations(
    session_id: str, *, store_text: bool, with_analysis: bool = False,
    path: Optional[Path] = None,
) -> list[dict]:
    """Reconstruct Generation spans for one Claude Code session.

    One generation = one API round-trip (all assistant records sharing a
    ``requestId``), NOT one transcript record. Claude Code writes a transcript
    line per streamed content block, and every line for a round-trip repeats
    the SAME ``usage`` block — so emitting per-record would show one turn as
    many spans and multiply its token count. We group by ``requestId``, take
    the usage once, concatenate the text blocks, and keep the earliest
    timestamp.

    Each generation carries model, token counts, timestamp, and (gated on
    ``store_text``) a redacted 8 KB preview of the model's text output plus
    the prompt that drove it. Returns [] when the transcript can't be found or
    read — the trace still renders its tool spans; generations are additive.

    ``with_analysis`` adds content-identity fields for the Cost Optimizer —
    ``input_hash`` on the generation, ``tool_calls`` ({name, args_hash}) and a
    ``result_hash`` per tool_result. Hashes only, never text; off by default so
    the trace payload is unchanged for existing callers.
    """
    # ``path`` override: subagent transcripts (<session>/subagents/agent-*.jsonl)
    # share this exact record format but aren't discoverable by session id.
    if path is None:
        path = _find_transcript(session_id)
    if path is None:
        return []

    gens: list[dict] = []
    # Accumulator for the round-trip currently being assembled.
    cur: Optional[dict] = None
    cur_out_parts: list[str] = []
    cur_tools: list[str] = []  # tool names this round-trip asked to call
    cur_tool_ids: dict = {}    # tool_use_id -> name, to match returned results
    cur_tool_calls: list[dict] = []  # {name, args_hash} when with_analysis
    search_ids: set = set()  # tool_use ids that ran a search command (grep / rg)
    # The just-flushed generation + its id->name map: the tool_result blocks in
    # the NEXT user turn belong to it (it made the calls).
    last_gen: Optional[dict] = None
    last_gen_ids: dict = {}
    # Every emitted generation by requestId. Claude Code can interleave a
    # tool_result USER record in the middle of one request's streamed records
    # (interleaved tool use); the records after it carry the SAME requestId
    # and the SAME usage. Without this map each split re-counted the request's
    # tokens as a brand-new generation — ~3% inflation on real sessions.
    emitted_rids: dict = {}

    def _flush() -> None:
        nonlocal cur, cur_out_parts, cur_tools, cur_tool_ids, cur_tool_calls, last_gen, last_gen_ids
        if cur is None:
            return
        reopen = bool(cur.get("reopen"))
        out_text = "\n".join(p for p in cur_out_parts if p)
        gen = cur["gen"]
        if store_text and not reopen:
            inp_prev, inp_trunc = _preview(cur["input_text"])
            out_prev, out_trunc = _preview(out_text)
            gen["input_preview"] = inp_prev
            gen["output_preview"] = out_prev
            gen["input_truncated"] = inp_trunc
            gen["output_truncated"] = out_trunc
        if with_analysis:
            if reopen:
                if cur_tool_calls:
                    gen["tool_calls"] = (gen.get("tool_calls") or []) + cur_tool_calls
            else:
                gen["input_hash"] = _sha16(cur["input_text"])
                gen["tool_calls"] = cur_tool_calls
        # De-dupe tool names, preserving first-seen order (a tool called twice
        # in one turn shows once; token/cost stay on the run, not per tool).
        # A reopened request keeps the tools it already declared.
        seen: set = set()
        base_tools = (gen.get("tools_called") or []) if reopen else []
        gen["tools_called"] = [
            t for t in list(base_tools) + cur_tools if not (t in seen or seen.add(t))
        ]
        # Every tool_use by name, repeats kept (names only, never args), so a
        # step can tell which calls the Guard plugin never saw.
        base_names = (gen.get("tool_use_names") or []) if reopen else []
        gen["tool_use_names"] = list(base_names) + list(cur_tools)
        ids_for_last = cur_tool_ids
        # Claude Code writes synthetic assistant records (system-injected turns)
        # with model "<synthetic>" and zero usage — not real API calls, so they
        # must not appear as LLM runs (they render as junk "0→0 tok" rows).
        if not reopen and gen.get("model") != "<synthetic>":
            gens.append(gen)
            if cur.get("rid"):
                emitted_rids[cur["rid"]] = (gen, dict(cur_tool_ids))
        elif reopen and cur.get("rid") in emitted_rids:
            merged = {**emitted_rids[cur["rid"]][1], **cur_tool_ids}
            emitted_rids[cur["rid"]] = (gen, merged)
            ids_for_last = merged
        last_gen = gen
        last_gen_ids = ids_for_last
        cur = None
        cur_out_parts = []
        cur_tools = []
        cur_tool_ids = {}
        cur_tool_calls = []

    # The prompt that drove a generation is the most-recent preceding user
    # message. tool-result-only user turns leave a marker so the input box
    # reads honestly ("responding to a tool result") rather than blank.
    last_user_text = ""
    last_user_was_tool = False
    # Timestamp of the latest user record (a prompt or a tool_result): the
    # record that fed the next generation, for its estimated model time.
    last_user_ts = None
    # Which kind of user record that was: "prompt" or "tool_result".
    last_user_kind = None
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
                    last_user_ts = rec.get("timestamp")
                    content = msg.get("content")
                    # Tool results belong to the LLM run that just flushed — it
                    # made the calls (matched by tool_use_id). This is Pillar 3:
                    # "what the tool returned", captured, not guessed.
                    results = _tool_results_of(content)
                    if results:
                        last_user_kind = "tool_result"
                    elif not _is_meta_user_record(rec, _text_of(content)):
                        last_user_kind = "prompt"
                    # A meta record (isMeta, command/caveat wrapper) is not
                    # a typed prompt: it leaves the kind as it was.
                    if results and last_gen is not None:
                        tr = []
                        for tid, text, is_err in results:
                            entry = {"name": last_gen_ids.get(tid), "is_error": is_err, "tool_use_id": tid}
                            if store_text:
                                prev, trunc = _preview(text)
                                entry["preview"] = prev
                                entry["truncated"] = trunc
                            if with_analysis:
                                entry["result_hash"] = _sha16(text)
                                entry["result_chars"] = len(text)
                                # Run health: flags only, never the text. A
                                # governed deny is policy, not a failure; an
                                # exit 1 with no output is a search that
                                # found nothing (grep / rg), not an error.
                                if is_err:
                                    entry["denied"] = _looks_denied(text)
                                    # Only a search (grep / rg) exiting 1 with
                                    # no output is "found nothing"; any other
                                    # command exiting 1 is a real failure.
                                    entry["no_match"] = bool(
                                        tid in search_ids and _NO_MATCH_RE.match(text or ""))
                            tr.append(entry)
                        if tr:
                            # Each result arrives in its own user record
                            # when a turn made several calls: append, so a
                            # turn keeps every result, not just the last.
                            # A result seen twice (a re-read record) counts once.
                            prior = list(last_gen.get("tool_results") or [])
                            seen_ids = {r.get("tool_use_id") for r in prior if r.get("tool_use_id")}
                            for r in tr:
                                if r.get("tool_use_id") and r["tool_use_id"] in seen_ids:
                                    continue
                                if r.get("tool_use_id"):
                                    seen_ids.add(r["tool_use_id"])
                                prior.append(r)
                            last_gen["tool_results"] = prior
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
                    if rid is not None and rid in emitted_rids:
                        # Continuation of a request we already emitted (its
                        # stream was split by an interleaved user record).
                        # Reopen the SAME generation: its usage is already
                        # counted once; only tools/stop_reason accumulate.
                        cur = {
                            "rid": rid,
                            "input_text": last_user_text,
                            "gen": emitted_rids[rid][0],
                            "reopen": True,
                        }
                        cur_out_parts = []
                        cur_out_parts.append(_text_of(msg.get("content")))
                        cur_tools.extend(_tool_uses_of(msg.get("content")))
                        for _i, _n in _tool_use_pairs(msg.get("content")):
                            cur_tool_ids[_i] = _n
                        if with_analysis:
                            cur_tool_calls.extend(_tool_use_calls(msg.get("content")))
                            search_ids.update(_search_use_ids(msg.get("content")))
                        sr = msg.get("stop_reason")
                        if sr:
                            cur["gen"]["stop_reason"] = sr
                        continue
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
                    _stamp_estimated_duration(cur["gen"], last_user_ts, last_user_kind)
                    cur_out_parts = []
                # Accumulate this record's text + tool_use requests (name + id, so
                # the returned result can be matched back); keep the latest
                # stop_reason (the terminal record carries the real one).
                cur_out_parts.append(_text_of(msg.get("content")))
                cur_tools.extend(_tool_uses_of(msg.get("content")))
                for _i, _n in _tool_use_pairs(msg.get("content")):
                    cur_tool_ids[_i] = _n
                if with_analysis:
                    cur_tool_calls.extend(_tool_use_calls(msg.get("content")))
                    search_ids.update(_search_use_ids(msg.get("content")))
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


# Codex runs shell commands through several tool names; its hook reports all
# of them as "Bash" (plugins/codex/lib/normalize.js). Matching a transcript
# call to the Guard's row needs the hook's name.
_CODEX_HOOK_NAMES = {
    "exec": "Bash", "exec_command": "Bash", "shell": "Bash",
    "shell_command": "Bash", "local_shell": "Bash", "container.exec": "Bash",
}


def build_generations_codex(
    session_id: str, *, store_text: bool, with_analysis: bool = False
) -> list[dict]:
    """Reconstruct Generation spans for one Codex session from its rollout.

    Codex's transcript differs from Claude Code's: token usage rides on
    separate ``token_count`` events (``info.last_token_usage`` = the turn's
    delta), the model lives on ``turn_context`` records, and assistant text is
    in ``output_text`` content blocks. One generation = one model turn (the run
    of assistant text since the previous token_count). Same privacy contract:
    metadata always; redacted 8 KB preview only when store_text is on.
    """
    path = _find_codex_rollout(session_id)
    if path is None:
        return []

    gens: list[dict] = []
    model = "unknown"
    last_user_text = ""
    last_user_was_tool = False
    pending_out: list[str] = []
    # Tool calls the model made since the last token_count, by the name the
    # Guard hook reports (names only, never args).
    pending_calls: list[str] = []

    def _emit(usage: dict) -> None:
        nonlocal pending_out, pending_calls
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
        if with_analysis:
            # Content identity only — Codex rollouts don't correlate tool
            # calls to turns here, so tool_calls stays absent and the
            # optimizer's retry/duplicate detectors abstain for Codex.
            gen["input_hash"] = _sha16(last_user_text)
        if store_text:
            ip, it = _preview(last_user_text)
            op, ot = _preview(out_text)
            gen["input_preview"] = ip
            gen["output_preview"] = op
            gen["input_truncated"] = it
            gen["output_truncated"] = ot
        gen["tool_use_names"] = pending_calls
        gens.append(gen)
        pending_out = []
        pending_calls = []

    try:
        with path.open("r", encoding="utf-8") as fh:
            last_ts = None
            # Timestamp of the record that fed the next turn: the user
            # message or a tool call's output.
            fed_ts = None
            fed_by = None  # "prompt" | "tool_result": what fed_ts was
            # A model call's own record order, as Codex writes it: its output
            # items (reasoning, assistant message, function/custom tool call),
            # then a token_usage_record, then (for a tool call) the tool's
            # output, and only then the event_msg token_count carrying its
            # usage. So the call is timed from its own records, not from the
            # token_count: `call_fed` is the feeding record seen when its first
            # output item arrived, `call_out_ts` its last output item, and
            # `call_end_ts` its token_usage_record (the model end).
            call_fed = None  # (ts, "prompt" | "tool_result") or None
            call_out_ts = None
            call_end_ts = None
            last_total = None  # info.total_token_usage of the last emitted call
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
                if rec.get("type") == "token_usage_record" or ptype == "token_usage_record":
                    if isinstance(ts, str):
                        call_end_ts = ts
                    continue
                is_output = ptype in ("reasoning", "function_call", "custom_tool_call") or (
                    ptype == "message" and payload.get("role") == "assistant")
                if is_output:
                    if call_fed is None:
                        call_fed = (fed_ts, fed_by)
                    if ptype != "reasoning" and isinstance(ts, str):
                        call_out_ts = ts
                    if ptype in ("function_call", "custom_tool_call"):
                        n = payload.get("name")
                        if isinstance(n, str) and n:
                            pending_calls.append(_CODEX_HOOK_NAMES.get(n, n))
                    if ptype != "message":
                        continue
                if ptype == "message":
                    role = payload.get("role")
                    text = _codex_text(payload.get("content"))
                    if role == "assistant":
                        if text:
                            pending_out.append(text)
                    elif role == "user":
                        fed_by = "prompt"
                        if isinstance(ts, str):
                            fed_ts = ts
                        if text:
                            last_user_text = text
                            last_user_was_tool = False
                        else:
                            last_user_text = ""
                            last_user_was_tool = True
                    continue
                if ptype in ("function_call_output", "custom_tool_call_output"):
                    fed_by = "tool_result"
                    if isinstance(ts, str):
                        fed_ts = ts
                    continue
                if ptype == "token_count":
                    info = payload.get("info") or {}
                    usage = info.get("last_token_usage")
                    total = info.get("total_token_usage")
                    if isinstance(usage, dict) and int(usage.get("output_tokens") or 0) > 0:
                        if total is not None and total == last_total and call_fed is None \
                                and call_end_ts is None:
                            # The same call's usage reported again: the running
                            # total did not move and no model output came
                            # between. One call, one generation.
                            continue
                        last_total = total
                        _emit(usage)
                        if call_fed is not None:
                            # Timed from the call's own records (see above).
                            end = call_end_ts or call_out_ts or last_ts
                            start_ts, start_by = call_fed
                        else:
                            # An older rollout with no output items: the
                            # token_count is the only mark of the call.
                            end = call_end_ts or last_ts
                            start_ts, start_by = fed_ts, fed_by
                        if end:
                            gens[-1]["called_at"] = end
                        _stamp_estimated_duration(gens[-1], start_ts, start_by)
                        if call_fed is None:
                            fed_ts = None
                            fed_by = None
                        call_fed = None
                        call_out_ts = None
                        call_end_ts = None
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
