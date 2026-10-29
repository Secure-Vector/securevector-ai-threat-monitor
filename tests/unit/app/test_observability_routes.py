"""Observability read routes: coverage table, per-run decision counts, one
session's governance summary and the Live grid of running sessions."""

from __future__ import annotations

import asyncio
import sqlite3
import time
from datetime import datetime, timedelta, timezone

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.server.routes import observability as obs_routes
from securevector.app.server.routes import traces as traces_routes
from securevector.app.services import harness_coverage, observability, session_drift
from securevector.app.terminals.auth import HEADER
from securevector.app.terminals.store import RUNTIME_TO_EXECUTOR
from tests.unit.app.terminals.test_routes import AUTH, ORIGIN, env  # noqa: F401 - fixture

BASE = "/api/terminals/observability"


def _ts(seconds_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)).strftime("%Y-%m-%d %H:%M:%S")


class Seed:
    """Raw inserts, so each test states exactly the rows it reads."""

    def __init__(self, path):
        self.raw = sqlite3.connect(path)
        self.n = 0

    def call(self, sid, action="allow", ago=30, rk="claude-code", tool="Bash", args=None, trace=None):
        self.n += 1
        self.raw.execute(
            "INSERT INTO tool_call_audit (tool_id, function_name, action, reason, args_preview, called_at, "
            "seq, row_hash, runtime_kind, session_id, trace_id, span_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (tool, tool, action, "Denied by rule" if action == "block" else None, args, _ts(ago),
             self.n, f"h{self.n}", rk, sid, trace or f"tr-{sid}", f"sp{self.n}"),
        )

    def request(self, sid, *, ago=30, source="local", status="pending", tool="Bash", trace=None, rid=None,
                preview=None):
        self.n += 1
        rid = rid or f"rq{self.n}"
        self.raw.execute(
            "INSERT INTO jit_access_requests (id, tool_id, runtime_kind, session_id, trace_id, rule_source, "
            "requested_at, status, call_preview) VALUES (?, ?, 'claude-code', ?, ?, ?, ?, ?, ?)",
            (rid, tool, sid, trace, source, _ts(ago), status, preview),
        )
        return rid

    def grant(self, sid, rid, *, duration="session", fingerprint=None, used=False, tool="Bash"):
        self.n += 1
        self.raw.execute(
            "INSERT INTO jit_access_grants (id, request_id, tool_id, runtime_kind, session_id, duration, "
            "expires_at, revoked_at, call_fingerprint, used_at) VALUES (?, ?, ?, 'claude-code', ?, ?, ?, ?, ?, ?)",
            (f"g{self.n}", rid, tool, sid, duration, _ts(-3600),
             _ts(5) if used else None, fingerprint, _ts(5) if used else None),
        )

    def egress(self, sid, host, action="allow", ago=30, rk="claude-code", request_id=None):
        self.raw.execute(
            "INSERT INTO egress_audit (timestamp, host, operation, kind, action, rule_id, severity, confidence, "
            "detector, tool_name, runtime_kind, session_id, request_id) "
            "VALUES (?, ?, 'read', 'http', ?, ?, 'low', 'high', 'test', 'WebFetch', ?, ?, ?)",
            (_ts(ago), host, action, "sv.block.x" if action == "block" else None, rk, sid, request_id),
        )

    def cost(self, sid, usd, tokens, ago=30, rk="claude-code", model="m-1"):
        self.n += 1
        self.raw.execute(
            "INSERT INTO llm_cost_records (agent_id, provider, model_id, input_tokens, output_tokens, "
            "input_cost_usd, output_cost_usd, total_cost_usd, recorded_at, session_id, trace_id, runtime_kind) "
            "VALUES ('a', 'p', ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)",
            (model, tokens, usd, _ts(ago), sid, f"tr-{sid}", rk),
        )

    def task(self, tid, sid, ws, status="working", executor="claude-code"):
        self.raw.execute(
            "INSERT INTO terminal_tasks (id, executor_id, workspace, status, session_id) VALUES (?, ?, ?, ?, ?)",
            (tid, executor, ws, status, sid),
        )

    def drift(self, sid, score):
        self.raw.execute(
            "INSERT INTO session_drift (session_id, harness, score, band, status, computed_at) "
            "VALUES (?, 'claude-code', ?, 'high', 'scored', ?)",
            (sid, score, datetime.now(timezone.utc).isoformat()),
        )

    def done(self):
        self.raw.commit()
        self.raw.close()


@pytest.fixture
def obs(env, monkeypatch):  # noqa: F811
    client, manager, ws, db = env
    client.app.include_router(obs_routes.router, prefix="/api")

    async def fake_score(session_id, *, db=None, task=None, store=True):
        return session_drift.DriftResult(42, "watch", "scored", [], True, "now")

    monkeypatch.setattr(session_drift, "score_for", fake_score)
    return client, ws, db


# ---------------------------------------------------------------- coverage


