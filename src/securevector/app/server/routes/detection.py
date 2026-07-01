"""Local agent / harness detection (story: "what's running on this machine").

A read-only probe that answers three questions about the LOCAL device:
  1. Which coding-agent HARNESSES are present (Claude Code, Codex, Copilot CLI,
     Cursor, OpenClaw) — by checking each one's home dir, the same signal the
     per-harness ``/api/hooks/<slug>/status`` endpoints already use.
  2. How many SESSIONS each harness has, and how many are recently ACTIVE — by
     counting the on-disk session transcripts each harness writes (the same dirs
     the token-usage endpoints walk), using file mtime as the activity clock.
  3. Which AGENTS / agentic FRAMEWORKS have actually sent activity — derived from
     ``tool_call_audit.runtime_kind`` via the existing agent-graph repository.

Everything is best-effort: any probe that fails degrades to "not detected" /
zero counts and never raises, so a missing dir or odd permission can't 500 the
page. No process scanning (keeps it dependency-free + cross-platform); "running"
is inferred from recent session-file activity and recent audited tool calls.
"""

from __future__ import annotations

import os
import platform
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

_OS_FRIENDLY = {"Darwin": "macOS", "Linux": "Linux", "Windows": "Windows"}

from fastapi import APIRouter, Query

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.custom_tools import CustomToolsRepository

router = APIRouter()

# A session/harness counts as "active" if it showed activity within this many
# minutes (file mtime for sessions). Tunable via query param.
_DEFAULT_ACTIVE_MINUTES = 30

# Cap how many session files we stat per harness so a huge history dir can't
# stall the event loop. If we hit the cap we still report it (capped=True).
_SESSION_SCAN_CAP = 5000

# Known harness runtime_kind values (audit) — used to split harnesses from
# frameworks in the agent graph. 'copilot' and 'copilot-cli' are the same host.
_HARNESS_RUNTIME_KINDS = {
    "claude-code", "codex", "copilot", "copilot-cli", "cursor", "openclaw",
}
# Frameworks we explicitly recognise (runtime_kind -> display label); anything
# else with activity that isn't a harness is still reported as an "agent".
_FRAMEWORK_LABELS = {"langchain": "LangChain", "langgraph": "LangGraph", "crewai": "CrewAI"}
_KNOWN_FRAMEWORKS = set(_FRAMEWORK_LABELS)


def _home() -> Path:
    return Path(os.path.expanduser("~"))


def _harness_dir(env_var: str, default_rel: str) -> Path:
    """Resolve a harness home dir, honouring its override env var if set."""
    override = os.environ.get(env_var)
    if override:
        return Path(override).expanduser()
    return _home() / default_rel


# Per-harness spec: how to detect presence + where its session transcripts live.
# session_glob is relative to session_root; session_unit='file' counts matching
# files, 'dir' counts immediate sub-dirs (Copilot keeps one dir per session).
_HARNESSES = [
    {
        "slug": "claude-code", "label": "Claude Code",
        "home": lambda: _harness_dir("CLAUDE_HOME", ".claude"),
        "session_root": lambda: _harness_dir("CLAUDE_HOME", ".claude") / "projects",
        "session_glob": "*.jsonl", "session_unit": "file", "recursive": True,
    },
    {
        "slug": "codex", "label": "Codex",
        "home": lambda: _harness_dir("CODEX_HOME", ".codex"),
        "session_root": lambda: _harness_dir("CODEX_HOME", ".codex") / "sessions",
        "session_glob": "rollout-*.jsonl", "session_unit": "file", "recursive": True,
    },
    {
        "slug": "copilot-cli", "label": "GitHub Copilot CLI",
        "home": lambda: _harness_dir("COPILOT_HOME", ".copilot"),
        "session_root": lambda: _harness_dir("COPILOT_HOME", ".copilot") / "session-state",
        "session_glob": "*", "session_unit": "dir", "recursive": False,
    },
    {
        "slug": "cursor", "label": "Cursor",
        "home": lambda: _harness_dir("CURSOR_HOME", ".cursor"),
        "session_root": None,  # plugin-only; no hook-layer session transcripts
        "session_glob": None, "session_unit": None, "recursive": False,
    },
    {
        "slug": "openclaw", "label": "OpenClaw / ClawdBot",
        "home": lambda: _home() / ".openclaw",
        "session_root": None, "session_glob": None, "session_unit": None, "recursive": False,
    },
]


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _parse_ts(value) -> Optional[float]:
    """Parse a DB/ISO timestamp to an epoch (UTC). Tolerant of the audit
    "YYYY-MM-DD HH:MM:SS" form AND ISO "…T…+00:00"; returns None on failure."""
    if not value:
        return None
    s = str(value).strip().replace("T", " ")
    # drop timezone suffix / fractional seconds for the lenient path
    s = s.split("+")[0].split("Z")[0].strip()
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            continue
    return None


