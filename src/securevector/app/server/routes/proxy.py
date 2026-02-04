"""
Proxy management routes for OpenClaw.
Starts LLM proxy that captures ALL LLM traffic (TUI, Telegram, API, etc.).
"""

import asyncio
import logging
import subprocess
import sys
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/proxy", tags=["Proxy"])

# Global proxy process reference and state
_llm_proxy_process: Optional[subprocess.Popen] = None
_current_provider: str = "openai"

# Supported providers
PROVIDERS = ["openai", "anthropic", "ollama", "groq", "openrouter", "deepseek", "mistral", "azure", "gemini", "together", "fireworks", "perplexity", "cohere"]


class StartProxyRequest(BaseModel):
    provider: str = "openai"


@router.get("/status")
async def get_proxy_status():
    """Get the current status of the LLM proxy."""
    global _llm_proxy_process, _current_provider

    running = False

    if _llm_proxy_process is not None:
        poll_result = _llm_proxy_process.poll()
        running = poll_result is None
        if not running:
            _llm_proxy_process = None

    return {
        "running": running,
        "provider": _current_provider if running else None,
        "providers": PROVIDERS,
        "llm_proxy": {"running": running, "port": 8742},
    }


@router.post("/start")
async def start_proxy(request: StartProxyRequest = None):
    """Start the LLM proxy that captures ALL OpenClaw LLM traffic."""
    global _llm_proxy_process, _current_provider

    provider = request.provider if request else "openai"
    if provider not in PROVIDERS:
        provider = "openai"

    # Check if already running
    if _llm_proxy_process is not None and _llm_proxy_process.poll() is None:
        return {"status": "already_running", "message": f"LLM proxy already running on port 8742 ({_current_provider})"}

    try:
        # Start LLM proxy (captures ALL LLM traffic from any source)
        _llm_proxy_process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "securevector.integrations.openclaw_llm_proxy",
                "--port", "8742",
                "--provider", provider,
                "-v",  # verbose mode
            ],
            # Don't pipe - let output go to terminal for debugging
        )

        # Wait a moment to check if it started successfully
        await asyncio.sleep(0.5)

        if _llm_proxy_process.poll() is None:
            _current_provider = provider
            logger.info(f"LLM proxy started on port 8742 with provider: {provider}")
            return {
                "status": "started",
                "message": f"LLM proxy started ({provider}) on port 8742",
                "provider": provider,
            }
        else:
            return {"status": "error", "message": "LLM proxy failed to start"}

    except Exception:
        logger.exception("Failed to start LLM proxy")
        return {"status": "error", "message": "Failed to start LLM proxy"}


@router.post("/stop")
async def stop_proxy():
    """Stop the LLM proxy."""
    global _llm_proxy_process

    if _llm_proxy_process is None:
        return {"status": "not_running", "message": "LLM proxy is not running"}

    try:
        _llm_proxy_process.terminate()
        _llm_proxy_process.wait(timeout=5)
        logger.info("LLM proxy stopped")
        result = {"status": "stopped", "message": "LLM proxy stopped"}
    except subprocess.TimeoutExpired:
        _llm_proxy_process.kill()
        result = {"status": "stopped", "message": "LLM proxy killed (timeout)"}
    except Exception:
        result = {"status": "error", "message": "Error stopping LLM proxy"}

    _llm_proxy_process = None
    return result
