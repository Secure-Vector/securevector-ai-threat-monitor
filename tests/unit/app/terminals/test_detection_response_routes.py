"""Agent Detection & Response summary route: behind the terminals token, read
only, and built from stored rows (drift, setup checks, pre-flight decisions)."""

import asyncio
import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from securevector.app.database.migrations import (
    ensure_config_trust_tables,
    ensure_policy_check_tables,
    ensure_response_rung_tables,
    ensure_session_drift_table,
)
from securevector.app.server.routes import detection_response as dr_routes
from securevector.app.services import config_trust, mcp_registration
from securevector.app.terminals.auth import HEADER
from tests.unit.app.terminals.test_routes import AUTH, ORIGIN, env  # noqa: F401 - fixture

NOW = datetime.now(timezone.utc)
URL = "/api/terminals/detection-response/summary"


@pytest.fixture
def dr_env(env, monkeypatch):  # noqa: F811
    client, manager, ws, db = env
    for ensure in (ensure_session_drift_table, ensure_config_trust_tables, ensure_policy_check_tables):
        asyncio.run(ensure(db))
    client.app.include_router(dr_routes.router, prefix="/api")

    async def fake_status(_db, **_kw):
        return {"harnesses": [], "checked_at": NOW.isoformat(),
                "totals": {"harnesses": 2, "changed": 3, "unapproved": 1, "risky": 1}}

    monkeypatch.setattr(config_trust, "status", fake_status)
    monkeypatch.setattr(mcp_registration, "status", lambda *_a, **_k: {"claude-code": {"state": "not_registered"}})
    return client, ws, db


def _task(raw, tid, sid, ws, *, ended_days=None, created_days=1):
    raw.execute(
        "INSERT INTO terminal_tasks (id, executor_id, workspace, status, session_id, created_at, ended_at) "
        "VALUES (?, 'claude-code', ?, ?, ?, ?, ?)",
        (tid, ws, "done" if ended_days is not None else "working", sid,
         (NOW - timedelta(days=created_days)).isoformat(),
         (NOW - timedelta(days=ended_days)).isoformat() if ended_days is not None else None),
    )


def _drift(raw, sid, tid, score, band, *, feedback=None, status="scored"):
    feats = [{"id": "tool_novelty", "value": 0.8, "weight": 3, "skipped": False,
              "counts": {"unseen_calls": 4, "calls": 31}}]
    raw.execute(
        "INSERT INTO session_drift (session_id, task_id, harness, workspace, score, band, status, features_json, "
        "baseline_sessions, baseline_calls, feedback, computed_at) VALUES (?, ?, 'claude-code', '/w', ?, ?, ?, ?, 6, 300, ?, ?)",
        (sid, tid, score, band, status, json.dumps(feats), feedback, (NOW - timedelta(minutes=5)).isoformat()),
    )


def _seed(db, ws):
    raw = sqlite3.connect(db.db_path)
    _task(raw, "t-high", "s-high", ws, ended_days=0)
    _drift(raw, "s-high", "t-high", 82, "high")
    _task(raw, "t-calm", "s-calm", ws, ended_days=0)
    _drift(raw, "s-calm", "t-calm", 10, "calm")
    _task(raw, "t-normal", "s-normal", ws, ended_days=1)
    _drift(raw, "s-normal", "t-normal", 55, "watch", feedback="normal")
    _task(raw, "t-old", "s-old", ws, ended_days=20, created_days=21)
    _drift(raw, "s-old", "t-old", 90, "high")
    _task(raw, "t-setup", "s-setup", ws, ended_days=2, created_days=3)
    _drift(raw, "s-setup", "t-setup", 12, "calm")
    raw.execute(
        "INSERT INTO config_checks (session_id, task_id, harness, workspace_hash, phase, setup_hash, state, diff_json, "
        "checked_at) VALUES ('s-setup', 't-setup', 'claude-code', '', 'exit', 'h', 'changed', ?, ?)",
        (json.dumps([{"severity": "red", "text": "A new MCP server was added."}]), NOW.isoformat()),
    )
    iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S")  # noqa: E731
    for i, (decision, after) in enumerate([("allow", 0), ("deny", 0), ("deny", 1), ("allow", 0)]):
        raw.execute(
            "INSERT INTO policy_decisions (jti, session, action_kind, action_hash, target_hash, decision, reason, "
            "issued_at, attempted_after_deny) VALUES (?, 'h1', 'shell', 'a', 't', ?, 'r', ?, ?)",
            (f"j{i}", decision, iso(NOW - timedelta(hours=1)), after),
        )
    raw.execute(
        "INSERT INTO policy_decisions (jti, session, action_kind, action_hash, target_hash, decision, reason, "
        "issued_at) VALUES ('j-old', 'h1', 'shell', 'a', 't', 'deny', 'r', ?)",
        (iso(NOW - timedelta(days=9)),),
    )
    raw.commit()
    raw.close()


