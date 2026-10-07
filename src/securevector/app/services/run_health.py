"""Run health: per-run findings for one agent run (trace).

Each finding says what happened, why it matters and what to do, and points
at the exact steps (``step_refs``) so the step list can mark them and jump.
Local heuristics only: no model calls, no network, nothing written into a
session. Every detector reads data the app already holds, the governed
tool-call audit rows and, when the transcript is readable, the generations
built with analysis fields (hashes, never text).

Refs: a string ref is a span_id (a governed tool call or a stored
generation). An int ref is a span's ``turn_index`` in the trace detail the
UI already fetched; with no trace detail it is the generation's index.

Two entry points:
  analyze_run(trace_detail, generations, baseline)  the full set, one run.
  audit_findings(calls)                              the cheap subset the
      runs list computes for every run in one pass (same_call, cycle,
      reread, blocked), from tool_call_audit alone.
"""

from __future__ import annotations

import hashlib
import json
import re
import statistics
from collections import OrderedDict
from typing import Any, Iterable, Optional

from securevector.app.services.cost_optimizer import (
    CONTEXT_FIXES,
    IDEMPOTENT_TOOLS,
    detect_abnormal_loop,
    detect_duplicates,
    prompt_tokens,
    segment_generations,
)

# --- thresholds (module constants; operators can disagree with a number) ----

# loop / same_call: the same (tool, args identity) this many times ...
SAME_CALL_MIN = 3
# ... inside any window of this many consecutive tool calls.
SAME_CALL_WINDOW = 20
# Read-only tools repeat as normal polling; they count only when repeated
# back to back at least this many times.
READ_ONLY_BACK_TO_BACK_MIN = 3
# loop / cycle: a repeated subsequence of this length range ...
CYCLE_MIN_LEN = 2
CYCLE_MAX_LEN = 4
# ... repeated back to back at least this many times (A B A B A B).
CYCLE_MIN_REPEATS = 3
# loop / reread: the same file read this many times with no edit between.
REREAD_MIN = 3
# failing / error_streak: consecutive tool results with is_error.
ERROR_STREAK_MIN = 3
# failing / error_rate: share of the run's tool results that errored ...
ERROR_RATE_MIN = 0.30
# ... judged only once the run has made this many tool calls.
ERROR_RATE_MIN_CALLS = 10
# failing / stuck: a working task with no activity for this long. Exposed
# for the UI (Agent Sessions reads last_activity_at); not computed here.
STUCK_SECONDS = 120
# wasteful / tool_result_carry: one tool result at least this big (chars/4
# estimate). Four times the live advisor's 2K nudge, so a normal file read
# is not a finding on every run.
CARRY_MIN_TOKENS = 8000
# wasteful / resend_growth: the context re-sent per turn must end above
# this floor (half a 200K window) and have at least doubled within the
# current segment (a compaction starts a new segment).
RESEND_FLOOR_TOKENS = 100_000
RESEND_GROWTH_MULTIPLE = 2.0
# wasteful / runaway: more than this multiple of the runtime's own median
# over the last 30 days ...
RUNAWAY_MEDIAN_MULTIPLE = 2.0
# ... once the baseline holds this many runs ...
RUNAWAY_MIN_BASELINE_RUNS = 5
# ... and the run itself is past these floors, so a 3 vs 1 call run is
# never "runaway".
RUNAWAY_MIN_CALLS = 20
RUNAWAY_MIN_TURNS = 20
RUNAWAY_MIN_COST_USD = 0.50
# Args identity for audit rows: the first N chars of the redacted preview
# plus its length. The runs list reads only this prefix from SQL, so the
# list and the detail compute the same identity.
IDENTITY_PREFIX_CHARS = 512
# Proactive warm-up: every WARM_INTERVAL_SECONDS, off the event loop, full
# health for runs active in the last WARM_WINDOW_SECONDS (newest first, at
# most WARM_MAX_RUNS a pass), skipping runs whose cache key has not moved.
WARM_INTERVAL_SECONDS = 60
WARM_FIRST_DELAY_SECONDS = 5  # first pass soon after startup
WARM_WINDOW_SECONDS = 2 * 60 * 60
WARM_MAX_RUNS = 20
# At most this many findings of one kind per run, largest first.
MAX_FINDINGS_PER_KIND = 3
# Refs kept per finding (the UI marks and jumps; it never needs hundreds).
MAX_REFS = 50

CHARS_PER_TOKEN = 4

# Tools whose repetition is normal work (polling, searching, reading).
# (IDEMPOTENT_TOOLS' "git status" is a command, not a tool name: shell
# commands are matched on their text by READ_ONLY_COMMANDS instead.)
READ_ONLY_TOOLS = (set(IDEMPOTENT_TOOLS) - {"git status"}) | {
    "NotebookRead", "WebSearch", "read_file", "list_dir", "list_directory",
    "grep", "glob", "ls", "view", "search", "read",
}
# Shell tools whose command text decides whether a call is read-only.
SHELL_TOOLS = {"Bash", "bash", "shell", "exec", "exec_command", "local_shell",
               "run_shell_command", "container.exec", "run_terminal_cmd"}