def test_every_terminal_runtime_has_a_coverage_entry():
    for kind in RUNTIME_TO_EXECUTOR:
        assert kind in harness_coverage.COVERAGE, kind
    for kind, entry in harness_coverage.table().items():
        assert entry["enforced"] in ("before_call", "after_call", "none")
        for key in ("egress_visible", "token_data", "session_id_sent", "approvals"):
            assert isinstance(entry[key], bool), (kind, key)
        assert isinstance(entry["unchecked"], list)
        assert entry["level"] in ("full", "partial", "not_enforced")
        assert "\u2014" not in entry["label"]


def test_coverage_values_and_labels():
    oc = harness_coverage.coverage("openclaw")
    assert oc["approvals"] is False and harness_coverage.NO_APPROVALS in oc["unchecked"]
    assert harness_coverage.label("openclaw") == "not enforced · recorded after the call"
    n = len(harness_coverage.COVERAGE["claude-code"]["unchecked"])
    assert harness_coverage.label("claude-code") == f"partial · {n} paths not checked"
    unknown = harness_coverage.coverage("something-else")
    assert unknown["enforced"] == "none" and unknown["level"] == "not_enforced"
    tokens = {k for k, v in harness_coverage.COVERAGE.items() if v["token_data"]}
    assert {"claude-code", "codex"} <= tokens


@pytest.mark.parametrize("path", ["/coverage", "/live", "/sessions/sa/governance"])
def test_observability_routes_need_the_token(obs, path):
    client, _ws, db = obs
    s = Seed(db.db_path)
    s.call("sa")
    s.done()
    bare = client.__class__(client.app, base_url=ORIGIN)
    assert bare.get(f"{BASE}{path}", headers={HEADER: "1"}).status_code == 403
    assert client.get(f"{BASE}{path}").status_code == 403
    assert client.get(f"{BASE}{path}", headers=AUTH).status_code == 200


def test_coverage_route_returns_the_table(obs):
    client, _ws, _db = obs
    r = client.get(f"{BASE}/coverage", headers=AUTH)
    assert r.status_code == 200
    assert set(r.json()["runtimes"]) >= set(RUNTIME_TO_EXECUTOR)


# ------------------------------------------------------- run decision counts


def test_traces_carry_allowed_waiting_and_oldest_expiry(tmp_path, monkeypatch):
    db = DatabaseConnection(tmp_path / "tr.db")
    asyncio.run(run_migrations(db))
    s = Seed(db.db_path)
    for _ in range(3):
        s.call("s1", "allow")
    s.call("s1", "allow", tool="__session_start__")
    s.call("s1", "block")
    s.call("s1", "log_only")
    s.request("s1", ago=60, source="rung", trace="tr-s1")       # hold, expires in 4 minutes
    s.request("s1", ago=30, trace=None)                          # session-level request
    s.request("s1", ago=10, source="delegate")                   # not a held call
    s.request("s1", ago=900, source="rung", trace="tr-s1")       # lapsed hold, expired on read
    s.request("s2", ago=10, trace="tr-s2")
    s.done()
    monkeypatch.setattr(traces_routes, "get_database", lambda: db)
    try:
        runs = asyncio.run(traces_routes._collect_runs(7, 50))
        run = next(r for r in runs if r["session_id"] == "s1")
        assert run["allowed"] == 3
        assert run["blocked"] == 1 and run["log_only"] == 1
        assert run["waiting"] == 2
        exp = observability.parse_ts(run["oldest_waiting_expires_at"])
        left = (exp - datetime.now(timezone.utc)).total_seconds()
        assert 200 < left < 260
        lapsed = asyncio.run(db.fetch_one(
            "SELECT COUNT(*) AS n FROM jit_access_requests WHERE status = 'pending' AND rule_source = 'rung'"))
        assert lapsed["n"] == 1
    finally:
        asyncio.run(db.disconnect())


def test_a_request_without_a_trace_is_counted_on_one_run_only(tmp_path, monkeypatch):
    db = DatabaseConnection(tmp_path / "tr3.db")
    asyncio.run(run_migrations(db))
    s = Seed(db.db_path)
    s.call("s1", ago=500, trace="run-a")
    s.call("s1", ago=400, trace="run-a")
    s.call("s1", ago=300, trace="run-b")
    s.call("s1", ago=200, trace="run-b")
    s.call("s1", ago=100, trace="run-c")
    s.call("s1", ago=50, trace="run-c")
    s.request("s1", ago=250, trace=None)        # inside run-b's window
    s.request("s2", ago=20, trace=None)
    s.call("s2", ago=900, trace="run-d")         # outside every window: newest run
    s.call("s2", ago=800, trace="run-e")
    s.done()
    monkeypatch.setattr(traces_routes, "get_database", lambda: db)
    try:
        runs = {r["trace_id"]: r for r in asyncio.run(traces_routes._collect_runs(7, 50))}
        assert {k: runs[k]["waiting"] for k in ("run-a", "run-b", "run-c")} == {"run-a": 0, "run-b": 1, "run-c": 0}
        assert runs["run-b"]["oldest_waiting_expires_at"]
        assert runs["run-a"]["oldest_waiting_expires_at"] is None
        assert (runs["run-d"]["waiting"], runs["run-e"]["waiting"]) == (0, 1)
    finally:
        asyncio.run(db.disconnect())


