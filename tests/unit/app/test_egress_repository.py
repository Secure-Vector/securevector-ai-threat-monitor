"""
Egress repository queries that the UI reads directly.

The case worth pinning here is `promotable`. Baseline verdicts are decided
before the allowlist is consulted, so adding a publish host to the allowlist
changes nothing. A destinations table that offers a one-click "Allow" on such a
host offers a button that silently does not work, which is worse than offering
no button: the operator believes the destination is now permitted and finds out
otherwise at the next block. The flag exists so the UI can tell the difference,
and this file exists so it keeps doing so.
"""

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.egress import EgressRepository
from securevector.core.egress.destinations import EgressAttempt
from securevector.core.egress.engine import EgressVerdict


async def _repo(tmp_path) -> EgressRepository:
    db = DatabaseConnection(tmp_path / "egress.db")
    await run_migrations(db)
    return EgressRepository(db)


def _verdict(host, action="allow", operation="read", rule_id=None, kind="http"):
    return EgressVerdict(
        action=action,
        rule_id=rule_id,
        attempt=EgressAttempt(
            host=host, operation=operation, kind=kind, detector="bash",
            confidence="PARSED", scheme="https", port=443, evidence="curl ...",
        ),
    )


class TestDestinationInventory:
    @pytest.mark.asyncio
    async def test_ordinary_host_is_promotable(self, tmp_path):
        repo = await _repo(tmp_path)
        await repo.log_attempts([_verdict("api.example.com", operation="write")])
        row = (await repo.destination_inventory())[0]
        assert row["host"] == "api.example.com"
        assert row["promotable"] is True

    @pytest.mark.asyncio
    async def test_publish_block_is_not_promotable(self, tmp_path):
        """A one-click allow cannot clear this; the UI must not offer one."""
        repo = await _repo(tmp_path)
        await repo.log_attempts([_verdict(
            "upload.pypi.org", action="block", operation="write",
            rule_id="sv.egress.package_publish",
        )])
        row = (await repo.destination_inventory())[0]
        assert row["promotable"] is False

    @pytest.mark.asyncio
    async def test_metadata_endpoint_block_is_not_promotable(self, tmp_path):
        repo = await _repo(tmp_path)
        await repo.log_attempts([_verdict(
            "169.254.169.254", action="block", operation="read",
            rule_id="sv.egress.cloud_metadata",
        )])
        assert (await repo.destination_inventory())[0]["promotable"] is False

    @pytest.mark.asyncio
    async def test_denylisted_host_is_not_promotable(self, tmp_path):
        repo = await _repo(tmp_path)
        await repo.log_attempts([_verdict(
            "bad.example.com", action="block", rule_id="policy.denylist",
        )])
        assert (await repo.destination_inventory())[0]["promotable"] is False

    @pytest.mark.asyncio
    async def test_one_hard_block_makes_the_whole_host_non_promotable(self, tmp_path):
        """Mixed history must resolve to the stricter answer, not the common one."""
        repo = await _repo(tmp_path)
        await repo.log_attempts([
            _verdict("upload.pypi.org"),
            _verdict("upload.pypi.org"),
            _verdict("upload.pypi.org", action="block", operation="write",
                     rule_id="sv.egress.package_publish"),
        ])
        row = (await repo.destination_inventory())[0]
        assert row["calls"] == 3
        assert row["promotable"] is False

    @pytest.mark.asyncio
    async def test_promotable_block_stays_promotable(self, tmp_path):
        repo = await _repo(tmp_path)
        await repo.log_attempts([_verdict(
            "api.example.com", action="block", operation="write",
            rule_id="preset.hardened_write",
        )])
        assert (await repo.destination_inventory())[0]["promotable"] is True

    @pytest.mark.asyncio
    async def test_counts_are_per_host(self, tmp_path):
        repo = await _repo(tmp_path)
        await repo.log_attempts([
            _verdict("a.example.com"),
            _verdict("a.example.com", operation="write"),
            _verdict("b.example.com", action="block", rule_id="preset.contained"),
        ])
        rows = {r["host"]: r for r in await repo.destination_inventory()}
        assert rows["a.example.com"]["calls"] == 2
        assert rows["a.example.com"]["writes"] == 1
        assert rows["b.example.com"]["blocked"] == 1


