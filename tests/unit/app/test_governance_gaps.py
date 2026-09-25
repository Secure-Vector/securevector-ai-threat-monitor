"""Governance from gaps in real activity: GET /api/governance/gaps."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.custom_tools import CustomToolsRepository
from securevector.app.server.routes import governance as gov
from securevector.app.services import governance_gaps as G

KEY = "securevector-guard@securevector-local"
HOOKS = {"hooks": {
    "PreToolUse": [{"matcher": ".*", "hooks": [{"type": "command", "command": "a"}]}],
    "PostToolUse": [{"matcher": ".*", "hooks": [{"type": "command", "command": "b"}]}],
}}


@pytest.fixture(autouse=True)
def _fresh_memo():
    gov.clear_memo()
    yield
    gov.clear_memo()


# --- pure helpers -------------------------------------------------------------------

def test_match_calls_by_name_and_count_skips_ignored_and_boundary():
    names = ["Bash", "Bash", "Bash", "Read", "TodoWrite", "mcp__gh__issue"]
    rows = [{"function_name": "Bash", "tool_id": "Bash"},
            {"function_name": "__session_start__", "tool_id": "__session_start__"},
            {"function_name": "Read", "tool_id": "Read"},
            {"function_name": "issue", "tool_id": "gh:issue"}]
    total, governed, miss = G.match_calls(names, rows)
    assert (total, governed) == (5, 3)
    assert miss == {"Bash": 2}


def test_pct_is_none_without_calls_never_a_fake_100():
    assert G.pct(0, 0) is None
    assert G.pct(3, 4) == 75.0
    # floored to one decimal, never 100 unless every call was checked
    assert G.pct(2, 3) == 66.6
    assert G.pct(1, 3) == 33.3
    assert G.pct(9999, 10000) == 99.9
    assert G.pct(5, 5) == 100.0


def test_codex_trust_trusted_untrusted_and_missing(tmp_path):
    hooks = tmp_path / "hooks.json"
    hooks.write_text(json.dumps(HOOKS))
    expected = G.expected_trust_keys(HOOKS, KEY)
    assert expected == [f"{KEY}:hooks/hooks.json:pre_tool_use:0:0", f"{KEY}:hooks/hooks.json:post_tool_use:0:0"]

    cfg = tmp_path / "config.toml"
    cfg.write_text(
        '[hooks.state]\n'
        f'[hooks.state."{KEY}:hooks/hooks.json:pre_tool_use:0:0"]\n'
        'trusted_hash = "sha256:abc"\n\n'
        f'[hooks.state."{KEY}:hooks/hooks.json:post_tool_use:0:0"]\n'
        'trusted_hash = "sha256:def"\n'
    )
    got = G.codex_hooks_trust(cfg, hooks, KEY)
    assert got["trusted"] is True and got["missing"] == [] and got["config_found"]

    cfg.write_text(
        f'[hooks.state."{KEY}:hooks/hooks.json:pre_tool_use:0:0"]\n'
        'trusted_hash = "sha256:abc"\n'
        '[marketplaces.other]\nsource = "x"\n'
    )
    got = G.codex_hooks_trust(cfg, hooks, KEY)
    assert got["trusted"] is False
    assert got["missing"] == [f"{KEY}:hooks/hooks.json:post_tool_use:0:0"]

    got = G.codex_hooks_trust(tmp_path / "absent.toml", hooks, KEY)
    assert got["trusted"] is False and got["config_found"] is False and len(got["missing"]) == 2

    # inline table form under [hooks.state] also counts
    cfg.write_text('[hooks.state]\n' + "".join(
        f'"{k}" = {{ trusted_hash = "sha256:x" }}\n' for k in expected))
    assert G.codex_hooks_trust(cfg, hooks, KEY)["trusted"] is True

    # unreadable hooks.json: unknown, never a guess
    assert G.codex_hooks_trust(cfg, tmp_path / "nope.json", KEY)["trusted"] is None


# --- coverage math ----------------------------------------------------------------------

def test_compute_coverage_windows_and_unrecorded_by_runtime():
    now = datetime(2026, 9, 25, 12, tzinfo=timezone.utc)
    d = lambda days: now - timedelta(days=days)
    sessions = [("claude-code", "s1"), ("codex", "s2"), ("claude-code", "s3")]
    calls = {
        "s1": [(d(1), ["Bash", "Bash", "Read"]), (d(10), ["Bash"])],
        "s2": [(d(2), ["shell"])],
        "s3": None,  # no transcript
    }
    audit = {
        "s1": [{"function_name": "Bash", "tool_id": "Bash", "called_at": d(1).strftime("%Y-%m-%d %H:%M:%S")},
               {"function_name": "Read", "tool_id": "Read", "called_at": d(1).strftime("%Y-%m-%d %H:%M:%S")},
               {"function_name": "Bash", "tool_id": "Bash", "called_at": d(10).strftime("%Y-%m-%d %H:%M:%S")}],
        "s3": [{"function_name": "Bash", "tool_id": "Bash", "called_at": d(1).strftime("%Y-%m-%d %H:%M:%S")}],
    }
    cur = gov.compute_coverage(sessions, calls, audit, d(7), now)
    assert (cur["governed_calls"], cur["total_calls"], cur["pct"]) == (2, 4, 50.0)
    assert cur["unrecorded"] == {"claude-code": {"Bash": 1}, "codex": {"shell": 1}}
    prev = gov.compute_coverage(sessions, calls, audit, d(14), d(7))
    assert (prev["governed_calls"], prev["total_calls"], prev["pct"]) == (1, 1, 100.0)
    none = gov.compute_coverage([("claude-code", "s3")], calls, audit, d(7), now)
    assert none["pct"] is None and none["sessions_with_transcript"] == 0


# --- route ------------------------------------------------------------------------------

async def _db(tmp_path, monkeypatch):
    db = DatabaseConnection(tmp_path / "t.db")
    await run_migrations(db)
    from securevector.app.server.routes import traces as T
    monkeypatch.setattr(T, "get_database", lambda: db)
    monkeypatch.setattr(gov, "get_database", lambda: db)
    return db


def _transcripts(monkeypatch, by_sid, runtime="claude-code"):
    """Stand-in transcripts: the index lists them, the parser returns them."""
    import time as _t
    from pathlib import Path
    monkeypatch.setattr(gov, "transcript_index", lambda since, now: {
        sid: (runtime, Path(f"/nonexistent/{sid}.jsonl"), _t.time()) for sid in by_sid})
    monkeypatch.setattr(gov, "_session_calls", lambda rt, sid, path: by_sid.get(sid))


def _quiet_sources(monkeypatch, **over):
    async def statuses():
        return over.get("statuses", {})

    async def hosts(_w):
        return over.get("hosts", [])

    async def pending():
        return over.get("pending", 0)

    async def health(_w):
        return over.get("health", {"runs": 0, "failing": 0})

    monkeypatch.setattr(gov, "_plugin_statuses", statuses)
    monkeypatch.setattr(gov, "_egress_uncovered", hosts)
    monkeypatch.setattr(gov, "_pending_approvals", pending)
    monkeypatch.setattr(gov, "_agent_health", health)
    monkeypatch.setattr(gov, "_codex_trust_blocking", lambda: over.get("trust"))


@pytest.mark.asyncio
async def test_route_shape_and_pct_null_without_transcripts(tmp_path, monkeypatch):
    db = await _db(tmp_path, monkeypatch)
    _quiet_sources(monkeypatch)
    repo = CustomToolsRepository(db)
    await repo.log_tool_call_audit("Bash", "Bash", "allow", runtime_kind="claude-code", session_id="s1")
    _transcripts(monkeypatch, {"s1": None})
    out = await gov.governance_gaps(window_days=7)
    assert set(out) == {"window_days", "coverage", "gaps", "partial", "generated_at"}
    assert out["partial"] is False
    assert out["window_days"] == 7
    cov = out["coverage"]
    assert {"governed_calls", "total_calls", "pct", "prev_pct"} <= set(cov)
    assert cov["pct"] is None and cov["prev_pct"] is None and cov["note"]
    assert out["gaps"] == []


@pytest.mark.asyncio
async def test_route_coverage_and_unrecorded_gap(tmp_path, monkeypatch):
    db = await _db(tmp_path, monkeypatch)
    _quiet_sources(monkeypatch)
    repo = CustomToolsRepository(db)
    await repo.log_tool_call_audit("Bash", "Bash", "allow", runtime_kind="claude-code", session_id="s1")
    now = datetime.now(timezone.utc)
    conn = await db.connect()
    await conn.execute("UPDATE schema_version SET applied_at = datetime('now', '-1 day')")
    await conn.commit()
    _transcripts(monkeypatch, {"s1": [(now - timedelta(minutes=1), ["Bash", "Bash", "Edit"])]})
    out = await gov.governance_gaps(window_days=7)
    cov = out["coverage"]
    assert (cov["governed_calls"], cov["total_calls"]) == (1, 3)
    assert cov["pct"] == pytest.approx(33.3)
    [g] = out["gaps"]
    assert g["kind"] == "unrecorded_calls" and g["severity"] == "high" and g["count"] == 2
    # no active Claude Code plugin: the fix says connect it
    assert g["fix"] == {"label": "Connect Claude Code", "route": "guide-claude-code"}
    for k in ("id", "kind", "severity", "title", "detail", "count", "fix"):
        assert k in g


def test_each_gap_kind_only_when_count_positive():
    active = {"installed": True, "auto_installed": True, "enabled": True}
    staged = {"installed": True, "auto_installed": False, "enabled": False}
    none = gov.build_gaps({}, {"claude-code": active, "cursor": {"installed": False}},
                          {"trusted": True, "missing": []}, [], 0, {"runs": 0, "failing": 0}, 7)
    assert none == []

    gaps = gov.build_gaps(
        {"codex": {"shell": 4}},
        {"claude-code": staged, "codex": active},
        {"trusted": False, "missing": ["a", "b"]},
        ["a.example", "b.example", "c.example", "d.example", "e.example", "f.example"],
        2, {"runs": 3, "failing": 1}, 7)
    by = {g["kind"]: g for g in gaps}
    assert set(by) == {"unrecorded_calls", "plugin_not_active", "codex_hooks_untrusted",
                       "egress_uncovered_hosts", "approvals_pending", "agent_health"}
    assert "tools_without_rule" not in by
    assert by["plugin_not_active"]["fix"] == {"label": "Install", "action": "install_plugin:claude-code"}
    assert by["codex_hooks_untrusted"]["severity"] == "high" and "/hooks" in by["codex_hooks_untrusted"]["fix"]["label"]
    assert by["egress_uncovered_hosts"]["severity"] == "warn" and by["egress_uncovered_hosts"]["count"] == 6
    assert "e.example" in by["egress_uncovered_hosts"]["detail"] and "f.example" not in by["egress_uncovered_hosts"]["detail"]
    assert by["egress_uncovered_hosts"]["fix"]["route"] == "egress-policy"
    assert by["approvals_pending"]["severity"] == "info" and by["approvals_pending"]["fix"]["route"] == "terminals"
    assert by["agent_health"]["severity"] == "warn" and by["agent_health"]["fix"]["route"] == "run-health"
    assert [g["severity"] for g in gaps] == sorted([g["severity"] for g in gaps], key={"high": 0, "warn": 1, "info": 2}.get)

    # health with loops only stays info; codex trust only reported when Codex is installed
    gaps = gov.build_gaps({}, {"codex": {"installed": True}}, {"trusted": False, "missing": ["a"]},
                          [], 0, {"runs": 1, "failing": 0}, 7)
    kinds = {g["kind"]: g for g in gaps}
    assert "codex_hooks_untrusted" not in kinds
    assert kinds["agent_health"]["severity"] == "info"


@pytest.mark.asyncio
async def test_codex_trust_checked_only_when_plugin_installed(tmp_path, monkeypatch):
    await _db(tmp_path, monkeypatch)
    calls = []

    def trust():
        calls.append(1)
        return {"trusted": False, "missing": ["k"]}

    _quiet_sources(monkeypatch, statuses={"codex": {"installed": True, "auto_installed": True, "enabled": True}})
    monkeypatch.setattr(gov, "_codex_trust_blocking", trust)
    _transcripts(monkeypatch, {"s1": None})
    out = await gov.compute_gaps(7)
    assert calls == [1]
    assert [g["kind"] for g in out["gaps"]] == ["codex_hooks_untrusted"]

    _quiet_sources(monkeypatch, statuses={})
    monkeypatch.setattr(gov, "_codex_trust_blocking", trust)
    await gov.compute_gaps(7)
    assert calls == [1]


@pytest.mark.asyncio
async def test_response_is_memoised_for_60_seconds(tmp_path, monkeypatch):
    await _db(tmp_path, monkeypatch)
    n = {"calls": 0}

    async def fake(window_days, now=None):
        n["calls"] += 1
        return {"window_days": window_days, "coverage": {}, "gaps": [], "generated_at": str(n["calls"])}

    clock = {"t": 1000.0}
    monkeypatch.setattr(gov, "compute_gaps", fake)
    monkeypatch.setattr(gov.time, "monotonic", lambda: clock["t"])
    a = await gov.governance_gaps(window_days=7)
    clock["t"] += 59
    b = await gov.governance_gaps(window_days=7)
    assert a is b and n["calls"] == 1
    clock["t"] += 2
    c = await gov.governance_gaps(window_days=7)
    assert n["calls"] == 2 and c["generated_at"] == "2"


def test_route_is_registered(monkeypatch):
    from fastapi.testclient import TestClient
    from securevector.app.server.app import create_app

    async def fake(window_days, now=None):
        return {"window_days": window_days, "coverage": {"pct": None}, "gaps": [], "generated_at": "x"}

    monkeypatch.setattr(gov, "compute_gaps", fake)
    res = TestClient(create_app()).get("/api/governance/gaps?window_days=7")
    assert res.status_code == 200
    assert res.json()["window_days"] == 7


@pytest.mark.asyncio
async def test_refresh_bypasses_the_memo(monkeypatch):
    n = {"calls": 0}

    async def fake(window_days, now=None):
        n["calls"] += 1
        return {"window_days": window_days, "coverage": {}, "gaps": [], "generated_at": str(n["calls"])}

    monkeypatch.setattr(gov, "compute_gaps", fake)
    await gov.governance_gaps(window_days=7, refresh=False)
    await gov.governance_gaps(window_days=7, refresh=False)
    assert n["calls"] == 1
    await gov.governance_gaps(window_days=7, refresh=True)
    assert n["calls"] == 2


def test_calls_before_recording_since_are_not_counted_but_unaudited_sessions_are():
    now = datetime(2026, 9, 25, 12, tzinfo=timezone.utc)
    d = lambda days: now - timedelta(days=days)
    since = d(1.5)
    sessions = [("claude-code", "old"), ("claude-code", "bare")]
    calls = {
        # before the wipe: 3 Bash, none audited; after: 1 Bash, audited
        "old": [(d(3), ["Bash", "Bash", "Bash"]), (d(1), ["Bash"])],
        # after recording began, but no audit rows at all: the real gap
        "bare": [(d(0.5), ["Edit", "Edit"])],
    }
    audit = {"old": [{"function_name": "Bash", "tool_id": "Bash", "called_at": d(1).strftime("%Y-%m-%d %H:%M:%S")}]}
    cur = gov.compute_coverage(sessions, calls, audit, d(7), now, since)
    assert (cur["governed_calls"], cur["total_calls"]) == (1, 3)
    assert cur["unrecorded"] == {"claude-code": {"Edit": 2}}
    # without the recording floor the pre-wipe calls would count
    assert gov.compute_coverage(sessions, calls, audit, d(7), now)["total_calls"] == 6


@pytest.mark.asyncio
async def test_recording_since_is_earliest_of_db_creation_and_first_audit_row(tmp_path, monkeypatch):
    db = await _db(tmp_path, monkeypatch)
    conn = await db.connect()
    await conn.execute("UPDATE schema_version SET applied_at = '2026-09-24 19:16:34'")
    await conn.commit()
    since = await gov.recording_since(db)
    assert since == datetime(2026, 9, 24, 19, 16, 34, tzinfo=timezone.utc)
    repo = CustomToolsRepository(db)
    await repo.log_tool_call_audit("Bash", "Bash", "allow", runtime_kind="claude-code", session_id="s1")
    await conn.execute("UPDATE tool_call_audit SET called_at = '2026-09-20 08:00:00'")
    await conn.commit()
    assert await gov.recording_since(db) == datetime(2026, 9, 20, 8, tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_route_reports_recording_since_and_prev_window(tmp_path, monkeypatch):
    db = await _db(tmp_path, monkeypatch)
    _quiet_sources(monkeypatch)
    repo = CustomToolsRepository(db)
    await repo.log_tool_call_audit("Bash", "Bash", "allow", runtime_kind="claude-code", session_id="s1")
    now = datetime.now(timezone.utc)
    _transcripts(monkeypatch, {"s1": [
        (now - timedelta(days=10), ["Bash", "Bash"]), (now - timedelta(minutes=1), ["Bash"])]})
    conn = await db.connect()
    await conn.execute("UPDATE schema_version SET applied_at = datetime('now', '-1 hour')")
    await conn.commit()
    out = await gov.compute_gaps(7)
    cov = out["coverage"]
    # recording began an hour ago, so the older calls are out
    assert (cov["governed_calls"], cov["total_calls"], cov["pct"]) == (1, 1, 100.0)
    assert cov["recording_since"] is not None
    assert cov["prev_pct"] is None and cov["prev_partial"] is False
    assert out["gaps"] == []

    gov.clear_memo()
    await conn.execute("UPDATE schema_version SET applied_at = datetime('now', '-10 days')")
    await conn.commit()
    cov = (await gov.compute_gaps(7))["coverage"]
    assert cov["recording_since"] is None
    assert cov["prev_pct"] == 0.0 and cov["prev_partial"] is True


def test_unrecorded_fix_label_depends_on_the_plugin():
    active = {"claude-code": {"installed": True, "auto_installed": True, "enabled": True}}
    [g] = gov.build_gaps({"claude-code": {"Bash": 2}}, active, None, [], 0, None, 7)
    assert g["fix"]["label"] == "How to connect"
    # not staged at all: still reported, with the connect fix
    [g] = gov.build_gaps({"claude-code": {"Bash": 2}}, {}, None, [], 0, None, 7)
    assert g["fix"] == {"label": "Connect Claude Code", "route": "guide-claude-code"}


def test_claude_coordination_tools_are_ignored_but_agent_counts():
    names = ["SendMessage", "SendMessage", "ListAgents", "ReadNotifications", "Agent", "Task"]
    total, governed, miss = G.match_calls(names, [])
    assert (total, governed) == (2, 0)
    assert miss == {"Agent": 1, "Task": 1}


def test_transcript_index_lists_by_mtime_and_only_window_date_dirs(tmp_path, monkeypatch):
    import os
    claude = tmp_path / "claude"
    codex = tmp_path / "codex"
    monkeypatch.setenv("CLAUDE_HOME", str(claude))
    monkeypatch.setenv("CODEX_HOME", str(codex))
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=7)
    slug = claude / "projects" / "-Users-x-proj"
    slug.mkdir(parents=True)
    (slug / "1111aaaa-bbbb-4ccc-8ddd-eeeeffff1111.jsonl").write_text("{}\n")
    (slug / "agent-a1b2c3.jsonl").write_text("{}\n")  # old subagent file: not a session
    old = slug / "2222aaaa-bbbb-4ccc-8ddd-eeeeffff2222.jsonl"
    old.write_text("{}\n")
    t_old = (now - timedelta(days=20)).timestamp()
    os.utime(old, (t_old, t_old))
    uid = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000"
    day = now - timedelta(days=1)
    d = codex / "sessions" / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}"
    d.mkdir(parents=True)
    (d / f"rollout-2026-09-24T10-00-00-{uid}.jsonl").write_text("{}\n")
    far = codex / "sessions" / "2020" / "01" / "01"
    far.mkdir(parents=True)
    (far / "rollout-2020-01-01T00-00-00-0199aaaa-bbbb-4ccc-8ddd-000000000000.jsonl").write_text("{}\n")
    idx = gov.transcript_index(since, now)
    assert set(idx) == {"1111aaaa-bbbb-4ccc-8ddd-eeeeffff1111", uid}
    assert idx["1111aaaa-bbbb-4ccc-8ddd-eeeeffff1111"][0] == "claude-code" and idx[uid][0] == "codex"


@pytest.mark.asyncio
async def test_session_securevector_never_saw_counts_as_unrecorded(tmp_path, monkeypatch):
    db = await _db(tmp_path, monkeypatch)
    _quiet_sources(monkeypatch)
    conn = await db.connect()
    await conn.execute("UPDATE schema_version SET applied_at = datetime('now', '-3 days')")
    await conn.commit()
    now = datetime.now(timezone.utc)
    # no runs, no audit rows: the plugin was off all week
    _transcripts(monkeypatch, {"ghost": [(now - timedelta(hours=2), ["Bash", "Edit", "Bash"])]})
    out = await gov.compute_gaps(7)
    cov = out["coverage"]
    assert (cov["governed_calls"], cov["total_calls"], cov["pct"]) == (0, 3, 0.0)
    [g] = out["gaps"]
    assert g["kind"] == "unrecorded_calls" and g["count"] == 3
    assert g["fix"]["label"] == "Connect Claude Code"


def test_read_calls_stops_at_the_budget(monkeypatch):
    from pathlib import Path
    monkeypatch.setattr(gov, "_session_calls", lambda rt, sid, path: [])
    entries = [("claude-code", "a", Path("/nonexistent/a")), ("claude-code", "b", Path("/nonexistent/b"))]
    got, pending = gov.read_calls(entries, budget=0)
    assert got == {} and [p[1] for p in pending] == ["a", "b"]
    got, pending = gov.read_calls(entries, budget=5)
    assert set(got) == {"a", "b"} and pending == []


@pytest.mark.asyncio
async def test_partial_answer_warms_the_rest_and_is_memoised_briefly(tmp_path, monkeypatch):
    await _db(tmp_path, monkeypatch)
    _quiet_sources(monkeypatch)
    from pathlib import Path
    monkeypatch.setattr(gov, "transcript_index", lambda since, now: {
        "a": ("claude-code", Path("/nonexistent/a"), 1.0)})
    monkeypatch.setattr(gov, "read_calls", lambda entries: ({}, list(entries)))
    warmed = []
    monkeypatch.setattr(gov, "_warm_rest", lambda pending: warmed.extend(pending))
    clock = {"t": 1000.0}
    monkeypatch.setattr(gov.time, "monotonic", lambda: clock["t"])
    out = await gov.governance_gaps(window_days=7)
    assert out["partial"] is True and out["coverage"]["partial"] is True
    assert [w[1] for w in warmed] == ["a"]
    clock["t"] += 4
    assert await gov.governance_gaps(window_days=7) is out
    clock["t"] += 2
    assert await gov.governance_gaps(window_days=7) is not out


@pytest.mark.asyncio
async def test_recording_since_is_clamped_to_audit_retention(tmp_path, monkeypatch):
    db = await _db(tmp_path, monkeypatch)
    _quiet_sources(monkeypatch)
    _transcripts(monkeypatch, {})
    conn = await db.connect()
    await conn.execute("UPDATE schema_version SET applied_at = datetime('now', '-20 days')")
    await conn.execute("UPDATE app_settings SET retention_days = 2 WHERE id = 1")
    await conn.commit()
    cov = (await gov.compute_gaps(7))["coverage"]
    since = datetime.fromisoformat(cov["recording_since"])
    assert timedelta(days=1.9) < datetime.now(timezone.utc) - since < timedelta(days=2.1)


def test_codex_trust_reader_handles_arrays_multiline_and_bad_bytes(tmp_path):
    hooks = tmp_path / "hooks.json"
    hooks.write_text(json.dumps(HOOKS))
    expected = G.expected_trust_keys(HOOKS, KEY)
    body = "".join(f'[hooks.state."{k}"]\ntrusted_hash = "sha256:x"\n' for k in expected)
    cfg = tmp_path / "config.toml"
    cfg.write_text('notes = """\n[hooks.state."fake"]\n"""\n[[profiles]]\nname = "a"\n' + body)
    assert G.codex_hooks_trust(cfg, hooks, KEY)["trusted"] is True
    # the line scan (no TOML parser) agrees, and ignores the key inside the string
    keys = G._scan_state(cfg.read_text())
    assert keys == set(expected)
    cfg.write_bytes(b"\xff\xfe not utf-8")
    got = G.codex_hooks_trust(cfg, hooks, KEY)
    assert got["trusted"] is False and got["config_found"] is False


def test_memo_lock_is_created_lazily():
    src = open(gov.__file__).read()
    assert "_memo_lock: Optional[asyncio.Lock] = None" in src
    assert "\n_memo_lock = asyncio.Lock()" not in src


def test_toml_state_tolerates_odd_but_valid_shapes():
    assert G._toml_state('hooks = "x"\n') == set()
    assert G._toml_state('[hooks]\nstate = [1, 2]\n') == set()
    assert G._toml_state('[hooks]\nstate = "trusted"\n') == set()
    assert G.trusted_keys('hooks = 3\n') == set()


@pytest.mark.asyncio
async def test_prev_partial_follows_the_parse_budget_not_the_run_cap(tmp_path, monkeypatch):
    db = await _db(tmp_path, monkeypatch)
    _quiet_sources(monkeypatch)
    conn = await db.connect()
    await conn.execute("UPDATE schema_version SET applied_at = datetime('now', '-30 days')")
    await conn.commit()
    now = datetime.now(timezone.utc)
    _transcripts(monkeypatch, {"s1": [(now - timedelta(days=10), ["Bash"]), (now - timedelta(hours=1), ["Bash"])]})
    cov = (await gov.compute_gaps(7))["coverage"]
    assert cov["prev_pct"] == 0.0 and cov["prev_partial"] is False
    # the budget ran out: some sessions unread, so the previous window is partial
    from pathlib import Path
    gov.clear_memo()
    monkeypatch.setattr(gov, "transcript_index", lambda since, now: {
        "s1": ("claude-code", Path("/nonexistent/s1"), 2.0), "s2": ("claude-code", Path("/nonexistent/s2"), 1.0)})
    monkeypatch.setattr(gov, "read_calls", lambda entries: (
        {"s1": [(now - timedelta(days=10), ["Bash"])]}, [e for e in entries if e[1] == "s2"]))
    monkeypatch.setattr(gov, "_warm_rest", lambda pending: None)
    cov = (await gov.compute_gaps(7))["coverage"]
    assert cov["prev_partial"] is True and cov["partial"] is True
    assert "len(runs) >= RUN_CAP" not in open(gov.__file__).read()