# Read-only shell commands (first word, or first two for git): these repeat
# as normal checking and count only when back to back.
READ_ONLY_COMMANDS = {"git status", "git diff", "git log", "git show", "ls", "pwd",
                      "cat", "head", "tail", "grep", "rg", "find", "wc"}

# Tools that read one file, for the reread detector.
READ_FILE_TOOLS = {"Read", "NotebookRead", "read_file", "view", "read"}
# Tools that change files; any of them between two reads resets the count.
EDIT_TOOLS = {
    "Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch", "edit_file",
    "write_file", "create_file", "str_replace_editor", "edit", "write",
    # Codex write tools
    "apply_patch_tool", "update_file", "delete_file",
}

CATEGORIES = ("loop", "failing", "wasteful", "blocked")
_SEVERITY_RANK = {"high": 0, "warn": 1, "info": 2}
_CATEGORY_RANK = {c: i for i, c in enumerate(CATEGORIES)}

# The state-note-first workflow the live advisor uses for context fixes.
STATE_NOTE_NUDGE = (
    "Pause here. Write a short state note to STATE.md so a fresh session can "
    "continue this work: the task in one line, decisions already made, files "
    "in flight with their paths, and the exact next step. Keep it under 40 "
    "lines. Then compact or start a fresh session from the note."
)


# --- small helpers -----------------------------------------------------------

def _sha16(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "ignore")).hexdigest()[:16]


def args_identity(head: Optional[str], length: Optional[int] = None) -> Optional[str]:
    """Identity of an audit row's args: first IDENTITY_PREFIX_CHARS of the
    redacted preview plus its full length. None for an empty preview, so two
    calls with no recorded args never count as the same call."""
    if head is None:
        return None
    s = str(head)
    if not s:
        return None
    n = len(s) if length is None else int(length)
    return _sha16(f"{s[:IDENTITY_PREFIX_CHARS]}#{n}")


_PATH_RE = re.compile(r'"(?:file_path|notebook_path|path|filePath)"\s*:\s*"((?:[^"\\]|\\.)*)"')
_OFFSET_RE = re.compile(r'"offset"\s*:\s*(\d+)')
_LIMIT_RE = re.compile(r'"limit"\s*:\s*(\d+)')


def path_of(preview: Optional[str]) -> Optional[str]:
    """The file a read names, from the JSON-ish args preview. Reading other
    ranges of the same file is different work, so a range is part of the key."""
    if not preview:
        return None
    s = str(preview)[:IDENTITY_PREFIX_CHARS]
    m = _PATH_RE.search(s)
    if not m:
        return None
    key = m.group(1)
    off, lim = _OFFSET_RE.search(s), _LIMIT_RE.search(s)
    if off or lim:
        key += f"#{off.group(1) if off else ''}:{lim.group(1) if lim else ''}"
    return key


_CMD_RE = re.compile(r'"(?:command|cmd)"\s*:\s*("(?:[^"\\]|\\.)*"|\[[^\]]*\])')
_WRAPPERS = ("bash -lc ", "bash -c ", "sh -c ", "zsh -lc ", "zsh -c ")


def command_of(preview: Optional[str]) -> Optional[str]:
    """The shell command a Bash / exec call ran, from its args preview.
    Codex sends an argv list (["bash", "-lc", "git status"]); a wrapper
    shell is stripped so the command itself is what is matched."""
    if not preview:
        return None
    s = str(preview)[:IDENTITY_PREFIX_CHARS]
    m = _CMD_RE.search(s)
    if not m:
        return None
    raw = m.group(1)
    try:
        val = json.loads(raw)
    except ValueError:
        # A truncated argv list: keep its quoted parts.
        parts = re.findall(r'"((?:[^"\\]|\\.)*)"', raw)
        val = parts if raw.startswith("[") and parts else raw.strip('"[]')
    if isinstance(val, list):
        val = " ".join(str(v) for v in val)
    cmd = str(val).strip()
    for w in _WRAPPERS:
        if cmd.startswith(w):
            cmd = cmd[len(w):].strip().strip("'\"")
            break
    return cmd or None


def is_read_only_command(cmd: Optional[str]) -> bool:
    if not cmd:
        return False
    words = cmd.split()
    first = words[0].rsplit("/", 1)[-1] if words else ""
    two = f"{first} {words[1]}" if len(words) > 1 else first
    return (first != "git" and first in READ_ONLY_COMMANDS) or two in READ_ONLY_COMMANDS


# Shell commands that change files: a retry after one of these is new work.
_WRITE_CMD_PREFIXES = ("apply_patch", "sed -i", "perl -pi", "perl -i", "tee ", "cat >")
_REDIRECT_RE = re.compile(r"(?<![<>])>>?\s*([^\s;&|]+)")


def is_write_command(cmd: Optional[str]) -> bool:
    """apply_patch, sed -i, perl -pi, tee, cat >, or an output redirection
    to anything but /dev/null (a file-descriptor dup like 2>&1 is not one)."""
    if not cmd:
        return False
    c = cmd.strip()
    if c.startswith(_WRITE_CMD_PREFIXES):
        return True
    for m in _REDIRECT_RE.finditer(c):
        target = m.group(1)
        if target != "/dev/null" and not target.startswith("&"):
            return True
    return False


