"""
API route handlers for the SecureVector local server.

Routes:
- /health - Server health check
- /api/threat-analytics/ - Threat analysis (primary endpoint, mirrors cloud API)
- /api/v1/rules - Detection rules management
- /api/v1/settings/cloud - Cloud mode settings
- /api/v1/analyze - Legacy analysis endpoint (backwards compatibility)
"""

from . import analyze
from . import rules
from . import cloud_settings
from . import threat_analytics
from . import tool_permissions

__all__ = [
    "analyze",
    "rules",
    "cloud_settings",
    "threat_analytics",
    "tool_permissions",
]
