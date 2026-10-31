"""Runs list "Calls refused": egress refusals count only inside the list's
own window, never all-time."""

from __future__ import annotations

import asyncio

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.egress import EgressRepository
from securevector.app.server.routes import traces as traces_routes
from tests.unit.app.test_observability_routes import Seed

DAY = 86400


def _db(tmp_path):
    db = DatabaseConnection(tmp_path / "refused.db")
    asyncio.run(run_migrations(db))
    return db


def test_egress_refusals_outside_the_window_are_not_counted(tmp_path, monkeypatch):
    db = _db(tmp_path)
    s = Seed(db.db_path)
    s.call("s1", "allow", ago=60)
    s.call("s1", "block", ago=50)
    s.egress("s1", "now.example.test", "block", ago=40, request_id="in1")
    # Same session, refused 10 and 40 days ago: outside a 7-day list.
    s.egress("s1", "old.example.test", "block", ago=10 * DAY, request_id="old1")
    s.egress("s1", "older.example.test", "block", ago=40 * DAY, request_id="old2")
    s.done()
    monkeypatch.setattr(traces_routes, "get_database", lambda: db)
    try:
        run = next(r for r in asyncio.run(traces_routes._collect_runs(7, 50)) if r["session_id"] == "s1")
        assert run["egress_blocked"] == 1
        assert run["blocked"] == 2, "one tool-policy block plus one egress refusal in the window"
        wide = next(r for r in asyncio.run(traces_routes._collect_runs(30, 50)) if r["session_id"] == "s1")
        assert wide["egress_blocked"] == 2, "the 30-day list reaches the 10-day-old refusal only"
    finally:
        asyncio.run(db.disconnect())


@pytest.mark.parametrize("days,expected", [(None, 3), (1, 1), (15, 2), (90, 3)])
def test_blocked_calls_window(tmp_path, days, expected):
    db = _db(tmp_path)
    s = Seed(db.db_path)
    s.egress("s1", "a.example.test", "block", ago=60, request_id="a")
    s.egress("s1", "b.example.test", "block", ago=10 * DAY, request_id="b")
    s.egress("s1", "c.example.test", "block", ago=40 * DAY, request_id="c")
    s.done()
    try:
        rows = asyncio.run(EgressRepository(db).blocked_calls(["s1"], window_days=days))
        assert len(rows) == expected
    finally:
        asyncio.run(db.disconnect())
