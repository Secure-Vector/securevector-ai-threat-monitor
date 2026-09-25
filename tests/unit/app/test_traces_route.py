"""Tests for the Agent Run Trace aggregation (story #142)."""

from __future__ import annotations

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.custom_tools import CustomToolsRepository
from securevector.app.server.routes.traces import _VERDICT, _run_risk


# ---------------- pure helpers ----------------


def test_run_risk():
    assert _run_risk(blocked=1, recent_risk="read") == "red"
    assert _run_risk(0, "admin") == "amber"
    assert _run_risk(0, "read") == "green"
    assert _run_risk(0, None) == "green"


def test_verdict_map():
    assert _VERDICT["block"] == ("blocked", "BLOCKED", "red")
    assert _VERDICT["log_only"] == ("log_only", "LOG", "grey")
    assert _VERDICT["allow"] == ("allow", "ALLOW", "green")


# ---------------- repository (real DB) ----------------


async def _build_db(tmp_path) -> DatabaseConnection:
    db = DatabaseConnection(tmp_path / "test.db")
    await run_migrations(db)
    return db


async def _seed_run(repo, runtime, session, calls):
    """calls = list of (tool_id, action, reason)."""
    for tool_id, action, reason in calls:
        await repo.log_tool_call_audit(
            tool_id, tool_id.split(":")[-1], action,
            reason=reason, runtime_kind=runtime, session_id=session,
        )


@pytest.mark.asyncio
async def test_trace_runs_group_by_session(tmp_path):
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    await _seed_run(repo, "claude-code", "s1", [
        ("srv:read", "allow", None),
        ("srv:read", "allow", None),
        ("srv:web", "block", "data_leakage"),
    ])
    await _seed_run(repo, "codex", "s2", [("srv:read", "allow", None)])

    runs = await repo.get_trace_runs(window_days=7)
    assert len(runs) == 2
    by_session = {r["session_id"]: r for r in runs}
    assert by_session["s1"]["spans"] == 3
    assert by_session["s1"]["blocked"] == 1
    assert by_session["s2"]["spans"] == 1
    # both runs have a derived trace_id
    assert all(r["trace_id"] for r in runs)


@pytest.mark.asyncio
async def test_trace_detection_counts_roll_up(tmp_path):
    """Per-trace threat/secret roll-up for the list cards: distinct flagged
    requests per trace, secret sub-count, dedupe across spans, clean traces
    absent."""
    from securevector.app.database.repositories.threat_intel import (
        ThreatIntelRepository,
    )

    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)
    threats = ThreatIntelRepository(db)

    # Trace s1 (claude-code): a clean call, a secret leak spanning TWO spans
    # (same request_id → must count once), and a plain threat.
    await repo.log_tool_call_audit("srv:read", "read", "allow", runtime_kind="claude-code", session_id="s1", request_id="req-clean")
    await repo.log_tool_call_audit("srv:web", "web", "allow", runtime_kind="claude-code", session_id="s1", request_id="req-secret")
    await repo.log_tool_call_audit("srv:web", "web", "allow", runtime_kind="claude-code", session_id="s1", request_id="req-secret")
    await repo.log_tool_call_audit("srv:exec", "exec", "block", runtime_kind="claude-code", session_id="s1", request_id="req-threat")
    # Trace s2 (codex): clean — no detections at all.
    await repo.log_tool_call_audit("srv:read", "read", "allow", runtime_kind="codex", session_id="s2", request_id="req-s2")

    await threats.create(text="leak", is_threat=True, threat_type="credential_leak", risk_score=90, confidence=0.9,
                         matched_rules=[{"name": "Credential Exfiltration", "severity": "high"}], processing_time_ms=1,
                         store_text=False, request_id="req-secret")
    await threats.create(text="inject", is_threat=True, threat_type="prompt_injection", risk_score=80, confidence=0.8,
                         matched_rules=[{"name": "Prompt Injection", "severity": "high"}], processing_time_ms=1,
                         store_text=False, request_id="req-threat")
    # A non-threat record on the clean request must NOT be counted.
    await threats.create(text="ok", is_threat=False, threat_type=None, risk_score=0, confidence=0.1,
                         matched_rules=[], processing_time_ms=1, store_text=False, request_id="req-clean")

    runs = {r["session_id"]: r for r in await repo.get_trace_runs(window_days=7)}
    counts = await repo.get_trace_detection_counts(window_days=7)
    s1_trace = runs["s1"]["trace_id"]
    s2_trace = runs["s2"]["trace_id"]
    # 2 distinct flagged requests (secret dedup'd across its 2 spans), 1 secret.
    assert counts[s1_trace] == {"detections": 2, "secrets": 1}
    # A trace with no threat records has no entry (card shows no chip).
    assert s2_trace not in counts


