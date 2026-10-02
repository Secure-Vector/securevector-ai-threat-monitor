"""Quiet and ungoverned must not look the same.

A release-gate exit criterion asks for "unverified marking with a heartbeat
timeout".
It was written for the screen-manifest fallback, which was never built and is
now moot: every harness shipping in 6.0.0 has hooks. The same hazard arrived by
a different road. A linked row's liveness can be derived from the harness
transcript's mtime when the audit trail has gone quiet, and a file mtime says
the harness is alive, not that anything is watching it.

That is the state this marking exists to make visible. It is not a security
verdict: the session may be perfectly healthy.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from securevector.app.terminals.manager import GUARD_HEARTBEAT_SECONDS, TerminalManager


def ago(seconds: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()


@pytest.fixture
def verify():
    """_verification is pure: it reads a row and the activity summary and
    returns a dict. No manager state is touched, so no fixture is needed."""
    return TerminalManager._verification


def row(status="working"):
    return {"id": "t1", "status": status, "origin": "linked", "session_id": "s1"}


def test_a_recent_governed_call_is_verified(verify):
    out = verify(None, row(), {"last_call": ago(10)})
    assert out["verified"] is True
    assert "reported recently" in out["verified_reason"]


def test_a_guard_that_has_gone_quiet_past_the_window_is_unverified(verify):
    out = verify(None, row(), {"last_call": ago(GUARD_HEARTBEAT_SECONDS + 60)})
    assert out["verified"] is False
    assert "has not reported" in out["verified_reason"]


def test_the_boundary_is_inclusive(verify):
    """Exactly at the window is still verified. An off-by-one here would flap
    the badge on every poll for a session calling at the threshold."""
    assert verify(None, row(), {"last_call": ago(GUARD_HEARTBEAT_SECONDS - 1)})["verified"] is True


def test_a_session_that_never_reported_is_unverified_and_says_so_differently(verify):
    """"Never reported" and "stopped reporting" are different situations: the
    first is usually a missing plugin, the second a session that went away."""
    out = verify(None, row(), {})
    assert out["verified"] is False
    assert "never" in out["verified_reason"]


def test_no_activity_row_at_all_is_treated_as_never_reported(verify):
    assert verify(None, row(), None)["verified"] is False


@pytest.mark.parametrize("status", ["done", "failed", "interrupted"])
def test_an_ended_session_claims_nothing_so_there_is_nothing_to_verify(verify, status):
    """A badge on every finished row would be noise, and would imply the
    ending itself was unverified."""
    out = verify(None, row(status=status), {})
    assert out["verified"] is None
    assert out["verified_reason"] == ""


@pytest.mark.parametrize("status", ["starting", "working", "blocked", "idle"])
def test_every_live_status_is_assessed(verify, status):
    assert verify(None, row(status=status), {})["verified"] is False


def test_the_heartbeat_window_is_longer_than_the_working_window():
    """A session legitimately pauses for thought between tool calls. If the
    heartbeat were as tight as the working window the badge would flicker
    every time someone read a long file, and a badge people learn to ignore is
    worse than no badge."""
    from securevector.app.terminals.manager import LINKED_WORKING_SECONDS

    assert GUARD_HEARTBEAT_SECONDS > LINKED_WORKING_SECONDS