def _is_edit_call(c: dict) -> bool:
    if _in(c.get("tool"), EDIT_TOOLS):
        return True
    if c.get("cmd_kind") == "write":
        return True
    return _in(c.get("tool"), SHELL_TOOLS) and is_write_command(c.get("cmd"))


def _read_only_call(c: dict) -> bool:
    if c.get("cmd_kind") == "read":
        return True
    if _in(c.get("tool"), SHELL_TOOLS):
        return is_read_only_command(c.get("cmd"))
    return _in(c.get("tool"), READ_ONLY_TOOLS)


def _base_name(path_key: str) -> str:
    p = path_key.split("#", 1)[0].replace("\\", "/").rstrip("/")
    return p.rsplit("/", 1)[-1] or p


def _is_boundary(name: Optional[str]) -> bool:
    s = str(name or "")
    return len(s) >= 4 and s.startswith("__") and s.endswith("__")


def _in(name: Optional[str], group: set) -> bool:
    n = str(name or "")
    return n in group or n.lower() in group


def _fmt_tokens(n: float) -> str:
    n = float(n or 0)
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1000:
        return f"{n / 1000:.0f}K"
    return str(int(n))


def _refs(items: Iterable[Any]) -> list:
    out: list = []
    for r in items:
        if r is None or r == "" or r in out:
            continue
        out.append(r)
        if len(out) >= MAX_REFS:
            break
    return out


def _finding(kind: str, category: str, severity: str, title: str, why: str,
             action: str, refs: Iterable[Any], *, key: Any = None,
             tool: Optional[str] = None, counts: Optional[dict] = None,
             est_tokens: Optional[int] = None, est_usd: Optional[float] = None,
             nudge: Optional[str] = None) -> dict:
    return {
        "id": f"{kind}-{_sha16(repr((kind, key if key is not None else title)))[:8]}",
        "category": category,
        "kind": kind,
        "severity": severity,
        "title": title,
        "why": why,
        "action": action,
        "nudge": nudge,
        "step_refs": _refs(refs),
        "evidence": {
            "counts": counts or {},
            "tool": tool,
            "est_tokens": est_tokens,
            "est_usd": round(est_usd, 6) if isinstance(est_usd, (int, float)) else None,
        },
    }


# --- call normalisation ------------------------------------------------------

def calls_from_spans(spans: Iterable[dict]) -> list[dict]:
    """Governed tool calls (audit rows or trace spans) in order, as
    {tool, ident, path, ref, action}. Session markers are boundaries, not
    calls. Rows from the runs list carry ``args_head``/``args_len`` in place
    of the full preview."""
    out = []
    for s in spans or []:
        if not isinstance(s, dict) or s.get("span_kind") == "generation":
            continue
        name = s.get("function_name") or s.get("tool_id")
        if not name or _is_boundary(s.get("function_name")) or _is_boundary(s.get("tool_id")):
            continue
        if "args_head" in s:
            head = s.get("args_head")
            ident = args_identity(head, s.get("args_len"))
        else:
            head = s.get("args_preview")
            ident = args_identity(head)
        cmd = command_of(head)
        if cmd and _in(str(name), SHELL_TOOLS):
            # A shell call is what it ran: the narration beside the command
            # ("description") differs on every retry of the same command.
            ident = _sha16(f"cmd#{cmd}")
        ref = s.get("span_id") or (s.get("turn_index") if isinstance(s.get("turn_index"), int) else None)
        out.append({
            "tool": str(name),
            "ident": ident,
            "path": path_of(head),
            "cmd": cmd,
            "ref": ref,
            "action": s.get("action"),
            # PostToolUseFailure rows (Claude Code) carry this reason.
            "error": str(s.get("reason") or "").startswith("tool error"),
        })
    return out


def calls_from_generations(gens: list[dict], gen_refs: list) -> list[dict]:
    """Transcript tool_use calls in order: the ground truth for what ran,
    each with its args hash, its shell command class and whether its result
    was an error (matched by tool_use id)."""
    out = []
    for i, g in enumerate(gens or []):
        by_id = {r.get("tool_use_id"): r for r in g.get("tool_results") or [] if r.get("tool_use_id")}
        for c in g.get("tool_calls") or []:
            if c.get("name"):
                res = by_id.get(c.get("id"))
                out.append({"tool": c["name"], "ident": c.get("args_hash"), "path": None, "cmd": None,
                            "cmd_kind": c.get("cmd_kind"),
                            "error": bool(res and res.get("is_error") and not res.get("no_match")
                                          and not res.get("denied")),
                            "ref": gen_refs[i] if i < len(gen_refs) else None, "action": None})
    return out


def merge_calls(transcript: list[dict], audit: list[dict]) -> list[dict]:
    """The transcript sequence, with each call pointed at its governed audit
    row where one matches (same tool, in order), so step_refs land on the
    exact call and verdicts carry over. Audit rows the transcript lacks are
    dropped here; detect_blocked still reads the audit list itself."""
    out = []
    p = 0
    for t in transcript:
        hit = None
        for k in range(p, min(len(audit), p + 8)):
            if audit[k]["tool"] == t["tool"]:
                hit = k
                break
        c = dict(t)
        if hit is not None:
            a = audit[hit]
            c["ref"] = a.get("ref") if a.get("ref") not in (None, "") else t.get("ref")
            c["action"] = a.get("action")
            c["path"] = a.get("path")
            c["cmd"] = a.get("cmd")
            c["error"] = t.get("error") or a.get("error")
            p = hit + 1
        out.append(c)
    return out