def _is_recent(value, cutoff_epoch: float) -> bool:
    """True if the timestamp parses and is at/after the active cutoff."""
    ts = _parse_ts(value)
    return ts is not None and ts >= cutoff_epoch


def _scan_sessions(spec: dict, active_cutoff: float) -> dict:
    """Count session units for a harness + how many are recently active.

    Returns {supported, total, active, last_activity (iso|None), capped}.
    'supported' is False for plugin-only harnesses with no transcript dir.
    """
    if not spec.get("session_root"):
        return {"supported": False, "total": 0, "active": 0, "last_activity": None, "capped": False}

    out = {"supported": True, "total": 0, "active": 0, "last_activity": None, "capped": False}
    try:
        root = spec["session_root"]()
        if not root.exists():
            return out
        unit = spec["session_unit"]
        last_mtime = 0.0
        count = 0

        if unit == "dir":
            # one sub-dir per session; activity = newest file inside it
            for child in root.iterdir():
                if not child.is_dir():
                    continue
                count += 1
                if count > _SESSION_SCAN_CAP:
                    out["capped"] = True
                    break
                m = 0.0
                try:
                    for f in child.iterdir():
                        if f.is_file():
                            m = max(m, f.stat().st_mtime)
                    if m == 0.0:
                        m = child.stat().st_mtime
                except OSError:
                    continue
                last_mtime = max(last_mtime, m)
                if m >= active_cutoff:
                    out["active"] += 1
        else:
            iterator = root.rglob(spec["session_glob"]) if spec["recursive"] else root.glob(spec["session_glob"])
            for f in iterator:
                try:
                    if not f.is_file():
                        continue
                    count += 1
                    if count > _SESSION_SCAN_CAP:
                        out["capped"] = True
                        break
                    m = f.stat().st_mtime
                except OSError:
                    continue
                last_mtime = max(last_mtime, m)
                if m >= active_cutoff:
                    out["active"] += 1

        out["total"] = min(count, _SESSION_SCAN_CAP)
        out["last_activity"] = _iso(last_mtime) if last_mtime > 0 else None
    except Exception:
        # best-effort: never let a disk quirk break the page
        return {"supported": True, "total": 0, "active": 0, "last_activity": None, "capped": False}
    return out


def _normalize_runtime(rk: Optional[str]) -> str:
    rk = (rk or "").strip().lower()
    if rk in ("copilot", "copilot-cli"):
        return "copilot-cli"
    return rk


async def _audited_runtimes(window_days: int) -> dict:
    """Aggregate tool_call_audit by runtime_kind via the agent-graph repo.

    Returns {normalized_runtime_kind: {calls, blocked, last_used}}.
    """
    agg: dict = {}
    try:
        db = get_database()
        repo = CustomToolsRepository(db)
        rows = await repo.get_agent_tool_graph(window_days=window_days)
        for r in rows:
            rk = _normalize_runtime(r.get("runtime_kind"))
            if not rk or rk == "unknown":
                continue
            e = agg.setdefault(rk, {"calls": 0, "blocked": 0, "last_used": None})
            e["calls"] += int(r.get("calls") or 0)
            e["blocked"] += int(r.get("blocked") or 0)
            lu = r.get("last_used")
            if lu and (e["last_used"] is None or str(lu) > str(e["last_used"])):
                e["last_used"] = lu
    except Exception:
        return {}
    return agg


async def _protected_sessions() -> dict:
    """Distinct sessions per runtime_kind that produced audit rows — i.e. ran
    WITH SecureVector Guard active. {normalized_runtime_kind: count}. Best-effort."""
    out: dict = {}
    try:
        db = get_database()
        conn = await db.connect()
        cur = await conn.execute(
            "SELECT runtime_kind, COUNT(DISTINCT session_id) AS n "
            "FROM tool_call_audit WHERE session_id IS NOT NULL AND session_id != '' "
            "GROUP BY runtime_kind"
        )
        for r in await cur.fetchall():
            rk = _normalize_runtime(r["runtime_kind"] if "runtime_kind" in r.keys() else r[0])
            if rk and rk != "unknown":
                out[rk] = out.get(rk, 0) + int(r["n"] if "n" in r.keys() else r[1] or 0)
    except Exception:
        return {}
    return out


