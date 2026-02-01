"""
NLP-based rule pattern generator.

Converts natural language descriptions into regex patterns for threat detection.

Examples:
- "block credit card numbers" → credit card regex patterns
- "detect email addresses" → email pattern regex
- "flag requests to ignore instructions" → prompt injection patterns
"""

import re
from dataclasses import dataclass
from typing import Optional


@dataclass
class GeneratedPattern:
    """Generated pattern with metadata."""

    pattern: str
    description: str
    confidence: float  # 0-1, how confident we are in this pattern
    category: str


# Pattern templates for common threat types
PATTERN_TEMPLATES = {
    # PII Detection
    "credit_card": {
        "keywords": ["credit card", "card number", "cc number", "visa", "mastercard", "amex"],
        "patterns": [
            r"\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b",
            r"\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b",
        ],
        "category": "pii_detection",
        "description": "Credit card number patterns (Visa, Mastercard, Amex, Discover)",
    },
    "ssn": {
        "keywords": ["ssn", "social security", "social security number"],
        "patterns": [
            r"\b\d{3}[- ]?\d{2}[- ]?\d{4}\b",
        ],
        "category": "pii_detection",
        "description": "US Social Security Number",
    },
    "email": {
        "keywords": ["email", "email address", "e-mail"],
        "patterns": [
            r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}",
        ],
        "category": "pii_detection",
        "description": "Email address pattern",
    },
    "phone": {
        "keywords": ["phone", "phone number", "telephone", "mobile number", "cell"],
        "patterns": [
            r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b",
            r"\b\d{3}[-.]?\d{3}[-.]?\d{4}\b",
        ],
        "category": "pii_detection",
        "description": "Phone number patterns",
    },
    "ip_address": {
        "keywords": ["ip address", "ip", "ipv4"],
        "patterns": [
            r"\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b",
        ],
        "category": "pii_detection",
        "description": "IPv4 address",
    },

    # Secret Detection
    "api_key": {
        "keywords": ["api key", "apikey", "api_key", "access key", "secret key"],
        "patterns": [
            r"(?i)(?:api[_-]?key|access[_-]?key|secret[_-]?key)['\"]?\s*[:=]\s*['\"]?([a-zA-Z0-9_-]{20,})",
            r"\b[a-zA-Z0-9]{32,}\b",
        ],
        "category": "secret_leaks",
        "description": "API key patterns",
    },
    "password": {
        "keywords": ["password", "passwd", "pwd", "secret"],
        "patterns": [
            r"(?i)(?:password|passwd|pwd)['\"]?\s*[:=]\s*['\"]?([^\s'\"]+)",
        ],
        "category": "secret_leaks",
        "description": "Password in plaintext",
    },
    "aws_key": {
        "keywords": ["aws", "aws key", "amazon key", "aws access"],
        "patterns": [
            r"(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}",
            r"aws[_-]?(?:access[_-]?key|secret)['\"]?\s*[:=]\s*['\"]?([a-zA-Z0-9/+=]{40})",
        ],
        "category": "secret_leaks",
        "description": "AWS access key",
    },
    "private_key": {
        "keywords": ["private key", "rsa key", "ssh key", "pem key"],
        "patterns": [
            r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
        ],
        "category": "secret_leaks",
        "description": "Private key header",
    },
    "jwt": {
        "keywords": ["jwt", "json web token", "bearer token"],
        "patterns": [
            r"eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*",
        ],
        "category": "secret_leaks",
        "description": "JWT token",
    },

    # Prompt Injection
    "ignore_instructions": {
        "keywords": ["ignore instruction", "ignore previous", "disregard", "forget instruction"],
        "patterns": [
            r"(?i)(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|commands?)",
            r"(?i)(?:do\s+not|don't)\s+follow\s+(?:the\s+)?(?:previous|above)\s+instructions?",
        ],
        "category": "prompt_injection",
        "description": "Instruction override attempts",
    },
    "new_instructions": {
        "keywords": ["new instruction", "new task", "real task", "actual instruction"],
        "patterns": [
            r"(?i)(?:your\s+)?(?:new|real|actual|true)\s+(?:instructions?|task|job|mission)\s+(?:is|are)",
            r"(?i)from\s+now\s+on\s+(?:you\s+)?(?:will|must|should)",
        ],
        "category": "prompt_injection",
        "description": "New instruction injection",
    },
    "system_prompt": {
        "keywords": ["system prompt", "system message", "reveal prompt", "show prompt"],
        "patterns": [
            r"(?i)(?:reveal|show|display|print|output|tell\s+me)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?|rules?)",
            r"(?i)what\s+(?:is|are)\s+your\s+(?:system\s+)?(?:instructions?|prompt|rules?)",
        ],
        "category": "prompt_injection",
        "description": "System prompt extraction attempts",
    },

    # Jailbreak
    "roleplay": {
        "keywords": ["roleplay", "pretend", "act as", "you are now", "dan mode"],
        "patterns": [
            r"(?i)(?:pretend|imagine|act)\s+(?:you\s+are|that\s+you're|to\s+be)\s+(?:a\s+)?(?:different|new|another)",
            r"(?i)you\s+are\s+now\s+(?:in\s+)?(?:dan|jailbreak|unrestricted)\s+mode",
            r"(?i)from\s+now\s+on\s+you\s+(?:will\s+)?(?:act|behave|respond)\s+as",
        ],
        "category": "jailbreak",
        "description": "Roleplay jailbreak attempts",
    },

    # Data Exfiltration
    "internal_url": {
        "keywords": ["internal url", "internal api", "localhost", "127.0.0.1", "intranet"],
        "patterns": [
            r"(?i)(?:https?://)?(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)",
            r"(?i)(?:https?://)?[a-z0-9-]+\.(?:internal|local|intranet|corp)\b",
        ],
        "category": "data_exfiltration",
        "description": "Internal/private network URLs",
    },
    "database_query": {
        "keywords": ["sql", "database", "query", "select from", "drop table"],
        "patterns": [
            r"(?i)\b(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\s+(?:INTO|FROM|TABLE|DATABASE)\b",
            r"(?i);\s*(?:DROP|DELETE|TRUNCATE)\s+",
        ],
        "category": "data_exfiltration",
        "description": "SQL injection patterns",
    },
}