# --- loop detectors (work on calls) -------------------------------------------

def detect_same_call(calls: list[dict]) -> list[dict]:
    """The same (tool, args) repeated with nothing changing between. An
    edit or write resets the count (the retry after a fix is normal work),
    as in reread. Read-only tools and read-only shell commands (git status,
    ls, grep, ...) count only when back to back."""
    by_key: dict[tuple, list[int]] = {}
    ro_key: dict[tuple, bool] = {}
    epoch = 0
    for i, c in enumerate(calls):
        if _is_edit_call(c):
            epoch += 1
            continue
        if c.get("ident"):
            key = (c["tool"], c["ident"])
            by_key.setdefault(key + (epoch,), []).append(i)
            ro_key[key] = _read_only_call(c)
    found = []
    best_by_key: dict[tuple, tuple] = {}
    for (tool, ident, _ep), pos in by_key.items():
        if len(pos) < SAME_CALL_MIN:
            continue
        if ro_key.get((tool, ident)):
            best: list[int] = []
            run: list[int] = []
            for p in pos:
                run = run + [p] if run and p == run[-1] + 1 else [p]
                if len(run) > len(best):
                    best = list(run)
            if len(best) < READ_ONLY_BACK_TO_BACK_MIN:
                continue
            members, back_to_back = best, True
        else:
            members, j = [], 0
            for k in range(len(pos)):
                while pos[k] - pos[j] >= SAME_CALL_WINDOW:
                    j += 1
                if k - j + 1 > len(members):
                    members = pos[j:k + 1]
            if len(members) < SAME_CALL_MIN:
                continue
            back_to_back = False
        prev = best_by_key.get((tool, ident))
        if prev is None or len(members) > prev[0]:
            best_by_key[(tool, ident)] = (len(members), tool, ident, members, back_to_back)
    found = list(best_by_key.values())
    found.sort(key=lambda f: -f[0])
    out = []
    for n, tool, ident, members, b2b in found[:MAX_FINDINGS_PER_KIND]:
        title = (f"Running {tool} {n} times in a row, same arguments" if b2b
                 else f"Looping on {tool}, same arguments {n} times")
        out.append(_finding(
            "same_call", "loop", "high" if n >= 6 else "warn", title,
            "The agent repeated an identical call instead of changing its approach, "
            "and every repeat re-sends the whole context.",
            "Stop the repeat and ask the agent to use what the call already returned.",
            [calls[p]["ref"] for p in members], key=(tool, ident), tool=tool,
            counts={"calls": n},
            nudge=(f"You have run {tool} {n} times with the same arguments. Stop repeating it, "
                   "look at what it already returned, and change the approach."),
        ))
    return out


def detect_cycle(calls: list[dict]) -> list[dict]:
    seq = [(c["tool"], c.get("ident") or f"__none_{i}") for i, c in enumerate(calls)]
    n = len(seq)
    cycles: dict[tuple, dict] = {}
    i = 0
    while i < n:
        hit = None
        for L in range(CYCLE_MIN_LEN, CYCLE_MAX_LEN + 1):
            if i + L * CYCLE_MIN_REPEATS > n:
                break
            pat = seq[i:i + L]
            if len(set(pat)) < 2 or any(p[1].startswith("__none_") for p in pat):
                continue
            # Reading several files in turn is the reread detector's job.
            if all(_in(p[0], READ_ONLY_TOOLS) for p in pat):
                continue
            reps = 1
            while seq[i + reps * L:i + (reps + 1) * L] == pat:
                reps += 1
            if reps >= CYCLE_MIN_REPEATS:
                hit = (L, reps, pat)
                break
        if not hit:
            i += 1
            continue
        L, reps, pat = hit
        # One key for every rotation of the same cycle.
        rot = min(tuple(pat[k:] + pat[:k]) for k in range(L))
        entry = cycles.setdefault(rot, {"reps": 0, "positions": [], "pat": pat})
        entry["reps"] = max(entry["reps"], reps)
        entry["positions"].extend(range(i, i + L * reps))
        i += L * reps
    out = []
    for rot, e in sorted(cycles.items(), key=lambda kv: -kv[1]["reps"])[:MAX_FINDINGS_PER_KIND]:
        names = ", ".join(p[0] for p in e["pat"])
        reps = e["reps"]
        out.append(_finding(
            "cycle", "loop", "high" if reps >= 5 else "warn",
            f"Repeating the same {len(e['pat'])} calls {reps} times ({names})",
            "The agent is going round the same sequence with the same arguments, so each pass "
            "gets the same result.",
            "Interrupt the run and ask the agent what it expects to change on the next pass.",
            [calls[p]["ref"] for p in e["positions"]], key=rot, tool=e["pat"][0][0],
            counts={"repeats": reps, "length": len(e["pat"])},
            nudge=(f"You have repeated the same sequence ({names}) {reps} times with the same "
                   "arguments. Stop, say what is not working, and try a different approach."),
        ))
    return out