# ------------------------------------------------------- session governance


def test_a_denied_call_with_a_request_is_one_call_in_the_summary_and_live(obs):
    client, _ws, db = obs
    s = Seed(db.db_path)
    s.call("rq", "allow", ago=40)
    s.call("rq", "block", ago=30, tool="Bash")
    s.request("rq", ago=29, tool="Bash")                         # the same denied call
    s.request("rq", ago=5, tool="Write")                         # no block row: its own call
    s.done()
    want = {"total": 3, "allowed": 1, "logged": 0, "waiting": 2, "blocked": 1}
    assert client.get(f"{BASE}/sessions/rq/governance", headers=AUTH).json()["tool_calls"] == want
    live = {x["session_id"]: x for x in client.get(f"{BASE}/live", headers=AUTH).json()["sessions"]}
    assert live["rq"]["tool_calls"] == want


def test_egress_denies_outside_any_run_count_the_same_in_summary_and_live(obs):
    client, _ws, db = obs
    s = Seed(db.db_path)
    s.egress("eo", "x.example", "block", ago=20, request_id="c1")
    s.egress("eo", "y.example", "block", ago=10, request_id="c2")
    s.done()
    body = client.get(f"{BASE}/sessions/eo/governance", headers=AUTH).json()
    assert body["tool_calls"]["blocked"] == 2
    assert {b["args_preview"] for b in body["blocked_calls"]} == {"x.example", "y.example"}
    assert all(b["trace_id"] is None for b in body["blocked_calls"])
    live = {x["session_id"]: x for x in client.get(f"{BASE}/live", headers=AUTH).json()["sessions"]}
    assert live["eo"]["blocked"] == 2


def test_migration_v66_adds_the_time_indexes_and_is_idempotent(tmp_path):
    from securevector.app.database.migrations import migrate_to_v66
    from securevector.app.database.models import CURRENT_SCHEMA_VERSION

    db = DatabaseConnection(tmp_path / "m.db")
    try:
        asyncio.run(run_migrations(db))
        raw = sqlite3.connect(db.db_path)
        raw.execute("DROP INDEX idx_tool_call_audit_called_at")
        raw.execute("DROP INDEX idx_cost_records_recorded_at")
        raw.commit()
        raw.close()
        asyncio.run(migrate_to_v66(db))
        asyncio.run(migrate_to_v66(db))
        names = {r["name"] for r in asyncio.run(db.fetch_all(
            "SELECT name FROM sqlite_master WHERE type = 'index'"))}
        assert {"idx_tool_call_audit_called_at", "idx_cost_records_recorded_at"} <= names
        v = asyncio.run(db.fetch_one("SELECT MAX(version) AS v FROM schema_version"))
        assert v["v"] == CURRENT_SCHEMA_VERSION == 67
        plan = asyncio.run(db.fetch_all(
            "EXPLAIN QUERY PLAN SELECT session_id FROM tool_call_audit WHERE called_at >= '2026-01-01' "
            "AND session_id IS NOT NULL UNION SELECT session_id FROM llm_cost_records "
            "WHERE recorded_at >= '2026-01-01' AND session_id IS NOT NULL"))
        plan = " ".join(str(tuple(r)) for r in plan)
        assert "idx_tool_call_audit_called_at" in plan and "idx_cost_records_recorded_at" in plan
    finally:
        asyncio.run(db.disconnect())


