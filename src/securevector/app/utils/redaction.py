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
    # Passwords (simplified patterns to avoid ReDoS)
    (r'(password[:=]\s*)[^\s]{8,50}', r'\1[REDACTED]'),
    (r'(passwd[:=]\s*)[^\s]{8,50}', r'\1[REDACTED]'),
    (r'(pwd[:=]\s*)[^\s]{8,50}', r'\1[REDACTED]'),
    # Passwords in backticks - various patterns
    # Pattern: letters + numbers (e.g., Sunshine123, Password1)
    (r'`([A-Z][a-z]{3,15}[0-9]{1,6})`', r'`[REDACTED]`'),
    # Pattern: mixed case + special chars (e.g., M@tn3r!2024^Day)
    (r'`([A-Za-z0-9!@#$%^&*_]{8,30})`', r'`[REDACTED]`'),
    # Passphrases (multiple words, e.g., CorrectHorseBattery)
    (r'`([A-Z][a-z]+[A-Z][a-z]+[A-Za-z0-9!]*)`', r'`[REDACTED]`'),
    # Passwords after bullet points (• TestPass1!, - Demo@123)
    (r'([•\-\*]\s*)([A-Z][a-z]+[A-Z]?[a-z]*[0-9]*[!@#$%^&*]+[A-Za-z0-9!@#$%^&*]*)', r'\1[REDACTED]'),
    (r'([•\-\*]\s*)([A-Z][a-z]+@[A-Za-z]+[0-9]+)', r'\1[REDACTED]'),
    (r'([•\-\*]\s*)([A-Z][a-z]+[0-9]+[!@#$%^&*]+)', r'\1[REDACTED]'),
    # Common password patterns anywhere (word + numbers + symbols)
    (r'\b([A-Z][a-z]{3,10}[!@#$%^&*][A-Za-z0-9!@#$%^&*]{2,15})\b', r'[REDACTED]'),
    (r'\b([A-Z][a-z]{3,10}@[A-Za-z]+[0-9]{2,6})\b', r'[REDACTED]'),
    (r'\b([A-Z][a-z]+[0-9]{2,6}[!@#$%^&*]{1,3})\b', r'[REDACTED]'),
]


# Patterns applied ONLY when scanning content the agent has fetched and is
# about to read as context (`direction='incoming'` — tool responses, RAG
# content, etc.). Scoped this narrowly because:
#   - A PEM PRIVATE KEY *body* substring in an outgoing user prompt is
#     either (a) the user is asking about cryptography, or (b) the user
#     pasted their own key for the LLM to look at. Either way, redacting
#     it inside the prompt before storage would silently strip something
#     the user explicitly chose to include — surprising behaviour.
#   - In an incoming tool response, the same substring is almost certainly
#     a key that leaked out of a tool the agent called (a Read on
#     ~/.ssh/id_rsa, an MCP vault dump, a misconfigured cloud read). We
#     do NOT want the rule that flagged the leak to then write the key
#     body into threat_intel_records.text_content and SIEM-forward it.
INCOMING_ONLY_PATTERNS = [
    # PEM private-key blocks — keep the BEGIN/END envelope so the matching
    # rule `sv_community_output_003_pem_private_key_leak` still fires on
    # re-scan and the threat is still recorded; the body between is
    # replaced. Non-greedy; constrained to PRIVATE KEY variants only
    # (PUBLIC KEY envelopes are not secrets and stay verbatim).
    (
        r'(-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH|ENCRYPTED|PGP)?\s*PRIVATE\s+KEY(?:\s+BLOCK)?-----)'
        r'[\s\S]*?'
        r'(-----END\s+(?:RSA|DSA|EC|OPENSSH|ENCRYPTED|PGP)?\s*PRIVATE\s+KEY(?:\s+BLOCK)?-----)',
        r'\1\n[REDACTED-PRIVATE-KEY]\n\2',
    ),
    # OpenSSH binary key carrier — `openssh-key-v1\0` magic + bounded
    # base64-shaped tail. Bounded length so a stray match doesn't eat
    # arbitrary trailing content.
    (r'openssh-key-v1\x00[A-Za-z0-9+/=\s]{0,4096}', '[REDACTED-OPENSSH-KEY]'),
]


def redact_secrets(text: str, direction: str = "outgoing") -> Tuple[str, int]:
    """
    Redact detected secrets from text.

    Args:
        text: The text to scan and redact.
        direction: Scan direction — "outgoing" (user→LLM, default), "incoming"
            (tool response / RAG content the agent fetched), or "llm_response"
            (LLM → user). Determines whether INCOMING_ONLY_PATTERNS are run
            on top of the always-on SECRET_PATTERNS. Default of "outgoing"
            keeps the existing call-site contract for any caller that hasn't
            been updated to pass direction.

    Returns:
        Tuple of (redacted_text, count_of_redactions)
    """
    if not text:
        return text, 0

    redaction_count = 0
    redacted = text

    patterns = SECRET_PATTERNS
    if direction == "incoming":
        patterns = patterns + INCOMING_ONLY_PATTERNS

    for pattern, replacement in patterns:
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
