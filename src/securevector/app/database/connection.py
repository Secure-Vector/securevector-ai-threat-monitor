"""
Async SQLite database connection management.

Provides:
- Async connection pool using aiosqlite
- Context manager for safe connection handling
- Database initialization and health checks
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator, Optional

import aiosqlite

from securevector.app.utils.platform import get_database_path

logger = logging.getLogger(__name__)


class DatabaseConnection:
    """
    Async SQLite database connection manager.

    Provides connection pooling and context management for
    safe async database operations.
    """

    def __init__(self, db_path: Optional[Path] = None):
        """
        Initialize database connection manager.

        Args:
            db_path: Path to SQLite database file. Uses default if not provided.
        """
        self.db_path = db_path or get_database_path()
        self._connection: Optional[aiosqlite.Connection] = None
        self._lock = asyncio.Lock()

    async def connect(self) -> aiosqlite.Connection:
        """
        Get or create database connection.

        Returns:
            Active aiosqlite connection.
        """
        async with self._lock:
            if self._connection is None:
                logger.info(f"Connecting to database: {self.db_path}")
                self._connection = await aiosqlite.connect(
                    self.db_path,
                    isolation_level=None,  # Autocommit mode
                )
                # Enable foreign keys
                await self._connection.execute("PRAGMA foreign_keys = ON")
                # Enable WAL mode for better concurrency
                await self._connection.execute("PRAGMA journal_mode = WAL")
                # Row factory for dict-like access
                self._connection.row_factory = aiosqlite.Row
                logger.info("Database connection established")

            return self._connection

    async def disconnect(self) -> None:
        """Close database connection if open."""
        async with self._lock:
            if self._connection is not None:
                logger.info("Closing database connection")
                await self._connection.close()
                self._connection = None

    async def is_connected(self) -> bool:
        """Check if database connection is active."""
        return self._connection is not None

    @asynccontextmanager
    async def transaction(self) -> AsyncGenerator[aiosqlite.Connection, None]:
        """
        Context manager for database transactions.

        Automatically commits on success, rolls back on error.

        Yields:
            Active database connection within transaction.
        """
        conn = await self.connect()
        try:
            await conn.execute("BEGIN")
            yield conn
            await conn.execute("COMMIT")
        except Exception:
            await conn.execute("ROLLBACK")
            raise

    async def execute(
        self, sql: str, parameters: tuple = ()
    ) -> aiosqlite.Cursor:
        """
        Execute a SQL statement.

        Args:
            sql: SQL statement to execute.
            parameters: Parameters for the statement.

        Returns:
            Cursor with results.
        """
        conn = await self.connect()
        return await conn.execute(sql, parameters)

    async def execute_many(
        self, sql: str, parameters: list[tuple]
    ) -> aiosqlite.Cursor:
        """
        Execute a SQL statement with multiple parameter sets.

        Args:
            sql: SQL statement to execute.
            parameters: List of parameter tuples.

        Returns:
            Cursor with results.
        """
        conn = await self.connect()
        return await conn.executemany(sql, parameters)

    async def fetch_one(
        self, sql: str, parameters: tuple = ()
    ) -> Optional[aiosqlite.Row]:
        """
        Execute SQL and fetch one result.

        Args:
            sql: SQL query to execute.
            parameters: Parameters for the query.

        Returns:
            Single row or None if no results.
        """
        cursor = await self.execute(sql, parameters)
        return await cursor.fetchone()

    async def fetch_all(
        self, sql: str, parameters: tuple = ()
    ) -> list[aiosqlite.Row]:
        """
        Execute SQL and fetch all results.

        Args:
            sql: SQL query to execute.
            parameters: Parameters for the query.

        Returns:
            List of rows.
        """
        cursor = await self.execute(sql, parameters)
        return await cursor.fetchall()

    async def health_check(self) -> dict:
        """
        Check database health and return status.

        Returns:
            Dictionary with health status information.
        """
        try:
            conn = await self.connect()
            # Simple query to verify connection
            cursor = await conn.execute("SELECT 1")
            await cursor.fetchone()

            # Get record count
            cursor = await conn.execute(
                "SELECT COUNT(*) FROM threat_intel_records"
            )
            row = await cursor.fetchone()
            record_count = row[0] if row else 0

            return {
                "connected": True,
                "record_count": record_count,
                "path": str(self.db_path),
            }
        except Exception as e:
            logger.error(f"Database health check failed: {e}")
            return {
                "connected": False,
                "error": str(e),
                "path": str(self.db_path),
            }


# Global database instance
_db: Optional[DatabaseConnection] = None


def get_database() -> DatabaseConnection:
    """
    Get the global database connection instance.

    Returns:
        DatabaseConnection instance.

    Raises:
        RuntimeError: If database not initialized.
    """
    global _db
    if _db is None:
        _db = DatabaseConnection()
    return _db


async def init_database(db_path: Optional[Path] = None) -> DatabaseConnection:
    """
    Initialize the global database connection.

    Args:
        db_path: Optional custom database path.

    Returns:
        Initialized DatabaseConnection instance.
    """
    global _db
    _db = DatabaseConnection(db_path)
    await _db.connect()
    return _db


async def close_database() -> None:
    """Close the global database connection."""
    global _db
    if _db is not None:
        await _db.disconnect()
        _db = None
