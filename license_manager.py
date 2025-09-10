"""
SecureVector AI Security - Simple license management
Currently open source - enhanced versions may be available in the future.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import os
from enum import Enum


class LicenseLevel(Enum):
    OPEN_SOURCE = "open"


def get_license_level() -> LicenseLevel:
    """Get current license level - currently only open source"""
    return LicenseLevel.OPEN_SOURCE


def get_upgrade_message() -> str:
    """Get message about potential future versions"""
    return """
⚡ Enhanced versions coming soon!
   
   SecureVector AI Security will offer enhanced, professional, and enterprise 
   versions with additional features. These may or may not require subscription.
   
   For more information: Create GitHub issue with 'commercial' label
    """


def get_license_info() -> dict:
    """Get current license information"""
    return {
        'level': 'open_source',
        'version': 'community',
        'features': ['local_analysis', 'basic_patterns', 'threat_detection'],
        'enhanced_available': False,
        'contact': 'Create GitHub issue with commercial label'
    }