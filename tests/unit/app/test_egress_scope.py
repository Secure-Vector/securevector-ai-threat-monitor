"""
Scope-expansion assessment.

Two failure modes, and they pull in opposite directions. Fire too readily and
the signal is muted within a week, at which point the one session that mattered
goes unread. Fire too rarely and a nine-thousand-host scan made entirely of
individually-unremarkable reads passes without comment, which is the exact
event this exists for.

The tests below pin the compromise: novelty against the device (not the
session) is what escalates, volume alone is merely elevated, and nothing fires
at all until the device has enough history for "new" to mean something.
"""

import pytest

from securevector.app.services.egress_scope import (
    DISTINCT_HOST_ALERT,
    MIN_BASELINE_HOSTS,
    NOVEL_HOST_ALERT,
    STATUS_ELEVATED,
    STATUS_EXPANDING,
    STATUS_NO_BASELINE,
    STATUS_QUIET,
    assess,
    summarize,
)


def session(distinct=5, novel=0, minutes=10.0, sid="s1"):
    return {
        "session_id": sid,
        "distinct_hosts": distinct,
        "novel_hosts": novel,
        "calls": distinct,
        "span_minutes": minutes,
    }


class TestBaselineGate:
    """A novelty detector on a fresh device fires every time and gets muted."""

    def test_below_baseline_never_alerts(self):
        result = assess(session(distinct=200, novel=200), known_host_count=3)
        assert result["status"] == STATUS_NO_BASELINE

    def test_below_baseline_explains_itself(self):
        result = assess(session(distinct=200, novel=200), known_host_count=3)
        assert "every host is new" in result["reasons"][0]

    def test_exactly_at_baseline_starts_assessing(self):
        result = assess(session(distinct=200, novel=200),
                        known_host_count=MIN_BASELINE_HOSTS)
        assert result["status"] != STATUS_NO_BASELINE


class TestQuietSessions:
    def test_ordinary_session_is_quiet(self):
        assert assess(session(distinct=6, novel=1), 100)["status"] == STATUS_QUIET

    def test_quiet_session_carries_no_reasons(self):
        assert assess(session(distinct=6, novel=1), 100)["reasons"] == []

    def test_busy_session_against_familiar_hosts_is_not_expanding(self):
        """Volume against known infrastructure is a busy session, not an event."""
        result = assess(session(distinct=DISTINCT_HOST_ALERT + 20, novel=0,
                                minutes=120), 500)
        assert result["status"] == STATUS_ELEVATED


class TestExpansion:
    def test_novelty_plus_volume_escalates(self):
        result = assess(session(distinct=DISTINCT_HOST_ALERT + 5,
                                novel=NOVEL_HOST_ALERT + 5, minutes=60), 500)
        assert result["status"] == STATUS_EXPANDING

    def test_novelty_alone_is_elevated_not_expanding(self):
        result = assess(session(distinct=NOVEL_HOST_ALERT + 1,
                                novel=NOVEL_HOST_ALERT + 1, minutes=120), 500)
        assert result["status"] == STATUS_ELEVATED

    def test_the_scan_shape_is_caught(self):
        """Many hosts, all new, fast. The pattern the destination rules miss."""
        result = assess(session(distinct=900, novel=900, minutes=5), 500)
        assert result["status"] == STATUS_EXPANDING
        assert len(result["reasons"]) >= 3

    def test_reasons_are_stated_not_scored(self):
        result = assess(session(distinct=900, novel=900, minutes=5), 500)
        assert any("never contacted before" in r for r in result["reasons"])


class TestRate:
    def test_zero_span_does_not_produce_infinite_rate(self):
        result = assess(session(distinct=20, novel=2, minutes=0.0), 500)
        assert result["rate_per_minute"] < 100000

    def test_slow_session_is_not_rate_flagged(self):
        result = assess(session(distinct=20, novel=2, minutes=600), 500)
        assert not any("per minute" in r for r in result["reasons"])

    def test_small_burst_is_not_rate_flagged(self):
        """Two calls in one tick is not a loop, whatever the arithmetic says."""
        result = assess(session(distinct=2, novel=0, minutes=0.0), 500)
        assert not any("per minute" in r for r in result["reasons"])


class TestSummary:
    def test_alert_only_is_stated_every_time(self):
        out = summarize([assess(session(distinct=900, novel=900, minutes=5), 500)])
        assert "not an enforcement action" in out["note"]
        assert "Nothing was blocked" in out["note"]

    def test_quiet_sessions_are_not_listed(self):
        out = summarize([assess(session(), 500) for _ in range(4)])
        assert out["status"] == STATUS_QUIET
        assert out["sessions"] == []

    def test_expanding_outranks_elevated_in_the_headline(self):
        out = summarize([
            assess(session(distinct=DISTINCT_HOST_ALERT + 1, novel=0, sid="busy"), 500),
            assess(session(distinct=900, novel=900, minutes=5, sid="scan"), 500),
        ])
        assert out["status"] == STATUS_EXPANDING

    def test_no_baseline_is_reported_rather_than_called_quiet(self):
        out = summarize([assess(session(distinct=900, novel=900), 2)])
        assert out["status"] == STATUS_NO_BASELINE

    def test_thresholds_are_published(self):
        """An operator who disagrees needs the number, not a black box."""
        out = summarize([assess(session(), 500)])
        assert out["thresholds"]["novel_hosts"] == NOVEL_HOST_ALERT


class TestRepositoryShape:
    @pytest.mark.asyncio
    async def test_session_scope_counts_novel_against_the_device(self, tmp_path):
        from securevector.app.database.connection import DatabaseConnection
        from securevector.app.database.migrations import run_migrations
        from securevector.app.database.repositories.egress import EgressRepository
        from securevector.core.egress.destinations import EgressAttempt
        from securevector.core.egress.engine import EgressVerdict

        db = DatabaseConnection(tmp_path / "scope.db")
        await run_migrations(db)
        repo = EgressRepository(db)

        def v(host):
            return EgressVerdict(action="allow", attempt=EgressAttempt(
                host=host, operation="read", kind="http", detector="bash",
                confidence="PARSED"))

        # Session one discovers both hosts.
        await repo.log_attempts([v("a.example.com"), v("b.example.com")],
                                session_id="s1")
        # Session two revisits them; nothing is new to the device.
        await repo.log_attempts([v("a.example.com"), v("b.example.com")],
                                session_id="s2")

        rows = {r["session_id"]: r for r in await repo.session_scope()}
        assert rows["s1"]["novel_hosts"] == 2
        assert rows["s2"]["novel_hosts"] == 0
        assert rows["s2"]["distinct_hosts"] == 2
        await db.disconnect()
