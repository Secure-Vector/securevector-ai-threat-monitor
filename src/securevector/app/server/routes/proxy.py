"""
Proxy management routes for OpenClaw.
Starts LLM proxy that captures ALL LLM traffic (TUI, Telegram, API, etc.).
"""

import asyncio
import logging
import socket
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
_proxy_running_in_process: bool = False  # Set when proxy runs via --proxy --web

# Supported providers
PROVIDERS = ["openai", "anthropic", "ollama", "groq", "openrouter", "deepseek", "mistral", "azure", "gemini", "together", "fireworks", "perplexity", "cohere"]


def _is_port_in_use(port: int) -> bool:
    """Check if a port is in use (proxy might be running)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return False  # Port is free
        except OSError:
            return True  # Port is in use


def set_proxy_running_in_process(running: bool, provider: str = "openai"):
    """Called by main.py when proxy is started via --proxy --web flag."""
    global _proxy_running_in_process, _current_provider
    _proxy_running_in_process = running
    if running:
        _current_provider = provider


class StartProxyRequest(BaseModel):
    provider: str = "openai"
    multi: bool = False


# Track if multi-mode is active
_multi_mode = False


@router.get("/status")
async def get_proxy_status():
    """Get the current status of the LLM proxy."""
    global _llm_proxy_process, _multi_mode

    running = False

    # Check 1: Proxy running in same process (via --proxy --web)
    if _proxy_running_in_process:
        running = True
    # Check 2: Proxy running as subprocess (started via UI button)
    elif _llm_proxy_process is not None:
        poll_result = _llm_proxy_process.poll()
        running = poll_result is None
        if not running:
            _llm_proxy_process = None
            _multi_mode = False
    # Check 3: Port 8742 is in use (proxy started externally)
    elif _is_port_in_use(8742):
        running = True

    return {
        "running": running,
        "provider": _current_provider if running else None,
        "multi": _multi_mode if running else False,
        "providers": PROVIDERS,
        "llm_proxy": {"running": running, "port": 8742},
    }


@router.post("/start")
async def start_proxy(request: StartProxyRequest = None):
    """Start the LLM proxy that captures ALL OpenClaw LLM traffic."""
    global _llm_proxy_process, _current_provider, _multi_mode

    provider = request.provider if request else "openai"
    multi = request.multi if request else False
    if provider not in PROVIDERS:
        provider = "openai"

    # Check if already running
    if _llm_proxy_process is not None and _llm_proxy_process.poll() is None:
        mode_str = "multi-provider" if _multi_mode else _current_provider
        return {"status": "already_running", "message": f"Proxy already running ({mode_str}). Stop it first."}

    # Check if port is in use (started externally)
    if _is_port_in_use(8742):
        return {"status": "already_running", "message": "Proxy already running on port 8742 (started externally)"}

    try:
        # Build command
        cmd = [
            sys.executable,
            "-m",
            "securevector.integrations.openclaw_llm_proxy",
            "--port", "8742",
            "-v",  # verbose mode
        ]
        if multi:
            cmd.append("--multi")
        else:
            cmd.extend(["--provider", provider])

        # Start LLM proxy
        _llm_proxy_process = subprocess.Popen(cmd)

        # Wait a moment to check if it started successfully
        await asyncio.sleep(0.5)

        if _llm_proxy_process.poll() is None:
            _current_provider = provider
            _multi_mode = multi
            mode_str = "multi-provider" if multi else provider
            logger.info(f"LLM proxy started on port 8742 ({mode_str})")
            return {
                "status": "started",
                "message": f"Proxy started ({mode_str}) on port 8742",
                "provider": provider,
                "multi": multi,
            }
        else:
            return {"status": "error", "message": "Proxy failed to start"}

    except Exception:
        logger.exception("Failed to start LLM proxy")
        return {"status": "error", "message": "Failed to start proxy"}


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
