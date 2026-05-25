"""
Secret redaction utilities for SecureVector.

Provides functions to detect and redact sensitive data like API keys,
tokens, passwords, and other credentials from text content.

Patterns are 3-tuples ``(regex, replacement, (pattern_id, secret_type))``
where the trailing pair feeds the redaction_events audit log (the
local-app Redactions page reads pattern_id + secret_type per match).
The pattern_id is a stable kebab-case slug; secret_type is the
human-readable label surfaced in UI / CSV / PDF exports.
"""

import re
from typing import Tuple, List, Optional, Callable


# Secret patterns to detect and redact
# Tuple shape: (regex, replacement, (pattern_id, secret_type))
SECRET_PATTERNS = [
    # Stripe keys
    (r'(sk_(?:test|live)_)[a-zA-Z0-9]{20,}', r'\1****', ('stripe-secret', 'Stripe secret key')),
    (r'(rk_(?:test|live)_)[a-zA-Z0-9]{20,}', r'\1****', ('stripe-restricted', 'Stripe restricted key')),
    (r'(pk_(?:test|live)_)[a-zA-Z0-9]{20,}', r'\1****', ('stripe-publishable', 'Stripe publishable key')),
    # OpenAI keys
    (r'(sk-)[a-zA-Z0-9]{32,}', r'\1****', ('openai-sk', 'OpenAI sk- key')),
    # GitHub tokens
    (r'(ghp_)[a-zA-Z0-9]{36}', r'\1****', ('github-pat-classic', 'GitHub PAT (classic)')),
    (r'(gho_)[a-zA-Z0-9]{36}', r'\1****', ('github-oauth', 'GitHub OAuth token')),
    (r'(github_pat_)[a-zA-Z0-9_]{22,}', r'\1****', ('github-pat-fine', 'GitHub PAT (fine-grained)')),
    # Slack tokens
    (r'(xox[baprs]-)[a-zA-Z0-9\-]{10,}', r'\1****', ('slack-token', 'Slack token')),
    # AWS keys
    (r'(AKIA)[A-Z0-9]{16}', r'\1****', ('aws-access-key', 'AWS access key')),
    # JWT tokens (keep header, redact payload and signature)
    (r'(eyJ[a-zA-Z0-9_-]{10,})\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+', r'\1.[REDACTED].[REDACTED]', ('jwt', 'JWT')),
    # Generic API key patterns
    (r'(api[_-]?key[:\s]*[\'"]?)[a-zA-Z0-9_\-]{20,}', r'\1[REDACTED]', ('generic-api-key', 'Generic api_key kv')),
    (r'(api[_-]?secret[:\s]*[\'"]?)[a-zA-Z0-9_\-]{20,}', r'\1[REDACTED]', ('generic-api-secret', 'Generic api_secret kv')),
    (r'(access[_-]?token[:\s]*[\'"]?)[a-zA-Z0-9_\-]{20,}', r'\1[REDACTED]', ('generic-access-token', 'Generic access_token kv')),
    (r'(auth[_-]?token[:\s]*[\'"]?)[a-zA-Z0-9_\-]{20,}', r'\1[REDACTED]', ('generic-auth-token', 'Generic auth_token kv')),
    (r'(bearer[:\s]+)[a-zA-Z0-9_\-\.]{20,}', r'\1[REDACTED]', ('bearer', 'Bearer token')),
    # Passwords (simplified patterns to avoid ReDoS)
    (r'(password[:=]\s*)[^\s]{8,50}', r'\1[REDACTED]', ('password-kv', 'Password kv')),
    (r'(passwd[:=]\s*)[^\s]{8,50}', r'\1[REDACTED]', ('password-kv', 'Password kv')),
    (r'(pwd[:=]\s*)[^\s]{8,50}', r'\1[REDACTED]', ('password-kv', 'Password kv')),
    # Passwords in backticks - various patterns
    (r'`([A-Z][a-z]{3,15}[0-9]{1,6})`', r'`[REDACTED]`', ('password-backtick', 'Password (backtick)')),
    (r'`([A-Za-z0-9!@#$%^&*_]{8,30})`', r'`[REDACTED]`', ('password-backtick', 'Password (backtick)')),
    (r'`([A-Z][a-z]+[A-Z][a-z]+[A-Za-z0-9!]*)`', r'`[REDACTED]`', ('passphrase-backtick', 'Passphrase (backtick)')),
    # Passwords after bullet points
    (r'([•\-\*]\s*)([A-Z][a-z]+[A-Z]?[a-z]*[0-9]*[!@#$%^&*]+[A-Za-z0-9!@#$%^&*]*)', r'\1[REDACTED]', ('password-bulleted', 'Password (bulleted)')),
    (r'([•\-\*]\s*)([A-Z][a-z]+@[A-Za-z]+[0-9]+)', r'\1[REDACTED]', ('password-bulleted', 'Password (bulleted)')),
    (r'([•\-\*]\s*)([A-Z][a-z]+[0-9]+[!@#$%^&*]+)', r'\1[REDACTED]', ('password-bulleted', 'Password (bulleted)')),
    # Common password patterns anywhere
    (r'\b([A-Z][a-z]{3,10}[!@#$%^&*][A-Za-z0-9!@#$%^&*]{2,15})\b', r'[REDACTED]', ('password-inline', 'Password (inline)')),
    (r'\b([A-Z][a-z]{3,10}@[A-Za-z]+[0-9]{2,6})\b', r'[REDACTED]', ('password-inline', 'Password (inline)')),
    (r'\b([A-Z][a-z]+[0-9]{2,6}[!@#$%^&*]{1,3})\b', r'[REDACTED]', ('password-inline', 'Password (inline)')),
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
        ('pem-private-key', 'PEM private key'),
    ),
    # OpenSSH binary key carrier — `openssh-key-v1\0` magic + bounded
    # base64-shaped tail. Bounded length so a stray match doesn't eat
    # arbitrary trailing content.
    (
        r'openssh-key-v1\x00[A-Za-z0-9+/=\s]{0,4096}',
        '[REDACTED-OPENSSH-KEY]',
        ('pem-openssh-binary', 'OpenSSH binary key'),
    ),
]


def redact_secrets(
    text: str,
    direction: str = "outgoing",
    *,
    record_event: Optional[Callable[[dict], None]] = None,
) -> Tuple[str, int]:
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
        record_event: Optional callback invoked once per matched substring
            with a dict ``{"pattern_id", "secret_type", "matched"}``. Used by
            the analyze route to write redaction_events rows for the local
            Redactions report. NEVER receives the redacted text — only the
            metadata + the raw matched substring so the caller can hash and
            persist (the hash, not the substring). Errors raised by the
            callback are swallowed: a logging failure must not derail an
            in-flight scan.

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

    for entry in patterns:
        pattern, replacement, meta = entry
        pattern_id, secret_type = meta

        if record_event is not None:
            # Iterate per-match so we can hand the callback each raw
            # substring exactly once. This is the only path that exposes
            # the matched substring outside redact_secrets — callers MUST
            # hash before persisting.
            try:
                compiled = re.compile(pattern, flags=re.IGNORECASE)
            except re.error:
                continue
            for m in compiled.finditer(redacted):
                try:
                    record_event({
                        "pattern_id": pattern_id,
                        "secret_type": secret_type,
                        "matched": m.group(0),
                    })
                except Exception:  # noqa: BLE001
                    # callback failure never blocks redaction
                    pass

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

    for entry in SECRET_PATTERNS:
        pattern = entry[0]
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