def test_governance_summary_shape_counts_and_repeats(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    s.task("t1", "sa", ws)
    s.call("sa", "allow", ago=400)
    s.call("sa", "log_only", ago=390)
    s.call("sa", "block", ago=300, args="rm -rf /a")
    s.call("sa", "block", ago=270, args="curl evil.example")    # different target, 30 s later
    s.call("sa", "block", ago=260, args="curl evil.example")    # same target again
    s.call("sa", "block", ago=60, args="cat ~/.ssh/id_rsa")     # 200 s later
    s.egress("sa", "ok.example", "allow", ago=200)
    s.egress("sa", "bad.example", "block", ago=250, request_id="eg1")
    s.request("sa", ago=20, tool="egress:wait.example")
    s.request("sa", ago=10, source="rung", preview="git push")
    s.cost("sa", 0.25, 1000, model="m-1")
    s.cost("sa", 0.5, 500, model="m-2")
    s.done()

    r = client.get(f"{BASE}/sessions/sa/governance", headers=AUTH)
    assert r.status_code == 200, r.text
    body = r.json()
    for key in ("harness", "project", "host", "user", "started_at", "last_activity_at", "runs", "tool_calls",
                "blocked_calls", "egress", "cost", "findings", "score", "coverage", "approvals"):
        assert key in body, key
    assert body["harness"] == "claude-code"
    assert body["project"] == "proj"
    assert body["runs"] == {"count": 1, "trace_ids": ["tr-sa"]}
    # The rung request for Bash 10 s ago is the call blocked 50 s before it:
    # waiting and blocked both show it, the total counts it once.
    assert body["tool_calls"] == {"total": 8, "allowed": 1, "logged": 1, "waiting": 2, "blocked": 5}
    assert body["cost"]["usd"] == 0.75 and body["cost"]["tokens"] == 1500
    assert sorted(body["cost"]["models"]) == ["m-1", "m-2"]
    hosts = {h["host"]: h for h in body["egress"]["hosts"]}
    assert hosts["ok.example"]["status"] == "allowed"
    assert hosts["bad.example"]["status"] == "blocked"
    assert hosts["wait.example"]["status"] == "waiting"
    assert body["egress"]["visible"] is True

    by_args = {(b["kind"], b["args_preview"], b["called_at"]): b for b in body["blocked_calls"]}
    calls = sorted(body["blocked_calls"], key=lambda b: b["called_at"])
    flags = [(b["args_preview"], b["repeat_attempt"]) for b in calls]
    assert flags == [
        ("rm -rf /a", False),            # first block in the session
        ("curl evil.example", True),     # 30 s later, other target
        ("curl evil.example", False),    # same target, not a new route
        ("bad.example", True),           # refused destination 10 s later
        ("cat ~/.ssh/id_rsa", False),    # 190 s gap
    ]
    assert len(by_args) == 5
    assert all(b["trace_id"] for b in body["blocked_calls"])
    pend = body["approvals"]["pending"]
    assert {p["kind"] for p in pend} == {"hold", "request"}
    assert all(p["expires_at"] for p in pend)


def test_governance_unknown_and_invalid_session(obs):
    client, _ws, _db = obs
    assert client.get(f"{BASE}/sessions/nope/governance", headers=AUTH).status_code == 404
    assert client.get(f"{BASE}/sessions/bad%20id/governance", headers=AUTH).status_code == 400


def test_score_is_null_when_the_harness_is_not_enforced_before_the_call(obs):
    client, _ws, db = obs
    s = Seed(db.db_path)
    s.call("s-oc", "allow", rk="openclaw")
    s.call("s-cc", "allow", rk="claude-code")
    s.done()
    oc = client.get(f"{BASE}/sessions/s-oc/governance", headers=AUTH).json()
    assert oc["score"] is None
    assert oc["coverage"]["enforced"] == "after_call"
    assert oc["coverage"]["approvals"] is False
    cc = client.get(f"{BASE}/sessions/s-cc/governance", headers=AUTH).json()
    assert cc["score"] == {"score": 42, "band": "watch", "status": "scored"}


def test_session_approvals_never_cross_sessions(obs):
    client, _ws, db = obs
    s = Seed(db.db_path)
    s.call("A", "allow")
    s.call("B", "allow")
    ra = s.request("A", status="approved", preview="npm test")
    s.grant("A", ra, fingerprint="fp1")                          # unspent once grant
    rb = s.request("A", status="approved", preview="npm publish")
    s.grant("A", rb, fingerprint="fp2", used=True)               # spent once grant
    rc = s.request("A", status="approved")
    s.grant("A", rc, duration="1h")
    rd = s.request("B", status="approved", tool="Write")
    s.grant("B", rd, duration="session", tool="Write")
    s.request("A", ago=5)
    s.done()

    a = client.get(f"{BASE}/sessions/A/governance", headers=AUTH).json()["approvals"]
    b = client.get(f"{BASE}/sessions/B/governance", headers=AUTH).json()["approvals"]
    assert [g["tool_id"] for g in b["grants"]] == ["Write"]
    assert b["pending"] == []
    assert "Write" not in [g["tool_id"] for g in a["grants"]]
    assert len(a["grants"]) == 3 and len(a["pending"]) == 1
    once = {g["call_preview"]: g for g in a["grants"] if g["duration"] == "once"}
    assert once["npm test"]["state"] == "active"
    assert once["npm publish"]["state"] == "used"
    hour = next(g for g in a["grants"] if g["duration"] == "1h")
    assert hour["call_preview"] is None


# ---------------------------------------------------------------- live grid


def test_governance_and_live_show_the_same_stored_score(obs):
    """The summary reads the stored drift row the Live grid reads; it only
    recomputes (fake_score gives 42) when no row is stored."""
    client, _ws, db = obs
    s = Seed(db.db_path)
    s.call("s-st", "allow", ago=20)
    s.drift("s-st", 71)
    s.call("s-none", "allow", ago=20)
    s.done()
    gov = client.get(f"{BASE}/sessions/s-st/governance", headers=AUTH).json()
    live = {x["session_id"]: x for x in client.get(f"{BASE}/live", headers=AUTH).json()["sessions"]}
    assert gov["score"]["score"] == 71 == live["s-st"]["score"]
    assert gov["score"]["band"] == "high"
    none = client.get(f"{BASE}/sessions/s-none/governance", headers=AUTH).json()
    assert none["score"]["score"] == 42 and live["s-none"]["score"] is None


def _seed_live(db, ws):
    s = Seed(db.db_path)
    s.call("w-new", ago=20)
    s.request("w-new", ago=60, source="rung")
    s.call("w-old", ago=200)
    s.request("w-old", ago=120, source="rung")
    s.call("blk", ago=10)
    s.call("blk", "block", ago=10)
    s.call("hi", ago=40)
    s.drift("hi", 80)
    s.call("lo", ago=15)
    s.drift("lo", 20)
    s.call("quiet", ago=420, rk="codex")
    s.call("oc", ago=5, rk="openclaw")
    s.drift("oc", 95)                                             # not shown: not enforced
    s.call("gone", ago=3600)                                      # not running
    s.task("t-run", "idle-task", ws, status="idle")               # running task, no recent rows
    s.call("idle-task", ago=3000)
    s.cost("lo", 1.5, 2000)
    s.done()


def test_live_lists_running_sessions_in_triage_order(obs):
    client, ws, db = obs
    _seed_live(db, ws)
    r = client.get(f"{BASE}/live", headers=AUTH)
    assert r.status_code == 200, r.text
    body = r.json()
    ids = [x["session_id"] for x in body["sessions"]]
    assert "gone" not in ids and "idle-task" in ids
    assert ids[:4] == ["w-old", "w-new", "blk", "hi"]
    assert ids[4:] == ["lo", "oc", "quiet", "idle-task"]  # then no score, newest activity first
    by = {x["session_id"]: x for x in body["sessions"]}
    assert by["oc"]["score"] is None
    assert by["oc"]["coverage"] == "not enforced · recorded after the call"
    assert by["w-old"]["waiting"] == 1 and by["w-old"]["oldest_waiting_expires_at"]
    assert by["blk"]["tool_calls"] == {"total": 2, "allowed": 1, "logged": 0, "waiting": 0, "blocked": 1}
    assert by["idle-task"]["project"] == "proj"
    c = body["counters"]
    assert c["running"] == 8 and c["waiting"] == 2 and c["blocked_sessions"] == 1
    assert c["score_70_plus"] == 1
    # Quiet from two minutes: w-old (200 s), quiet (420 s) and idle-task.
    assert c["quiet"] == 3 and c["quiet_over_5m"] == 3
    assert c["cost_usd"] == 1.5 and c["tokens"] == 2000
    assert c["coverage_not_enforced"] == 1 and c["coverage_partial"] == 7
    assert "groups" not in body


def _live(client):
    body = client.get(f"{BASE}/live", headers=AUTH).json()
    return body, {x["session_id"]: x for x in body["sessions"]}


def test_an_end_marker_ends_the_session_at_once(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    s.call("run1", ago=40)
    s.call("run1", "log_only", ago=30, tool="__session_end__")
    s.call("live1", ago=40)
    s.done()
    body, by = _live(client)
    assert by["run1"]["ended"] is True
    assert by["run1"]["ended_at"] == observability.iso(_ts(30))
    assert by["live1"]["ended"] is False
    c = body["counters"]
    assert c["running"] == 1 and c["ended"] == 1
    assert c["running"] == sum(1 for x in body["sessions"] if not x["ended"])


def test_activity_after_the_end_marker_reopens_the_session(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    s.call("res", ago=90)
    s.call("res", "log_only", ago=60, tool="__session_end__")
    s.call("res", ago=20)
    s.call("res2", ago=90)
    s.call("res2", "log_only", ago=60, tool="__session_end__")
    s.call("res2", "log_only", ago=10, tool="__session_start__")
    s.cost("res3", 0.1, 10, ago=90)
    s.call("res3", "log_only", ago=60, tool="__session_end__")
    s.cost("res3", 0.1, 10, ago=5)
    s.done()
    body, by = _live(client)
    assert all(by[x]["ended"] is False for x in ("res", "res2", "res3"))
    assert body["counters"]["running"] == 3 and body["counters"]["ended"] == 0


def test_a_turn_marker_never_ends_the_session(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    s.call("turns", ago=40)
    s.call("turns", "log_only", ago=30, tool="__turn_end__")
    s.call("both", ago=60)
    s.call("both", "log_only", ago=50, tool="__session_end__")
    s.call("both", "log_only", ago=10, tool="__turn_end__")    # not activity: still ended
    s.done()
    body, by = _live(client)
    assert by["turns"]["ended"] is False
    # A turn marker is a boundary, never a call.
    assert by["turns"]["tool_calls"]["total"] == 1 and by["turns"]["tool_calls"]["logged"] == 0
    assert by["turns"]["last_call"]["tool_id"] == "Bash"
    assert by["both"]["ended"] is True
    assert body["counters"]["running"] == 1 and body["counters"]["ended"] == 1


def test_a_row_landing_just_after_the_end_marker_does_not_reopen(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    s.call("late", ago=40)
    s.call("late", "log_only", ago=30, tool="__session_end__")
    s.call("late", ago=28)                  # PostToolUse landing after SessionEnd
    s.call("back", "log_only", ago=30, tool="__session_end__")
    s.call("back", ago=20)                  # 10 s later: a resumed session
    s.done()
    body, by = _live(client)
    assert by["late"]["ended"] is True and by["late"]["ended_at"] == observability.iso(_ts(30))
    assert by["back"]["ended"] is False


def test_a_running_terminal_task_stays_live_with_an_end_marker(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    s.task("t-held", "held", ws, status="idle")
    s.call("held", ago=40)
    s.call("held", "log_only", ago=30, tool="__session_end__")
    s.done()
    body, by = _live(client)
    assert by["held"]["ended"] is False
    assert body["counters"]["running"] == 1


def test_turn_markers_are_not_activity_for_quiet_or_the_ten_minute_rule(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    s.call("thinking", ago=200)
    s.call("thinking", "log_only", ago=5, tool="__turn_end__")
    s.call("stale", ago=700)
    s.call("stale", "log_only", ago=10, tool="__turn_end__")
    s.done()
    body, by = _live(client)
    assert by["thinking"]["quiet_seconds"] >= 200 and by["thinking"]["ended"] is False
    assert by["stale"]["ended"] is True
    assert body["counters"]["quiet"] == 1


def test_a_call_waiting_for_approval_keeps_an_ended_session_live(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    s.call("wt", ago=40)
    s.call("wt", "log_only", ago=30, tool="__session_end__")
    s.request("wt", ago=35, source="rung")
    s.done()
    body, by = _live(client)
    assert by["wt"]["ended"] is False and by["wt"]["waiting"] == 1
    assert body["counters"]["running"] == 1 and body["counters"]["waiting"] == 1


def test_counters_and_rollups_agree_on_ended_sessions(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    s.call("a", ago=10)
    s.call("b", ago=50)
    s.call("b", "log_only", ago=45, tool="__session_end__")
    s.call("c", ago=700)                    # no marker: ended by the ten-minute rule
    s.done()
    body, by = _live(client)
    assert [k for k in ("a", "b", "c") if by[k]["ended"]] == ["b", "c"]
    assert by["c"]["ended_at"] == by["c"]["last_activity_at"]
    assert body["counters"]["running"] == 1 and body["counters"]["ended"] == 2
    roll = client.get(f"{BASE}/live?group=harness", headers=AUTH).json()["groups"][0]["rollup"]
    assert roll["running"] == 1 and roll["ended"] == 2


def test_quiet_starts_at_two_minutes_and_stays_running(obs):
    client, ws, db = obs
    assert observability.QUIET_AFTER_S == 120
    s = Seed(db.db_path)
    s.call("q", ago=130)
    s.call("busy", ago=60)
    s.done()
    body, by = _live(client)
    assert by["q"]["quiet_seconds"] >= 120 and by["q"]["ended"] is False
    assert by["busy"]["quiet_seconds"] < 120
    c = body["counters"]
    assert c["running"] == 2 and c["quiet"] == 1


def test_live_rows_carry_the_latest_call_and_egress_host(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    s.call("lc", ago=40, args='{"command": "ls"}')
    s.call("lc", "block", ago=10, tool="Write", args='{"file_path": "/tmp/a"}')
    s.egress("lc", "old.example.test", ago=50)
    s.egress("lc", "api.example.test", "block", ago=5)
    s.call("oc2", ago=5, rk="openclaw")
    s.call("quiet2", ago=20, rk="unknown-kind")
    s.done()
    by = {x["session_id"]: x for x in client.get(f"{BASE}/live", headers=AUTH).json()["sessions"]}
    lc = by["lc"]
    assert lc["last_call"]["tool_id"] == "Write" and lc["last_call"]["action"] == "block"
    assert lc["last_call"]["reason"] == "Denied by rule" and lc["last_call"]["args_preview"] == '{"file_path": "/tmp/a"}'
    assert lc["last_egress"]["host"] == "api.example.test" and lc["last_egress"]["action"] == "block"
    assert lc["egress_visible"] is True
    assert by["oc2"]["last_egress"] is None and by["oc2"]["egress_visible"] is True
    assert by["quiet2"]["egress_visible"] is False
    assert lc["waiting_call"] is None


def test_live_rows_name_the_waiting_call_that_expires_soonest(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    s.call("wc", ago=30)
    s.request("wc", ago=60, tool="WebFetch", preview="GET https://a.example.test")
    s.request("wc", ago=20, tool="Bash", preview="curl b.example.test")
    s.done()
    row = {x["session_id"]: x for x in client.get(f"{BASE}/live", headers=AUTH).json()["sessions"]}["wc"]
    assert row["waiting"] == 2
    assert row["waiting_call"]["tool_id"] == "WebFetch"
    assert row["waiting_call"]["call_preview"] == "GET https://a.example.test"


def test_live_grouping_rollups(obs):
    client, ws, db = obs
    _seed_live(db, ws)
    body = client.get(f"{BASE}/live?group=harness", headers=AUTH).json()
    groups = {g["key"]: g for g in body["groups"]}
    assert set(groups) == {"claude-code", "codex", "openclaw"}
    cc = groups["claude-code"]["rollup"]
    assert cc["running"] == 6 and cc["waiting"] == 2 and cc["blocked_sessions"] == 1
    assert cc["max_score"] == 80 and cc["cost_usd"] == 1.5
    proj = {g["key"]: g for g in client.get(f"{BASE}/live?group=project", headers=AUTH).json()["groups"]}
    assert proj["proj"]["session_ids"] == ["idle-task"]
    assert proj["unknown"]["rollup"]["running"] == 7
    host = client.get(f"{BASE}/live?group=host", headers=AUTH).json()["groups"]
    assert [g["key"] for g in host] == ["unknown"]
    assert client.get(f"{BASE}/live?group=bogus", headers=AUTH).status_code == 422


def test_live_stays_fast_with_300_running_sessions(tmp_path):
    db = DatabaseConnection(tmp_path / "perf.db")
    asyncio.run(run_migrations(db))
    s = Seed(db.db_path)
    for i in range(300):
        sid = f"p{i}"
        for j in range(20):
            s.call(sid, "block" if j == 0 and i % 7 == 0 else "allow", ago=30 + j)
        if i % 5 == 0:
            s.request(sid, ago=40, source="rung")
        s.cost(sid, 0.01, 100)
        s.egress(sid, f"h{i % 9}.example", ago=50)
    for i in range(300):  # history that is no longer running
        s.call(f"old{i}", ago=7200)
    s.done()

    async def run():
        await observability.live_sessions(db, group="project")  # warm up
        t0 = time.perf_counter()
        body = await observability.live_sessions(db, group="project")
        return body, time.perf_counter() - t0

    try:
        body, took = asyncio.run(run())
        assert body["counters"]["running"] == 300
        assert len(body["sessions"]) == 200  # default limit
        assert took < 1.0, took  # well above the laptop target, to stay stable on CI
    finally:
        asyncio.run(db.disconnect())


def test_cost_from_records_is_proxy_else_transcript_tokens_with_no_price(obs, monkeypatch):
    client, ws, db = obs
    s = Seed(db.db_path)
    s.call("px", "allow", ago=30)
    s.cost("px", 0.4, 900, model="m-1")
    s.call("tx", "allow", ago=30)
    s.call("none", "allow", ago=30, rk="openclaw")
    s.done()
    parsed = []

    async def fake_parse(kind, sid, *, store_text, with_analysis=False):
        parsed.append(sid)
        if sid != "tx":
            return []
        return [{"model": "m-9", "input_tokens": 1000, "output_tokens": 200},
                {"model": "m-9", "input_tokens": 300, "output_tokens": 50}]

    monkeypatch.setattr(traces_routes, "parse_generations", fake_parse)
    observability._tokens_cache.clear()
    px = client.get(f"{BASE}/sessions/px/governance", headers=AUTH).json()["cost"]
    assert px == {"usd": 0.4, "tokens": 900, "models": ["m-1"], "source": "proxy"}
    assert "px" not in parsed, "cost records win; the transcript is not read"
    tx = client.get(f"{BASE}/sessions/tx/governance", headers=AUTH).json()["cost"]
    assert tx == {"usd": None, "tokens": 1550, "models": ["m-9"], "source": "transcript"}
    none = client.get(f"{BASE}/sessions/none/governance", headers=AUTH).json()["cost"]
    assert none["usd"] is None and none["tokens"] == 0 and none["source"] is None

    body = client.get(f"{BASE}/live", headers=AUTH).json()
    by = {x["session_id"]: x for x in body["sessions"]}
    assert by["px"]["cost_usd"] == 0.4 and by["px"]["cost_source"] == "proxy"
    assert by["tx"]["cost_usd"] is None and by["tx"]["tokens"] == 1550 and by["tx"]["cost_source"] == "transcript"
    assert body["counters"]["cost_usd"] == 0.4 and body["counters"]["tokens"] == 2450


def test_live_cost_total_is_null_when_no_session_has_a_recorded_cost(obs, monkeypatch):
    client, ws, db = obs
    s = Seed(db.db_path)
    s.call("t1", "allow", ago=30)
    s.call("t2", "allow", ago=20)
    s.done()

    async def fake_parse(kind, sid, *, store_text, with_analysis=False):
        return [{"model": "m", "input_tokens": 100, "output_tokens": 0}]

    monkeypatch.setattr(traces_routes, "parse_generations", fake_parse)
    observability._tokens_cache.clear()
    c = client.get(f"{BASE}/live", headers=AUTH).json()["counters"]
    assert c["cost_usd"] is None and c["cost_known_sessions"] == 0
    assert c["tokens"] == 200


def test_live_parses_a_bounded_number_per_poll_and_caches_the_rest(obs, monkeypatch):
    client, ws, db = obs
    s = Seed(db.db_path)
    for i in range(3):
        s.call(f"p{i}", "allow", ago=30 + i)
    s.done()
    calls = []

    async def fake_parse(kind, sid, *, store_text, with_analysis=False):
        calls.append(sid)
        return [{"model": "m", "input_tokens": 10, "output_tokens": 5}]

    monkeypatch.setattr(traces_routes, "parse_generations", fake_parse)
    monkeypatch.setattr(observability, "LIVE_PARSE_MAX", 2)
    observability._tokens_cache.clear()
    by = {x["session_id"]: x for x in client.get(f"{BASE}/live", headers=AUTH).json()["sessions"]}
    pending = [k for k, v in by.items() if v["tokens_pending"]]
    assert len(calls) == 2 and len(pending) == 1
    assert by[pending[0]]["tokens"] is None
    by = {x["session_id"]: x for x in client.get(f"{BASE}/live", headers=AUTH).json()["sessions"]}
    assert len(calls) == 3, "cached sessions are not parsed again"
    assert all(v["tokens"] == 15 and not v["tokens_pending"] for v in by.values())


def test_live_parses_real_transcripts_a_bounded_few_per_poll(tmp_path, monkeypatch):
    """30 running sessions with small real transcripts: each poll parses at
    most LIVE_PARSE_MAX, cached ones are not parsed again."""
    import json as _json
    projects = tmp_path / "claude" / "projects" / "-work"
    projects.mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_HOME", str(tmp_path / "claude"))
    monkeypatch.setattr(observability, "LIVE_PARSE_MAX", 10)
    monkeypatch.setattr(observability, "LIVE_PARSE_BUDGET_S", 60.0)
    db = DatabaseConnection(tmp_path / "small.db")
    asyncio.run(run_migrations(db))
    s = Seed(db.db_path)
    for i in range(30):
        sid = f"t{i}"
        s.call(sid, "allow", ago=30)
        lines = [{"type": "user", "timestamp": _ts(90), "message": {"role": "user", "content": "go"}},
                 {"type": "assistant", "requestId": f"r{i}", "timestamp": _ts(85),
                  "message": {"id": f"m{i}", "role": "assistant", "model": "m-1",
                              "content": [{"type": "text", "text": "ok"}],
                              "usage": {"input_tokens": 100, "output_tokens": 10}}}]
        (projects / f"{sid}.jsonl").write_text("\n".join(_json.dumps(x) for x in lines) + "\n")
    s.done()
    observability._tokens_cache.clear()
    calls = []
    real = traces_routes.parse_generations

    async def counting(kind, sid, **kw):
        calls.append(sid)
        return await real(kind, sid, **kw)

    monkeypatch.setattr(traces_routes, "parse_generations", counting)
    try:
        counts = []
        for _ in range(3):
            body = asyncio.run(observability.live_sessions(db))
            counts.append(len(calls))
        assert counts == [10, 20, 30]
        assert all(x["tokens"] == 110 and not x["tokens_pending"] for x in body["sessions"])
        asyncio.run(observability.live_sessions(db))
        assert len(calls) == 30, "fresh totals are not parsed again"
    finally:
        asyncio.run(db.disconnect())


def test_live_token_cache_never_starves_a_session(tmp_path, monkeypatch):
    """300 sessions, 25 parses per poll, a poll every 5 s against a 30 s
    TTL: expired totals are served while they wait, never-seen sessions
    go first, and after 12 polls every session has tokens."""
    db = DatabaseConnection(tmp_path / "starve.db")
    asyncio.run(run_migrations(db))
    s = Seed(db.db_path)
    for i in range(300):
        s.call(f"s{i}", "allow", ago=30 + (i % 50))
    s.done()
    observability._tokens_cache.clear()
    monkeypatch.setattr(observability, "LIVE_PARSE_MAX", 25)
    monkeypatch.setattr(observability, "LIVE_PARSE_BUDGET_S", 60.0)
    clock = [1000.0]

    class FakeTime:
        @staticmethod
        def monotonic():
            return clock[0]

    monkeypatch.setattr(observability, "time", FakeTime)

    async def fake_parse(kind, sid, *, store_text, with_analysis=False):
        return [{"model": "m", "input_tokens": 7, "output_tokens": 0}]

    monkeypatch.setattr(traces_routes, "parse_generations", fake_parse)
    try:
        pending = []
        for _ in range(12):
            body = asyncio.run(observability.live_sessions(db, limit=300))
            pending.append(sum(1 for x in body["sessions"] if x["tokens_pending"]))
            clock[0] += 5.0
        assert pending[0] == 275 and pending[-1] == 0
        assert all(x["tokens"] == 7 for x in body["sessions"])
        # Long after: stale totals still show while they refresh.
        clock[0] += 600.0
        body = asyncio.run(observability.live_sessions(db, limit=300))
        assert all(x["tokens"] == 7 and not x["tokens_pending"] for x in body["sessions"])
    finally:
        asyncio.run(db.disconnect())
