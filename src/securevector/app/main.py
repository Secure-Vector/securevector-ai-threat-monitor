"""
Main entry point for the SecureVector Local Threat Monitor Desktop Application.

Usage:
    securevector-app [OPTIONS]

Options:
    --port PORT       API server port (default: 8741)
    --host HOST       API server host (default: 127.0.0.1)
    --web             Run in web browser mode (no desktop window)
    --proxy           Start LLM proxy for any app
    --openclaw        Enable OpenClaw integration (auto-patches pi-ai)
    --proxy-port PORT Proxy listen port (default: 8742)
    --provider NAME   LLM provider: openai, anthropic, ollama, groq, etc.
    --mode MODE       Proxy mode: analyze (log only) or block (stop threats)
    --revert-proxy    Undo OpenClaw setup (restore original files)
    --debug           Enable debug logging
    --version         Show version and exit

Examples:
    # Any app (LangChain, CrewAI, custom apps)
    securevector-app --proxy --provider ollama --web

    # OpenClaw users (one command, auto-patches pi-ai)
    securevector-app --proxy --provider openai --web --openclaw
"""

import argparse
import logging
import os
import sys
import threading
import time
from pathlib import Path

from securevector.app import (
    __app_name__,
    __version__,
    check_app_dependencies,
    AppDependencyError,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def get_assets_path() -> Path:
    """Get the path to the assets directory."""
    return Path(__file__).parent / "assets"


def start_server(host: str, port: int, ready_event: threading.Event) -> None:
    """Start the FastAPI server in a background thread."""
    import uvicorn
    from securevector.app.server.app import create_app

    app = create_app(host=host, port=port)

    # Signal that we're about to start
    def signal_ready():
        time.sleep(0.5)  # Give uvicorn a moment to bind
        ready_event.set()

    threading.Thread(target=signal_ready, daemon=True).start()

    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="warning",
        access_log=False,
    )


def run_desktop(host: str, port: int, debug: bool) -> None:
    """Run the application with a native desktop window."""
    import webview

    assets_path = get_assets_path()
    loading_html = assets_path / "web" / "loading.html"
    favicon_path = assets_path / "favicon.ico"

    # Start with loading screen
    window = webview.create_window(
        title="SecureVector",
        url=str(loading_html) if loading_html.exists() else f"http://{host}:{port}",
        width=1200,
        height=800,
        min_size=(800, 600),
        text_select=True,
    )

    # Start server in background
    server_ready = threading.Event()
    server_thread = threading.Thread(
        target=start_server,
        args=(host, port, server_ready),
        daemon=True,
    )
    server_thread.start()

    def on_loaded():
        """Called when webview is ready."""
        # Wait for server to be ready
        server_ready.wait(timeout=10)
        time.sleep(0.3)  # Extra buffer for server startup

        # Navigate to the main app
        window.load_url(f"http://{host}:{port}")

    # Start webview (blocking)
    webview.start(on_loaded, debug=debug)


def run_web(host: str, port: int) -> None:
    """Run in web-only mode (no desktop window)."""
    import uvicorn
    from securevector.app.server.app import create_app

    print(f"\n  SecureVector Local Threat Monitor v{__version__}")
    print(f"  ─────────────────────────────────────────")
    print(f"  Web UI:  http://{host}:{port}")
    print(f"  API:     http://{host}:{port}/docs")
    print(f"\n  Press Ctrl+C to stop\n")

    app = create_app(host=host, port=port)
    uvicorn.run(app, host=host, port=port, log_level="info")


