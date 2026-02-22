"""SecureVector integrations for various AI agent platforms."""

try:
    from .openclaw_proxy import SecureVectorProxy
except ImportError:
    SecureVectorProxy = None  # type: ignore[assignment,misc]

__all__ = ["SecureVectorProxy"]