def detect_reread(calls: list[dict]) -> list[dict]:
    open_reads: dict[str, list[int]] = {}
    best: dict[str, list[int]] = {}
    tools: dict[str, str] = {}
    for i, c in enumerate(calls):
        tool = c["tool"]
        if _in(tool, EDIT_TOOLS):
            open_reads.clear()
            continue
        if not _in(tool, READ_FILE_TOOLS):
            continue
        key = c.get("path") or (f"{tool}#{c['ident']}" if c.get("ident") else None)
        if key is None:
            continue
        open_reads.setdefault(key, []).append(i)
        tools[key] = tool
        if len(open_reads[key]) > len(best.get(key, [])):
            best[key] = list(open_reads[key])
    hits = sorted(((k, v) for k, v in best.items() if len(v) >= REREAD_MIN), key=lambda kv: -len(kv[1]))
    out = []
    for key, pos in hits[:MAX_FINDINGS_PER_KIND]:
        n = len(pos)
        has_path = not key.startswith(f"{tools[key]}#")
        what = _base_name(key) if has_path else "the same file"
        out.append(_finding(
            "reread", "loop", "warn" if n >= 5 else "info",
            f"Read {what} {n} times with no edit between",
            "Nothing changed the file between reads, so each read re-sends content the agent "
            "already has.",
            "Ask the agent to work from what it already read.",
            [calls[p]["ref"] for p in pos], key=key, tool=tools[key], counts={"reads": n},
            nudge=(f"You have read {what} {n} times without changing it. Use what you already "
                   "read, or say what you are looking for before reading it again."),
        ))
    return out


def detect_blocked(calls: list[dict], extra_blocked: int = 0) -> list[dict]:
    refs = [c["ref"] for c in calls if c.get("action") == "block"]
    n = len(refs) + max(0, int(extra_blocked or 0))
    if not n:
        return []
    return [_finding(
        "blocked", "blocked", "info", f"{n} call{'' if n == 1 else 's'} blocked by policy",
        "Policy refused these calls, so the agent could not do what it asked.",
        "Review the blocked calls; approve one only if the agent really needs it.",
        refs, key="blocked", counts={"blocked": n, "egress": int(extra_blocked or 0)},
    )]


def audit_findings(calls: list[dict], extra_blocked: int = 0) -> list[dict]:
    """The cheap subset: everything the audit rows alone can show."""
    return (detect_same_call(calls) + detect_cycle(calls) + detect_reread(calls)
            + detect_blocked(calls, extra_blocked))


# --- transcript detectors (work on generations) ------------------------------

def _results(gens: list[dict], denied_ids: Optional[set] = None) -> list[tuple]:
    """(is_error, gen index, tool name) per tool result. A result that is a
    governed refusal is policy, not a failure, and is left out: matched by
    tool_use_id to a blocked call's request_id where they share one, else by
    the hook-deny marker the transcript builder flags. A search that found
    nothing (exit 1, no output) is not an error."""
    out = []
    denied_ids = denied_ids or set()
    for i, g in enumerate(gens or []):
        for r in g.get("tool_results") or []:
            if r.get("denied") or (r.get("tool_use_id") and r.get("tool_use_id") in denied_ids):
                continue
            err = bool(r.get("is_error")) and not r.get("no_match")
            out.append((err, i, r.get("name")))
    return out


def detect_errors(gens: list[dict], gen_refs: list, denied_ids: Optional[set] = None,
                  calls: Optional[list[dict]] = None) -> list[dict]:
    """Failure streaks and rates over the transcript's tool results. With no
    transcript results, the audit's own error rows (PostToolUseFailure)."""
    res = _results(gens, denied_ids)
    if not res and calls:
        refs_of = [c.get("ref") for c in calls]
        gen_refs = refs_of
        res = [(bool(c.get("error")), i, c.get("tool")) for i, c in enumerate(calls)]
    out = []
    best: list[tuple] = []
    run: list[tuple] = []
    for r in res:
        run = run + [r] if r[0] else []
        if len(run) > len(best):
            best = list(run)
    ref = (lambda i: gen_refs[i] if i < len(gen_refs) else None)
    if len(best) >= ERROR_STREAK_MIN:
        n = len(best)
        names = sorted({str(r[2]) for r in best if r[2]})
        out.append(_finding(
            "error_streak", "failing", "high" if n >= 6 else "warn",
            f"{n} tool calls failed in a row" + (f" ({', '.join(names[:3])})" if names else ""),
            "The agent keeps running a step that fails, and pays for the whole context on "
            "every attempt.",
            "Read the last error, then tell the agent what to change before it tries again.",
            [ref(r[1]) for r in best], key="streak", tool=names[0] if names else None,
            counts={"streak": n},
            nudge=("Stop retrying the failing command. State what failed, what you already "
                   "tried, and propose a different approach before running anything else."),
        ))
    total = len(res)
    errs = [r for r in res if r[0]]
    if total >= ERROR_RATE_MIN_CALLS and len(errs) / total > ERROR_RATE_MIN:
        pct = round(100 * len(errs) / total)
        out.append(_finding(
            "error_rate", "failing", "info",
            f"{pct}% of tool calls failed ({len(errs)} of {total})",
            "A high failure rate usually means a wrong path, a missing dependency or a "
            "permission the agent does not have.",
            "Check the failing steps for the common cause and fix it once.",
            [ref(r[1]) for r in errs], key="rate", counts={"errors": len(errs), "calls": total},
        ))
    return out


