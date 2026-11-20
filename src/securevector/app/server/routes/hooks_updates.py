"""Plugin update awareness across every harness plugin.

GET  /api/hooks/status-all      - Update fields for all eight plugins in one call
POST /api/hooks/update-plugins  - Restage every installed plugin that is stale

Each harness module exposes ``_update_state()`` (built on
``_hooks_common.update_state``) and its existing install handler. This module
only aggregates them; it never installs a plugin that is not installed.
"""

from __future__ import annotations

import asyncio
import importlib
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from ._plugin_guard import require_local_origin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hooks", tags=["Hooks"])

# One update run at a time: a second click while one runs gets a 409.
_UPDATE_LOCK = asyncio.Lock()

# (runtime id, module under securevector.app.server.routes)
HARNESSES: list[tuple[str, str]] = [
    ("claude-code", "hooks_claude_code"),
    ("codex", "hooks_codex"),
    ("copilot-cli", "hooks_copilot_cli"),
    ("cursor", "hooks_cursor"),
    ("antigravity", "hooks_antigravity"),
    ("opencode", "hooks_opencode"),
    ("openclaw", "hooks"),
    ("hermes", "hooks_hermes"),
]


def _module(name: str):
    return importlib.import_module(f"securevector.app.server.routes.{name}")


def plugin_states() -> list[dict]:
    """Update fields for every harness plugin. A harness whose state cannot
    be read is reported as not installed."""
    out: list[dict] = []
    for runtime, mod_name in HARNESSES:
        try:
            state = dict(_module(mod_name)._update_state())
        except Exception:
            logger.exception("Could not read plugin state for %s", runtime)
            state = {
                "installed": False,
                "files_current": False,
                "update_available": False,
                "installed_version": None,
                "bundled_version": None,
            }
        state["runtime"] = runtime
        out.append(state)
    return out


async def _run_install(runtime: str, mod_name: str) -> tuple[bool, Optional[str]]:
    """Run the harness's own install handler. Returns (ok, reason on failure)."""
    mod = _module(mod_name)
    if runtime == "openclaw":
        result = await mod.install_plugin(mod.InstallRequest(force=True))
    else:
        result = await mod.install_plugin()
    if hasattr(result, "model_dump"):
        result = result.model_dump()
    if isinstance(result, dict):
        if result.get("ok") is False or result.get("status") in ("error", "partial"):
            return False, result.get("message") or result.get("next_step") or "install failed"
    return True, None


async def update_plugins() -> list[dict]:
    """Restage every installed plugin whose files differ from the bundle.

    Returns one ``{runtime, before_version, after_version, status}`` per
    harness, where status is ``updated``, ``current``, ``not installed`` or
    ``failed`` (a failure also carries ``reason``). One failure never stops
    the rest.
    """
    results: list[dict] = []
    for runtime, mod_name in HARNESSES:
        before: Optional[str] = None
        after: Optional[str] = None
        reason: Optional[str] = None
        try:
            mod = _module(mod_name)
            state = mod._update_state()
            before = state.get("installed_version")
            after = before
            if not state.get("installed"):
                status = "not installed"
            elif not state.get("update_available"):
                status = "current"
            else:
                ok, reason = await _run_install(runtime, mod_name)
                state = mod._update_state()
                after = state.get("installed_version")
                if ok and not state.get("files_current"):
                    reason = "files still differ after the update"
                status = "updated" if ok and state.get("files_current") else "failed"
        except HTTPException as e:
            logger.warning("Plugin update for %s failed: %s", runtime, e.detail)
            status, reason = "failed", str(e.detail)
        except Exception as e:
            logger.exception("Plugin update for %s failed", runtime)
            status, reason = "failed", str(e) or type(e).__name__
        row = {
            "runtime": runtime,
            "before_version": before,
            "after_version": after,
            "status": status,
        }
        if status == "failed":
            row["reason"] = reason
        results.append(row)
    return results


def log_stale_plugins() -> None:
    """One INFO line naming installed plugins that differ from the bundle."""
    try:
        stale = [s for s in plugin_states() if s.get("update_available")]
    except Exception:
        logger.debug("Plugin update check failed", exc_info=True)
        return
    if stale:
        names = ", ".join(
            f"{s['runtime']} {s.get('installed_version') or '?'} -> {s.get('bundled_version') or '?'}"
            for s in stale
        )
        logger.info(
            "Plugin updates available: %s. Run securevector-app --update-plugins or use Connect Agents.",
            names,
        )


@router.get("/status-all")
async def status_all():
    """Update fields for every harness plugin in one response."""
    plugins = await asyncio.get_running_loop().run_in_executor(None, plugin_states)
    return {
        "plugins": plugins,
        "update_count": sum(1 for p in plugins if p.get("update_available")),
    }


@router.post("/update-plugins", dependencies=[Depends(require_local_origin)])
async def update_plugins_route():
    """Restage every installed, stale plugin through its own install path."""
    if _UPDATE_LOCK.locked():
        raise HTTPException(status_code=409, detail="update already running")
    async with _UPDATE_LOCK:
        results = await update_plugins()
    return {
        "results": results,
        "ok": not any(r["status"] == "failed" for r in results),
    }
