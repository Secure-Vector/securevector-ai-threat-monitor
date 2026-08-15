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
