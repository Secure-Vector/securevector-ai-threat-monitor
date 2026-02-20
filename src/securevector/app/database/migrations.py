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
    MIGRATION_V12_SQL,
    MIGRATION_V13_SQL,
    MIGRATION_V14_SQL,
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
        5: migrate_to_v5,
        6: migrate_to_v6,
        7: migrate_to_v7,
        8: migrate_to_v8,
        9: migrate_to_v9,
        10: migrate_to_v10,
        11: migrate_to_v11,
        12: migrate_to_v12,
        13: migrate_to_v13,
        14: migrate_to_v14,
        15: migrate_to_v15,
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


async def migrate_to_v5(db: DatabaseConnection) -> None:
    """Migration v4 -> v5: Add user_agent column for client tracking."""
    conn = await db.connect()

    # Check if column already exists
    cursor = await conn.execute("PRAGMA table_info(threat_intel_records)")
    existing_columns = {row[1] for row in await cursor.fetchall()}

    if "user_agent" not in existing_columns:
        await conn.execute(
            "ALTER TABLE threat_intel_records ADD COLUMN user_agent TEXT DEFAULT NULL"
        )

    # Record migration
    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) VALUES (5, CURRENT_TIMESTAMP, 'Add user_agent column for client tracking')"
    )

    logger.info("Applied migration v5: user_agent column")


async def migrate_to_v6(db: DatabaseConnection) -> None:
    """Migration v5 -> v6: Add scan_llm_responses setting for output leakage detection."""
    conn = await db.connect()

    # Check if column already exists
    cursor = await conn.execute("PRAGMA table_info(app_settings)")
    existing_columns = {row[1] for row in await cursor.fetchall()}

    if "scan_llm_responses" not in existing_columns:
        await conn.execute(
            "ALTER TABLE app_settings ADD COLUMN scan_llm_responses INTEGER NOT NULL DEFAULT 1"
        )

    # Record migration
    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) VALUES (6, CURRENT_TIMESTAMP, 'Add scan_llm_responses setting for output leakage detection')"
    )

    logger.info("Applied migration v6: scan_llm_responses setting")


async def migrate_to_v7(db: DatabaseConnection) -> None:
    """Migration v6 -> v7: Add block_threats setting for proxy blocking mode."""
    conn = await db.connect()

    # Check if column already exists
    cursor = await conn.execute("PRAGMA table_info(app_settings)")
    existing_columns = {row[1] for row in await cursor.fetchall()}

    if "block_threats" not in existing_columns:
        # Default to 1 (enabled) - block threats by default for security-first stance
        await conn.execute(
            "ALTER TABLE app_settings ADD COLUMN block_threats INTEGER NOT NULL DEFAULT 1"
        )

    # Record migration
    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) VALUES (7, CURRENT_TIMESTAMP, 'Add block_threats setting for proxy blocking mode')"
    )

    logger.info("Applied migration v7: block_threats setting")


async def migrate_to_v8(db: DatabaseConnection) -> None:
    """Migration v7 -> v8: Add action_taken column to track blocked vs logged threats."""
    conn = await db.connect()

    # Check if column already exists
    cursor = await conn.execute("PRAGMA table_info(threat_intel_records)")
    existing_columns = {row[1] for row in await cursor.fetchall()}

    if "action_taken" not in existing_columns:
        # Default to 'logged' for existing records
        await conn.execute(
            "ALTER TABLE threat_intel_records ADD COLUMN action_taken TEXT DEFAULT 'logged'"
        )

    # Record migration
    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) VALUES (8, CURRENT_TIMESTAMP, 'Add action_taken column to track blocked vs logged threats')"
    )

    logger.info("Applied migration v8: action_taken column")


async def migrate_to_v9(db: DatabaseConnection) -> None:
    """Migration v8 -> v9: Add tool permissions support."""
    conn = await db.connect()

    # Create tool_essential_overrides table
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tool_essential_overrides (
            tool_id TEXT PRIMARY KEY,
            action TEXT NOT NULL CHECK (action IN ('block', 'allow')),
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )

    # Add tool_permissions_enabled to app_settings
    cursor = await conn.execute("PRAGMA table_info(app_settings)")
    existing_columns = {row[1] for row in await cursor.fetchall()}

    if "tool_permissions_enabled" not in existing_columns:
        await conn.execute(
            "ALTER TABLE app_settings ADD COLUMN tool_permissions_enabled INTEGER NOT NULL DEFAULT 0"
        )

    # Record migration
    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) VALUES (9, CURRENT_TIMESTAMP, 'Add tool permissions support')"
    )

    logger.info("Applied migration v9: tool permissions support")


