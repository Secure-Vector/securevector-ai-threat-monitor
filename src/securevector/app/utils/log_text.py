"""Helpers for writing caller-supplied values into log lines."""

from typing import Any


def log_safe(value: Any, limit: int = 200) -> str:
    """Return a single-line, printable, length-capped form of ``value`` for logging."""
    text = "".join(c for c in str(value) if c.isprintable())[:limit]
    return text.replace("\r", "").replace("\n", "")
