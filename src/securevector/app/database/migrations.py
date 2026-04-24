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
    MIGRATION_V18_SQL,
    MIGRATION_V19_SQL,
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
        16: migrate_to_v16,
        17: migrate_to_v17,
        18: migrate_to_v18,
        19: migrate_to_v19,
        20: migrate_to_v20,
        21: migrate_to_v21,
        22: migrate_to_v22,
        23: migrate_to_v23,
        24: migrate_to_v24,
        25: migrate_to_v25,
        26: migrate_to_v26,
        27: migrate_to_v27,
        28: migrate_to_v28,
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
        # Default to 0 (disabled) - let users opt in to blocking
        await conn.execute(
            "ALTER TABLE app_settings ADD COLUMN block_threats INTEGER NOT NULL DEFAULT 0"
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
            "ALTER TABLE app_settings ADD COLUMN tool_permissions_enabled INTEGER NOT NULL DEFAULT 1"
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

    # Seed pricing on fresh installs
    await load_model_pricing(db)


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


async def migrate_to_v16(db: DatabaseConnection) -> None:
    """Migration v15 -> v16: Seed model pricing reference data."""
    count = await load_model_pricing(db)
    conn = await db.connect()
    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) "
        "VALUES (16, CURRENT_TIMESTAMP, 'Seed model pricing reference data')"
    )
    logger.info(f"Applied migration v16: seeded {count} model pricing entries")


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
                # Upsert — if YAML has newer prices for an existing model, update them.
                # This is what makes "pip install --upgrade + restart" propagate pricing changes.
                await db.execute(
                    """
                    INSERT INTO model_pricing
                    (id, provider, model_id, display_name, input_per_million, output_per_million,
                     effective_date, verified_at, source_url, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(id) DO UPDATE SET
                        display_name = excluded.display_name,
                        input_per_million = excluded.input_per_million,
                        output_per_million = excluded.output_per_million,
                        effective_date = excluded.effective_date,
                        verified_at = excluded.verified_at,
                        source_url = excluded.source_url,
                        updated_at = CURRENT_TIMESTAMP
                    """,
                    (pricing_id, provider, model_id, display_name, input_per_million,
                     output_per_million, effective_date, verified_at, source_url),
                )
                loaded_count += 1
            except Exception as e:
                logger.warning(f"Failed to upsert pricing for {pricing_id}: {e}")

    if loaded_count > 0:
        logger.info(f"Loaded {loaded_count} model pricing entries")

    return loaded_count


async def migrate_to_v17(db: DatabaseConnection) -> None:
    """Migration v16 -> v17: Default block_threats to disabled (opt-in)."""
    conn = await db.connect()
    await conn.execute("UPDATE app_settings SET block_threats = 0")
    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) "
        "VALUES (17, CURRENT_TIMESTAMP, 'Default block_threats to disabled')"
    )
    logger.info("Applied migration v17: block_threats defaulted to disabled")

    # Also patch svconfig.yml so apply_config_to_db (called after migrations)
    # doesn't read block_mode: true and override the DB back to enabled.
    try:
        from securevector.app.utils.config_file import get_config_path
        config_path = get_config_path()
        if config_path.exists():
            content = config_path.read_text(encoding="utf-8")
            if "block_mode: true" in content:
                content = content.replace("block_mode: true", "block_mode: false")
                config_path.write_text(content, encoding="utf-8")
                logger.info("Migration v17: patched svconfig.yml block_mode to false")
    except Exception as e:
        logger.warning(f"Migration v17: could not patch svconfig.yml: {e}")


async def migrate_to_v18(db: DatabaseConnection) -> None:
    """Migration v17 -> v18: Add skill scan records table for OpenClaw Skill Scanner."""
    conn = await db.connect()
    await conn.executescript(MIGRATION_V18_SQL)
    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) "
        "VALUES (18, CURRENT_TIMESTAMP, 'Add skill scan records table')"
    )
    logger.info("Applied migration v18: skill scan records table")


