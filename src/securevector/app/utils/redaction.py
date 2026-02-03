"""
Secret redaction utilities for SecureVector.

Provides functions to detect and redact sensitive data like API keys,
tokens, passwords, and other credentials from text content.
"""

import re
from typing import Tuple, List


# Secret patterns to detect and redact
SECRET_PATTERNS = [
    # Stripe keys
    (r'(sk_(?:test|live)_)[a-zA-Z0-9]{20,}', r'\1****'),
    (r'(rk_(?:test|live)_)[a-zA-Z0-9]{20,}', r'\1****'),
    (r'(pk_(?:test|live)_)[a-zA-Z0-9]{20,}', r'\1****'),
    # OpenAI keys
    (r'(sk-)[a-zA-Z0-9]{32,}', r'\1****'),
    # GitHub tokens
    (r'(ghp_)[a-zA-Z0-9]{36}', r'\1****'),
    (r'(gho_)[a-zA-Z0-9]{36}', r'\1****'),
    (r'(github_pat_)[a-zA-Z0-9_]{22,}', r'\1****'),
    # Slack tokens
    (r'(xox[baprs]-)[a-zA-Z0-9\-]{10,}', r'\1****'),
    # AWS keys
    (r'(AKIA)[A-Z0-9]{16}', r'\1****'),
    # JWT tokens (keep header, redact payload and signature)
    (r'(eyJ[a-zA-Z0-9_-]{10,})\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+', r'\1.[REDACTED].[REDACTED]'),
    # Generic API key patterns
    (r'(api[_-]?key[:\s]*[\'"]?)[a-zA-Z0-9_\-]{20,}', r'\1[REDACTED]'),
    (r'(api[_-]?secret[:\s]*[\'"]?)[a-zA-Z0-9_\-]{20,}', r'\1[REDACTED]'),
    (r'(access[_-]?token[:\s]*[\'"]?)[a-zA-Z0-9_\-]{20,}', r'\1[REDACTED]'),
    (r'(auth[_-]?token[:\s]*[\'"]?)[a-zA-Z0-9_\-]{20,}', r'\1[REDACTED]'),
    (r'(bearer[:\s]+)[a-zA-Z0-9_\-\.]{20,}', r'\1[REDACTED]'),
    # Passwords (careful not to over-match)
    (r'(password[:\s]*[\'"]?)[^\s\'"]{8,50}([\'"]?)', r'\1[REDACTED]\2'),
    (r'(passwd[:\s]*[\'"]?)[^\s\'"]{8,50}([\'"]?)', r'\1[REDACTED]\2'),
    (r'(pwd[:\s]*[\'"]?)[^\s\'"]{8,50}([\'"]?)', r'\1[REDACTED]\2'),
]


def redact_secrets(text: str) -> Tuple[str, int]:
    """
    Redact detected secrets from text.

    Args:
        text: The text to scan and redact.

    Returns:
        Tuple of (redacted_text, count_of_redactions)
    """
    if not text:
        return text, 0

    redaction_count = 0
    redacted = text

    for pattern, replacement in SECRET_PATTERNS:
        new_text, count = re.subn(pattern, replacement, redacted, flags=re.IGNORECASE)
        if count > 0:
            redacted = new_text
            redaction_count += count

    return redacted, redaction_count


def has_secrets(text: str) -> bool:
    """
    Check if text contains any detectable secrets.

    Args:
        text: The text to check.

    Returns:
        True if secrets were detected.
    """
    if not text:
        return False

    for pattern, _ in SECRET_PATTERNS:
        if re.search(pattern, text, flags=re.IGNORECASE):
            return True

    return False


def get_secret_types(text: str) -> List[str]:
    """
    Get list of secret types detected in text.

    Args:
        text: The text to scan.

    Returns:
        List of detected secret type names.
    """
    if not text:
        return []

    detected = []
    type_names = [
        ("Stripe key", r'[srp]k_(?:test|live)_[a-zA-Z0-9]{20,}'),
        ("OpenAI key", r'sk-[a-zA-Z0-9]{32,}'),
        ("GitHub token", r'gh[po]_[a-zA-Z0-9]{36}|github_pat_'),
        ("Slack token", r'xox[baprs]-'),
        ("AWS key", r'AKIA[A-Z0-9]{16}'),
        ("JWT token", r'eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+'),
        ("API key", r'api[_-]?(?:key|secret)[:\s]'),
        ("Access token", r'(?:access|auth)[_-]?token[:\s]'),
        ("Bearer token", r'bearer[:\s]+[a-zA-Z0-9_\-\.]{20,}'),
        ("Password", r'(?:password|passwd|pwd)[:\s]'),
    ]

    for type_name, pattern in type_names:
        if re.search(pattern, text, flags=re.IGNORECASE):
            if type_name not in detected:
                detected.append(type_name)

    return detected