async def migrate_to_v10(db: DatabaseConnection) -> None:
    """Migration v9 -> v10: Add custom tools table."""
    conn = await db.connect()

    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS custom_tools (
            tool_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'custom',
            risk TEXT NOT NULL DEFAULT 'write' CHECK (risk IN ('read','write','delete','admin')),
            default_permission TEXT NOT NULL DEFAULT 'block' CHECK (default_permission IN ('block','allow')),
            description TEXT DEFAULT '',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )

    # Record migration
    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) VALUES (10, CURRENT_TIMESTAMP, 'Add custom tools support')"
    )

    logger.info("Applied migration v10: custom tools table")


async def migrate_to_v11(db: DatabaseConnection) -> None:
    """Migration v10 -> v11: Add tool rate limiting."""
    conn = await db.connect()

    # Add rate limit columns to custom_tools (nullable = no limit)
    cursor = await conn.execute("PRAGMA table_info(custom_tools)")
    existing_columns = {row[1] for row in await cursor.fetchall()}

    rate_limit_columns = [
        ("rate_limit_max_calls", "INTEGER DEFAULT NULL"),
        ("rate_limit_window_seconds", "INTEGER DEFAULT NULL"),
    ]

    for col_name, col_def in rate_limit_columns:
        if col_name not in existing_columns:
            await conn.execute(
                f"ALTER TABLE custom_tools ADD COLUMN {col_name} {col_def}"
            )

    # Add rate limit columns to tool_essential_overrides too
    cursor = await conn.execute("PRAGMA table_info(tool_essential_overrides)")
    existing_columns = {row[1] for row in await cursor.fetchall()}

    for col_name, col_def in rate_limit_columns:
        if col_name not in existing_columns:
            await conn.execute(
                f"ALTER TABLE tool_essential_overrides ADD COLUMN {col_name} {col_def}"
            )

    # Create tool_call_log table for tracking calls
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tool_call_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tool_id TEXT NOT NULL,
            called_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )

    # Index for fast window queries
    await conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_tool_call_log_lookup
        ON tool_call_log (tool_id, called_at)
        """
    )

    # Record migration
    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) VALUES (11, CURRENT_TIMESTAMP, 'Add tool rate limiting')"
    )

    logger.info("Applied migration v11: tool rate limiting")


async def migrate_to_v12(db: DatabaseConnection) -> None:
    """Migration v11 -> v12: Add LLM cost tracking tables."""
    conn = await db.connect()
    await conn.executescript(MIGRATION_V12_SQL)

    # Add cost_tracking_enabled to app_settings
    cursor = await conn.execute("PRAGMA table_info(app_settings)")
    existing_columns = {row[1] for row in await cursor.fetchall()}

    if "cost_tracking_enabled" not in existing_columns:
        await conn.execute(
            "ALTER TABLE app_settings ADD COLUMN cost_tracking_enabled INTEGER NOT NULL DEFAULT 1"
        )

    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) VALUES (12, CURRENT_TIMESTAMP, 'Add LLM cost tracking tables')"
    )

    logger.info("Applied migration v12: LLM cost tracking tables")


async def migrate_to_v13(db: DatabaseConnection) -> None:
    """Migration v12 -> v13: Add budget limits for cost control."""
    conn = await db.connect()
    await conn.executescript(MIGRATION_V13_SQL)

    # Add global budget columns to app_settings
    cursor = await conn.execute("PRAGMA table_info(app_settings)")
    existing_columns = {row[1] for row in await cursor.fetchall()}

    budget_columns = [
        ("daily_budget_usd", "REAL DEFAULT NULL"),
        ("budget_action", "TEXT DEFAULT 'warn'"),
    ]
    for col_name, col_def in budget_columns:
        if col_name not in existing_columns:
            await conn.execute(
                f"ALTER TABLE app_settings ADD COLUMN {col_name} {col_def}"
            )

    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) VALUES (13, CURRENT_TIMESTAMP, 'Add budget limits for cost control')"
    )
    logger.info("Applied migration v13: budget limits")


async def migrate_to_v14(db: DatabaseConnection) -> None:
    """Migration v13 -> v14: Add input_cached_tokens column to llm_cost_records."""
    conn = await db.connect()
    # ALTER TABLE doesn't support IF NOT EXISTS in SQLite — check first
    cursor = await conn.execute("PRAGMA table_info(llm_cost_records)")
    existing_columns = {row[1] for row in await cursor.fetchall()}
    if "input_cached_tokens" not in existing_columns:
        await conn.execute(
            "ALTER TABLE llm_cost_records ADD COLUMN input_cached_tokens INTEGER NOT NULL DEFAULT 0"
        )
    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) VALUES (14, CURRENT_TIMESTAMP, 'Add cached token tracking')"
    )
    logger.info("Applied migration v14: cached token tracking")


async def migrate_to_v15(db: DatabaseConnection) -> None:
    """Migration v14 -> v15: Add tool call audit log for full block/allow history."""
    conn = await db.connect()

    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tool_call_audit (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            tool_id      TEXT NOT NULL,
            function_name TEXT NOT NULL,
            action       TEXT NOT NULL CHECK (action IN ('block', 'allow', 'log_only')),
            risk         TEXT,
            reason       TEXT,
            is_essential INTEGER NOT NULL DEFAULT 0,
            args_preview TEXT,
            called_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )

    await conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_tool_call_audit_lookup
        ON tool_call_audit (action, called_at)
        """
    )

    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) "
        "VALUES (15, CURRENT_TIMESTAMP, 'Add tool call audit log')"
    )

    logger.info("Applied migration v15: tool call audit log")


