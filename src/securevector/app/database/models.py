"""
SQLAlchemy table definitions for the SecureVector desktop application.

Tables:
- schema_version: Database schema version tracking
- threat_intel_records: Historical analysis results
- custom_rules: User-created detection rules
- rule_overrides: Modifications to community rules
- app_settings: Application preferences (singleton)
"""

from datetime import datetime
from typing import Optional

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    Integer,
    String,
    Text,
    CheckConstraint,
    MetaData,
    Table,
)
from sqlalchemy.dialects.sqlite import JSON

# Use naming convention for constraints
convention = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

metadata = MetaData(naming_convention=convention)

# Schema version table for migrations
schema_version = Table(
    "schema_version",
    metadata,
    Column("version", Integer, primary_key=True),
    Column(
        "applied_at",
        DateTime,
        nullable=False,
        default=datetime.utcnow,
    ),
    Column("description", Text, nullable=False),
)

# Threat intel records table
threat_intel_records = Table(
    "threat_intel_records",
    metadata,
    Column("id", String(36), primary_key=True),  # UUID
    Column("request_id", String(64), nullable=True, index=True),
    Column("text_content", Text, nullable=True),  # Optional for privacy
    Column("text_hash", String(64), nullable=False, index=True),
    Column("text_length", Integer, nullable=False),
    Column("is_threat", Boolean, nullable=False, index=True),
    Column("threat_type", String(50), nullable=True, index=True),
    Column("risk_score", Integer, nullable=False),
    Column("confidence", Float, nullable=False),
    Column("matched_rules", JSON, nullable=False),  # Array of matched rules
    Column("source_identifier", String(255), nullable=True, index=True),
    Column("session_id", String(64), nullable=True, index=True),
    Column("processing_time_ms", Integer, nullable=False),
    Column(
        "created_at",
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        index=True,
    ),
    Column("metadata", JSON, nullable=True),
    # Constraints
    CheckConstraint("risk_score >= 0 AND risk_score <= 100", name="risk_score_range"),
    CheckConstraint("confidence >= 0 AND confidence <= 1", name="confidence_range"),
)

# Custom rules table
custom_rules = Table(
    "custom_rules",
    metadata,
    Column("id", String(100), primary_key=True),
    Column("name", String(255), nullable=False),
    Column("category", String(50), nullable=False, index=True),
    Column("description", Text, nullable=False),
    Column("severity", String(20), nullable=False),
    Column("patterns", JSON, nullable=False),  # Array of regex patterns
    Column("enabled", Boolean, nullable=False, default=True),
    Column("metadata", JSON, nullable=True),
    Column(
        "created_at",
        DateTime,
        nullable=False,
        default=datetime.utcnow,
    ),
    Column(
        "updated_at",
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    ),
    # Constraints
    CheckConstraint(
        "severity IN ('low', 'medium', 'high', 'critical')",
        name="severity_values",
    ),
)

# Rule overrides table for community rules
rule_overrides = Table(
    "rule_overrides",
    metadata,
    Column("id", String(36), primary_key=True),  # UUID
    Column("original_rule_id", String(100), nullable=False, unique=True),
    Column("enabled", Boolean, nullable=True),
    Column("severity", String(20), nullable=True),
    Column("patterns", JSON, nullable=True),  # Override patterns
    Column(
        "created_at",
        DateTime,
        nullable=False,
        default=datetime.utcnow,
    ),
    Column(
        "updated_at",
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    ),
    # Constraints
    CheckConstraint(
        "severity IS NULL OR severity IN ('low', 'medium', 'high', 'critical')",
        name="override_severity_values",
    ),
)

# App settings table (singleton - always id=1)
app_settings = Table(
    "app_settings",
    metadata,
    Column("id", Integer, primary_key=True, default=1),
    Column("theme", String(20), nullable=False, default="system"),
    Column("server_port", Integer, nullable=False, default=8741),
    Column("server_host", String(255), nullable=False, default="127.0.0.1"),
    Column("retention_days", Integer, nullable=False, default=30),
    Column("store_text_content", Boolean, nullable=False, default=True),
    Column("notifications_enabled", Boolean, nullable=False, default=True),
    Column("launch_on_startup", Boolean, nullable=False, default=False),
    Column("minimize_to_tray", Boolean, nullable=False, default=True),
    Column("window_width", Integer, nullable=True),
    Column("window_height", Integer, nullable=True),
    Column("window_x", Integer, nullable=True),
    Column("window_y", Integer, nullable=True),
    # Cloud mode fields (added in schema v3)
    Column("cloud_mode_enabled", Boolean, nullable=False, default=False),
    Column("cloud_user_email", String(255), nullable=True),
    Column("cloud_connected_at", DateTime, nullable=True),
    Column(
        "updated_at",
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    ),
    # Constraints
    CheckConstraint("id = 1", name="singleton"),
    CheckConstraint(
        "theme IN ('system', 'light', 'dark')",
        name="theme_values",
    ),
    CheckConstraint(
        "server_port >= 1024 AND server_port <= 65535",
        name="port_range",
    ),
    CheckConstraint(
        "retention_days >= 1 AND retention_days <= 365",
        name="retention_range",
    ),
)