async def migrate_to_v19(db: DatabaseConnection) -> None:
    """Migration v18 -> v19: Add skill permissions and policy engine tables."""
    conn = await db.connect()
    await conn.executescript(MIGRATION_V19_SQL)

    # Seed default permissions from policy_defaults
    await _seed_skill_permissions(db)
    await _seed_trusted_publishers(db)

    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) "
        "VALUES (19, CURRENT_TIMESTAMP, 'Add skill permissions and policy engine tables')"
    )
    logger.info("Applied migration v19: skill permissions and policy engine tables")


async def _seed_skill_permissions(db: DatabaseConnection) -> None:
    """Seed skill_permissions table with defaults from policy_defaults.py."""
    from securevector.app.services.policy_defaults import (
        NETWORK_PERMISSIONS,
        ENV_VAR_PERMISSIONS,
        FILE_PATH_PERMISSIONS,
        SHELL_COMMAND_PERMISSIONS,
    )

    category_map = [
        ("network", NETWORK_PERMISSIONS),
        ("env_var", ENV_VAR_PERMISSIONS),
        ("file_path", FILE_PATH_PERMISSIONS),
        ("shell_command", SHELL_COMMAND_PERMISSIONS),
    ]

    count = 0
    for category, permissions in category_map:
        for pattern, classification, label in permissions:
            await db.execute(
                """
                INSERT OR IGNORE INTO skill_permissions
                    (category, pattern, classification, label, is_default, enabled)
                VALUES (?, ?, ?, ?, 1, 1)
                """,
                (category, pattern, classification, label),
            )
            count += 1

    logger.info(f"Seeded {count} default skill permissions")


async def _seed_trusted_publishers(db: DatabaseConnection) -> None:
    """Seed skill_trusted_publishers table with defaults."""
    from securevector.app.services.policy_defaults import TRUSTED_PUBLISHERS

    for publisher_name, trust_level in TRUSTED_PUBLISHERS:
        await db.execute(
            """
            INSERT OR IGNORE INTO skill_trusted_publishers
                (publisher_name, trust_level, is_default)
            VALUES (?, ?, 1)
            """,
            (publisher_name, trust_level),
        )

    logger.info(f"Seeded {len(TRUSTED_PUBLISHERS)} trusted publishers")