def detect_retry(calls: list[dict]) -> list[dict]:
    """The same call (tool and args identity) run back to back, each
    earlier attempt's own result an error (matched by tool_use_id), with
    no edit or shell write between. A retry after a change is new work (the
    TDD loop), so an edit ends the run, as does any other call or an
    attempt that succeeded."""
    runs: list[list[int]] = []
    cur: list[int] = []

    def close():
        if len(cur) >= SAME_CALL_MIN:
            runs.append(list(cur))

    for i, c in enumerate(calls):
        key = (c["tool"], c.get("ident")) if c.get("ident") else None
        prev = calls[cur[-1]] if cur else None
        same = prev is not None and key is not None and (prev["tool"], prev.get("ident")) == key
        if same and prev.get("error"):
            cur.append(i)
            continue
        close()
        cur = [i] if key is not None and not _is_edit_call(c) else []
    close()
    runs.sort(key=len, reverse=True)
    out = []
    seen_tools: set = set()
    for members in runs:
        c0 = calls[members[0]]
        tool, n = c0["tool"], len(members)
        if (tool, c0.get("ident")) in seen_tools:
            continue
        seen_tools.add((tool, c0.get("ident")))
        out.append(_finding(
            "retry_loop", "loop", "high" if n >= 5 else "warn",
            f"Retrying {tool} after errors, {n} times with the same arguments",
            "The same call failed and was sent again unchanged, so it can only fail again.",
            "Stop the retries and change the command or its inputs.",
            [calls[m]["ref"] for m in members], key=(tool, c0.get("ident")), tool=tool,
            counts={"calls": n},
            nudge=(f"You have run {tool} {n} times with the same arguments and it keeps failing. "
                   "Stop retrying, read the error, and change the approach."),
        ))
        if len(out) >= MAX_FINDINGS_PER_KIND:
            break
    return out


def detect_duplicate_turns(gens: list[dict], gen_refs: list) -> list[dict]:
    out = []
    for grp in detect_duplicates(gens or [])[:MAX_FINDINGS_PER_KIND]:
        turns = grp["turns"]
        extra = [gens[i] for i in turns[1:]]
        tok = sum(prompt_tokens(g) + int(g.get("output_tokens") or 0) for g in extra)
        costs = [g.get("cost") for g in extra if isinstance(g.get("cost"), (int, float))]
        usd = sum(costs) if costs else None
        out.append(_finding(
            "duplicate_turns", "wasteful", "warn" if (usd or 0) >= 0.10 else "info",
            f"The same model turn was sent {len(turns)} times",
            "Identical consecutive requests with no tool call between bill the whole context "
            "each time.",
            "Check the harness or proxy for a retry that resends the request.",
            [gen_refs[i] if i < len(gen_refs) else None for i in turns], key=tuple(turns),
            counts={"turns": len(turns)}, est_tokens=tok, est_usd=usd,
        ))
    return out


def detect_context(gens: list[dict], gen_refs: list) -> list[dict]:
    """resend_growth and tool_result_carry, the live advisor's two context
    flags, applied to the run's current segment (after the last compaction)."""
    if not gens:
        return []
    ref = (lambda i: gen_refs[i] if i < len(gen_refs) else None)
    seg = segment_generations(gens)[-1]
    out = []
    ctx = [(i, prompt_tokens(gens[i])) for i in seg if prompt_tokens(gens[i]) > 0]
    if len(ctx) >= 2:
        (i0, first), (i1, last) = ctx[0], ctx[-1]
        if last > RESEND_FLOOR_TOKENS and last >= RESEND_GROWTH_MULTIPLE * max(1, first):
            out.append(_finding(
                "resend_growth", "wasteful", "info",
                f"Context re-sent per turn grew from {_fmt_tokens(first)} to {_fmt_tokens(last)} tokens",
                "Every turn re-sends the whole history, so each new turn costs more than the last.",
                "Write a short state note, then compact or start a fresh session from it.",
                [ref(i0), ref(i1)], key="resend", counts={"from_tokens": first, "to_tokens": last},
                # A context fix (CONTEXT_FIXES): the state note first, then compact.
                est_tokens=last, nudge=STATE_NOTE_NUDGE if "resend_growth" in CONTEXT_FIXES else None,
            ))
    best_tok, best_i, best_tool = 0, None, None
    for i in seg:
        for r in gens[i].get("tool_results") or []:
            chars = r.get("result_chars")
            tok = int(chars) // CHARS_PER_TOKEN if isinstance(chars, int) else 0
            if tok > best_tok:
                best_tok, best_i, best_tool = tok, i, r.get("name")
    if best_i is not None and best_tok >= CARRY_MIN_TOKENS:
        later = sum(1 for i in seg if i > best_i)
        out.append(_finding(
            "tool_result_carry", "wasteful", "info",
            f"A {best_tool or 'tool'} result of about {_fmt_tokens(best_tok)} tokens stayed in context",
            f"It is re-sent with each of the {later} later turn{'' if later == 1 else 's'} until "
            "the context is compacted.",
            "Ask for smaller results: search first, then read only the lines needed.",
            [ref(best_i)], key="carry", tool=best_tool,
            counts={"later_turns": later}, est_tokens=best_tok,
            nudge=("From now on, keep tool results small: search first, then read only the "
                   "specific line ranges you need, and keep any single tool result under about "
                   "2K tokens."),
        ))
    return out


