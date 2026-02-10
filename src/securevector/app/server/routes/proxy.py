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
_current_integration: str = None  # Which integration started the proxy (openclaw, ollama, langchain, etc.)
_proxy_running_in_process: bool = False  # Set when proxy runs via --proxy --web
_started_with_openclaw: bool = False  # Set when proxy is started with --openclaw flag

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


def set_proxy_running_in_process(running: bool, provider: str = "openai", integration: str = None):
    """Called by main.py when proxy is started via --proxy --web flag."""
    global _proxy_running_in_process, _current_provider, _current_integration
    _proxy_running_in_process = running
    if running:
        _current_provider = provider
        _current_integration = integration


class StartProxyRequest(BaseModel):
    provider: str = "openai"
    multi: bool = False
    integration: str = None  # Which integration is starting the proxy (langchain, ollama, crewai, etc.)


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
        "integration": _current_integration if running else None,
        "multi": _multi_mode if running else False,
        "openclaw": _started_with_openclaw if running else False,
        "in_process": _proxy_running_in_process,
        "providers": PROVIDERS,
        "llm_proxy": {"running": running, "port": 8742},
    }


@router.post("/start")
async def start_proxy(request: StartProxyRequest = None):
    """Start the LLM proxy that captures ALL LLM traffic."""
    global _llm_proxy_process, _current_provider, _current_integration, _multi_mode

    provider = request.provider if request else "openai"
    multi = request.multi if request else False
    integration = request.integration if request else None
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
            _current_integration = integration
            _multi_mode = multi
            mode_str = "multi-provider" if multi else provider
            integration_str = f" for {integration}" if integration else ""
            logger.info(f"LLM proxy started on port 8742 ({mode_str}){integration_str}")
            return {
                "status": "started",
                "message": f"Proxy started ({mode_str}) on port 8742",
                "provider": provider,
                "integration": integration,
                "multi": multi,
            }
        else:
            return {"status": "error", "message": "Proxy failed to start"}

    except Exception:
        logger.exception("Failed to start LLM proxy")
        return {"status": "error", "message": "Failed to start proxy"}


def set_openclaw_mode(enabled: bool):
    """Called when proxy is started with --openclaw flag."""
    global _started_with_openclaw, _current_integration
    _started_with_openclaw = enabled
    if enabled:
        _current_integration = "openclaw"


@router.post("/stop")
async def stop_proxy():
    """Stop the LLM proxy and revert pi-ai files if started with --openclaw."""
    global _llm_proxy_process, _current_integration, _started_with_openclaw

    if _llm_proxy_process is None and not _proxy_running_in_process:
        return {"status": "not_running", "message": "LLM proxy is not running"}

    # If running in-process (via --proxy --web), can't stop from UI
    if _proxy_running_in_process:
        return {"status": "error", "message": "Proxy running in-process. Stop the app with Ctrl+C."}

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
    _current_integration = None

    # Only revert pi-ai files if started with --openclaw
    if _started_with_openclaw:
        try:
            from securevector.app.main import revert_provider_proxy
            revert_provider_proxy(_current_provider, quiet=True)
            logger.info(f"Reverted pi-ai files for {_current_provider}")
            result["reverted"] = True
        except Exception as e:
            logger.warning(f"Could not revert pi-ai files: {e}")
        _started_with_openclaw = False

    return result


@router.post("/revert")
async def revert_proxy():
    """Revert pi-ai files to original state (remove SecureVector proxy patches)."""
    try:
        from securevector.app.main import revert_proxy as do_revert

        # Run the revert in a thread to avoid blocking
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, do_revert)

        logger.info("Proxy files reverted successfully")
        return {"status": "success", "message": "Pi-ai files reverted to original state"}
    except Exception:
        logger.exception("Failed to revert proxy files")
        return {"status": "error", "message": "Failed to revert proxy files"}