class TestBlastRadius:
    @pytest.mark.asyncio
    async def test_counts_distinct_hosts_not_calls(self, tmp_path):
        repo = await _repo(tmp_path)
        await repo.log_attempts([_verdict("a.example.com") for _ in range(5)])
        blast = await repo.blast_radius()
        assert blast["distinct_hosts"] == 1
        assert blast["total_calls"] == 5

    @pytest.mark.asyncio
    async def test_write_capable_hosts_counted_separately(self, tmp_path):
        repo = await _repo(tmp_path)
        await repo.log_attempts([
            _verdict("read.example.com"),
            _verdict("write.example.com", operation="write"),
        ])
        assert (await repo.blast_radius())["write_capable_hosts"] == 1

    @pytest.mark.asyncio
    async def test_empty_history_reports_zero_not_an_error(self, tmp_path):
        repo = await _repo(tmp_path)
        blast = await repo.blast_radius()
        assert blast["distinct_hosts"] == 0
        assert blast["first_seen_recently"] == 0

    @pytest.mark.asyncio
    async def test_coverage_statement_is_always_present(self, tmp_path):
        """The counter must never be shown without what it does not count."""
        repo = await _repo(tmp_path)
        assert "not included" in (await repo.blast_radius())["coverage"]


class TestReplayRows:
    @pytest.mark.asyncio
    async def test_evidence_is_not_selected_for_replay(self, tmp_path):
        """Replay has no use for the command fragment and must not receive it."""
        repo = await _repo(tmp_path)
        await repo.log_attempts([_verdict("api.example.com")])
        row = (await repo.attempts_for_replay())[0]
        assert "evidence" not in row
        assert row["host"] == "api.example.com"


class TestProofRetrieval:
    @pytest.mark.asyncio
    async def test_recent_proofs_full_carries_probe_detail(self, tmp_path):
        repo = await _repo(tmp_path)
        probes = [{"id": "x", "reached": False, "blocked_by_securevector": True}]
        await repo.save_proof(probes, "contained", ["a gap"], policy_preset="baseline")
        proofs = await repo.recent_proofs_full(limit=2)
        assert proofs[0]["probes"][0]["id"] == "x"
        assert proofs[0]["coverage"] == ["a gap"]

    @pytest.mark.asyncio
    async def test_proofs_are_hash_chained(self, tmp_path):
        repo = await _repo(tmp_path)
        first = await repo.save_proof([], "contained", [], policy_preset="baseline")
        await repo.save_proof([], "contained", [], policy_preset="baseline")
        proofs = await repo.recent_proofs_full(limit=2)
        assert proofs[0]["prev_hash"] == first["result_hash"]

    @pytest.mark.asyncio
    async def test_get_proof_by_id_returns_none_when_absent(self, tmp_path):
        repo = await _repo(tmp_path)
        assert await repo.get_proof("does-not-exist") is None


