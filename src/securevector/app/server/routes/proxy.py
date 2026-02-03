"""
Proxy management routes for OpenClaw WebSocket proxy.
"""

import asyncio
import logging
import subprocess
import sys
from typing import Optional

from fastapi import APIRouter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/proxy", tags=["Proxy"])

# Global proxy process reference
_proxy_process: Optional[subprocess.Popen] = None


@router.get("/status")
async def get_proxy_status():
    """Get the current status of the OpenClaw proxy."""
    global _proxy_process

    running = False
    if _proxy_process is not None:
        poll_result = _proxy_process.poll()
        running = poll_result is None

        if not running:
            # Process has exited, clean up
            _proxy_process = None

    return {
        "running": running,
        "proxy_port": 18789,
        "openclaw_port": 18790,
    }


@router.post("/start")
async def start_proxy():
    """Start the OpenClaw proxy."""
    global _proxy_process

    # Check if already running
    if _proxy_process is not None:
        poll_result = _proxy_process.poll()
        if poll_result is None:
            return {"status": "already_running", "message": "Proxy is already running"}
        else:
            _proxy_process = None

    try:
        # Start proxy as subprocess
        _proxy_process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "securevector.integrations.openclaw_proxy",
                "--port", "18789",
                "--openclaw-port", "18790",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )

        # Wait a moment to check if it started successfully
        await asyncio.sleep(0.5)

        if _proxy_process.poll() is None:
            logger.info("OpenClaw proxy started on port 18789")
            return {"status": "started", "message": "Proxy started on port 18789"}
        else:
            return {"status": "failed", "message": "Proxy failed to start"}

    except Exception as e:
        logger.exception("Failed to start proxy")
        return {"status": "error", "message": str(e)}


@router.post("/stop")
async def stop_proxy():
    """Stop the OpenClaw proxy."""
    global _proxy_process

    if _proxy_process is None:
        return {"status": "not_running", "message": "Proxy is not running"}

    try:
        _proxy_process.terminate()
        _proxy_process.wait(timeout=5)
        _proxy_process = None
        logger.info("OpenClaw proxy stopped")
        return {"status": "stopped", "message": "Proxy stopped"}
    except subprocess.TimeoutExpired:
        _proxy_process.kill()
        _proxy_process = None
        return {"status": "killed", "message": "Proxy force killed"}
    except Exception as e:
        logger.exception("Failed to stop proxy")
        return {"status": "error", "message": str(e)}