def run_llm_proxy(provider: str, proxy_port: int, securevector_port: int, verbose: bool = False, mode: str = "analyze", multi: bool = False) -> None:
    """Run LLM proxy only (no web server)."""
    try:
        from securevector.integrations.openclaw_llm_proxy import LLMProxy, MultiProviderProxy
        import uvicorn
    except ImportError:
        print("Error: Missing dependencies. Install with: pip install httpx fastapi uvicorn")
        sys.exit(1)

    block_threats = (mode == "block")

    if multi:
        # Multi-provider mode with path-based routing
        proxy = MultiProviderProxy(
            securevector_url=f"http://127.0.0.1:{securevector_port}",
            block_threats=block_threats,
            verbose=verbose,
        )

        print(f"\n  SecureVector Multi-Provider LLM Proxy")
        print(f"  ─────────────────────────────────────────")
        print(f"  Proxy:      http://127.0.0.1:{proxy_port}")
        print(f"  Mode:       {'BLOCK' if block_threats else 'ANALYZE'}")
        print(f"\n  Multi-provider routing enabled!")
        print(f"  Use path-based URLs:")
        print(f"    http://localhost:{proxy_port}/openai/v1")
        print(f"    http://localhost:{proxy_port}/anthropic")
        print(f"    http://localhost:{proxy_port}/ollama/v1")
        print(f"\n  Press Ctrl+C to stop\n")
    else:
        # Single provider mode
        target_url = LLMProxy.PROVIDERS.get(provider, "https://api.openai.com")

        proxy = LLMProxy(
            target_url=target_url,
            securevector_url=f"http://127.0.0.1:{securevector_port}",
            block_threats=block_threats,
            verbose=verbose,
            provider=provider,
        )

        print(f"\n  SecureVector LLM Proxy")
        print(f"  ─────────────────────────────────────────")
        print(f"  Proxy:      http://127.0.0.1:{proxy_port}")
        print(f"  Provider:   {provider} → {target_url}")
        print(f"  Mode:       {'BLOCK' if block_threats else 'ANALYZE'}")
        print(f"\n  Start OpenClaw with:")
        print(f"    OPENAI_BASE_URL=http://localhost:{proxy_port} openclaw gateway")
        print(f"\n  Press Ctrl+C to stop\n")

    app = proxy.create_app()
    try:
        uvicorn.run(app, host="127.0.0.1", port=proxy_port, log_level="warning" if not verbose else "info")
    except KeyboardInterrupt:
        print("\n[llm-proxy] Shutting down...")


def run_web_with_proxy(host: str, port: int, platform: str, proxy_port: int, target_port: int, verbose: bool = False, mode: str = "analyze") -> None:
    """Run web server and proxy together."""
    import asyncio
    import uvicorn
    from securevector.app.server.app import create_app

    block_threats = (mode == "block")
    mode_label = "BLOCK" if block_threats else "ANALYZE"

    try:
        from securevector.integrations.openclaw_proxy import SecureVectorProxy
    except ImportError:
        print("Error: Missing dependencies. Install with: pip install websockets httpx")
        sys.exit(1)

    print(f"\n  SecureVector Local Threat Monitor v{__version__}")
    print(f"  ─────────────────────────────────────────")
    print(f"  Web UI:     http://{host}:{port}")
    print(f"  API:        http://{host}:{port}/docs")
    print(f"  Proxy:      ws://127.0.0.1:{proxy_port} → OpenClaw ({target_port})")
    print(f"  Mode:       {mode_label} {'(threats will be blocked)' if block_threats else '(threats logged only)'}")
    if verbose:
        print(f"  Verbose:    ON (logging all messages)")
    print(f"\n  Press Ctrl+C to stop\n")

    app = create_app(host=host, port=port)

    # Run both uvicorn and proxy
    async def run_both():
        proxy = SecureVectorProxy(
            proxy_port=proxy_port,
            openclaw_host="127.0.0.1",
            openclaw_port=target_port,
            securevector_host="127.0.0.1",
            securevector_port=port,
            verbose=verbose,
            block_threats=block_threats,
        )

        config = uvicorn.Config(app, host=host, port=port, log_level="warning")
        server = uvicorn.Server(config)

        await asyncio.gather(
            server.serve(),
            proxy.run(),
        )

    try:
        asyncio.run(run_both())
    except KeyboardInterrupt:
        print("\n  Shutting down...")


