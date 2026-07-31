"""Instant Agent Audit — retroactive scan of agent history already on disk.

The conversion-ux idea "Instant Agent Audit": on first launch (opt-in), scan
the Claude Code / Codex transcripts that already exist on this machine — no
Guard plugin, no config, nothing forwarded — and report what already happened:

- secrets/credentials that appeared in plaintext in past sessions,
- destructive commands that actually ran, matched by a small deterministic
  checklist (no rules engine, no ML — heuristics false-positive too much to
  belong in a first-touch report; see the 2026-07-20 persona review),
- which external MCP servers past sessions talked to,
- the list-price value of the LLM usage, per model and harness.

Everything stays local. The scan reuses the exact pipelines the live product
already trusts: ``transcript_generations`` for LLM turns + cost and
``utils.redaction`` for secret detection. Command findings come only from
shell-executing tools (Bash/shell/exec) — file-edit payloads that merely
*contain* shell-looking text are never flagged.

Privacy contract (stricter than the live pages, since this walks history):
- The report NEVER stores a matched secret — only its type and counts.
- Risky-item previews are secret-redacted and capped at 140 chars.
- The report is a single JSON file in the app data dir; deleting it via the
  API removes every trace of the scan.
- Nothing runs until the user has explicitly consented in the UI; consent is
  recorded (timestamp) so the app never re-asks silently.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from securevector.app.utils.platform import get_app_data_dir
from securevector.app.utils.redaction import redact_secrets

logger = logging.getLogger(__name__)

REPORT_VERSION = 2
REPORT_FILENAME = "instant_audit_report.json"
CONSENT_FILENAME = "instant_audit_consent.json"

# Caps — a years-deep transcript directory must not turn the "60 seconds"
# promise into minutes. Every cap that trips is disclosed in the report
# (scanned.truncated + scanned.caps) — silent truncation would read as
# "covered everything" when it didn't.
MAX_SESSIONS_PER_HARNESS = 300
MAX_CHARS_PER_SESSION = 400_000  # secret-scan budget per transcript
MAX_RISKY_ITEMS = 100            # detailed rows kept in the report
PREVIEW_CAP = 140

# Tools whose input IS an executed command. Only these are checked against
# the destructive-command patterns — an Edit/Write payload that merely
# contains "rm -rf" in file content never ran anything.
_SHELL_TOOL_RE = re.compile(r"(?:^|_)(bash|shell|exec|cmd|terminal|run_command)", re.IGNORECASE)

# Paths where recursive deletes are routine housekeeping, not destruction.
_TEMP_PATH_RE = re.compile(
    r"^(/tmp|/private/tmp|/private/var/folders|/var/folders|/dev/shm)(/|\s|$)")

# The destructive-command checklist. Deterministic on purpose: every pattern
# here describes an action that is destructive or privileged by definition,
# so a match is a fact ("this ran"), not a judgement. severity may be a
# callable(match, command) -> str|None; returning None drops the match
# (used to exempt temp-path deletes).


def _rm_severity(m: re.Match, cmd: str) -> Optional[str]:
    target = (m.group("target") or "").strip().strip("'\"")
    if not target:
        return None
    if target in ("/", "/*", "~", "~/", "$HOME", "$HOME/"):
        return "critical"
    if target.startswith(("~", "$HOME")):
        return "high"
    if target.startswith("/"):
        return None if _TEMP_PATH_RE.match(target) else "high"
    return None  # relative paths (build dirs, node_modules…) are routine


# Command-position anchor: the binary must start the command — beginning of
# input, or right after ; && | ( ` newline or $( — never straight after a
# quote. This is what keeps a JSON test payload like '{"cmd": "rm -rf /"}'
# (data, not execution) out of the report without a full shell lexer.
_CMD = r"(?:^|[;&|(`\n]\s*|\$\(\s*)"

DANGEROUS_PATTERNS: list[dict] = [
    {"id": "recursive_delete", "label": "Recursive delete outside temp paths",
     "severity": _rm_severity,
     "re": re.compile(_CMD + r"rm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:-[a-zA-Z]+\s+)*(?P<target>[^\s;|&]+)")},
    # No quotes allowed before the pipe: a quoted arg means the pipe likely
    # sits inside data (e.g. a POSTed fixture), and real installer one-liners
    # (curl -fsSL https://… | sh) don't quote the URL.
    {"id": "pipe_to_shell", "label": "Remote script piped straight into a shell",
     "severity": "critical",
     "re": re.compile(_CMD + r"(?:curl|wget)\b[^|;\n'\"]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b")},
    {"id": "disk_write", "label": "Raw disk write (dd to a device)",
     "severity": "critical",
     "re": re.compile(_CMD + r"dd\b[^;&|\n]*\bof=/dev/")},
    {"id": "mkfs", "label": "Filesystem format (mkfs)",
     "severity": "critical",
     "re": re.compile(_CMD + r"mkfs(?:\.\w+)?\b")},
    {"id": "keychain_read", "label": "Keychain / credential store read",
     "severity": "high",
     "re": re.compile(_CMD + r"security\s+(?:dump-keychain|find-(?:generic|internet)-password\b[^\n;&|]*\s-w)")},
    # Destructive SQL only counts when a SQL client ran it on the same
    # command — "DROP TABLE" inside an echoed string or a written file is data.
    {"id": "destructive_sql", "label": "Destructive SQL (DROP / TRUNCATE)",
     "severity": "high",
     "re": re.compile(_CMD + r"(?:psql|mysql|mariadb|sqlite3|sqlcmd)\b[^\n;&]*\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b", re.IGNORECASE)},
    # --force-with-lease is the recommended safe variant — not flagged.
    {"id": "force_push", "label": "Git force-push",
     "severity": "high",
     "re": re.compile(_CMD + r"git\s+push\b[^\n;&|]*(?:--force(?!-with-lease)\b|\s-f\b)")},
    {"id": "world_writable", "label": "World-writable permissions (chmod 777)",
     "severity": "medium",
     "re": re.compile(_CMD + r"chmod\s+(?:-[a-zA-Z]+\s+)*0?777\b")},
    {"id": "sudo", "label": "Privileged command (sudo)",
     "severity": "medium",
     "re": re.compile(_CMD + r"sudo\s+\S")},
    {"id": "hard_reset", "label": "Git hard reset / clean",
     "severity": "medium",
     "re": re.compile(_CMD + r"git\s+(?:reset\s+--hard\b|clean\s+-[a-zA-Z]*f)")},
]


def _is_shell_tool(tool: str) -> bool:
    return bool(_SHELL_TOOL_RE.search(tool))


def _check_command(cmd: str) -> list[dict]:
    """All checklist matches for one executed command. Deterministic."""
    out: list[dict] = []
    for pat in DANGEROUS_PATTERNS:
        m = pat["re"].search(cmd)
        if not m:
            continue
        sev = pat["severity"]
        if callable(sev):
            sev = sev(m, cmd)
            if sev is None:
                continue
        out.append({"pattern_id": pat["id"], "label": pat["label"], "severity": sev})
    return out


def _report_path() -> Path:
    return get_app_data_dir() / REPORT_FILENAME


def _consent_path() -> Path:
    return get_app_data_dir() / CONSENT_FILENAME


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class InstantAuditService:
    """One scan at a time; progress + last report readable at any point."""

    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self.progress: dict = {"phase": "idle", "done": 0, "total": 0}

    # ---------------- consent ----------------

    def consented(self) -> Optional[str]:
        """ISO timestamp of consent, or None."""
        try:
            data = json.loads(_consent_path().read_text(encoding="utf-8"))
            ts = data.get("consented_at")
            return ts if isinstance(ts, str) else None
        except (OSError, ValueError):
            return None

    def record_consent(self) -> str:
        ts = _utcnow_iso()
        try:
            _consent_path().write_text(
                json.dumps({"consented_at": ts, "scope": "local-transcript-scan"}),
                encoding="utf-8",
            )
        except OSError as e:
            logger.warning(f"could not persist audit consent: {e}")
        return ts

    # ---------------- report I/O ----------------

    def load_report(self) -> Optional[dict]:
        try:
            return json.loads(_report_path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def delete_report(self) -> bool:
        try:
            _report_path().unlink(missing_ok=True)
            return True
        except OSError as e:
            logger.warning(f"could not delete audit report: {e}")
            return False

    # ---------------- scan orchestration ----------------

    @property
    def running(self) -> bool:
        return bool(self._task and not self._task.done())

    def start(self, db, window_days: int = 90) -> bool:
        """Kick off a background scan. Returns False if one is running."""
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
            _report_path().write_text(json.dumps(report), encoding="utf-8")
            self.progress = {"phase": "done", "done": self.progress.get("total", 0),
                             "total": self.progress.get("total", 0)}
        except Exception as e:  # noqa: BLE001 — a failed scan must report, not hang
            logger.error(f"instant audit scan failed: {e}")
            self.progress = {"phase": "error", "done": 0, "total": 0, "error": str(e)}

    # ---------------- discovery ----------------

    @staticmethod
    def _discover(window_days: int) -> list[tuple[str, str, Path]]:
        """(harness, session_id, path) for transcripts modified in-window,
        newest first, capped per harness."""
        from securevector.app.server.routes.transcript_generations import (
            _claude_projects_dir,
            _codex_sessions_dir,
        )
        cutoff = time.time() - window_days * 86400
        found: list[tuple[float, str, str, Path]] = []
        root = _claude_projects_dir()
        if root.is_dir():
            for p in root.glob("*/*.jsonl"):
                try:
                    mt = p.stat().st_mtime
                except OSError:
                    continue
                if mt >= cutoff:
                    found.append((mt, "claude-code", p.stem, p))
        croot = _codex_sessions_dir()
        if croot.is_dir():
            for p in croot.rglob("rollout-*.jsonl"):
                try:
                    mt = p.stat().st_mtime
                except OSError:
                    continue
                if mt >= cutoff:
                    # rollout-<ISO>-<uuid>.jsonl — the trailing uuid is the id
                    sid = p.stem.split("-", 1)[-1]
                    parts = p.stem.rsplit("-", 5)
                    if len(parts) == 6:
                        sid = "-".join(parts[1:])
                    found.append((mt, "codex", sid, p))
        found.sort(reverse=True)
        out: list[tuple[str, str, Path]] = []
        per: dict[str, int] = {}
        for _mt, kind, sid, p in found:
            if per.get(kind, 0) >= MAX_SESSIONS_PER_HARNESS:
                continue
            per[kind] = per.get(kind, 0) + 1
            out.append((kind, sid, p))
        return out

    # ---------------- the scan ----------------

    async def _scan(self, db, window_days: int) -> dict:
        from securevector.app.database.repositories.costs import CostsRepository
        from securevector.app.server.routes.transcript_generations import (
            apply_cost,
            build_generations,
            build_generations_codex,
        )

        sessions = self._discover(window_days)
        self.progress = {"phase": "scanning", "done": 0, "total": len(sessions)}

        try:
            pricing = await CostsRepository(db).list_pricing()
            price_map = {p.model_id: (p.input_per_million, p.output_per_million) for p in pricing}
        except Exception:  # noqa: BLE001 — no pricing → spend shows unpriced
            price_map = {}

        secrets_by_type: dict[str, int] = {}
        secret_sessions: set[str] = set()
        secrets_total = 0
        risky_items: list[dict] = []
        risky_total = 0
        risky_sessions: set[str] = set()
        risky_by_sev: dict[str, int] = {}
        mcp: dict[str, dict] = {}
        spend_by_model: dict[str, dict] = {}
        spend_by_harness: dict[str, dict] = {}
        unpriced: set[str] = set()
        harness_stats: dict[str, dict] = {}
        period_first: Optional[str] = None
        period_last: Optional[str] = None
        commands_checked = 0
        chars_scanned = 0
        truncated = False

        for kind, sid, path in sessions:
            self.progress["done"] += 1
            await asyncio.sleep(0)  # stay responsive — the app is serving pages
            hs = harness_stats.setdefault(
                kind, {"kind": kind, "sessions": 0, "llm_runs": 0, "tool_calls": 0,
                       "first": None, "last": None})
            hs["sessions"] += 1

            # --- LLM turns + spend (existing pipeline, list price) ---
            try:
                gens = (build_generations_codex(sid, store_text=False) if kind == "codex"
                        else build_generations(sid, store_text=False))
                apply_cost(gens, price_map)
            except Exception:  # noqa: BLE001 — one bad transcript, keep going
                gens = []
            for g in gens:
                hs["llm_runs"] += 1
                ts = g.get("called_at")
                if isinstance(ts, str):
                    period_first = min(period_first, ts) if period_first else ts
                    period_last = max(period_last, ts) if period_last else ts
                    hs["first"] = min(hs["first"], ts) if hs["first"] else ts
                    hs["last"] = max(hs["last"], ts) if hs["last"] else ts
                model = g.get("model") or "unknown"
                if g.get("cost") is None:
                    unpriced.add(model)
                else:
                    m = spend_by_model.setdefault(model, {"model": model, "usd": 0.0, "runs": 0})
                    m["usd"] += g["cost"]
                    m["runs"] += 1
                    h = spend_by_harness.setdefault(kind, {"harness": kind, "usd": 0.0, "runs": 0})
                    h["usd"] += g["cost"]
                    h["runs"] += 1

            # --- tool calls + text: secrets, risky inputs, MCP flows ---
            events = self._session_events(kind, path)
            budget = MAX_CHARS_PER_SESSION
            for ev in events:
                text = ev.get("text") or ""
                tool = ev.get("tool")
                ts = ev.get("ts")
                if tool:
                    hs["tool_calls"] += 1
                    if tool.startswith("mcp__"):
                        server = tool.split("__")[1] if tool.count("__") >= 2 else tool
                        m = mcp.setdefault(server, {"name": server, "calls": 0, "sessions": set()})
                        m["calls"] += 1
                        m["sessions"].add(sid)
                if not text:
                    continue

                # Destructive commands — deterministic checklist, and only on
                # tools that actually EXECUTE their input. No rules engine, no
                # ML: a heuristic false positive in a first-touch report costs
                # more trust than a missed edge case (2026-07-20 persona
                # review). Regex is cheap, so this runs on EVERY shell command
                # — it is not subject to the secret-scan char budget below.
                if tool and _is_shell_tool(tool):
                    commands_checked += 1
                    for hit in _check_command(text[:20_000]):
                        risky_total += 1
                        risky_sessions.add(sid)
                        sev = hit["severity"]
                        risky_by_sev[sev] = risky_by_sev.get(sev, 0) + 1
                        if len(risky_items) < MAX_RISKY_ITEMS:
                            prev, _n = redact_secrets(text[:PREVIEW_CAP * 2],
                                                      direction="outgoing")
                            risky_items.append({
                                "pattern_id": hit["pattern_id"],
                                "label": hit["label"],
                                "severity": sev,
                                "tool": tool,
                                "preview": prev[:PREVIEW_CAP],
                                "harness": kind,
                                "session_id": sid,
                                "called_at": ts,
                            })

                # Secrets — count by type; never store the match. Pattern
                # matching over full transcripts is the expensive part, so
                # this is what the per-session char budget bounds.
                if budget <= 0:
                    truncated = True
                    continue
                snippet = text[:budget]
                budget -= len(snippet)
                chars_scanned += len(snippet)
                hits: list[dict] = []
                try:
                    redact_secrets(snippet, direction="outgoing",
                                   record_event=lambda e: hits.append(e))
                except Exception:  # noqa: BLE001
                    hits = []
                if hits:
                    secrets_total += len(hits)
                    secret_sessions.add(sid)
                    for hval in hits:
                        t = hval.get("secret_type") or hval.get("pattern_id") or "secret"
                        secrets_by_type[t] = secrets_by_type.get(t, 0) + 1

        sev_rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
        risky_items.sort(key=lambda i: (sev_rank.get(i["severity"], 9), i.get("called_at") or ""))
        return {
            "version": REPORT_VERSION,
            "generated_at": _utcnow_iso(),
            "window_days": window_days,
            "scanned": {
                "sessions": {k: v["sessions"] for k, v in harness_stats.items()},
                "sessions_total": len(sessions),
                "commands_checked": commands_checked,
                "chars_scanned": chars_scanned,
                "truncated": truncated,
                "caps": {
                    "sessions_per_harness": MAX_SESSIONS_PER_HARNESS,
                    "chars_per_session": MAX_CHARS_PER_SESSION,
                },
            },
            "period": {"first": period_first, "last": period_last},
            "secrets": {
                "total": secrets_total,
                "sessions_affected": len(secret_sessions),
                "by_type": sorted(
                    ({"type": t, "count": c} for t, c in secrets_by_type.items()),
                    key=lambda x: -x["count"]),
            },
            "risky": {
                "total": risky_total,
                "sessions_affected": len(risky_sessions),
                "by_severity": risky_by_sev,
                "items": risky_items,
                "method": "deterministic-checklist",
                "patterns": len(DANGEROUS_PATTERNS),
            },
            "mcp": {
                "servers": sorted(
                    ({"name": v["name"], "calls": v["calls"], "sessions": len(v["sessions"])}
                     for v in mcp.values()),
                    key=lambda x: -x["calls"]),
                "external_calls_total": sum(v["calls"] for v in mcp.values()),
            },
            "spend": {
                "total_usd": round(sum(m["usd"] for m in spend_by_model.values()), 4),
                "llm_runs": sum(m["runs"] for m in spend_by_model.values()),
                "by_model": sorted(
                    ({**m, "usd": round(m["usd"], 4)} for m in spend_by_model.values()),
                    key=lambda x: -x["usd"]),
                "by_harness": sorted(
                    ({**h, "usd": round(h["usd"], 4)} for h in spend_by_harness.values()),
                    key=lambda x: -x["usd"]),
                "unpriced_models": sorted(unpriced),
            },
            "harnesses": sorted(harness_stats.values(), key=lambda h: -h["sessions"]),
        }

    # ---------------- per-session event extraction ----------------

    @staticmethod
    def _session_events(kind: str, path: Path) -> list[dict]:
        """Flatten one transcript into scannable events.

        Each event: {"tool": name|None, "text": str, "ts": iso|None}. Tool
        events carry the tool's INPUT as text (that's what ran); plain events
        carry message text (scanned for secrets only). Codex rollouts put tool
        calls in ``function_call`` payloads; Claude Code inlines ``tool_use``
        blocks in assistant messages.
        """
        events: list[dict] = []
        try:
            with path.open("r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    if kind == "codex":
                        payload = rec.get("payload") or {}
                        ptype = payload.get("type")
                        ts = rec.get("timestamp")
                        if ptype == "function_call":
                            args = payload.get("arguments")
                            if not isinstance(args, str):
                                try:
                                    args = json.dumps(args)
                                except (TypeError, ValueError):
                                    args = ""
                            events.append({"tool": payload.get("name") or "tool",
                                           "text": args or "", "ts": ts})
                        elif ptype == "message":
                            txt = _codex_payload_text(payload.get("content"))
                            if txt:
                                events.append({"tool": None, "text": txt, "ts": ts})
                        continue
                    # claude-code
                    msg = rec.get("message") or {}
                    content = msg.get("content")
                    ts = rec.get("timestamp")
                    if isinstance(content, str):
                        if content:
                            events.append({"tool": None, "text": content, "ts": ts})
                        continue
                    if not isinstance(content, list):
                        continue
                    for blk in content:
                        if not isinstance(blk, dict):
                            continue
                        btype = blk.get("type")
                        if btype == "tool_use":
                            inp = blk.get("input")
                            if isinstance(inp, dict) and isinstance(inp.get("command"), str):
                                text = inp["command"]
                            else:
                                try:
                                    text = json.dumps(inp)
                                except (TypeError, ValueError):
                                    text = ""
                            events.append({"tool": blk.get("name") or "tool",
                                           "text": text or "", "ts": ts})
                        elif btype == "text":
                            t = blk.get("text")
                            if isinstance(t, str) and t:
                                events.append({"tool": None, "text": t, "ts": ts})
                        elif btype == "tool_result":
                            c = blk.get("content")
                            if isinstance(c, list):
                                c = "\n".join(b.get("text", "") for b in c
                                              if isinstance(b, dict) and b.get("type") == "text")
                            if isinstance(c, str) and c:
                                events.append({"tool": None, "text": c, "ts": ts})
        except OSError:
            return events
        return events


def _codex_payload_text(content) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        b.get("text", "") for b in content
        if isinstance(b, dict) and b.get("type") in ("output_text", "input_text", "text"))


_service: Optional[InstantAuditService] = None


def get_instant_audit_service() -> InstantAuditService:
    global _service
    if _service is None:
        _service = InstantAuditService()
    return _service
