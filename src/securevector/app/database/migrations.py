"""
Database schema migrations for the SecureVector desktop application.

Provides:
- Automatic schema versioning
- Migration tracking
- Forward migrations (no rollback for simplicity)
"""

import logging
from datetime import datetime
from typing import Optional

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.models import (
    CURRENT_SCHEMA_VERSION,
    SCHEMA_DESCRIPTION,
    SCHEMA_SQL,
)

logger = logging.getLogger(__name__)


class MigrationError(Exception):
    """Raised when a migration fails."""

    pass


async def get_current_version(db: DatabaseConnection) -> int:
    """
    Get the current schema version from the database.

    Args:
        db: Database connection.

    Returns:
        Current schema version, or 0 if no version table exists.
    """
    try:
        row = await db.fetch_one(
            "SELECT MAX(version) as version FROM schema_version"
        )
        return row["version"] if row and row["version"] else 0
    except Exception:
        # Table doesn't exist yet
        return 0


async def record_migration(
    db: DatabaseConnection, version: int, description: str
) -> None:
    """
    Record a migration in the schema_version table.

    Args:
        db: Database connection.
        version: Schema version number.
        description: Migration description.
    """
    await db.execute(
        """
        INSERT INTO schema_version (version, applied_at, description)
        VALUES (?, ?, ?)
        """,
        (version, datetime.utcnow().isoformat(), description),
    )
    logger.info(f"Recorded migration v{version}: {description}")


async def apply_initial_schema(db: DatabaseConnection) -> None:
    """
    Apply the initial database schema.

    Args:
        db: Database connection.
    """
    logger.info("Applying initial database schema...")

    # Execute schema SQL (multiple statements)
    conn = await db.connect()
    await conn.executescript(SCHEMA_SQL)

    # Record the migration
    await record_migration(db, 1, SCHEMA_DESCRIPTION)

    logger.info("Initial schema applied successfully")


async def run_migrations(db: DatabaseConnection) -> int:
    """
    Run all pending migrations.

    Args:
        db: Database connection.

    Returns:
        Final schema version after migrations.

    Raises:
        MigrationError: If migration fails.
    """
    current_version = await get_current_version(db)
    logger.info(f"Current schema version: {current_version}")

    if current_version == 0:
        # Fresh database - apply initial schema
        await apply_initial_schema(db)
        current_version = 1

    # Apply any additional migrations
    while current_version < CURRENT_SCHEMA_VERSION:
        next_version = current_version + 1
        logger.info(f"Applying migration to v{next_version}...")

        try:
            await apply_migration(db, next_version)
            current_version = next_version
        except Exception as e:
            logger.error(f"Migration to v{next_version} failed: {e}")
            raise MigrationError(
                f"Failed to migrate to version {next_version}: {e}"
            ) from e

    logger.info(f"Database schema is at version {current_version}")
    return current_version


async def apply_migration(db: DatabaseConnection, version: int) -> None:
    """
    Apply a specific migration.

    Args:
        db: Database connection.
        version: Target schema version.

    Raises:
        MigrationError: If migration version is unknown.
    """
    migrations = {
        2: migrate_to_v2,
        3: migrate_to_v3,
    }

    if version in migrations:
        await migrations[version](db)
    else:
        raise MigrationError(f"Unknown migration version: {version}")


async def migrate_to_v2(db: DatabaseConnection) -> None:
    """Migration v1 -> v2: Add community rules cache table."""
    from securevector.app.database.models import MIGRATION_V2_SQL

    conn = await db.connect()
    await conn.executescript(MIGRATION_V2_SQL)
    logger.info("Applied migration v2: community rules cache table")


async def migrate_to_v3(db: DatabaseConnection) -> None:
    """Migration v2 -> v3: Add cloud mode fields to app_settings."""
    from securevector.app.database.models import MIGRATION_V3_SQL

    conn = await db.connect()
    await conn.executescript(MIGRATION_V3_SQL)
    logger.info("Applied migration v3: cloud mode fields")


# Future migration functions would be defined here:
#
# async def migrate_to_v2(db: DatabaseConnection) -> None:
#     """Migration v1 -> v2: Add aggregated statistics table."""
#     await db.execute("""
#         CREATE TABLE IF NOT EXISTS statistics_cache (
#             ...
#         )
#     """)
#     await record_migration(db, 2, "Add statistics cache table")


async def check_database_health(db: DatabaseConnection) -> dict:
    """
    Check database health and schema status.

    Args:
        db: Database connection.

    Returns:
        Health status dictionary.
    """
    try:
        version = await get_current_version(db)
        needs_migration = version < CURRENT_SCHEMA_VERSION

        # Count records
        row = await db.fetch_one(
            "SELECT COUNT(*) as count FROM threat_intel_records"
        )
        record_count = row["count"] if row else 0

        return {
            "healthy": True,
            "schema_version": version,
            "needs_migration": needs_migration,
            "target_version": CURRENT_SCHEMA_VERSION,
            "record_count": record_count,
        }
    except Exception as e:
        return {
            "healthy": False,
            "error": str(e),
        }


async def init_database_schema(db: DatabaseConnection) -> int:
    """
    Initialize database schema, running migrations if needed.

    This is the main entry point for database initialization.

    Args:
        db: Database connection.

    Returns:
        Final schema version.
    """
    logger.info("Initializing database schema...")
    return await run_migrations(db)
