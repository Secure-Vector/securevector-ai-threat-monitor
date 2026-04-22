"""
Cloud mode configuration data structures.

Provides dataclasses for cloud mode settings and analysis results
that include the source of analysis (local, cloud, or fallback).
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional


@dataclass
class CloudConfig:
    """
    Cloud mode configuration state.

    Combines database settings with keychain credential status.
    """

    # Whether credentials exist in OS keychain
    credentials_configured: bool = False

    # Whether user has enabled cloud mode (from database)
    cloud_mode_enabled: bool = False

    # User email from API key validation (from database)
    user_email: Optional[str] = None

    # When credentials were last validated (from database)
    connected_at: Optional[datetime] = None

    def to_dict(self) -> dict:
        """Convert to API response format."""
        return {
            "credentials_configured": self.credentials_configured,
            "cloud_mode_enabled": self.cloud_mode_enabled,
            "user_email": self.user_email,
            "connected_at": (
                self.connected_at.isoformat() if self.connected_at else None
            ),
        }


@dataclass
class AnalysisResult:
    """
    Result from threat analysis (local or cloud).

    Includes analysis_source field to indicate which analyzer was used:
    - "local": Local pattern matching (cloud mode OFF)
    - "cloud": Cloud ML analysis (cloud mode ON, successful)
    - "local_fallback": Cloud failed, fell back to local
    """

    is_threat: bool
    threat_type: Optional[str] = None
    risk_score: int = 0
    confidence: float = 0.0
    matched_rules: List[str] = field(default_factory=list)
    analysis_source: str = "local"  # "local", "cloud", or "local_fallback"
    processing_time_ms: int = 0
    request_id: Optional[str] = None

    def to_dict(self) -> dict:
        """Convert to API response format."""
        return {
            "is_threat": self.is_threat,
            "threat_type": self.threat_type,
            "risk_score": self.risk_score,
            "confidence": self.confidence,
            "matched_rules": self.matched_rules,
            "analysis_source": self.analysis_source,
            "processing_time_ms": self.processing_time_ms,
            "request_id": self.request_id,
        }


# Cloud API base URL
CLOUD_API_BASE_URL = "https://scan.securevector.io"

# Timeout for cloud API requests (seconds)
CLOUD_API_TIMEOUT = 5.0

# Rules Intel Service — serves the per-user, tier-filtered rule bundle
# for cloud → local rule syncs. The endpoint lives on the public API
# domain shared by the rest of the SecureVector platform:
#
#   https://api.securevector.io/api/rules/sync
#
# Both develop and master ship with this same default. For internal
# staging or local dev, set `SV_CLOUD_API_URL` at runtime — do not hard
# code non-prod URLs into this file (this repo is public).
import os as _os

CLOUD_API_URL = _os.getenv(
    "SV_CLOUD_API_URL",
    "https://api.securevector.io",
)

# Allow more time for bundle fetches — the bundle is large (thousands of rules).
CLOUD_RULES_SYNC_TIMEOUT = 30.0