# SQL for creating tables (SQLite-specific)
SCHEMA_SQL = """
-- Schema Version 1

CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threat_intel_records (
    id TEXT PRIMARY KEY,
    request_id TEXT,
    text_content TEXT,
    text_hash TEXT NOT NULL,
    text_length INTEGER NOT NULL,
    is_threat INTEGER NOT NULL,
    threat_type TEXT,
    risk_score INTEGER NOT NULL CHECK (risk_score >= 0 AND risk_score <= 100),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    matched_rules TEXT NOT NULL,
    source_identifier TEXT,
    session_id TEXT,
    processing_time_ms INTEGER NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata TEXT,
    -- LLM Review fields
    llm_reviewed INTEGER DEFAULT 0,
    llm_agrees INTEGER DEFAULT 1,
    llm_confidence REAL DEFAULT 0,
    llm_explanation TEXT DEFAULT NULL,
    llm_recommendation TEXT DEFAULT NULL,
    llm_risk_adjustment INTEGER DEFAULT 0,
    llm_model_used TEXT DEFAULT NULL,
    llm_tokens_used INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_threat_intel_created_at ON threat_intel_records(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_threat_intel_is_threat ON threat_intel_records(is_threat);
CREATE INDEX IF NOT EXISTS idx_threat_intel_threat_type ON threat_intel_records(threat_type);
CREATE INDEX IF NOT EXISTS idx_threat_intel_source ON threat_intel_records(source_identifier);
CREATE INDEX IF NOT EXISTS idx_threat_intel_hash ON threat_intel_records(text_hash);
CREATE INDEX IF NOT EXISTS idx_threat_intel_request_id ON threat_intel_records(request_id);

CREATE TABLE IF NOT EXISTS custom_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    patterns TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    metadata TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_custom_rules_category ON custom_rules(category);

CREATE TABLE IF NOT EXISTS rule_overrides (
    id TEXT PRIMARY KEY,
    original_rule_id TEXT NOT NULL UNIQUE,
    enabled INTEGER,
    severity TEXT CHECK (severity IS NULL OR severity IN ('low', 'medium', 'high', 'critical')),
    patterns TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark')),
    server_port INTEGER NOT NULL DEFAULT 8741 CHECK (server_port >= 1024 AND server_port <= 65535),
    server_host TEXT NOT NULL DEFAULT '127.0.0.1',
    retention_days INTEGER NOT NULL DEFAULT 30 CHECK (retention_days >= 1 AND retention_days <= 365),
    store_text_content INTEGER NOT NULL DEFAULT 1,
    notifications_enabled INTEGER NOT NULL DEFAULT 1,
    launch_on_startup INTEGER NOT NULL DEFAULT 0,
    minimize_to_tray INTEGER NOT NULL DEFAULT 1,
    window_width INTEGER,
    window_height INTEGER,
    window_x INTEGER,
    window_y INTEGER,
    cloud_mode_enabled INTEGER NOT NULL DEFAULT 0,
    cloud_user_email TEXT,
    cloud_connected_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Initialize singleton settings row if not exists
INSERT OR IGNORE INTO app_settings (id) VALUES (1);
"""

# Current schema version
CURRENT_SCHEMA_VERSION = 7
SCHEMA_DESCRIPTION = "Add block_threats setting for proxy blocking mode"

# Migration SQL for v2
MIGRATION_V2_SQL = """
-- Schema Version 2: Add community rules cache

CREATE TABLE IF NOT EXISTS community_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    patterns TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    source_file TEXT,
    metadata TEXT,
    loaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_community_rules_category ON community_rules(category);
CREATE INDEX IF NOT EXISTS idx_community_rules_enabled ON community_rules(enabled);

-- Record migration
INSERT INTO schema_version (version, applied_at, description)
VALUES (2, CURRENT_TIMESTAMP, 'Add community rules cache table');
"""

# Migration SQL for v3
MIGRATION_V3_SQL = """
-- Schema Version 3: Add cloud mode fields to app_settings

ALTER TABLE app_settings ADD COLUMN cloud_mode_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_settings ADD COLUMN cloud_user_email TEXT DEFAULT NULL;
ALTER TABLE app_settings ADD COLUMN cloud_connected_at TIMESTAMP DEFAULT NULL;

-- Record migration
INSERT INTO schema_version (version, applied_at, description)
VALUES (3, CURRENT_TIMESTAMP, 'Add cloud mode fields to app_settings');
"""