class TestSessionDestinations:
    """Per-session reach, for the attached-terminal governance panel.

    The panel sits next to one running task, so a row from another session
    leaking in would read as that task's reach and would be wrong evidence.
    """

    @pytest.mark.asyncio
    async def test_only_the_named_session_is_returned(self, tmp_path):
        repo = await _repo(tmp_path)
        await repo.log_attempts([_verdict("mine.example.com")], session_id="s1")
        await repo.log_attempts([_verdict("theirs.example.com")], session_id="s2")
        rows = await repo.session_destinations("s1")
        assert [r["host"] for r in rows] == ["mine.example.com"]

    @pytest.mark.asyncio
    async def test_blocked_hosts_sort_first(self, tmp_path):
        repo = await _repo(tmp_path)
        for _ in range(3):
            await repo.log_attempts([_verdict("busy.example.com")], session_id="s1")
        await repo.log_attempts(
            [_verdict("bad.example.com", action="block", rule_id="policy.denylist")],
            session_id="s1",
        )
        rows = await repo.session_destinations("s1")
        assert [r["host"] for r in rows] == ["bad.example.com", "busy.example.com"]
        assert rows[0]["blocked"] == 1
        assert rows[0]["hard_blocked"] == 1
        assert rows[1]["calls"] == 3

    @pytest.mark.asyncio
    async def test_counts_writes_and_respects_limit(self, tmp_path):
        repo = await _repo(tmp_path)
        await repo.log_attempts(
            [_verdict("a.example.com", operation="write")] * 2, session_id="s1")
        await repo.log_attempts([_verdict("b.example.com")], session_id="s1")
        rows = await repo.session_destinations("s1", limit=1)
        assert len(rows) == 1
        assert rows[0]["host"] == "a.example.com"
        assert rows[0]["writes"] == 2
        assert rows[0]["first_seen"] and rows[0]["last_seen"]

    @pytest.mark.asyncio
    async def test_unknown_session_is_empty_not_everything(self, tmp_path):
        repo = await _repo(tmp_path)
        await repo.log_attempts([_verdict("a.example.com")], session_id="s1")
        assert await repo.session_destinations("nope") == []