def run_web_with_llm_proxy(host: str, port: int, provider: str, proxy_port: int, verbose: bool = False, mode: str = "analyze", multi: bool = False) -> None:
    """Run web server and LLM proxy together."""
    import asyncio
    import uvicorn
    from securevector.app.server.app import create_app
    from securevector.app.server.routes.proxy import set_proxy_running_in_process

    try:
        from securevector.integrations.openclaw_llm_proxy import LLMProxy, MultiProviderProxy
    except ImportError:
        print("Error: Missing dependencies. Install with: pip install httpx fastapi uvicorn")
        sys.exit(1)

    block_threats = (mode == "block")

    print(f"\n  SecureVector Local Threat Monitor v{__version__}")
    print(f"  ─────────────────────────────────────────")
    print(f"  Web UI:     http://{host}:{port}")
    print(f"  API:        http://{host}:{port}/docs")

    if multi:
        print(f"  LLM Proxy:  http://127.0.0.1:{proxy_port} (multi-provider)")
        print(f"  Mode:       {'BLOCK' if block_threats else 'ANALYZE'}")
        if verbose:
            print(f"  Verbose:    ON")
        print(f"\n  Multi-provider routing enabled!")
        print(f"  Configure your apps with:")
        print(f"    OpenAI:    base_url=\"http://localhost:{proxy_port}/openai/v1\"")
        print(f"    Anthropic: base_url=\"http://localhost:{proxy_port}/anthropic\"")
        print(f"    Ollama:    base_url=\"http://localhost:{proxy_port}/ollama/v1\"")
        print(f"    Groq:      base_url=\"http://localhost:{proxy_port}/groq/v1\"")

        proxy = MultiProviderProxy(
            securevector_url=f"http://127.0.0.1:{port}",
            block_threats=block_threats,
            verbose=verbose,
        )
        # Signal multi-provider mode
        set_proxy_running_in_process(True, "multi")
    else:
        target_url = LLMProxy.PROVIDERS.get(provider, "https://api.openai.com")
        print(f"  LLM Proxy:  http://127.0.0.1:{proxy_port} → {provider}")
        print(f"  Mode:       {'BLOCK' if block_threats else 'ANALYZE'}")
        if verbose:
            print(f"  Verbose:    ON")
        print(f"\n  Configure your app with:")
        print(f"    OPENAI_BASE_URL=http://localhost:{proxy_port}/v1 python your_app.py")

        proxy = LLMProxy(
            target_url=target_url,
            securevector_url=f"http://127.0.0.1:{port}",
            block_threats=block_threats,
            verbose=verbose,
            provider=provider,
        )
        set_proxy_running_in_process(True, provider)

    print(f"\n  Press Ctrl+C to stop\n")

    web_app = create_app(host=host, port=port)
    proxy_app = proxy.create_app()

    async def run_both():
        web_config = uvicorn.Config(web_app, host=host, port=port, log_level="warning")
        web_server = uvicorn.Server(web_config)

        proxy_config = uvicorn.Config(proxy_app, host="127.0.0.1", port=proxy_port, log_level="warning" if not verbose else "info")
        proxy_server = uvicorn.Server(proxy_config)

        await asyncio.gather(
            web_server.serve(),
            proxy_server.serve(),
        )

    try:
        asyncio.run(run_both())
    except KeyboardInterrupt:
        print("\n  Shutting down...")
    finally:
        set_proxy_running_in_process(False)