# ---------------------------------------------------------------------------
# v20 — Hash-chain tool_call_audit for tamper-evidence
# ---------------------------------------------------------------------------
#
# Context (PR #46 / @desiorac review comment):
#     Tool call logs stored on disk can be modified after the fact. If a
#     compromised agent rewrites its own audit log, you lose the forensic
#     value. We committed to: hash-chained rows (catches casual tampering
#     + disk corruption; doesn't stop a determined local attacker who
#     recomputes the chain — off-host tamper evidence is the customer's
#     choice via the SIEM forwarder, not a bundled-in SV cloud sync).
#
# Design:
#     Each row gets three new columns:
#       seq        — monotonically increasing chain position (1, 2, 3, ...)
#       prev_hash  — hex SHA-256 of the previous row's row_hash
#       row_hash   — hex SHA-256 of a canonical serialization of THIS row's
#                    immutable fields combined with prev_hash. Defined as:
#                        SHA-256(
#                            prev_hash +
#                            "\n" + seq +
#                            "\n" + tool_id +
#                            "\n" + function_name +
#                            "\n" + action +
#                            "\n" + (risk or "") +
#                            "\n" + (reason or "") +
#                            "\n" + str(is_essential) +
#                            "\n" + (args_preview or "") +
#                            "\n" + called_at
#                        )
#     For the first row in the chain prev_hash is "GENESIS".
#
#     The migration backfills existing rows in id-order so the chain is
#     valid from the moment v20 is applied.
# ---------------------------------------------------------------------------
async def migrate_to_v20(db: DatabaseConnection) -> None:
    """v19 -> v20: hash-chain tool_call_audit rows for tamper-evidence."""
    import hashlib

    conn = await db.connect()

    # Add columns (nullable initially so we can backfill before making them required)
    await conn.execute("ALTER TABLE tool_call_audit ADD COLUMN seq INTEGER")
    await conn.execute("ALTER TABLE tool_call_audit ADD COLUMN prev_hash TEXT")
    await conn.execute("ALTER TABLE tool_call_audit ADD COLUMN row_hash TEXT")

    # Backfill the chain over existing rows in id-order.
    # SECURITY NOTE: these pre-v20 rows were written without integrity
    # protection — the chain merely certifies their state at v20-upgrade time,
    # not their authenticity before that. This is the honest behavior.
    cursor = await conn.execute(
        """
        SELECT id, tool_id, function_name, action,
               COALESCE(risk, '') AS risk,
               COALESCE(reason, '') AS reason,
               is_essential,
               COALESCE(args_preview, '') AS args_preview,
               called_at
        FROM tool_call_audit
        ORDER BY id ASC
        """
    )
    rows = await cursor.fetchall()

    prev_hash = "GENESIS"
    seq = 0
    for row in rows:
        seq += 1
        canonical = "\n".join([
            prev_hash,
            str(seq),
            str(row["tool_id"]),
            str(row["function_name"]),
            str(row["action"]),
            str(row["risk"]),
            str(row["reason"]),
            str(row["is_essential"]),
            str(row["args_preview"]),
            str(row["called_at"]),
        ])
        row_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        await conn.execute(
            "UPDATE tool_call_audit SET seq = ?, prev_hash = ?, row_hash = ? WHERE id = ?",
            (seq, prev_hash, row_hash, row["id"]),
        )
        prev_hash = row_hash

    # Index on seq for fast tail lookup when appending.
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tool_call_audit_seq ON tool_call_audit (seq)"
    )

    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) "
        "VALUES (20, CURRENT_TIMESTAMP, 'Hash-chain tool_call_audit rows for tamper-evidence')"
    )
    logger.info(f"Applied migration v20: hash-chained {seq} existing audit row(s)")


# ---------------------------------------------------------------------------
# v21 — Stable per-device identifier on every scan and audit row
# ---------------------------------------------------------------------------
#
# The scan and audit tables previously identified *agents* (via
# source_identifier / session_id / request_id) but not *devices*.
# Enterprise customers running SecureVector across a fleet need to slice
# threat activity by laptop, so we add a `device_id` column to both
# tables and stamp every new row with the stable ID from
# `securevector.app.utils.device_id.get_device_id()`.
#
# device_id is derived from the OS machine identifier (IOPlatformUUID /
# /etc/machine-id / MachineGuid), SHA-256-hashed with a namespace
# prefix. Stable across app reinstalls on the same machine. Cached in
# `{app_data}/.device_id` so the OS fetch happens at most once.
#
# The hash chain canonical serialization is intentionally UNCHANGED —
# we treat device_id as metadata, not as material in the chain. Adding
# it to the canonical string would break verify_audit_chain() for every
# already-backfilled row. Tamper evidence still covers the fields that
# matter (action / risk / reason / args_preview).
async def migrate_to_v21(db: DatabaseConnection) -> None:
    """v20 -> v21: device_id column on threat_intel_records + tool_call_audit.

    Both ALTER statements are idempotent via PRAGMA table_info so
    migrating a DB that already has the column (e.g. re-running on a
    restored backup) is a no-op.

    Existing rows keep device_id = NULL. Backfilling them would be
    misleading — we can't retroactively know which device wrote a row
    that predates the column. The UI / forwarders handle NULL as
    'unknown device'.
    """
    conn = await db.connect()

    for table in ("threat_intel_records", "tool_call_audit"):
        cur = await conn.execute(f"PRAGMA table_info({table})")
        existing = {row[1] for row in await cur.fetchall()}
        if "device_id" not in existing:
            await conn.execute(
                f"ALTER TABLE {table} ADD COLUMN device_id TEXT DEFAULT NULL"
            )

    # Index so dashboards can filter efficiently per device.
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_threat_intel_device "
        "ON threat_intel_records (device_id)"
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tool_call_audit_device "
        "ON tool_call_audit (device_id)"
    )

    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) "
        "VALUES (21, CURRENT_TIMESTAMP, 'Device ID on scans + audit rows')"
    )
    logger.info("Applied migration v21: device_id columns + indexes")