def detect_runaway(gens: list[dict], gen_refs: list, n_calls: int, baseline: Optional[dict],
                   runtime: Optional[str] = None) -> list[dict]:
    b = baseline or {}
    reasons = []
    shape = detect_abnormal_loop(gens or [], b if b.get("rate_mean") is not None else None)
    if shape:
        reasons.append((
            3.0,
            f"Runaway pace: {shape['peak_calls_per_min']} calls a minute, "
            f"{round(100 * shape['repetition_ratio'])}% repeated",
            {"peak_calls_per_min": shape["peak_calls_per_min"],
             "repetition_ratio": shape["repetition_ratio"], "z_score": shape["z_score"]},
        ))
    if int(b.get("runs") or 0) >= RUNAWAY_MIN_BASELINE_RUNS:
        who = runtime or "this runtime"
        med_calls = b.get("median_calls")
        if med_calls and n_calls >= RUNAWAY_MIN_CALLS and n_calls > RUNAWAY_MEDIAN_MULTIPLE * med_calls:
            reasons.append((n_calls / med_calls,
                            f"{n_calls} tool calls, over twice the usual {round(med_calls)} for {who}",
                            {"calls": n_calls, "median_calls": med_calls}))
        turns = len(gens or [])
        med_turns = b.get("median_turns")
        if med_turns and turns >= RUNAWAY_MIN_TURNS and turns > RUNAWAY_MEDIAN_MULTIPLE * med_turns:
            reasons.append((turns / med_turns,
                            f"{turns} model turns, over twice the usual {round(med_turns)} for {who}",
                            {"turns": turns, "median_turns": med_turns}))
        cost = sum(g.get("cost") or 0 for g in gens or [] if isinstance(g.get("cost"), (int, float)))
        med_cost = b.get("median_cost")
        if med_cost and cost >= RUNAWAY_MIN_COST_USD and cost > RUNAWAY_MEDIAN_MULTIPLE * med_cost:
            reasons.append((cost / med_cost,
                            f"${cost:.2f} spent, over twice the usual ${med_cost:.2f} for {who}",
                            {"cost": round(cost, 4), "median_cost": med_cost}))
    if not reasons:
        return []
    reasons.sort(key=lambda r: -r[0])
    counts: dict = {}
    for r in reasons:
        counts.update(r[2])
    cost = sum(g.get("cost") or 0 for g in gens or [] if isinstance(g.get("cost"), (int, float)))
    last = len(gens or []) - 1
    return [_finding(
        "runaway", "wasteful", "warn", reasons[0][1],
        "This run is far outside this agent's usual size or pace, which is how a loop or a "
        "stuck plan looks from the outside.",
        "Check whether the run is still making progress; stop it if it is not.",
        [gen_refs[last] if 0 <= last < len(gen_refs) else last] if last >= 0 else [],
        key="runaway", counts=counts, est_usd=cost or None,
        nudge=("You have been working on this for much longer than usual. Stop, summarise what is "
               "done and what is blocking you, and propose the smallest next step."),
    )]


# --- the run ------------------------------------------------------------------

def _gen_refs(trace_detail: Optional[dict], gens: list[dict]) -> list:
    """For each analysis generation, the ref of the same turn in the trace
    detail: its span_id when it has one, else its turn_index. Matched by
    request_id, else by called_at (several turns may share one timestamp,
    so each is consumed in order). No matching span gives None: the UI
    then shows the finding without a Jump button. With no detail at all
    (a bare analysis), the generation's own index."""
    detail_spans = (trace_detail or {}).get("spans")
    if detail_spans is None:
        return list(range(len(gens or [])))
    spans = [s for s in detail_spans if s.get("span_kind") == "generation"]
    by_rid = {s.get("request_id"): s for s in spans if s.get("request_id")}
    by_at: dict = {}
    for s in spans:
        if s.get("called_at"):
            by_at.setdefault(s.get("called_at"), []).append(s)
    used: set = set()
    out = []
    for g in gens or []:
        s = by_rid.get(g.get("request_id")) if g.get("request_id") else None
        if s is None or id(s) in used:
            s = None
            for cand in by_at.get(g.get("called_at")) or []:
                if id(cand) not in used:
                    s = cand
                    break
        if s is None:
            out.append(None)
            continue
        used.add(id(s))
        ref = s.get("span_id") or s.get("turn_index")
        out.append(ref if ref is not None and ref != "" else None)
    return out


def _sort(findings: list[dict]) -> list[dict]:
    return sorted(findings, key=lambda f: (_SEVERITY_RANK.get(f["severity"], 3),
                                           _CATEGORY_RANK.get(f["category"], 9)))


def counts_of(findings: list[dict]) -> dict:
    out = {c: 0 for c in CATEGORIES}
    for f in findings:
        out[f["category"]] = out.get(f["category"], 0) + 1
    return out