@pytest.mark.asyncio
async def test_trace_spans_ordered_with_verdicts(tmp_path):
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    await _seed_run(repo, "claude-code", "s1", [
        ("srv:read", "allow", None),
        ("srv:web", "block", "data_leakage credential"),
        ("srv:log", "log_only", None),
    ])
    from securevector.app.utils.trace_id import derive_trace_id
    tid = derive_trace_id("claude-code", "s1")

    spans = await repo.get_trace_spans(tid)
    assert [s["turn_index"] for s in spans] == [0, 1, 2]
    assert [s["action"] for s in spans] == ["allow", "block", "log_only"]
    # the blocked span carries its reason
    blocked = next(s for s in spans if s["action"] == "block")
    assert "data_leakage" in (blocked["reason"] or "")

    await db.disconnect()


@pytest.mark.asyncio
async def test_run_risk_not_lost_when_high_and_low_risk_coexist(tmp_path):
    """Regression: a high-risk action must surface as amber even when a
    lexicographically-larger but lower-severity action ('read' > 'admin')
    coexists in the same run. The old MAX(risk) returned 'read' → green."""
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)
    await _seed_run(repo, "claude-code", "s1", [
        ("srv:admin_tool", "allow", None),   # high-risk action below
        ("srv:reader", "allow", None),
    ])
    # stamp the risk levels directly (log_tool_call_audit takes risk kwarg)
    await repo.log_tool_call_audit("srv:admin2", "admin2", "allow", risk="admin", runtime_kind="claude-code", session_id="s2")
    await repo.log_tool_call_audit("srv:read2", "read2", "allow", risk="read", runtime_kind="claude-code", session_id="s2")

    runs = {r["session_id"]: r for r in await repo.get_trace_runs(window_days=7)}
    run = runs["s2"]
    assert run["blocked"] == 0
    # the fix: recent_risk reflects the high-risk action, not the lexicographic max
    assert _run_risk(run["blocked"], run["recent_risk"]) == "amber"

    await db.disconnect()


@pytest.mark.asyncio
async def test_orphan_rows_excluded_from_runs(tmp_path):
    """Rows without a session id (NULL trace_id) are not listed as runs."""
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)
    await repo.log_tool_call_audit("srv:x", "x", "allow", runtime_kind="claude-code")  # no session
    runs = await repo.get_trace_runs(window_days=7)
    assert runs == []
    await db.disconnect()


# ---------------- egress denies in the runs list ----------------


def _egress_verdict(host):
    from securevector.core.egress.destinations import EgressAttempt
    from securevector.core.egress.engine import EgressVerdict
    return EgressVerdict(action="block", rule_id="r1", attempt=EgressAttempt(
        host=host, operation="read", kind="http", detector="bash",
        confidence="PARSED", scheme="https", port=443, evidence=""))