# ---------------------------------------------------------------------------
# v22 — external_forwarders config table (SIEM export)
# ---------------------------------------------------------------------------
async def migrate_to_v22(db: DatabaseConnection) -> None:
    """v21 -> v22: external SIEM forwarders config table.

    Stores one row per user-configured destination (Splunk HEC, Datadog,
    generic webhook, OTLP/HTTP). Secrets themselves are NEVER stored
    here — only a `secret_ref` that resolves to a 0o600 file in the app
    data dir, so an exfil of this SQLite file gives URLs and names but
    no tokens.
    """
    conn = await db.connect()

    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS external_forwarders (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            kind                TEXT    NOT NULL CHECK (kind IN ('webhook', 'splunk_hec', 'datadog', 'otlp_http')),
            name                TEXT    NOT NULL,
            url                 TEXT    NOT NULL,
            secret_ref          TEXT,
            headers_json        TEXT,
            event_filter        TEXT    NOT NULL DEFAULT 'threats_only' CHECK (event_filter IN ('all', 'threats_only', 'audits_only')),
            include_tool_audits INTEGER NOT NULL DEFAULT 1,
            redaction_level     TEXT    NOT NULL DEFAULT 'standard' CHECK (redaction_level IN ('standard', 'minimal')),
            enabled             INTEGER NOT NULL DEFAULT 1,
            created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_success_at     TIMESTAMP,
            last_failure_at     TIMESTAMP,
            last_error          TEXT,
            consecutive_fails   INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_external_forwarders_enabled "
        "ON external_forwarders (enabled, id)"
    )

    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) "
        "VALUES (22, CURRENT_TIMESTAMP, 'External SIEM forwarders config')"
    )
    logger.info("Applied migration v22: external_forwarders")