class TestObservedRows:
    """Destinations reached without passing the evaluator.

    A harness's own web tool fires no hook, so its destinations arrive after
    the fact from a local transcript. They belong in the same table: one list
    per session is the point. They do not belong in the same vocabulary as a
    verdict, because nothing decided them, and they must never reach replay,
    which would otherwise report that a candidate preset "would have blocked" a
    call no preset can reach.
    """

    @pytest.mark.asyncio
    async def test_observed_is_an_accepted_action(self, tmp_path):
        repo = await _repo(tmp_path)
        await repo.record(
            host="example.com", port=443, operation="read", kind="web",
            action="observed", detector="codex-transcript",
            tool_name="web_search", runtime_kind="codex", session_id="s1",
            evidence="https://example.com/a", reason="no hook fired",
        )
        rows = await repo.recent()
        assert rows[0]["action"] == "observed"
        assert rows[0]["detector"] == "codex-transcript"
        assert rows[0]["evidence"] == "https://example.com/a"

    @pytest.mark.asyncio
    async def test_session_row_counts_observed_separately(self, tmp_path):
        repo = await _repo(tmp_path)
        await repo.record(host="docs.example.com", session_id="s1",
                          detector="codex-transcript")
        await repo.record(host="docs.example.com", session_id="s1",
                          detector="codex-transcript")
        await repo.log_attempts([_verdict("api.example.com")], session_id="s1")
        rows = {r["host"]: r for r in await repo.session_destinations("s1")}
        assert rows["docs.example.com"]["observed"] == 2
        assert rows["docs.example.com"]["blocked"] == 0
        assert rows["api.example.com"]["observed"] == 0
        assert rows["api.example.com"]["calls"] == 1

    @pytest.mark.asyncio
    async def test_the_search_pseudo_host_is_a_row_like_any_other(self, tmp_path):
        repo = await _repo(tmp_path)
        await repo.record(host="web-search", session_id="s1",
                          detector="codex-transcript", evidence="a query")
        row = (await repo.session_destinations("s1"))[0]
        assert row["host"] == "web-search"
        assert row["observed"] == 1

    @pytest.mark.asyncio
    async def test_known_hosts_ignores_observed_hosts(self, tmp_path):
        """First-seen detection asks what the *policy* has seen before."""
        repo = await _repo(tmp_path)
        await repo.record(host="never.evaluated.com", session_id="s1",
                          detector="codex-transcript")
        await repo.log_attempts([_verdict("api.example.com")], session_id="s1")
        assert await repo.known_hosts() == frozenset({"api.example.com"})

    @pytest.mark.asyncio
    async def test_scope_counts_only_governed_calls(self, tmp_path):
        """Scope is a rate an operator can act on; observed calls are not."""
        repo = await _repo(tmp_path)
        await repo.log_attempts([_verdict("api.example.com")], session_id="s1")
        for host in ("a.example.com", "b.example.com", "web-search"):
            await repo.record(host=host, session_id="s1",
                              detector="codex-transcript")
        rows = await repo.session_scope()
        assert len(rows) == 1
        assert rows[0]["distinct_hosts"] == 1
        assert rows[0]["novel_hosts"] == 1
        assert rows[0]["calls"] == 1

    @pytest.mark.asyncio
    async def test_a_session_with_only_observed_calls_has_no_scope_row(self, tmp_path):
        repo = await _repo(tmp_path)
        await repo.record(host="a.example.com", session_id="s1",
                          detector="codex-transcript")
        assert await repo.session_scope() == []

    @pytest.mark.asyncio
    async def test_inventory_keeps_observed_hosts_and_marks_them(self, tmp_path):
        """A host reached is a host reached; what is missing is the verdict."""
        repo = await _repo(tmp_path)
        await repo.record(host="docs.example.com", session_id="s1",
                          detector="codex-transcript")
        await repo.log_attempts([_verdict("api.example.com")], session_id="s1")
        rows = {r["host"]: r for r in await repo.destination_inventory()}
        assert set(rows) == {"docs.example.com", "api.example.com"}
        assert rows["docs.example.com"]["observed_only"] is True
        assert rows["api.example.com"]["observed_only"] is False
        assert rows["api.example.com"]["observed"] == 0

    @pytest.mark.asyncio
    async def test_the_search_pseudo_host_is_not_a_destination(self, tmp_path):
        """It cannot be allowlisted, resolved or probed, so it is not a host."""
        repo = await _repo(tmp_path)
        await repo.record(host="web-search", session_id="s1",
                          detector="codex-transcript")
        await repo.log_attempts([_verdict("api.example.com")], session_id="s1")
        assert [r["host"] for r in await repo.destination_inventory()] == [
            "api.example.com"]
        radius = await repo.blast_radius()
        assert radius["distinct_hosts"] == 1
        assert radius["first_seen_recently"] == 1

    @pytest.mark.asyncio
    async def test_an_observed_real_host_still_counts_as_reach(self, tmp_path):
        repo = await _repo(tmp_path)
        await repo.record(host="docs.example.com", session_id="s1",
                          detector="codex-transcript")
        radius = await repo.blast_radius()
        assert radius["distinct_hosts"] == 1
        assert radius["write_capable_hosts"] == 0

    @pytest.mark.asyncio
    async def test_replay_never_sees_an_observed_row(self, tmp_path):
        repo = await _repo(tmp_path)
        await repo.record(host="web-search", session_id="s1",
                          detector="codex-transcript")
        await repo.log_attempts([_verdict("api.example.com")], session_id="s1")
        rows = await repo.attempts_for_replay()
        assert [r["host"] for r in rows] == ["api.example.com"]


_PRE_V51_EGRESS_AUDIT = """
    CREATE TABLE egress_audit (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        host          TEXT,
        port          INTEGER,
        scheme        TEXT,
        operation     TEXT NOT NULL CHECK (operation IN ('read', 'write', 'unknown')),
        kind          TEXT NOT NULL,
        action        TEXT NOT NULL CHECK (action IN ('allow', 'block', 'log_only')),
        rule_id       TEXT,
        severity      TEXT,
        confidence    TEXT NOT NULL,
        detector      TEXT NOT NULL,
        tool_name     TEXT,
        runtime_kind  TEXT,
        session_id    TEXT,
        request_id    TEXT,
        evidence      TEXT,
        reason        TEXT,
        promoted      INTEGER NOT NULL DEFAULT 0,
        promoted_at   TIMESTAMP
    )
"""


