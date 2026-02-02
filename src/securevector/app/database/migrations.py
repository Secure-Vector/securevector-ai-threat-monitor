"""
Database schema migrations for the SecureVector desktop application.

Provides:
- Automatic schema versioning
- Migration tracking
- Forward migrations (no rollback for simplicity)
"""

import logging
from datetime import datetime

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
        4: migrate_to_v4,
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
    conn = await db.connect()

    # Check which columns already exist (initial schema may include them)
    cursor = await conn.execute("PRAGMA table_info(app_settings)")
    existing_columns = {row[1] for row in await cursor.fetchall()}

    columns_to_add = [
        ("cloud_mode_enabled", "INTEGER NOT NULL DEFAULT 0"),
        ("cloud_user_email", "TEXT DEFAULT NULL"),
        ("cloud_connected_at", "TIMESTAMP DEFAULT NULL"),
    ]

    for col_name, col_def in columns_to_add:
        if col_name not in existing_columns:
            await conn.execute(
                f"ALTER TABLE app_settings ADD COLUMN {col_name} {col_def}"
            )

    # Record migration
    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) VALUES (3, CURRENT_TIMESTAMP, 'Add cloud mode fields to app_settings')"
    )

    logger.info("Applied migration v3: cloud mode fields")


async def migrate_to_v4(db: DatabaseConnection) -> None:
    """Migration v3 -> v4: Add LLM review settings and fields."""
    conn = await db.connect()

    # Add llm_settings column to app_settings
    cursor = await conn.execute("PRAGMA table_info(app_settings)")
    existing_columns = {row[1] for row in await cursor.fetchall()}

    if "llm_settings" not in existing_columns:
        await conn.execute(
            "ALTER TABLE app_settings ADD COLUMN llm_settings TEXT DEFAULT NULL"
        )

    # Add LLM review fields to threat_intel_records
    cursor = await conn.execute("PRAGMA table_info(threat_intel_records)")
    existing_columns = {row[1] for row in await cursor.fetchall()}

    llm_columns = [
        ("llm_reviewed", "INTEGER DEFAULT 0"),
        ("llm_agrees", "INTEGER DEFAULT 1"),
        ("llm_confidence", "REAL DEFAULT 0"),
        ("llm_explanation", "TEXT DEFAULT NULL"),
        ("llm_recommendation", "TEXT DEFAULT NULL"),
        ("llm_risk_adjustment", "INTEGER DEFAULT 0"),
        ("llm_model_used", "TEXT DEFAULT NULL"),
        ("llm_tokens_used", "INTEGER DEFAULT 0"),
    ]

    for col_name, col_def in llm_columns:
        if col_name not in existing_columns:
            await conn.execute(
                f"ALTER TABLE threat_intel_records ADD COLUMN {col_name} {col_def}"
            )

    # Record migration
    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) VALUES (4, CURRENT_TIMESTAMP, 'Add LLM review settings and fields')"
    )

    logger.info("Applied migration v4: LLM review settings")


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
    version = await run_migrations(db)

    # Load community rules after schema is ready
    await load_community_rules(db)

    return version


async def load_community_rules(db: DatabaseConnection) -> int:
    """
    Load community rules from YAML files into the database.

    This function reads all community rule YAML files and inserts them
    into the community_rules table. Existing rules are updated if changed.

    Args:
        db: Database connection.

    Returns:
        Number of rules loaded.
    """
    import json
    from pathlib import Path
    import yaml

    # Find community rules directory - check multiple possible locations
    rules_paths = [
        # When installed as package: securevector/rules/community
        Path(__file__).parent.parent.parent / "rules" / "community",
        # Development: src/securevector/rules/community
        Path(__file__).parent.parent.parent.parent / "rules" / "community",
        # Alternative package structure
        Path(__file__).parent.parent / "rules" / "community",
    ]

    rules_path = None
    for p in rules_paths:
        logger.debug(f"Checking rules path: {p}")
        if p.exists():
            rules_path = p
            logger.info(f"Found community rules at: {rules_path}")
            break

    if not rules_path:
        logger.warning(f"Community rules directory not found. Checked: {rules_paths}")
        return 0

    # Check if community_rules table exists
    try:
        row = await db.fetch_one(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='community_rules'"
        )
        if not row:
            logger.debug("community_rules table not found, skipping rule load")
            return 0
    except Exception as e:
        logger.warning(f"Error checking for community_rules table: {e}")
        return 0

    # Load all YAML files
    rule_files = list(rules_path.glob("*.yml")) + list(rules_path.glob("*.yaml"))
    logger.info(f"Found {len(rule_files)} rule files to load")
    loaded_count = 0

    for rule_file in rule_files:
        try:
            logger.debug(f"Loading rules from: {rule_file.name}")
            with open(rule_file, "r", encoding="utf-8") as f:
                rule_data = yaml.safe_load(f)

            if not rule_data or "rules" not in rule_data:
                logger.debug(f"Skipping {rule_file.name}: no 'rules' key found")
                continue

            source_file = rule_file.name

            for rule_entry in rule_data.get("rules", []):
                rule_id = rule_entry.get("id")
                if not rule_id:
                    continue

                name = rule_entry.get("name", rule_id)
                category = rule_entry.get("category", "general")
                description = rule_entry.get("description", "")
                severity = rule_entry.get("severity", "medium").lower()
                patterns = rule_entry.get("patterns", [])
                enabled = 1 if rule_entry.get("enabled", True) else 0
                metadata = rule_entry.get("metadata", {})

                # Validate severity
                if severity not in ("low", "medium", "high", "critical"):
                    severity = "medium"

                # Convert patterns to JSON
                patterns_json = json.dumps(patterns)
                metadata_json = json.dumps(metadata) if metadata else None

                # Upsert rule (INSERT OR REPLACE)
                await db.execute(
                    """
                    INSERT OR REPLACE INTO community_rules
                    (id, name, category, description, severity, patterns, enabled, source_file, metadata, loaded_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    """,
                    (rule_id, name, category, description, severity, patterns_json, enabled, source_file, metadata_json)
                )
                loaded_count += 1

        except Exception as e:
            logger.warning(f"Failed to load rules from {rule_file}: {e}")
            continue

    if loaded_count > 0:
        logger.info(f"Loaded {loaded_count} community rules from {len(rule_files)} files")

    return loaded_count