class NLPRuleGenerator:
    """
    Generates regex patterns from natural language descriptions.

    Uses keyword matching and pattern templates to convert
    user-friendly descriptions into detection patterns.
    """

    def __init__(self):
        """Initialize the generator."""
        self.templates = PATTERN_TEMPLATES

    def generate(self, description: str) -> list[GeneratedPattern]:
        """
        Generate patterns from a natural language description.

        Args:
            description: Natural language description of what to detect.
                Examples:
                - "block credit card numbers"
                - "detect api keys and passwords"
                - "flag attempts to ignore instructions"

        Returns:
            List of GeneratedPattern objects with patterns and metadata.
        """
        description_lower = description.lower()
        results = []

        # Check each template for keyword matches
        for template_key, template in self.templates.items():
            for keyword in template["keywords"]:
                if keyword in description_lower:
                    # Found a match
                    for pattern in template["patterns"]:
                        results.append(
                            GeneratedPattern(
                                pattern=pattern,
                                description=template["description"],
                                confidence=self._calculate_confidence(description_lower, keyword, template),
                                category=template["category"],
                            )
                        )
                    break  # Don't add duplicate patterns from same template

        # If no templates matched, try to generate a simple pattern
        if not results:
            simple_pattern = self._generate_simple_pattern(description)
            if simple_pattern:
                results.append(simple_pattern)

        return results

    def _calculate_confidence(
        self,
        description: str,
        matched_keyword: str,
        template: dict,
    ) -> float:
        """Calculate confidence score for a pattern match."""
        # Base confidence from keyword match
        confidence = 0.7

        # Higher confidence for exact matches
        if matched_keyword == description.strip():
            confidence = 0.95

        # Higher confidence for longer keyword matches
        if len(matched_keyword) > 10:
            confidence += 0.1

        # Cap at 1.0
        return min(confidence, 1.0)

    def _generate_simple_pattern(self, description: str) -> Optional[GeneratedPattern]:
        """
        Generate a simple pattern for unrecognized descriptions.

        Falls back to case-insensitive literal matching for
        specific words mentioned in the description.
        """
        # Extract quoted strings as literal matches
        quoted = re.findall(r'"([^"]+)"|\'([^\']+)\'', description)
        if quoted:
            literals = [q[0] or q[1] for q in quoted]
            pattern = "|".join(re.escape(lit) for lit in literals)
            return GeneratedPattern(
                pattern=f"(?i)(?:{pattern})",
                description=f"Literal match for: {', '.join(literals)}",
                confidence=0.6,
                category="custom",
            )

        # Look for "containing X" or "includes X" patterns
        containing_match = re.search(
            r"(?:contain(?:ing)?|includ(?:es?|ing)|with)\s+['\"]?([a-zA-Z0-9_-]+)['\"]?",
            description,
            re.IGNORECASE,
        )
        if containing_match:
            word = containing_match.group(1)
            return GeneratedPattern(
                pattern=f"(?i){re.escape(word)}",
                description=f"Contains: {word}",
                confidence=0.5,
                category="custom",
            )

        return None

    def suggest_category(self, description: str) -> str:
        """
        Suggest a category based on the description.

        Args:
            description: Natural language description.

        Returns:
            Suggested category string.
        """
        description_lower = description.lower()

        category_keywords = {
            "pii_detection": ["pii", "personal", "email", "phone", "ssn", "credit card", "address"],
            "secret_leaks": ["secret", "password", "key", "token", "credential", "api key"],
            "prompt_injection": ["injection", "ignore", "instruction", "prompt", "override"],
            "jailbreak": ["jailbreak", "bypass", "roleplay", "pretend", "dan mode"],
            "data_exfiltration": ["exfil", "extract", "internal", "database", "sql"],
            "harmful_content": ["harmful", "violence", "illegal", "dangerous"],
        }

        for category, keywords in category_keywords.items():
            if any(kw in description_lower for kw in keywords):
                return category

        return "custom"

    def suggest_severity(self, patterns: list[GeneratedPattern]) -> str:
        """
        Suggest severity based on generated patterns.

        Args:
            patterns: List of generated patterns.

        Returns:
            Suggested severity (low/medium/high/critical).
        """
        if not patterns:
            return "medium"

        # Check categories for severity hints
        categories = {p.category for p in patterns}

        if "secret_leaks" in categories or "data_exfiltration" in categories:
            return "critical"
        elif "prompt_injection" in categories or "jailbreak" in categories:
            return "high"
        elif "pii_detection" in categories:
            return "high"
        else:
            return "medium"


# Convenience function
def generate_patterns(description: str) -> list[GeneratedPattern]:
    """
    Generate regex patterns from a natural language description.

    Args:
        description: Natural language description of what to detect.

    Returns:
        List of GeneratedPattern objects.
    """
    generator = NLPRuleGenerator()
    return generator.generate(description)