@pytest.mark.asyncio
async def test_runs_list_counts_egress_denies_once(tmp_path, monkeypatch):
    from securevector.app.database.repositories.egress import EgressRepository
    from securevector.app.server.routes import traces as traces_mod
    db = await _build_db(tmp_path)
    monkeypatch.setattr(traces_mod, "get_database", lambda: db)
    repo = CustomToolsRepository(db)
    egress = EgressRepository(db)
    # s1: only allowed calls, but one WebFetch refused by egress (two hosts,
    # one call). s2: a tool block and an egress deny. s3: clean.
    await _seed_run(repo, "claude-code", "s1", [("WebFetch", "allow", None), ("Read", "allow", None)])
    await egress.log_attempts([_egress_verdict("evil.example"), _egress_verdict("evil2.example")],
                              tool_name="WebFetch", session_id="s1", request_id="q1")
    await _seed_run(repo, "claude-code", "s2", [("Bash", "block", "rule")])
    await egress.log_attempts([_egress_verdict("x.example")], tool_name="Bash", session_id="s2", request_id="q2")
    await _seed_run(repo, "claude-code", "s3", [("Read", "allow", None)])
    # An egress deny for a session with no run in the list changes nothing.
    await egress.log_attempts([_egress_verdict("y.example")], tool_name="Bash", session_id="s9")

    out = await traces_mod.list_traces(window_days=7, limit=50)
    by = {r["session_id"]: r for r in out["runs"]}
    assert (by["s1"]["blocked"], by["s1"]["egress_blocked"], by["s1"]["risk"]) == (1, 1, "red")
    assert (by["s2"]["blocked"], by["s2"]["egress_blocked"], by["s2"]["risk"]) == (2, 1, "red")
    assert (by["s3"]["blocked"], by["s3"]["egress_blocked"], by["s3"]["risk"]) == (0, 0, "green")

    # The detail keeps them apart, so nothing adds the same refusal twice.
    detail = await traces_mod.get_trace(by["s1"]["trace_id"])
    assert detail["blocked"] == 0
    assert detail["egress_blocked"] == 1
    assert detail["egress_blocks"][0]["hosts"] == ["evil.example", "evil2.example"]


def test_assign_egress_one_run_per_deny():
    from securevector.app.server.routes.traces import _assign_egress, _ts_key
    t = lambda s: _ts_key(f"2026-01-01 10:00:{s:02d}")
    a = {"trace_id": "A", "session_id": "s1", "runtime_kind": None, "start": t(0), "end": t(10)}
    b = {"trace_id": "B", "session_id": "s1", "runtime_kind": None, "start": t(13), "end": t(20)}
    call = lambda s, k: {"session_id": "s1", "runtime_kind": None, "called_at": f"2026-01-01 10:00:{s:02d}", "call_key": k}
    got = _assign_egress([call(5, "in-a"), call(12, "gap"), call(15, "in-b"), call(24, "near-b"), call(59, "far")], [a, b])
    assert got == {("s1", "in-a"): "A", ("s1", "gap"): "B", ("s1", "in-b"): "B", ("s1", "near-b"): "B"}
    # One run in the session: its deny belongs to it even outside the padding.
    assert _assign_egress([call(59, "far")], [a]) == {("s1", "far"): "A"}
    # Another session's runs are never candidates.
    assert _assign_egress([dict(call(5, "x"), session_id="s2")], [a, b]) == {}


@pytest.mark.asyncio
async def test_deny_between_two_runs_counts_once_in_list_and_detail(tmp_path, monkeypatch):
    """Runs A and B of one session string (two runtimes) are 3 s apart; a deny
    in the gap, closer to B, shows once in the list and only in B's detail."""
    from securevector.app.database.repositories.egress import EgressRepository
    from securevector.app.server.routes import traces as traces_mod
    db = await _build_db(tmp_path)
    monkeypatch.setattr(traces_mod, "get_database", lambda: db)
    repo = CustomToolsRepository(db)
    await _seed_run(repo, "claude-code", "s1", [("Read", "allow", None)])
    await _seed_run(repo, "codex", "s1", [("Bash", "allow", None)])
    from datetime import datetime, timezone
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    conn = await db.connect()
    await conn.execute(f"UPDATE tool_call_audit SET called_at = '{day} 00:00:00' WHERE runtime_kind = 'claude-code'")
    await conn.execute(f"UPDATE tool_call_audit SET called_at = '{day} 00:00:03' WHERE runtime_kind = 'codex'")
    await conn.commit()
    await EgressRepository(db).log_attempts([_egress_verdict("evil.example")], tool_name="Bash",
                                            session_id="s1", request_id="q1")
    await conn.execute(f"UPDATE egress_audit SET timestamp = '{day} 00:00:02'")
    await conn.commit()

    out = await traces_mod.list_traces(window_days=90, limit=50)
    runs = {r["runtime_kind"]: r for r in out["runs"] if r["session_id"] == "s1"}
    assert runs["claude-code"]["egress_blocked"] == 0
    assert runs["codex"]["egress_blocked"] == 1
    assert sum(r["egress_blocked"] for r in runs.values()) == 1
    a = await traces_mod.get_trace(runs["claude-code"]["trace_id"])
    b = await traces_mod.get_trace(runs["codex"]["trace_id"])
    assert (a["egress_blocked"], b["egress_blocked"]) == (0, 1)