class TestObservedMigration:
    """An install that predates `observed` has to be able to store one.

    SQLite cannot widen a CHECK in place, so v51 rebuilds the table. The
    rebuild is worth a test precisely because it is a rebuild: the existing
    audit history must survive it intact.
    """

    async def _pre_v51_db(self, tmp_path):
        from securevector.app.database.migrations import migrate_to_v51

        db = DatabaseConnection(tmp_path / "old.db")
        await run_migrations(db)
        conn = await db.connect()
        await conn.execute("DROP TABLE egress_audit")
        await conn.execute(_PRE_V51_EGRESS_AUDIT)
        await conn.commit()
        return db, migrate_to_v51

    @pytest.mark.asyncio
    async def test_observed_is_rejected_before_the_migration(self, tmp_path):
        db, _ = await self._pre_v51_db(tmp_path)
        with pytest.raises(Exception):
            await EgressRepository(db).record(
                host="example.com", detector="codex-transcript")

    @pytest.mark.asyncio
    async def test_migration_widens_the_action_and_keeps_history(self, tmp_path):
        db, migrate_to_v51 = await self._pre_v51_db(tmp_path)
        repo = EgressRepository(db)
        await repo.log_attempts([_verdict("kept.example.com")], session_id="s1")
        await migrate_to_v51(db)
        await repo.record(host="example.com", session_id="s1",
                          detector="codex-transcript")
        rows = {r["host"]: r for r in await repo.session_destinations("s1")}
        assert rows["kept.example.com"]["calls"] == 1
        assert rows["example.com"]["observed"] == 1

    @pytest.mark.asyncio
    async def test_migration_is_idempotent(self, tmp_path):
        db, migrate_to_v51 = await self._pre_v51_db(tmp_path)
        await migrate_to_v51(db)
        await EgressRepository(db).record(host="example.com",
                                          detector="codex-transcript")
        await migrate_to_v51(db)
        assert len(await EgressRepository(db).recent()) == 1

    @pytest.mark.asyncio
    async def test_the_rebuilt_table_keeps_its_indexes(self, tmp_path):
        """Every index lives on the dropped table and has to be recreated."""
        db, migrate_to_v51 = await self._pre_v51_db(tmp_path)
        await migrate_to_v51(db)
        conn = await db.connect()
        cur = await conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index' "
            "AND tbl_name = 'egress_audit'"
        )
        names = {r[0] for r in await cur.fetchall()}
        assert {"idx_egress_audit_time", "idx_egress_audit_host",
                "idx_egress_audit_session"} <= names

    @pytest.mark.asyncio
    async def test_a_crash_after_the_drop_recovers_the_history(self, tmp_path):
        """Interrupted between DROP and RENAME: the staging table IS the audit.

        Dropping it on the next run would delete the history the rebuild was
        supposed to preserve, and leave no `egress_audit` at all.
        """
        db, migrate_to_v51 = await self._pre_v51_db(tmp_path)
        repo = EgressRepository(db)
        await repo.log_attempts([_verdict("kept.example.com")], session_id="s1")
        conn = await db.connect()
        await conn.execute(
            "CREATE TABLE egress_audit_v51 AS SELECT * FROM egress_audit")
        await conn.execute("DROP TABLE egress_audit")
        await conn.commit()

        await migrate_to_v51(db)
        rows = await repo.recent()
        assert [r["host"] for r in rows] == ["kept.example.com"]
        cur = await conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' "
            "AND name = 'egress_audit_v51'")
        assert await cur.fetchone() is None

    @pytest.mark.asyncio
    async def test_a_crash_before_the_drop_discards_the_stale_copy(self, tmp_path):
        db, migrate_to_v51 = await self._pre_v51_db(tmp_path)
        repo = EgressRepository(db)
        await repo.log_attempts([_verdict("live.example.com")], session_id="s1")
        conn = await db.connect()
        await conn.execute(
            "CREATE TABLE egress_audit_v51 AS SELECT * FROM egress_audit")
        await conn.commit()

        await migrate_to_v51(db)
        await repo.record(host="observed.example.com", session_id="s1",
                          detector="codex-transcript")
        assert {r["host"] for r in await repo.recent()} == {
            "live.example.com", "observed.example.com"}
        cur = await conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' "
            "AND name = 'egress_audit_v51'")
        assert await cur.fetchone() is None