async def load_model_pricing(db: DatabaseConnection) -> int:
    """
    Load model pricing from YAML file into the model_pricing table.

    Reads pricing/model_pricing.yml and upserts all entries.
    """
    import json
    from pathlib import Path
    import yaml

    # Check multiple possible locations (same pattern as load_community_rules)
    pricing_paths = [
        Path(__file__).parent.parent.parent / "pricing" / "model_pricing.yml",
        Path(__file__).parent.parent.parent.parent / "pricing" / "model_pricing.yml",
        Path(__file__).parent.parent / "pricing" / "model_pricing.yml",
    ]

    pricing_path = None
    for p in pricing_paths:
        if p.exists():
            pricing_path = p
            logger.info(f"Found model pricing at: {pricing_path}")
            break

    if not pricing_path:
        logger.warning(f"Model pricing YAML not found. Checked: {pricing_paths}")
        return 0

    # Check if model_pricing table exists
    try:
        row = await db.fetch_one(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='model_pricing'"
        )
        if not row:
            logger.debug("model_pricing table not found, skipping pricing load")
            return 0
    except Exception as e:
        logger.warning(f"Error checking for model_pricing table: {e}")
        return 0

    try:
        with open(pricing_path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
    except Exception as e:
        logger.warning(f"Failed to read model_pricing.yml: {e}")
        return 0

    loaded_count = 0
    for provider_entry in data.get("providers", []):
        provider = provider_entry.get("provider", "")
        if not provider:
            continue

        for model in provider_entry.get("models", []):
            model_id = model.get("model_id", "")
            if not model_id:
                continue

            pricing_id = f"{provider}/{model_id}"
            display_name = model.get("display_name", model_id)
            input_per_million = float(model.get("input_per_million", 0.0))
            output_per_million = float(model.get("output_per_million", 0.0))
            effective_date = model.get("effective_date")
            verified_at = model.get("verified_at")
            source_url = provider_entry.get("source_url")

            try:
                await db.execute(
                    """
                    INSERT OR IGNORE INTO model_pricing
                    (id, provider, model_id, display_name, input_per_million, output_per_million,
                     effective_date, verified_at, source_url, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    """,
                    (pricing_id, provider, model_id, display_name, input_per_million,
                     output_per_million, effective_date, verified_at, source_url),
                )
                loaded_count += 1
            except Exception as e:
                logger.warning(f"Failed to insert pricing for {pricing_id}: {e}")

    if loaded_count > 0:
        logger.info(f"Loaded {loaded_count} model pricing entries")

    return loaded_count


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

    # Load model pricing after schema is ready
    await load_model_pricing(db)

    # Clean up old cost records per retention policy
    await cleanup_old_cost_records(db)

    return version


async def cleanup_old_cost_records(db: DatabaseConnection) -> None:
    """Delete LLM cost records older than the app's retention_days setting."""
    try:
        row = await db.fetch_one("SELECT retention_days FROM app_settings WHERE id = 1")
        retention_days = row["retention_days"] if row and row["retention_days"] else 30

        from securevector.app.database.repositories.costs import CostsRepository
        repo = CostsRepository(db)
        deleted = await repo.cleanup_old_records(retention_days)
        if deleted > 0:
            logger.info(f"Cleaned up {deleted} expired cost records (retention: {retention_days} days)")
    except Exception as e:
        logger.debug(f"Cost records cleanup skipped: {e}")


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
