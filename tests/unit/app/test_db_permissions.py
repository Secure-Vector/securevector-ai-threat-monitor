"""The audit trail is a security record, not a log file.

A 6.0.0 release-gate criterion: "Token file and audit DB readable only by the
installing OS user." The token was 0600 from the start; the database was 0644
until 2026-09-21, which meant every row of the enforcement log was readable by
any account on the machine.
"""

from __future__ import annotations

import os
import stat

import pytest

from securevector.app.database.connection import DatabaseConnection, _restrict_to_owner

pytestmark = pytest.mark.skipif(os.name != "posix", reason="POSIX modes only")


def _mode(path):
    return stat.S_IMODE(os.stat(path).st_mode)


@pytest.mark.asyncio
async def test_connecting_restricts_the_database_to_its_owner(tmp_path):
    db = tmp_path / "threat_intel.db"
    conn = DatabaseConnection(db_path=db)
    await conn.connect()
    try:
        assert _mode(db) == 0o600, "the audit trail must not be world readable"
    finally:
        await conn.disconnect()


@pytest.mark.asyncio
async def test_the_wal_siblings_are_restricted_too(tmp_path):
    """WAL holds rows that are not yet in the .db file. Restricting only the
    database would leave the most recent writes readable by anyone.

    Setting `PRAGMA journal_mode = WAL` alone does not put `-wal`/`-shm` on
    disk -- SQLite only materialises them on the first write transaction --
    so a bare `connect()` with nothing written leaves both absent. The old
    `if os.path.exists(sibling): assert ...` treated "absent" as "nothing to
    check" and passed either way, which never actually exercised the
    criterion unless a write happened to occur first for some unrelated
    reason. A real write here forces both siblings into existence; existence
    is asserted BEFORE mode so a future regression that stops restricting
    them fails loudly instead of being silently skipped."""
    db = tmp_path / "threat_intel.db"
    conn = DatabaseConnection(db_path=db)
    await conn.connect()
    try:
        await conn.execute("CREATE TABLE wal_probe (id INTEGER)")
        await conn.execute("INSERT INTO wal_probe VALUES (1)")
        for sibling in (f"{db}-wal", f"{db}-shm"):
            assert os.path.exists(sibling), f"{sibling} was expected to exist after a write"
            assert _mode(sibling) == 0o600, sibling
    finally:
        await conn.disconnect()


@pytest.mark.asyncio
async def test_a_database_left_world_readable_by_an_older_build_is_tightened(tmp_path):
    """Upgrades matter more than fresh installs here: every existing install
    has a 0644 database on disk right now."""
    db = tmp_path / "threat_intel.db"
    db.write_bytes(b"")
    os.chmod(db, 0o644)
    conn = DatabaseConnection(db_path=db)
    await conn.connect()
    try:
        assert _mode(db) == 0o600
    finally:
        await conn.disconnect()


def test_a_filesystem_that_cannot_hold_the_mode_does_not_break_startup(tmp_path, monkeypatch):
    """A network share or a FAT volume can refuse chmod. The app still has to
    open; the warning is what a security review reads."""
    db = tmp_path / "threat_intel.db"
    db.write_bytes(b"")

    def refuse(*a, **k):
        raise OSError("read-only filesystem")

    monkeypatch.setattr(os, "chmod", refuse)
    _restrict_to_owner(db)  # must not raise


def test_windows_is_left_to_its_directory_acl(monkeypatch, tmp_path):
    """chmod cannot express "this user only" on Windows, so attempting it
    would report success without restricting anything."""
    db = tmp_path / "threat_intel.db"
    db.write_bytes(b"")
    called = []
    monkeypatch.setattr(os, "name", "nt")
    monkeypatch.setattr(os, "chmod", lambda *a, **k: called.append(a))
    _restrict_to_owner(db)
    assert called == []