@router.get("/detection/agents")
async def detect_agents(
    active_minutes: int = Query(_DEFAULT_ACTIVE_MINUTES, ge=1, le=1440),
    window_days: int = Query(30, ge=1, le=90),
):
    """Detect harnesses, sessions, and active agents/frameworks on this machine.

    Response::

        {
          "scanned_at": "...Z",
          "active_window_minutes": 30,
          "summary": {"harnesses_detected": 2, "harnesses_active": 1,
                       "total_sessions": 57, "active_sessions": 1,
                       "frameworks_active": 1, "agents_active": 0},
          "harnesses": [
            {"slug": "claude-code", "label": "Claude Code", "detected": true,
             "home": "/Users/x/.claude", "status": "active",
             "sessions": {"supported": true, "total": 57, "active": 1,
                           "last_activity": "...Z", "capped": false},
             "plugin_connected": true, "calls": 42, "blocked": 3,
             "last_call": "...Z"}
          ],
          "frameworks": [
            {"runtime_kind": "langchain", "label": "LangChain", "kind": "framework",
             "calls": 12, "blocked": 0, "last_used": "...Z", "active": true}
          ]
        }
    """
    now = datetime.now(timezone.utc).timestamp()
    active_cutoff = now - active_minutes * 60
    audited = await _audited_runtimes(window_days)
    protected = await _protected_sessions()

    harnesses = []
    total_sessions = active_sessions = detected_count = active_count = unprotected_total = 0
    for spec in _HARNESSES:
        try:
            home = spec["home"]()
            detected = home.exists()
        except Exception:
            home, detected = None, False
        sess = _scan_sessions(spec, active_cutoff) if detected else {
            "supported": spec.get("session_root") is not None,
            "total": 0, "active": 0, "last_activity": None, "capped": False,
        }
        audit = audited.get(spec["slug"], {})
        plugin_connected = bool(audit)
        last_call = audit.get("last_used")
        recent_call = _is_recent(last_call, active_cutoff)

        # status precedence: not_installed < installed < idle < active
        if not detected and not plugin_connected:
            status = "not_installed"
        elif sess.get("active", 0) > 0 or recent_call:
            status = "active"
        elif sess.get("total", 0) > 0 or plugin_connected:
            status = "idle"
        else:
            status = "installed"

        if detected or plugin_connected:
            detected_count += 1
        if status == "active":
            active_count += 1
        total_sessions += sess.get("total", 0)
        active_sessions += sess.get("active", 0)

        # Guard coverage: sessions that produced audit rows ran WITH Guard;
        # the rest of the on-disk transcripts ran WITHOUT it. Only meaningful
        # for harnesses that keep session transcripts (sess.supported).
        prot = int(protected.get(spec["slug"], 0))
        if sess.get("supported"):
            prot_clamped = min(prot, sess.get("total", 0))
            unprotected = max(0, sess.get("total", 0) - prot)
            unprotected_total += unprotected
        else:
            prot_clamped = None
            unprotected = None
        # Guard is considered installed when it has produced audit activity
        # (a definitive "it ran here" signal). The UI further refines this with
        # the per-harness /status registry check.
        guard_installed = plugin_connected

        harnesses.append({
            "slug": spec["slug"], "label": spec["label"],
            "detected": detected, "home": str(home) if home else None,
            "status": status, "sessions": sess,
            "plugin_connected": plugin_connected, "guard_installed": guard_installed,
            "protected_sessions": prot_clamped, "unprotected_sessions": unprotected,
            "calls": int(audit.get("calls", 0)), "blocked": int(audit.get("blocked", 0)),
            "last_call": last_call,
        })

    # Frameworks / non-harness agents from the audit trail.
    frameworks = []
    fw_active = agents_active = 0
    for rk, e in sorted(audited.items(), key=lambda kv: kv[1].get("calls", 0), reverse=True):
        if rk in _HARNESS_RUNTIME_KINDS:
            continue
        is_known = rk in _KNOWN_FRAMEWORKS
        active = _is_recent(e.get("last_used"), active_cutoff)
        frameworks.append({
            "runtime_kind": rk,
            "label": _FRAMEWORK_LABELS.get(rk, rk),
            "kind": "framework" if is_known else "agent",
            "calls": e.get("calls", 0), "blocked": e.get("blocked", 0),
            "last_used": e.get("last_used"), "active": active,
        })
        if is_known:
            fw_active += 1 if active else 0
        else:
            agents_active += 1 if active else 0

    return {
        "scanned_at": datetime.now(timezone.utc).isoformat(),
        "os": _OS_FRIENDLY.get(platform.system(), platform.system() or "Unknown"),
        "active_window_minutes": active_minutes,
        "window_days": window_days,
        "summary": {
            "harnesses_detected": detected_count,
            "harnesses_active": active_count,
            "total_sessions": total_sessions,
            "active_sessions": active_sessions,
            "unprotected_sessions": unprotected_total,
            "frameworks": len([f for f in frameworks if f["kind"] == "framework"]),
            "frameworks_active": fw_active,
            "agents": len([f for f in frameworks if f["kind"] == "agent"]),
            "agents_active": agents_active,
        },
        "harnesses": harnesses,
        "frameworks": frameworks,
    }
