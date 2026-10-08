"""Session Drift routes: behind the same loopback token rules as the other
terminals routes, reads score and return counts only, and the one write
records "looks normal" and nothing else."""

import asyncio
import json
import sqlite3
from datetime import datetime, timedelta, timezone

from securevector.app.database.migrations import ensure_session_drift_table
from securevector.app.services import session_drift
from securevector.app.terminals.auth import HEADER
from tests.unit.app.terminals.test_routes import AUTH, ORIGIN, env  # noqa: F401 - fixture

NOW = datetime.now(timezone.utc)


def _seed(db, ws, *, baseline=6):
    asyncio.run(ensure_session_drift_table(db))  # what startup does
    raw = sqlite3.connect(db.db_path)
    ts = lambda d: d.strftime("%Y-%m-%d %H:%M:%S")  # noqa: E731
    for k in range(baseline):
        sid = f"base-{k}"
        raw.execute(
            "INSERT INTO terminal_tasks (id, executor_id, workspace, status, session_id, created_at, ended_at) "
            "VALUES (?, 'claude-code', ?, 'done', ?, ?, ?)",
            (f"b{k}", ws, sid, (NOW - timedelta(days=2)).isoformat(), (NOW - timedelta(days=1)).isoformat()),
        )
        raw.executemany(
            "INSERT INTO tool_call_audit (tool_id, function_name, action, args_preview, called_at, session_id, "
            "runtime_kind) VALUES (?, ?, 'allow', ?, ?, ?, 'claude-code')",
            [("Read", "Read", json.dumps({"file_path": f"f{i}.py"}), ts(NOW - timedelta(days=2)), sid)
             for i in range(50)],
        )
    raw.execute(
        "INSERT INTO terminal_tasks (id, executor_id, workspace, status, session_id, created_at) "
        "VALUES ('live1', 'claude-code', ?, 'working', 'sess-live', ?)",
        (ws, NOW.isoformat()),
    )
    raw.executemany(
        "INSERT INTO tool_call_audit (tool_id, function_name, action, args_preview, called_at, session_id, "
        "runtime_kind) VALUES (?, ?, 'allow', ?, ?, 'sess-live', 'claude-code')",
        [(t, t, json.dumps({"n": i}), ts(NOW)) for i, t in enumerate(["WebFetch", "Glob", "Read", "Read"])],
    )
    # A finished session, the one "Looks normal" may mark. Ended outside the
    # 30-day window so it does not change the baseline the other tests read.
    raw.execute(
        "INSERT INTO terminal_tasks (id, executor_id, workspace, status, session_id, created_at, ended_at) "
        "VALUES ('done1', 'claude-code', ?, 'done', 'sess-done', ?, ?)",
        (ws, (NOW - timedelta(days=41)).isoformat(), (NOW - timedelta(days=40)).isoformat()),
    )
    raw.executemany(
        "INSERT INTO tool_call_audit (tool_id, function_name, action, args_preview, called_at, session_id, "
        "runtime_kind) VALUES (?, ?, 'allow', ?, ?, 'sess-done', 'claude-code')",
        [(t, t, json.dumps({"n": i}), ts(NOW - timedelta(days=40))) for i, t in enumerate(["NotebookEdit", "Read"])],
    )
    raw.commit()
    raw.close()
    session_drift.clear_cache()


def test_drift_routes_refuse_without_the_token(env):  # noqa: F811
    client, manager, ws, db = env
    _seed(db, ws)
    bare = client.__class__(client.app, base_url=ORIGIN)
    assert bare.get("/api/terminals/tasks/live1/drift", headers={HEADER: "1"}).status_code == 403
    assert bare.get("/api/terminals/drift?task_ids=live1", headers={HEADER: "1"}).status_code == 403
    assert bare.post("/api/terminals/tasks/live1/drift/feedback", headers=AUTH, json={}).status_code == 403
    # The cookie alone is not enough either: the UI header is required.
    assert client.get("/api/terminals/tasks/live1/drift").status_code == 403
    # A write without Origin is refused even with the cookie and header.
    assert client.post("/api/terminals/tasks/live1/drift/feedback", headers={HEADER: "1"}, json={}).status_code == 403


def test_task_drift_scores_and_returns_counts_only(env):  # noqa: F811
    client, manager, ws, db = env
    _seed(db, ws)
    r = client.get("/api/terminals/tasks/live1/drift", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"score", "band", "status", "top", "baseline", "computed_at", "feedback", "ended"}
    assert body["ended"] is False
    assert body["status"] in ("scored", "partial") and isinstance(body["score"], int)
    assert body["band"] in ("calm", "watch", "high")
    assert body["top"][0]["id"] == "tool_novelty"
    assert body["top"][0]["detail"] == "2 of 4 calls"
    assert "WebFetch" not in json.dumps(body)
    assert body["baseline"]["sessions"] == 6
    # Stored, so the board and the batch read see it.
    batch = client.get("/api/terminals/drift?task_ids=live1,missing", headers=AUTH).json()
    assert batch["items"]["live1"]["score"] == body["score"]
    board = client.get("/api/terminals/tasks/live1", headers=AUTH).json()
    assert board["drift_score"] == body["score"] and board["drift_band"] == body["band"]


def test_building_baseline_and_unknown_task(env):  # noqa: F811
    client, manager, ws, db = env
    _seed(db, ws, baseline=3)
    body = client.get("/api/terminals/tasks/live1/drift", headers=AUTH).json()
    assert body["status"] == "building_baseline" and body["score"] is None
    assert body["baseline"]["sessions"] == 3 and body["baseline"]["needed_sessions"] == 5
    assert client.get("/api/terminals/tasks/nope/drift", headers=AUTH).status_code == 404


def test_feedback_records_looks_normal_only(env):  # noqa: F811
    client, manager, ws, db = env
    _seed(db, ws)
    # A running session cannot be marked normal.
    running = client.post("/api/terminals/tasks/live1/drift/feedback", headers=AUTH, json={})
    assert running.status_code == 409 and "still running" in running.json()["detail"]
    assert client.get("/api/terminals/tasks/live1/drift", headers=AUTH).json()["feedback"] is None
    r = client.post("/api/terminals/tasks/done1/drift/feedback", headers=AUTH, json={})
    assert r.status_code == 200 and r.json() == {"ok": True, "feedback": "normal"}
    body = client.get("/api/terminals/tasks/done1/drift", headers=AUTH).json()
    assert body["feedback"] == "normal" and body["ended"] is True
    bad = client.post("/api/terminals/tasks/done1/drift/feedback", headers=AUTH, json={"feedback": "block"})
    assert bad.status_code == 422
    extra = client.post("/api/terminals/tasks/done1/drift/feedback", headers=AUTH,
                        json={"feedback": "normal", "action": "stop"})
    assert extra.status_code == 422
    # Observe only: neither task is touched by any of this.
    assert client.get("/api/terminals/tasks/live1", headers=AUTH).json()["status"] == "working"