def _find_pi_ai_path() -> str:
    """Find the pi-ai installation path. Returns path or exits with error."""
    import subprocess

    search_paths = []

    # Method 1: npm root -g
    try:
        result = subprocess.run(
            ["npm", "root", "-g"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            npm_global = result.stdout.strip()
            search_paths.append(os.path.join(npm_global, "openclaw", "node_modules", "@mariozechner", "pi-ai"))
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    # Method 2: which openclaw -> trace back
    try:
        result = subprocess.run(
            ["which", "openclaw"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            openclaw_bin = result.stdout.strip()
            openclaw_real = os.path.realpath(openclaw_bin)
            parts = openclaw_real.split(os.sep)
            for i, part in enumerate(parts):
                if part == "openclaw" and i > 0 and parts[i - 1] == "node_modules":
                    base = os.sep.join(parts[:i + 1])
                    search_paths.append(os.path.join(base, "node_modules", "@mariozechner", "pi-ai"))
                    break
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    # Method 3: Common nvm paths
    home = os.path.expanduser("~")
    nvm_base = os.path.join(home, ".nvm", "versions", "node")
    if os.path.isdir(nvm_base):
        for node_ver in os.listdir(nvm_base):
            search_paths.append(os.path.join(
                nvm_base, node_ver, "lib", "node_modules", "openclaw",
                "node_modules", "@mariozechner", "pi-ai"
            ))

    # Deduplicate and check
    seen = set()
    for path in search_paths:
        path = os.path.normpath(path)
        if path in seen:
            continue
        seen.add(path)
        if os.path.isdir(path):
            return path

    print("  ✗ Could not find pi-ai installation.")
    print()
    print("  Make sure OpenClaw is installed globally:")
    print("    npm install -g openclaw")
    sys.exit(1)


def _secure_path_join(base_path: str, relative_path: str) -> str:
    """Securely join paths, preventing path traversal attacks.

    Args:
        base_path: The base directory (must be absolute)
        relative_path: The relative path to join (e.g., "dist/providers/openai.js")

    Returns:
        The joined absolute path

    Raises:
        ValueError: If the resulting path escapes the base directory
    """
    # Normalize paths
    base_path = os.path.abspath(base_path)
    # Join and resolve to absolute path
    joined = os.path.abspath(os.path.join(base_path, relative_path))

    # Security check: ensure the result is within base_path
    if not joined.startswith(base_path + os.sep) and joined != base_path:
        raise ValueError(f"Path traversal detected: {relative_path} escapes {base_path}")

    return joined


# Provider → which pi-ai files to patch
_PROVIDER_PATCH_MAP = {
    # All OpenAI-compatible providers go through these 2 files
    "openai": ["dist/providers/openai-completions.js", "dist/providers/openai-responses.js"],
    "groq": ["dist/providers/openai-completions.js", "dist/providers/openai-responses.js"],
    "openrouter": ["dist/providers/openai-completions.js", "dist/providers/openai-responses.js"],
    "cerebras": ["dist/providers/openai-completions.js", "dist/providers/openai-responses.js"],
    "mistral": ["dist/providers/openai-completions.js", "dist/providers/openai-responses.js"],
    "xai": ["dist/providers/openai-completions.js", "dist/providers/openai-responses.js"],
    "deepseek": ["dist/providers/openai-completions.js", "dist/providers/openai-responses.js"],
    "together": ["dist/providers/openai-completions.js", "dist/providers/openai-responses.js"],
    "fireworks": ["dist/providers/openai-completions.js", "dist/providers/openai-responses.js"],
    "perplexity": ["dist/providers/openai-completions.js", "dist/providers/openai-responses.js"],
    "cohere": ["dist/providers/openai-completions.js", "dist/providers/openai-responses.js"],
    "ollama": ["dist/providers/openai-completions.js", "dist/providers/openai-responses.js"],
    "moonshot": ["dist/providers/openai-completions.js", "dist/providers/openai-responses.js"],
    "minimax": ["dist/providers/openai-completions.js", "dist/providers/openai-responses.js"],
    "lmstudio": ["dist/providers/openai-completions.js", "dist/providers/openai-responses.js"],
    "litellm": ["dist/providers/openai-completions.js", "dist/providers/openai-responses.js"],
    "azure": ["dist/providers/openai-completions.js", "dist/providers/openai-responses.js"],
    # Anthropic has its own file
    "anthropic": ["dist/providers/anthropic.js"],
    # Google has 2 files
    "gemini": ["dist/providers/google.js", "dist/providers/google-gemini-cli.js"],
}

# All patchable files
_ALL_PATCH_FILES = [
    "dist/providers/openai-completions.js",
    "dist/providers/openai-responses.js",
    "dist/providers/anthropic.js",
    "dist/providers/google.js",
    "dist/providers/google-gemini-cli.js",
]

# All patches keyed by file
_ALL_PATCHES = [
    {
        "file": "dist/providers/openai-completions.js",
        "search": "baseURL: model.baseUrl,",
        "replace": "baseURL: process.env.OPENAI_BASE_URL || model.baseUrl,",
        "desc": "openai-completions.js (OPENAI_BASE_URL)",
    },
    {
        "file": "dist/providers/openai-responses.js",
        "search": "baseURL: model.baseUrl,",
        "replace": "baseURL: process.env.OPENAI_BASE_URL || model.baseUrl,",
        "desc": "openai-responses.js  (OPENAI_BASE_URL)",
    },
    {
        "file": "dist/providers/anthropic.js",
        "search": "baseURL: model.baseUrl,",
        "replace": "baseURL: process.env.ANTHROPIC_BASE_URL || model.baseUrl,",
        "desc": "anthropic.js         (ANTHROPIC_BASE_URL)",
    },
    {
        "file": "dist/providers/google.js",
        "search": "if (model.baseUrl) {",
        "replace": "const _gBaseUrl = process.env.GOOGLE_GENAI_BASE_URL || model.baseUrl;\n    if (_gBaseUrl) {",
        "desc": "google.js            (GOOGLE_GENAI_BASE_URL)",
    },
    {
        "file": "dist/providers/google.js",
        "search": "httpOptions.baseUrl = model.baseUrl;",
        "replace": "httpOptions.baseUrl = _gBaseUrl;",
        "desc": "google.js            (baseUrl assignment)",
    },
    {
        "file": "dist/providers/google-gemini-cli.js",
        "search": "const baseUrl = model.baseUrl?.trim();",
        "replace": "const baseUrl = (process.env.GOOGLE_GENAI_BASE_URL || model.baseUrl)?.trim();",
        "desc": "google-gemini-cli.js (GOOGLE_GENAI_BASE_URL)",
    },
]

# Provider → env var name
_PROVIDER_ENV_VAR = {
    "openai": "OPENAI_BASE_URL",
    "anthropic": "ANTHROPIC_BASE_URL",
    "gemini": "GOOGLE_GENAI_BASE_URL",
}

# Provider → basePath suffix
_PROVIDER_BASE_PATH = {
    "openai": "/v1",
    "anthropic": "",
    "gemini": "/v1beta",
}


def setup_proxy(provider: str = "openai") -> None:
    """One-time setup: patch OpenClaw's pi-ai library for a specific provider."""
    import shutil

    # Resolve provider to patch files
    if provider in _PROVIDER_PATCH_MAP:
        target_files = _PROVIDER_PATCH_MAP[provider]
        provider_label = provider
    else:
        # Unknown provider — assume OpenAI-compatible
        target_files = _PROVIDER_PATCH_MAP["openai"]
        provider_label = f"{provider} (OpenAI-compatible)"

    # Deduplicate
    target_files = list(dict.fromkeys(target_files))

    # Determine env var for next steps
    env_var = _PROVIDER_ENV_VAR.get(provider, "OPENAI_BASE_URL")
    base_path = _PROVIDER_BASE_PATH.get(provider, "/v1")

    print()
    print("  SecureVector Proxy Setup")
    print("  ════════════════════════════════════════════════════════════")
    print()
    print("  WHY THIS IS NEEDED:")
    print("  OpenClaw uses the @mariozechner/pi-ai library which hardcodes")
    print("  LLM API URLs in its source, bypassing env var overrides.")
    print("  This patch restores env var support so traffic routes through")
    print("  the SecureVector proxy for threat scanning.")
    print()
    print(f"  PROVIDER: {provider_label}")
    print(f"  FILES TO PATCH: {len(target_files)}")
    for f in target_files:
        print(f"    - {os.path.basename(f)}")
    print()
    print("  ════════════════════════════════════════════════════════════")
    print()

    # --- Find pi-ai installation ---
    print("  [1/3] Searching for pi-ai installation...")
    pi_ai_path = _find_pi_ai_path()
    print(f"  ✓ Found pi-ai at: {pi_ai_path}")
    print()

    # --- Filter patches to only the target files ---
    patches = [p for p in _ALL_PATCHES if p["file"] in target_files]

    # --- Apply patches ---
    print("  [2/3] Applying patches...")

    patched = 0
    skipped = 0
    failed = 0

    for patch in patches:
        # Security: Use secure path join to prevent path traversal
        try:
            filepath = _secure_path_join(pi_ai_path, patch["file"])
        except ValueError as e:
            print(f"    ✗ Security error: {e}")
            failed += 1
            continue

        if not os.path.isfile(filepath):
            print(f"    ✗ Not found: {patch['desc']}")
            failed += 1
            continue

        with open(filepath, "r") as f:
            content = f.read()

        if patch["replace"] in content:
            print(f"    ○ Already patched: {patch['desc']}")
            skipped += 1
            continue

        if patch["search"] not in content:
            print(f"    ✗ Pattern not found: {patch['desc']} (pi-ai version may have changed)")
            failed += 1
            continue

        # Create backup
        backup_path = filepath + ".securevector.bak"
        if not os.path.exists(backup_path):
            shutil.copy2(filepath, backup_path)

        # Apply patch
        new_content = content.replace(patch["search"], patch["replace"])
        with open(filepath, "w") as f:
            f.write(new_content)

        print(f"    ✓ Patched: {patch['desc']}")
        patched += 1

    print()

    # --- Summary ---
    print("  [3/3] Summary")
    print(f"    Patched: {patched}  Skipped (already done): {skipped}  Failed: {failed}")
    print()

    if failed > 0:
        print("  ⚠ Some patches failed. The proxy may not work.")
        print("  Try updating OpenClaw and running --setup-proxy again.")
        print()

    if patched > 0 or skipped > 0:
        print("  ✓ Setup complete! Proxy routing is now supported.")
        print()
        print("  NEXT STEPS:")
        print(f"    1. Start SecureVector proxy:")
        print(f"         securevector-app --proxy --provider {provider}")
        print()
        print(f"    2. Start OpenClaw with proxy routing:")
        print(f"         {env_var}=http://localhost:8742{base_path} openclaw gateway")
        print()
        print(f"  NOTE: Re-run after updating OpenClaw (npm update -g openclaw)")
        print()
        print(f"  To undo: securevector-app --revert-proxy --provider {provider}")
    print()


def _auto_setup_proxy_if_needed(provider: str) -> None:
    """Check if proxy is already set up for this provider, auto-run setup if not."""
    target_files = _PROVIDER_PATCH_MAP.get(provider, _PROVIDER_PATCH_MAP["openai"])
    patches = [p for p in _ALL_PATCHES if p["file"] in target_files]

    try:
        pi_ai_path = _find_pi_ai_path()
    except SystemExit:
        # pi-ai not found, skip auto-setup
        return

    needs_setup = False
    for patch in patches:
        # Security: Use secure path join to prevent path traversal
        try:
            filepath = _secure_path_join(pi_ai_path, patch["file"])
        except ValueError:
            continue

        if not os.path.isfile(filepath):
            continue
        with open(filepath, "r") as f:
            content = f.read()
        if patch["replace"] not in content and patch["search"] in content:
            needs_setup = True
            break

    if needs_setup:
        print(f"[proxy] Auto-running setup for {provider} (first time)...")
        print()
        setup_proxy(provider=provider)


def revert_proxy() -> None:
    """Revert proxy setup: restore ALL pi-ai files from backups."""
    import shutil

    print()
    print("  SecureVector Proxy Revert")
    print("  ════════════════════════════════════════════════════════════")
    print()
    print(f"  FILES TO CHECK: {len(_ALL_PATCH_FILES)}")
    print("  ════════════════════════════════════════════════════════════")
    print()

    # --- Restore all pi-ai files ---
    print("  Restoring pi-ai files...")
    pi_ai_path = _find_pi_ai_path()
    print(f"  Found pi-ai at: {pi_ai_path}")
    print()

    restored = 0
    no_backup = 0
    errors = 0

    for rel_path in _ALL_PATCH_FILES:
        # Security: Use secure path join to prevent path traversal
        try:
            filepath = _secure_path_join(pi_ai_path, rel_path)
        except ValueError as e:
            print(f"    ✗ Security error: {e}")
            errors += 1
            continue

        backup_path = filepath + ".securevector.bak"
        filename = os.path.basename(rel_path)

        if not os.path.isfile(backup_path):
            print(f"    ○ No backup: {filename}")
            no_backup += 1
            continue

        shutil.copy2(backup_path, filepath)
        os.remove(backup_path)
        print(f"    ✓ Restored: {filename}")
        restored += 1

    print()

    # --- Summary ---
    print(f"  Files restored: {restored}")
    print()

    if restored > 0:
        print("  ✓ Revert complete. OpenClaw is back to its original state.")
        print("    API keys and environment variables were not modified.")
    else:
        print("  Nothing to revert. Everything was already clean.")
    print()


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="SecureVector Local Threat Monitor Desktop Application",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  Single provider (Ollama):
    securevector-app --proxy --provider ollama --web
    Then set: OPENAI_BASE_URL=http://localhost:8742/ollama/v1

  Multiple providers (use different LLMs simultaneously):
    securevector-app --proxy --multi --web
    Then set: OPENAI_BASE_URL=http://localhost:8742/openai/v1
              ANTHROPIC_BASE_URL=http://localhost:8742/anthropic

  OpenClaw integration:
    securevector-app --proxy --provider anthropic --web --openclaw
    Then run: ANTHROPIC_BASE_URL=http://localhost:8742/anthropic openclaw --gateway

  Revert OpenClaw patches:
    securevector-app --revert-proxy
""",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8741,
        help="API server port (default: 8741)",
    )
    parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="API server host (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--web",
        action="store_true",
        help="Open browser UI instead of desktop window",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging",
    )
    parser.add_argument(
        "--version",
        action="store_true",
        help="Show version and exit",
    )
    parser.add_argument(
        "--proxy",
        action="store_true",
        help="Start LLM proxy server. Use with --provider (single) or --multi (multiple LLMs)",
    )
    parser.add_argument(
        "--openclaw",
        action="store_true",
        help="Auto-patch pi-ai provider files for OpenClaw/ClaudBot integration",
    )
    parser.add_argument(
        "--multi",
        action="store_true",
        help="Multi-provider mode: route to multiple LLMs via path (/openai/v1, /anthropic, /ollama/v1)",
    )
    parser.add_argument(
        "--proxy-port",
        type=int,
        default=8742,
        help="LLM proxy listen port (default: 8742)",
    )
    parser.add_argument(
        "--provider",
        type=str,
        choices=["openai", "anthropic", "ollama", "groq", "openrouter", "cerebras", "mistral", "xai", "gemini", "azure", "lmstudio", "litellm", "moonshot", "minimax", "deepseek", "together", "fireworks", "perplexity", "cohere"],
        default="openai",
        help="Single LLM provider to proxy. Ignored if --multi is set",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Log all messages passing through proxy",
    )
    parser.add_argument(
        "--mode",
        type=str,
        choices=["analyze", "block"],
        default="analyze",
        help="analyze: log threats only (default), block: stop threats",
    )
    parser.add_argument(
        "--setup-proxy",
        action="store_true",
        help="One-time setup: patch OpenClaw pi-ai files for proxy routing",
    )
    parser.add_argument(
        "--revert-proxy",
        action="store_true",
        help="Restore original OpenClaw pi-ai files (undo --openclaw patches)",
    )

    args = parser.parse_args()

    if args.version:
        print(f"SecureVector Local Threat Monitor v{__version__}")
        sys.exit(0)

    if args.setup_proxy:
        setup_proxy(provider=args.provider or "openai")
        return

    if args.revert_proxy:
        revert_proxy()
        return

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)
        logger.debug("Debug mode enabled")

    # Proxy mode - starts LLM proxy (works with any app)
    if args.proxy:
        # If --openclaw flag, auto-patch pi-ai files
        if args.openclaw:
            _auto_setup_proxy_if_needed(args.provider)

        if args.web:
            # Run both web server and LLM proxy together
            run_web_with_llm_proxy(args.host, args.port, args.provider, args.proxy_port, args.verbose, args.mode, args.multi)
            return
        else:
            # Run LLM proxy only
            run_llm_proxy(args.provider, args.proxy_port, args.port, args.verbose, args.mode, args.multi)
            return

    # Check dependencies
    try:
        check_app_dependencies()
    except AppDependencyError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    # Initialize database before starting
    import asyncio
    from securevector.app.database.connection import init_database
    from securevector.app.database.migrations import init_database_schema
    from securevector.app.utils.platform import ensure_app_directories

    # Ensure directories exist
    ensure_app_directories()

    # Initialize database
    db = asyncio.run(init_database())
    asyncio.run(init_database_schema(db))

    logger.info(f"Starting SecureVector on {args.host}:{args.port}")

    if args.web:
        run_web(args.host, args.port)
    else:
        run_desktop(args.host, args.port, args.debug)


if __name__ == "__main__":
    main()