def analyze_run(trace_detail: Optional[dict], generations_with_analysis: Optional[list[dict]],
                baseline: Optional[dict] = None) -> dict:
    """Every finding for one run.

    ``trace_detail`` is the GET /api/traces/{id} payload (spans carry
    span_id / turn_index, egress_blocked); ``generations_with_analysis`` is
    build_generations(..., with_analysis=True) for the same session (may be
    empty). ``baseline`` optionally carries rate_mean / rate_stdev (the
    abnormal-loop z-score) and median_calls / median_turns / median_cost /
    runs (this runtime over the last 30 days)."""
    detail = trace_detail or {}
    gens = list(generations_with_analysis or [])
    refs = _gen_refs(detail, gens)
    audit_calls = calls_from_spans(detail.get("spans") or [])  # boundary rows excluded
    transcript_calls = calls_from_generations(gens, refs)
    # The transcript is the ground truth for what ran (a failed call may
    # never reach an audit hook); audit rows add verdicts and exact refs.
    if transcript_calls and len(transcript_calls) >= len(audit_calls):
        calls = merge_calls(transcript_calls, audit_calls)
        source = "transcript+audit" if audit_calls else "transcript"
    else:
        calls = audit_calls
        source = "audit"
    findings: list[dict] = []
    retry = detect_retry(calls)
    retried = {f["evidence"]["tool"] for f in retry}
    # A retry loop is the sharper reading of the same repeat: keep one.
    findings += [f for f in detect_same_call(calls) if f["evidence"]["tool"] not in retried]
    findings += retry
    findings += detect_cycle(calls)
    findings += detect_reread(calls)
    denied_ids = {s.get("request_id") for s in (detail.get("spans") or [])
                  if s.get("span_kind") == "tool_call" and s.get("action") == "block" and s.get("request_id")}
    findings += detect_errors(gens, refs, denied_ids, audit_calls)
    findings += detect_duplicate_turns(gens, refs)
    findings += detect_context(gens, refs)
    findings += detect_runaway(gens, refs, len(calls), baseline, detail.get("runtime_kind"))
    findings += detect_blocked(audit_calls, detail.get("egress_blocked") or 0)
    findings = _sort(findings)
    return {
        "findings": findings,
        "counts": counts_of(findings),
        "partial": False,
        "sources": {"calls": source if calls else None, "generations": len(gens)},
    }


# --- cache of full results (the runs list reuses them) ------------------------

_CACHE_MAX = 500
# trace_id -> (key, result). key = (last tool span time, transcript mtime,
# generation count); key[0] is what the runs list can see cheaply.
_cache: "OrderedDict[str, tuple[tuple, dict]]" = OrderedDict()


def _as_key(key: Any) -> tuple:
    if isinstance(key, tuple):
        return tuple(str(k) for k in key)
    return (str(key or ""),)


def remember(trace_id: str, key: Any, result: dict) -> None:
    if not trace_id:
        return
    _cache[trace_id] = (_as_key(key), result)
    _cache.move_to_end(trace_id)
    while len(_cache) > _CACHE_MAX:
        _cache.popitem(last=False)


def cached(trace_id: str, key: Any) -> Optional[dict]:
    """The full result when its key matches exactly, else None."""
    hit = _cache.get(trace_id)
    if hit and hit[0] == _as_key(key):
        return hit[1]
    return None


def cached_any(trace_id: str, last_time: Optional[str]) -> Optional[dict]:
    """For the runs list: the last full result for this run, with
    ``stale`` true when the run has moved on since it was computed (its last
    tool span time differs). Served until recomputed so badges do not vanish
    mid-run."""
    hit = _cache.get(trace_id)
    if not hit:
        return None
    key, result = hit
    return {**result, "stale": key[0] != str(last_time or "")}


def cache_key_of(trace_id: str) -> Optional[tuple]:
    hit = _cache.get(trace_id)
    return hit[0] if hit else None


def recent_runs(runs: list[dict], now, ts_key) -> list[dict]:
    """Runs with activity inside the warm-up window, newest first."""
    out = []
    for r in runs or []:
        if not r.get("trace_id") or not r.get("ended_at"):
            continue
        age = (now - ts_key(r.get("ended_at"))).total_seconds()
        if 0 <= age <= WARM_WINDOW_SECONDS or -60 < age < 0:
            out.append(r)
    out.sort(key=lambda r: ts_key(r.get("ended_at")), reverse=True)
    return out


def select_warm_runs(recent: list[dict], stamps: dict, health_key) -> list[str]:
    """Which recent runs to recompute: those with no full result, or whose
    last tool span time or transcript mtime moved. Capped at WARM_MAX_RUNS."""
    todo = []
    for r in recent:
        tid = r.get("trace_id")
        key = cache_key_of(tid)
        now_key = (str(health_key(r.get("ended_at"))), str(stamps.get(tid) or ""))
        if key is not None and tuple(key[:2]) == now_key:
            continue
        todo.append(tid)
        if len(todo) >= WARM_MAX_RUNS:
            break
    return todo


def clear_cache() -> None:
    _cache.clear()


def median(values: list) -> Optional[float]:
    vals = [float(v) for v in values if isinstance(v, (int, float))]
    return statistics.median(vals) if vals else None
