"""
SecureVector AI Threat Monitor - Real-time monitoring for AI application security

A local-first monitoring toolkit for LLM-powered applications providing real-time
threat detection and prevention with minimal latency.

This is the open source community version. Enhanced, professional, and enterprise 
versions with additional monitoring features may be available in the future. These 
may or may not require subscription. Create GitHub issue with "commercial" label for more information.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

__version__ = "0.1.0"
__author__ = "SecureVector Team"
__license__ = "Apache 2.0"

from .decorator import secure_ai_call
from .local_engine import SecurityEngine
from .console_logger import SecurityLogger
from .license_manager import get_license_level, get_upgrade_message, get_license_info

__all__ = [
    "secure_ai_call", 
    "SecurityEngine", 
    "SecurityLogger",
    "get_license_level",
    "get_upgrade_message", 
    "get_license_info"
]


def get_version_info():
    """Get version and license information"""
    return {
        "version": __version__,
        "license": "Apache 2.0",
        "type": "Open Source Community Version",
        "enhanced_versions": "Coming soon - create GitHub issue with 'commercial' label for info"
    }