def test_summary_refuses_without_the_token(dr_env):
    client, ws, db = dr_env
    bare = client.__class__(client.app, base_url=ORIGIN)
    assert bare.get(URL, headers={HEADER: "1"}).status_code == 403
    assert client.get(URL).status_code == 403


def test_summary_lists_sessions_to_review_and_counts(dr_env):
    client, ws, db = dr_env
    _seed(db, ws)
    r = client.get(URL, headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    ids = [row["task_id"] for row in body["sessions"]]
    # High drift and a changed setup are listed; calm, marked normal and
    # older than the window are not. Newest first.
    assert ids == ["t-high", "t-setup"]
    high = body["sessions"][0]
    assert high["band"] == "high" and high["score"] == 82 and high["ended"] is True
    assert high["folder"] == ws.rstrip("/").split("/")[-1]
    assert high["reason"].endswith("4 of 31 calls")
    assert high["harness_label"] and high["setup_harness"] == "claude-code"
    assert body["sessions"][1]["reason"] == "A new MCP server was added."
    assert body["detect"]["to_review"] == 2
    assert body["detect"]["marked_normal"] == 1
    assert body["detect"]["baseline"]["state"] == "scored"
    assert body["detect"]["last_scored_at"]
    # Read-only engagement inputs: counts and two timestamps, no names.
    assert body["detect"]["flagged"] == 3 and body["detect"]["scored"] == 4
    assert body["detect"]["first_task_at"] and body["detect"]["first_scored_at"]
    assert body["detect"]["first_task_at"] <= body["detect"]["first_scored_at"]
    assert body["harden"] == {"available": True, "changes": 4, "unapproved": 1, "risky": 1,
                              "harnesses": 2, "checked_at": body["harden"]["checked_at"]}
    assert body["preflight"] == {"checked": 4, "avoided_denials": 1, "registered": False}


def test_summary_with_nothing_stored_reads_as_building(dr_env):
    client, ws, db = dr_env
    body = client.get(URL, headers=AUTH).json()
    assert body["sessions"] == []
    assert body["detect"]["baseline"] == {"ended_sessions": 0, "needed": 5, "state": "building"}
    assert body["preflight"]["checked"] == 0
    assert body["detect"]["flagged"] == 0 and body["detect"]["scored"] == 0
    assert body["detect"]["first_task_at"] is None and body["detect"]["first_scored_at"] is None


def test_summary_writes_nothing(dr_env):
    client, ws, db = dr_env
    _seed(db, ws)
    raw = sqlite3.connect(db.db_path)
    counts = [raw.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
              for t in ("session_drift", "config_checks", "policy_decisions", "terminal_tasks")]
    raw.close()
    assert client.get(URL, headers=AUTH).status_code == 200
    raw = sqlite3.connect(db.db_path)
    after = [raw.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
             for t in ("session_drift", "config_checks", "policy_decisions", "terminal_tasks")]
    feedback = raw.execute("SELECT feedback FROM session_drift WHERE session_id = 's-high'").fetchone()[0]
    raw.close()
    assert counts == after and feedback is None


def _check(raw, sid, tid, severities):
    raw.execute(
        "INSERT INTO config_checks (session_id, task_id, harness, workspace_hash, phase, setup_hash, state, diff_json, "
        "checked_at) VALUES (?, ?, 'claude-code', '', 'exit', 'h', 'changed', ?, ?)",
        (sid, tid, json.dumps([{"severity": s, "text": f"{s} change"} for s in severities]), NOW.isoformat()),
    )


def test_summary_carries_no_absolute_path(dr_env):
    client, ws, db = dr_env
    _seed(db, ws)
    text = client.get(URL, headers=AUTH).text
    assert ws not in text
    assert "workspace" not in json.loads(text)["sessions"][0]
    assert not any(row["folder"].startswith("/") for row in json.loads(text)["sessions"])


def test_amber_only_setup_change_is_not_flagged(dr_env):
    client, ws, db = dr_env
    raw = sqlite3.connect(db.db_path)
    _task(raw, "t-amber", "s-amber", ws, ended_days=0)
    _drift(raw, "s-amber", "t-amber", 10, "calm")
    _check(raw, "s-amber", "t-amber", ["amber"])
    _task(raw, "t-red", "s-red", ws, ended_days=0)
    _drift(raw, "s-red", "t-red", 10, "calm")
    _check(raw, "s-red", "t-red", ["amber", "red"])
    raw.commit()
    raw.close()
    ids = [r["task_id"] for r in client.get(URL, headers=AUTH).json()["sessions"]]
    assert ids == ["t-red"]


def test_looks_normal_hides_drift_only_flags(dr_env):
    client, ws, db = dr_env
    raw = sqlite3.connect(db.db_path)
    _task(raw, "t-drift", "s-drift", ws, ended_days=0)
    _drift(raw, "s-drift", "t-drift", 75, "high", feedback="normal")
    _task(raw, "t-both", "s-both", ws, ended_days=0)
    _drift(raw, "s-both", "t-both", 75, "high", feedback="normal")
    _check(raw, "s-both", "t-both", ["red"])
    raw.commit()
    raw.close()
    body = client.get(URL, headers=AUTH).json()
    assert [r["task_id"] for r in body["sessions"]] == ["t-both"]
    assert body["detect"]["marked_normal"] == 1


def test_setup_checks_are_read_in_batches():
    from securevector.app.services.detection_response import _latest_checks

    class Repo:
        def __init__(self):
            self.calls = []

        async def latest_for_tasks(self, ids):
            self.calls.append(len(ids))
            return {i: {"state": "changed"} for i in ids}

    repo = Repo()
    ids = [f"t{i}" for i in range(950)]
    out = asyncio.run(_latest_checks(repo, ids))
    assert repo.calls == [400, 400, 150]
    assert len(out) == 950


def test_spotlight_is_the_highest_score_with_points_and_folder_name_only(dr_env):
    client, ws, db = dr_env
    _seed(db, ws)
    body = client.get(URL, headers=AUTH).json()
    sp = body["spotlight"]
    assert sp["task_id"] == "t-high" and sp["score"] == 82 and sp["band"] == "high" and sp["to_review"] is True
    assert sp["folder"] == ws.rstrip("/").split("/")[-1] and "/" not in sp["folder"]
    top = sp["features"][0]
    assert top["id"] == "tool_novelty" and top["signal"] == "Novelty"
    assert top["points"] == sp["score"] and top["counts"]["unseen_calls"] == 4
    scores = [r["score"] for r in sp["recent_scores"]]
    assert 82 in scores and sum(1 for r in sp["recent_scores"] if r["current"]) == 1
    assert sp["baseline"]["sessions"] == 6 and sp["baseline"]["median"] is not None
    assert "spotlight" not in body["detect"]


def test_spotlight_falls_back_to_the_top_calm_score_and_is_none_without_scores(dr_env):
    client, ws, db = dr_env
    assert client.get(URL, headers=AUTH).json()["spotlight"] is None
    raw = sqlite3.connect(db.db_path)
    _task(raw, "t-calm", "s-calm", ws, ended_days=0)
    _drift(raw, "s-calm", "t-calm", 10, "calm")
    _task(raw, "t-calm2", "s-calm2", ws, ended_days=1)
    _drift(raw, "s-calm2", "t-calm2", 25, "calm")
    raw.commit()
    sp = client.get(URL, headers=AUTH).json()["spotlight"]
    assert sp["task_id"] == "t-calm2" and sp["score"] == 25 and sp["band"] == "calm"
    assert sp["to_review"] is False


def test_spotlight_tie_goes_to_the_newest(dr_env):
    client, ws, db = dr_env
    raw = sqlite3.connect(db.db_path)
    _task(raw, "t-a", "s-a", ws, ended_days=2, created_days=3)
    _drift(raw, "s-a", "t-a", 75, "high")
    _task(raw, "t-b", "s-b", ws, ended_days=0)
    _drift(raw, "s-b", "t-b", 75, "high")
    raw.commit()
    assert client.get(URL, headers=AUTH).json()["spotlight"]["task_id"] == "t-b"


def test_spotlight_points_add_up_to_the_score_and_blocks_are_counted(dr_env):
    client, ws, db = dr_env
    raw = sqlite3.connect(db.db_path)
    _task(raw, "t-p", "s-p", ws, ended_days=0)
    feats = [{"id": "tool_novelty", "value": 0.5, "skipped": False, "counts": {"unseen_tools": 2}},
             {"id": "errors_after_block", "value": 0.4, "skipped": False, "counts": {"errors": 2}},
             {"id": "new_hosts", "value": 0.0, "skipped": True, "counts": {}}]
    # 100 * (25*0.5 + 20*0.4) / (25+20) = 45.6 -> 46 (partial: one feature skipped)
    raw.execute(
        "INSERT INTO session_drift (session_id, task_id, harness, workspace, score, band, status, features_json, "
        "baseline_sessions, baseline_calls, computed_at) VALUES ('s-p','t-p','claude-code','/w',46,'watch','partial',?,6,300,?)",
        (json.dumps(feats), (NOW - timedelta(minutes=5)).isoformat()))
    raw.execute("INSERT INTO tool_call_audit (tool_id, function_name, action, called_at, session_id, runtime_kind) VALUES ('Bash','Bash','block',?, 's-p','claude-code')",
                ((NOW - timedelta(minutes=6)).strftime("%Y-%m-%d %H:%M:%S"),))
    raw.commit()
    sp = client.get(URL, headers=AUTH).json()["spotlight"]
    assert sum(f["points"] for f in sp["features"]) == sp["score"] == 46
    assert sp["had_blocks"] is True


def test_fallback_spotlight_skips_sessions_marked_normal(dr_env):
    client, ws, db = dr_env
    raw = sqlite3.connect(db.db_path)
    _task(raw, "t-n", "s-n", ws, ended_days=0)
    _drift(raw, "s-n", "t-n", 30, "calm", feedback="normal")
    _task(raw, "t-m", "s-m", ws, ended_days=1)
    _drift(raw, "s-m", "t-m", 12, "calm")
    raw.commit()
    assert client.get(URL, headers=AUTH).json()["spotlight"]["task_id"] == "t-m"


def test_rung_two_or_above_counts_as_a_session_to_review(dr_env):
    client, ws, db = dr_env
    asyncio.run(ensure_response_rung_tables(db))
    raw = sqlite3.connect(db.db_path)
    _task(raw, "t-rung", "s-rung", ws, ended_days=0)
    _drift(raw, "s-rung", "t-rung", 10, "calm")
    _task(raw, "t-calm", "s-calm", ws, ended_days=0)
    _drift(raw, "s-calm", "t-calm", 10, "calm")
    raw.execute("INSERT INTO session_rungs (session_id, task_id, harness, rung, mode) VALUES ('s-rung', 't-rung', 'claude-code', 2, 'shadow')")
    raw.execute("INSERT INTO session_rungs (session_id, task_id, harness, rung, mode) VALUES ('s-calm', 't-calm', 'claude-code', 1, 'shadow')")
    raw.commit()
    raw.close()
    body = client.get(URL, headers=AUTH).json()
    assert [r["task_id"] for r in body["sessions"]] == ["t-rung"]
    assert body["sessions"][0]["reason"] == "Automatic actions flagged this session."
    assert body["detect"]["to_review"] == 1


def _guard(monkeypatch, states):
    from securevector.app.server.routes import governance

    async def fake():
        return states
    monkeypatch.setattr(governance, "_plugin_statuses", fake)


def test_getting_started_with_nothing_set_up(dr_env, monkeypatch):
    client, ws, db = dr_env
    _guard(monkeypatch, {"claude-code": {"installed": False, "enabled": False}})
    setup = client.get(URL, headers=AUTH).json()["setup"]
    assert setup == {"guard_installed": False, "governed_session": False, "scored": False, "baseline": None}


def test_getting_started_partial_shows_baseline_progress(dr_env, monkeypatch):
    client, ws, db = dr_env
    _guard(monkeypatch, {"claude-code": {"installed": True, "enabled": True}, "codex": {"installed": False}})
    raw = sqlite3.connect(db.db_path)
    for i in range(3):
        _task(raw, f"t-{i}", f"s-{i}", ws, ended_days=0)
    raw.commit()
    raw.close()
    setup = client.get(URL, headers=AUTH).json()["setup"]
    assert setup["guard_installed"] is True and setup["governed_session"] is True and setup["scored"] is False
    b = setup["baseline"]
    assert b["sessions"] == 3 and b["needed"] == 5 and b["harness_label"]
    assert "/" not in b["folder"]


def test_getting_started_all_done_once_scored(dr_env, monkeypatch):
    client, ws, db = dr_env
    _guard(monkeypatch, {"codex": {"installed": True}})
    raw = sqlite3.connect(db.db_path)
    _task(raw, "t-s", "s-s", ws, ended_days=0)
    _drift(raw, "s-s", "t-s", 20, "calm")
    raw.commit()
    raw.close()
    setup = client.get(URL, headers=AUTH).json()["setup"]
    assert setup["guard_installed"] is True and setup["governed_session"] is True and setup["scored"] is True


def test_getting_started_disabled_guard_is_not_installed(dr_env, monkeypatch):
    client, ws, db = dr_env
    _guard(monkeypatch, {"claude-code": {"installed": True, "enabled": False}})
    assert client.get(URL, headers=AUTH).json()["setup"]["guard_installed"] is False


def _rung(raw, sid, tid, rung, reasons, feedback=None):
    raw.execute("INSERT INTO session_rungs (session_id, task_id, harness, rung, mode, reasons_json, feedback) "
                "VALUES (?, ?, 'claude-code', ?, 'shadow', ?, ?)", (sid, tid, rung, json.dumps(reasons), feedback))


def test_looks_normal_clears_a_drift_only_rung_but_not_config_or_deny(dr_env):
    client, ws, db = dr_env
    asyncio.run(ensure_response_rung_tables(db))
    raw = sqlite3.connect(db.db_path)
    _task(raw, "t-d", "s-d", ws, ended_days=0)
    _drift(raw, "s-d", "t-d", 55, "watch", feedback="normal")
    _rung(raw, "s-d", "t-d", 2, ["drift"])
    _task(raw, "t-c", "s-c", ws, ended_days=0)
    _drift(raw, "s-c", "t-c", 55, "watch", feedback="normal")
    _rung(raw, "s-c", "t-c", 2, ["drift", "config"])
    _task(raw, "t-n", "s-n", ws, ended_days=0)
    _drift(raw, "s-n", "t-n", 10, "calm")
    _rung(raw, "s-n", "t-n", 2, ["deny"], feedback="not_needed")
    raw.commit()
    raw.close()
    body = client.get(URL, headers=AUTH).json()
    assert [r["task_id"] for r in body["sessions"]] == ["t-c"]
    assert body["detect"]["to_review"] == 1
    assert body["detect"]["marked_normal"] == 1


def test_rung_mode_error_is_plain():
    from securevector.app.services import response_rungs
    import inspect
    assert "Test mode is not finished yet" in inspect.getsource(response_rungs)
    assert "Shadow period" not in inspect.getsource(response_rungs)


def test_first_session_partial_row_counts_as_scored_with_scaled_weight(dr_env):
    client, ws, db = dr_env
    raw = sqlite3.connect(db.db_path)
    _task(raw, "t-1", "s-1", ws, ended_days=0)
    # A one-session comparison: novelty carries a fifth of its weight.
    feats = [{"id": "tool_novelty", "value": 1.0, "weight": 5.0, "skipped": False, "counts": {"unseen_tools": 1}},
             {"id": "errors_after_block", "value": 1.0, "weight": 20, "skipped": False, "counts": {"errors": 3}},
             {"id": "new_hosts", "value": 0.0, "weight": 3.0, "skipped": True, "counts": {}}]
    raw.execute(
        "INSERT INTO session_drift (session_id, task_id, harness, workspace, score, band, status, features_json, "
        "baseline_sessions, baseline_calls, computed_at) VALUES ('s-1','t-1','claude-code','/w',100,'high','partial',?,1,40,?)",
        (json.dumps(feats), (NOW - timedelta(minutes=5)).isoformat()))
    raw.commit()
    body = client.get(URL, headers=AUTH).json()
    assert body["detect"]["baseline"]["state"] == "partial"
    sp = body["spotlight"]
    assert sp["score"] == 100 and sp["baseline"]["sessions"] == 1
    assert sp["baseline"]["confidence"] == 0.2
    assert sum(f["points"] for f in sp["features"]) == 100
    pts = {f["id"]: f["points"] for f in sp["features"]}
    assert pts["errors_after_block"] == 80 and pts["tool_novelty"] == 20