# ---------------------------------------------------------------------------
# v23 — external_forward_outbox (per-destination queue)
# ---------------------------------------------------------------------------
async def migrate_to_v23(db: DatabaseConnection) -> None:
    """v22 -> v23: per-destination outbox for SIEM forwarding.

    Fan-out model: one enqueue at the call site produces N outbox rows
    (one per enabled forwarder that passes the event filter). Each row
    is delivered independently, so a failing Datadog destination never
    blocks Splunk. ON DELETE CASCADE means removing a forwarder wipes
    its queued rows automatically.
    """
    conn = await db.connect()

    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS external_forward_outbox (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            forwarder_id  INTEGER NOT NULL REFERENCES external_forwarders(id) ON DELETE CASCADE,
            kind          TEXT NOT NULL CHECK (kind IN ('scan', 'output_scan', 'tool_audit')),
            payload_json  TEXT NOT NULL,
            created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            attempts      INTEGER NOT NULL DEFAULT 0,
            delivered_at  TIMESTAMP,
            last_error    TEXT
        )
        """
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_external_forward_outbox_pending "
        "ON external_forward_outbox (forwarder_id, delivered_at, id) "
        "WHERE delivered_at IS NULL"
    )

    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) "
        "VALUES (23, CURRENT_TIMESTAMP, 'External SIEM forward outbox')"
    )
    logger.info("Applied migration v23: external_forward_outbox")


# ---------------------------------------------------------------------------
# v24 — Global SIEM forwarding kill-switch
# ---------------------------------------------------------------------------
#
# Per-destination `enabled` on external_forwarders already lets a user turn
# individual destinations off. This adds a SINGLE global switch so a user
# can pause ALL outbound forwarding in one click without touching each
# destination row. Checked at enqueue time in the `_siem_enqueue_*`
# helpers — when off, the call returns immediately, nothing lands in the
# outbox, and the background forwarder never wakes for that event.
#
# In-flight outbox rows from before the flip still drain — we don't strand
# rows. Re-enabling resumes new-event capture.
async def migrate_to_v24(db: DatabaseConnection) -> None:
    """v23 -> v24: global SIEM forwarding enable flag on app_settings."""
    conn = await db.connect()
    cur = await conn.execute("PRAGMA table_info(app_settings)")
    existing = {row[1] for row in await cur.fetchall()}
    if "siem_forwarding_enabled" not in existing:
        await conn.execute(
            "ALTER TABLE app_settings "
            "ADD COLUMN siem_forwarding_enabled INTEGER NOT NULL DEFAULT 1"
        )

    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) "
        "VALUES (24, CURRENT_TIMESTAMP, 'Global SIEM forwarding kill-switch')"
    )
    logger.info("Applied migration v24: siem_forwarding_enabled flag")


# ---------------------------------------------------------------------------
# v25 — Allow `full` redaction level on SIEM forwarders
# ---------------------------------------------------------------------------
#
# The v22 constraint was CHECK redaction_level IN ('standard', 'minimal'). To
# let SOC teams receive the actual prompt text + LLM output + matched
# patterns in their own SIEM (class 2001 raw_data + unmapped.llm_output),
# we add a third tier: `full`.
#
# SQLite doesn't support ALTER COLUMN DROP CONSTRAINT, so the migration
# rebuilds the table: copy → drop → rename. Same idempotency guard as
# every other column-level migration here.
async def migrate_to_v25(db: DatabaseConnection) -> None:
    """v24 -> v25: relax external_forwarders.redaction_level to allow 'full'."""
    conn = await db.connect()

    # If a fresh schema already permits 'full', short-circuit. We key on
    # the presence of an existing forwarder with redaction_level='full' —
    # if none and the CHECK is tight, the rebuild below handles the rest.
    cur = await conn.execute("PRAGMA table_info(external_forwarders)")
    cols = await cur.fetchall()
    if not cols:
        # Table doesn't exist on this DB yet — nothing to do. A later
        # migrate_to_v22 run on an older install will create it with the
        # new CHECK.
        await conn.execute(
            "INSERT INTO schema_version (version, applied_at, description) "
            "VALUES (25, CURRENT_TIMESTAMP, 'SIEM forwarder redaction_level full tier (no-op: table absent)')"
        )
        logger.info("Applied migration v25: no external_forwarders table yet, skipped")
        return

    # Rebuild with the new CHECK. Must drop dependent FK before recreating
    # since external_forward_outbox references external_forwarders(id).
    await conn.execute("PRAGMA foreign_keys = OFF")
    try:
        await conn.executescript(
            """
            -- Always start from a fresh staging table. Without this drop,
            -- a crash between `INSERT INTO ..._v25 SELECT FROM external_forwarders`
            -- and `DROP TABLE external_forwarders` would, on retry, double
            -- every config row: the staging table still holds the first
            -- round and the SELECT re-inserts them. Drop-first makes the
            -- migration idempotent under replay.
            DROP TABLE IF EXISTS external_forwarders_v25;

            CREATE TABLE external_forwarders_v25 (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                kind                TEXT    NOT NULL CHECK (kind IN ('webhook', 'splunk_hec', 'datadog', 'otlp_http')),
                name                TEXT    NOT NULL,
                url                 TEXT    NOT NULL,
                secret_ref          TEXT,
                headers_json        TEXT,
                event_filter        TEXT    NOT NULL DEFAULT 'threats_only' CHECK (event_filter IN ('all', 'threats_only', 'audits_only')),
                include_tool_audits INTEGER NOT NULL DEFAULT 1,
                redaction_level     TEXT    NOT NULL DEFAULT 'standard' CHECK (redaction_level IN ('standard', 'minimal', 'full')),
                enabled             INTEGER NOT NULL DEFAULT 1,
                created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_success_at     TIMESTAMP,
                last_failure_at     TIMESTAMP,
                last_error          TEXT,
                consecutive_fails   INTEGER NOT NULL DEFAULT 0
            );

            INSERT INTO external_forwarders_v25
            SELECT id, kind, name, url, secret_ref, headers_json, event_filter,
                   include_tool_audits, redaction_level, enabled, created_at,
                   updated_at, last_success_at, last_failure_at, last_error,
                   consecutive_fails
              FROM external_forwarders;

            DROP TABLE external_forwarders;
            ALTER TABLE external_forwarders_v25 RENAME TO external_forwarders;

            CREATE INDEX IF NOT EXISTS idx_external_forwarders_enabled
              ON external_forwarders (enabled, id);
            """
        )
    finally:
        await conn.execute("PRAGMA foreign_keys = ON")

    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) "
        "VALUES (25, CURRENT_TIMESTAMP, 'SIEM forwarder redaction_level allows full tier')"
    )
    logger.info("Applied migration v25: redaction_level accepts 'full'")


# ---------------------------------------------------------------------------
# v26 — SOC-grade filtering: min_severity threshold + rate limit
# ---------------------------------------------------------------------------
#
# SOC analyst review flagged two alert-fatigue risks: (1) threats_only
# still forwards WARN-level noise, and (2) a misbehaving agent could
# fire thousands of scans/sec with no cap.
#
# Adds two columns to external_forwarders:
#   min_severity         : 'block' | 'detected' | 'warn' — default 'review'
#                          which drops WARN-tier noise. Legacy values
#                          still accepted; see _passes_filter.
#   rate_limit_per_minute: 0 = unlimited (default). When exceeded, new
#                          events are dropped in-window and the next
#                          allowed event carries suppressed_count in
#                          unmapped so the SIEM sees the burst summary.
async def migrate_to_v26(db: DatabaseConnection) -> None:
    """v25 -> v26: SOC-grade filtering on external_forwarders."""
    conn = await db.connect()
    cur = await conn.execute("PRAGMA table_info(external_forwarders)")
    existing = {row[1] for row in await cur.fetchall()}

    if existing:
        # Simple ALTER — no CHECK constraint, validated in Pydantic
        # so we skip another table-rebuild cycle.
        if "min_severity" not in existing:
            await conn.execute(
                "ALTER TABLE external_forwarders "
                "ADD COLUMN min_severity TEXT NOT NULL DEFAULT 'review'"
            )
        if "rate_limit_per_minute" not in existing:
            await conn.execute(
                "ALTER TABLE external_forwarders "
                "ADD COLUMN rate_limit_per_minute INTEGER NOT NULL DEFAULT 0"
            )

    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) "
        "VALUES (26, CURRENT_TIMESTAMP, 'SOC filtering: min_severity + rate_limit_per_minute')"
    )
    logger.info("Applied migration v26: min_severity + rate_limit_per_minute")


async def migrate_to_v27(db: DatabaseConnection) -> None:
    """v26 -> v27: Drop CHECK(kind IN (...)) on external_forwarders.

    Rationale: every new destination kind ('file', future brands) would
    otherwise need its own migration just to expand the CHECK list.
    Pydantic at the API layer + Literal at the repo layer already
    enforce the valid kinds, so the CHECK is belt-and-suspenders that
    pays a rebuild cost for no real integrity gain.

    SQLite can't ALTER a CHECK in place — rebuild the table preserving
    all columns, data, and other constraints. Idempotent via a staging
    table name cleanup at the top.
    """
    conn = await db.connect()

    # Skip if the table doesn't exist (fresh install) — new schema
    # created in SCHEMA_SQL won't carry the CHECK.
    cur = await conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='external_forwarders'"
    )
    if not await cur.fetchone():
        await conn.execute(
            "INSERT INTO schema_version (version, applied_at, description) "
            "VALUES (27, CURRENT_TIMESTAMP, 'Drop kind CHECK on external_forwarders')"
        )
        await conn.commit()
        return

    # Inspect current columns so the rebuild preserves v26 additions.
    cur = await conn.execute("PRAGMA table_info(external_forwarders)")
    cols = [row[1] for row in await cur.fetchall()]
    has_min_sev = "min_severity" in cols
    has_rate = "rate_limit_per_minute" in cols

    # Staging cleanup in case a prior attempt left debris.
    await conn.execute("DROP TABLE IF EXISTS external_forwarders_v27")

    # Rebuild with no CHECK on `kind`. Every other constraint preserved.
    extra_cols = ""
    extra_cols_list = ""
    extra_select = ""
    if has_min_sev:
        extra_cols += "    min_severity          TEXT NOT NULL DEFAULT 'review',\n"
        extra_cols_list += ", min_severity"
        extra_select += ", min_severity"
    if has_rate:
        extra_cols += "    rate_limit_per_minute INTEGER NOT NULL DEFAULT 0,\n"
        extra_cols_list += ", rate_limit_per_minute"
        extra_select += ", rate_limit_per_minute"

    await conn.executescript(f"""
        CREATE TABLE external_forwarders_v27 (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            kind                TEXT    NOT NULL,
            name                TEXT    NOT NULL,
            url                 TEXT    NOT NULL,
            secret_ref          TEXT,
            headers_json        TEXT,
            event_filter        TEXT    NOT NULL DEFAULT 'threats_only'
                                CHECK (event_filter IN ('all','threats_only','audits_only')),
            include_tool_audits INTEGER NOT NULL DEFAULT 1,
            redaction_level     TEXT    NOT NULL DEFAULT 'standard'
                                CHECK (redaction_level IN ('minimal','standard','full')),
            enabled             INTEGER NOT NULL DEFAULT 1,
        {extra_cols}    created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_success_at     TEXT,
            last_failure_at     TEXT,
            consecutive_fails   INTEGER NOT NULL DEFAULT 0,
            last_error          TEXT
        );

        INSERT INTO external_forwarders_v27
            (id, kind, name, url, secret_ref, headers_json,
             event_filter, include_tool_audits, redaction_level, enabled{extra_cols_list},
             created_at, updated_at, last_success_at, last_failure_at,
             consecutive_fails, last_error)
        SELECT id, kind, name, url, secret_ref, headers_json,
               event_filter, include_tool_audits, redaction_level, enabled{extra_select},
               created_at, updated_at, last_success_at, last_failure_at,
               consecutive_fails, last_error
        FROM external_forwarders;

        DROP TABLE external_forwarders;
        ALTER TABLE external_forwarders_v27 RENAME TO external_forwarders;
    """)

    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) "
        "VALUES (27, CURRENT_TIMESTAMP, 'Drop kind CHECK on external_forwarders (allow new kinds via app-layer validation)')"
    )
    await conn.commit()
    logger.info("Applied migration v27: dropped kind CHECK on external_forwarders")


async def migrate_to_v28(db: DatabaseConnection) -> None:
    """v27 -> v28: Lifetime events_sent counter on external_forwarders.

    Surfaces "total events this destination has received" as a column
    in the UI. Cumulative across app restarts — persists with the row,
    unlike the outbox pending_count which purges after 7 days.

    Simple ALTER — DEFAULT 0 backfills all existing rows.
    """
    conn = await db.connect()
    cur = await conn.execute("PRAGMA table_info(external_forwarders)")
    cols = {row[1] for row in await cur.fetchall()}
    if cols and "events_sent" not in cols:
        await conn.execute(
            "ALTER TABLE external_forwarders "
            "ADD COLUMN events_sent INTEGER NOT NULL DEFAULT 0"
        )
    await conn.execute(
        "INSERT INTO schema_version (version, applied_at, description) "
        "VALUES (28, CURRENT_TIMESTAMP, 'external_forwarders.events_sent lifetime counter')"
    )
    await conn.commit()
    logger.info("Applied migration v28: events_sent counter on external_forwarders")


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
