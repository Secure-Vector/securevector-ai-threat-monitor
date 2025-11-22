#!/usr/bin/env python3
"""
SecureVector MCP Server - Multi-Platform Integration

This script provides comprehensive integration support for:
- Claude Desktop
- Claude CLI
- Cursor IDE
- Other MCP-compatible tools

Usage:
    python multi_platform_integration.py --platform claude-desktop --install
    python multi_platform_integration.py --platform claude-cli --install
    python multi_platform_integration.py --platform cursor --install
    python multi_platform_integration.py --platform all --install
    python multi_platform_integration.py --status

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import asyncio
import json
import sys
import argparse
import subprocess
import shutil
from pathlib import Path
from typing import Dict, Any, Optional, List

try:
    from securevector import create_mcp_server, check_mcp_dependencies
    from securevector.mcp.config import create_default_config
    SECUREVECTOR_AVAILABLE = True
except ImportError:
    SECUREVECTOR_AVAILABLE = False


class MCPPlatformIntegrator:
    """Handles MCP server integration across multiple platforms."""

    def __init__(self):
        self.platforms = {
            'claude-desktop': ClaudeDesktopIntegrator(),
            'claude-cli': ClaudeCLIIntegrator(),
            'cursor': CursorIntegrator(),
        }

    def install(self, platform: str, api_key: Optional[str] = None) -> bool:
        """Install MCP server for specified platform(s)."""
        if platform == 'all':
            success_count = 0
            for platform_name, integrator in self.platforms.items():
                print(f"\n🔧 Installing for {platform_name.replace('-', ' ').title()}...")
                if integrator.install(api_key):
                    success_count += 1
                    print(f"✅ {platform_name.replace('-', ' ').title()} integration successful")
                else:
                    print(f"❌ {platform_name.replace('-', ' ').title()} integration failed")

            print(f"\n📊 Installation Summary: {success_count}/{len(self.platforms)} platforms successful")
            return success_count > 0

        elif platform in self.platforms:
            return self.platforms[platform].install(api_key)
        else:
            print(f"❌ Unknown platform: {platform}")
            print(f"Available platforms: {', '.join(self.platforms.keys())}, all")
            return False

    def status(self) -> Dict[str, Any]:
        """Check installation status across all platforms."""
        status = {}
        for platform_name, integrator in self.platforms.items():
            status[platform_name] = integrator.get_status()
        return status

    def uninstall(self, platform: str) -> bool:
        """Uninstall MCP server from specified platform(s)."""
        if platform == 'all':
            success_count = 0
            for platform_name, integrator in self.platforms.items():
                if integrator.uninstall():
                    success_count += 1
            return success_count > 0
        elif platform in self.platforms:
            return self.platforms[platform].uninstall()
        return False


class BaseIntegrator:
    """Base class for platform integrators."""

    def __init__(self, platform_name: str):
        self.platform_name = platform_name

    def install(self, api_key: Optional[str] = None) -> bool:
        """Install MCP server integration."""
        raise NotImplementedError

    def uninstall(self) -> bool:
        """Uninstall MCP server integration."""
        raise NotImplementedError

    def get_status(self) -> Dict[str, Any]:
        """Get integration status."""
        raise NotImplementedError

    def create_mcp_config(self, api_key: Optional[str] = None) -> Dict[str, Any]:
        """Create standard MCP server configuration."""
        config = {
            "command": sys.executable,
            "args": ["-m", "securevector.mcp"],
            "env": {
                "SECUREVECTOR_MCP_TRANSPORT": "stdio",
                "SECUREVECTOR_MCP_MODE": "balanced",
                "SECUREVECTOR_MCP_LOG_LEVEL": "INFO"
            }
        }

        if api_key:
            config["env"]["SECUREVECTOR_API_KEY"] = api_key

        return config


class ClaudeDesktopIntegrator(BaseIntegrator):
    """Claude Desktop integration."""

    def __init__(self):
        super().__init__("Claude Desktop")

    def get_config_path(self) -> Optional[Path]:
        """Get Claude Desktop configuration file path."""
        import os

        if os.name == 'nt':  # Windows
            config_dir = Path.home() / "AppData" / "Roaming" / "Claude"
        elif sys.platform == 'darwin':  # macOS
            config_dir = Path.home() / "Library" / "Application Support" / "Claude"
        else:  # Linux
            config_dir = Path.home() / ".config" / "claude"

        return config_dir / "claude_desktop_config.json"

    def install(self, api_key: Optional[str] = None) -> bool:
        """Install for Claude Desktop."""
        try:
            config_path = self.get_config_path()
            if not config_path:
                return False

            # Load existing config
            config = {}
            if config_path.exists():
                with open(config_path, 'r') as f:
                    config = json.load(f)

            # Add MCP server
            if "mcpServers" not in config:
                config["mcpServers"] = {}

            config["mcpServers"]["securevector"] = self.create_mcp_config(api_key)

            # Save config
            config_path.parent.mkdir(parents=True, exist_ok=True)
            with open(config_path, 'w') as f:
                json.dump(config, f, indent=2)

            return True

        except Exception as e:
            print(f"❌ Claude Desktop installation failed: {e}")
            return False

    def uninstall(self) -> bool:
        """Uninstall from Claude Desktop."""
        try:
            config_path = self.get_config_path()
            if not config_path or not config_path.exists():
                return True

            with open(config_path, 'r') as f:
                config = json.load(f)

            if "mcpServers" in config and "securevector" in config["mcpServers"]:
                del config["mcpServers"]["securevector"]

                with open(config_path, 'w') as f:
                    json.dump(config, f, indent=2)

            return True

        except Exception:
            return False

    def get_status(self) -> Dict[str, Any]:
        """Get Claude Desktop integration status."""
        config_path = self.get_config_path()

        status = {
            "platform": self.platform_name,
            "config_path": str(config_path) if config_path else None,
            "config_exists": config_path.exists() if config_path else False,
            "mcp_configured": False,
            "installation_detected": False
        }

        if config_path and config_path.exists():
            try:
                with open(config_path, 'r') as f:
                    config = json.load(f)

                if "mcpServers" in config and "securevector" in config["mcpServers"]:
                    status["mcp_configured"] = True
                    status["installation_detected"] = True

            except Exception:
                pass

        return status


class ClaudeCLIIntegrator(BaseIntegrator):
    """Claude CLI integration."""

    def __init__(self):
        super().__init__("Claude CLI")

    def get_config_path(self) -> Optional[Path]:
        """Get Claude CLI configuration directory."""
        import os

        # Claude CLI typically stores config in ~/.claude/
        config_dir = Path.home() / ".claude"
        return config_dir / "mcp_servers.json"

    def is_claude_cli_installed(self) -> bool:
        """Check if Claude CLI is installed."""
        return shutil.which("claude") is not None

    def install(self, api_key: Optional[str] = None) -> bool:
        """Install for Claude CLI."""
        try:
            if not self.is_claude_cli_installed():
                print("⚠️  Claude CLI not found. Install from: https://github.com/anthropics/claude-cli")
                return False

            config_path = self.get_config_path()
            config_path.parent.mkdir(parents=True, exist_ok=True)

            # Load existing MCP servers config
            mcp_config = {}
            if config_path.exists():
                with open(config_path, 'r') as f:
                    mcp_config = json.load(f)

            # Add SecureVector MCP server
            mcp_config["securevector"] = self.create_mcp_config(api_key)

            # Save config
            with open(config_path, 'w') as f:
                json.dump(mcp_config, f, indent=2)

            # Try to register with Claude CLI
            try:
                result = subprocess.run(
                    ["claude", "mcp", "add", "securevector", str(config_path)],
                    capture_output=True,
                    text=True,
                    timeout=30
                )
                if result.returncode == 0:
                    print("✅ Registered with Claude CLI")
                else:
                    print("⚠️  Manual registration may be needed with Claude CLI")
            except (subprocess.TimeoutExpired, FileNotFoundError):
                print("⚠️  Could not auto-register with Claude CLI - manual setup may be needed")

            return True

        except Exception as e:
            print(f"❌ Claude CLI installation failed: {e}")
            return False

    def uninstall(self) -> bool:
        """Uninstall from Claude CLI."""
        try:
            # Remove from MCP servers config
            config_path = self.get_config_path()
            if config_path and config_path.exists():
                with open(config_path, 'r') as f:
                    mcp_config = json.load(f)

                if "securevector" in mcp_config:
                    del mcp_config["securevector"]

                    with open(config_path, 'w') as f:
                        json.dump(mcp_config, f, indent=2)

            # Try to unregister from Claude CLI
            if self.is_claude_cli_installed():
                try:
                    subprocess.run(
                        ["claude", "mcp", "remove", "securevector"],
                        capture_output=True,
                        timeout=30
                    )
                except:
                    pass

            return True

        except Exception:
            return False

    def get_status(self) -> Dict[str, Any]:
        """Get Claude CLI integration status."""
        config_path = self.get_config_path()
        cli_installed = self.is_claude_cli_installed()

        status = {
            "platform": self.platform_name,
            "cli_installed": cli_installed,
            "config_path": str(config_path) if config_path else None,
            "config_exists": config_path.exists() if config_path else False,
            "mcp_configured": False,
            "installation_detected": False
        }

        if config_path and config_path.exists():
            try:
                with open(config_path, 'r') as f:
                    mcp_config = json.load(f)

                if "securevector" in mcp_config:
                    status["mcp_configured"] = True
                    status["installation_detected"] = True

            except Exception:
                pass

        return status


class CursorIntegrator(BaseIntegrator):
    """Cursor IDE integration."""

    def __init__(self):
        super().__init__("Cursor IDE")

    def get_config_path(self) -> Optional[Path]:
        """Get Cursor IDE configuration directory."""
        import os

        if os.name == 'nt':  # Windows
            config_dir = Path.home() / "AppData" / "Roaming" / "Cursor" / "User"
        elif sys.platform == 'darwin':  # macOS
            config_dir = Path.home() / "Library" / "Application Support" / "Cursor" / "User"
        else:  # Linux
            config_dir = Path.home() / ".config" / "Cursor" / "User"

        return config_dir / "settings.json"

    def is_cursor_installed(self) -> bool:
        """Check if Cursor IDE is installed."""
        # Check for cursor command or application
        return (shutil.which("cursor") is not None or
                self.get_config_path().parent.exists())

    def install(self, api_key: Optional[str] = None) -> bool:
        """Install for Cursor IDE."""
        try:
            if not self.is_cursor_installed():
                print("⚠️  Cursor IDE not found. Install from: https://cursor.sh/")
                return False

            config_path = self.get_config_path()
            config_path.parent.mkdir(parents=True, exist_ok=True)

            # Load existing settings
            settings = {}
            if config_path.exists():
                with open(config_path, 'r') as f:
                    settings = json.load(f)

            # Add MCP configuration to Cursor settings
            if "mcp" not in settings:
                settings["mcp"] = {}

            if "servers" not in settings["mcp"]:
                settings["mcp"]["servers"] = {}

            # Add SecureVector MCP server
            settings["mcp"]["servers"]["securevector"] = self.create_mcp_config(api_key)

            # Add MCP enablement
            settings["mcp.enabled"] = True

            # Save settings
            with open(config_path, 'w') as f:
                json.dump(settings, f, indent=2)

            # Create workspace-specific MCP config if possible
            self._create_workspace_config(api_key)

            return True

        except Exception as e:
            print(f"❌ Cursor IDE installation failed: {e}")
            return False

    def _create_workspace_config(self, api_key: Optional[str] = None):
        """Create workspace-specific MCP configuration."""
        try:
            # Create .cursor/mcp.json in current directory for workspace-specific config
            cursor_dir = Path.cwd() / ".cursor"
            cursor_dir.mkdir(exist_ok=True)

            mcp_config = {
                "servers": {
                    "securevector": self.create_mcp_config(api_key)
                }
            }

            with open(cursor_dir / "mcp.json", 'w') as f:
                json.dump(mcp_config, f, indent=2)

        except Exception:
            pass  # Workspace config is optional

    def uninstall(self) -> bool:
        """Uninstall from Cursor IDE."""
        try:
            config_path = self.get_config_path()

            # Remove from global settings
            if config_path and config_path.exists():
                with open(config_path, 'r') as f:
                    settings = json.load(f)

                if ("mcp" in settings and
                    "servers" in settings["mcp"] and
                    "securevector" in settings["mcp"]["servers"]):

                    del settings["mcp"]["servers"]["securevector"]

                    # Remove MCP section if empty
                    if not settings["mcp"]["servers"]:
                        settings.pop("mcp", None)
                        settings.pop("mcp.enabled", None)

                    with open(config_path, 'w') as f:
                        json.dump(settings, f, indent=2)

            # Remove workspace config
            workspace_config = Path.cwd() / ".cursor" / "mcp.json"
            if workspace_config.exists():
                workspace_config.unlink()

            return True

        except Exception:
            return False

    def get_status(self) -> Dict[str, Any]:
        """Get Cursor IDE integration status."""
        config_path = self.get_config_path()
        cursor_installed = self.is_cursor_installed()
        workspace_config = Path.cwd() / ".cursor" / "mcp.json"

        status = {
            "platform": self.platform_name,
            "ide_installed": cursor_installed,
            "config_path": str(config_path) if config_path else None,
            "config_exists": config_path.exists() if config_path else False,
            "workspace_config_exists": workspace_config.exists(),
            "mcp_configured": False,
            "installation_detected": False
        }

        # Check global config
        if config_path and config_path.exists():
            try:
                with open(config_path, 'r') as f:
                    settings = json.load(f)

                if ("mcp" in settings and
                    "servers" in settings["mcp"] and
                    "securevector" in settings["mcp"]["servers"]):
                    status["mcp_configured"] = True
                    status["installation_detected"] = True

            except Exception:
                pass

        # Check workspace config
        if workspace_config.exists():
            try:
                with open(workspace_config, 'r') as f:
                    config = json.load(f)

                if "servers" in config and "securevector" in config["servers"]:
                    status["workspace_configured"] = True
                    if not status["installation_detected"]:
                        status["installation_detected"] = True

            except Exception:
                pass

        return status


def print_status(status: Dict[str, Any]):
    """Print comprehensive status across all platforms."""
    print("🔍 SecureVector MCP Integration Status")
    print("=" * 50)

    # SecureVector availability
    if SECUREVECTOR_AVAILABLE:
        print("✅ SecureVector SDK: Available")
        mcp_deps = check_mcp_dependencies()
        if mcp_deps:
            print("✅ MCP Dependencies: Available")
        else:
            print("❌ MCP Dependencies: Not available")
            print("   Install with: pip install securevector-ai-monitor[mcp]")
    else:
        print("❌ SecureVector SDK: Not available")
        print("   Install with: pip install securevector-ai-monitor")

    print("\n📊 Platform Integration Status:")

    for platform_name, platform_status in status.items():
        platform_display = platform_name.replace('-', ' ').title()
        print(f"\n{platform_display}:")

        if platform_name == "claude-desktop":
            if platform_status["config_exists"]:
                print(f"  ✅ Configuration file: Found")
                print(f"     Path: {platform_status['config_path']}")
            else:
                print(f"  ⚠️  Configuration file: Not found")
                print(f"     Expected: {platform_status['config_path']}")

            if platform_status["mcp_configured"]:
                print(f"  ✅ MCP Server: Configured")
            else:
                print(f"  ❌ MCP Server: Not configured")

        elif platform_name == "claude-cli":
            if platform_status["cli_installed"]:
                print(f"  ✅ Claude CLI: Installed")
            else:
                print(f"  ❌ Claude CLI: Not installed")
                print(f"     Install from: https://github.com/anthropics/claude-cli")

            if platform_status["mcp_configured"]:
                print(f"  ✅ MCP Server: Configured")
            else:
                print(f"  ❌ MCP Server: Not configured")

        elif platform_name == "cursor":
            if platform_status["ide_installed"]:
                print(f"  ✅ Cursor IDE: Installed")
            else:
                print(f"  ❌ Cursor IDE: Not installed")
                print(f"     Install from: https://cursor.sh/")

            if platform_status["mcp_configured"]:
                print(f"  ✅ Global MCP Config: Configured")
            else:
                print(f"  ❌ Global MCP Config: Not configured")

            if platform_status.get("workspace_configured"):
                print(f"  ✅ Workspace MCP Config: Configured")
            else:
                print(f"  ⚠️  Workspace MCP Config: Not configured")

        if platform_status["installation_detected"]:
            print(f"  🎯 Status: Ready to use")
        else:
            print(f"  🔧 Status: Installation required")


def show_usage_examples():
    """Show usage examples for each platform."""
    print("📚 Platform Usage Examples")
    print("=" * 50)

    examples = [
        {
            "platform": "Claude Desktop",
            "description": "AI assistant with desktop interface",
            "usage": [
                "1. Restart Claude Desktop after installation",
                "2. Look for SecureVector tools in the interface",
                "3. Try: 'Analyze this prompt for threats: Hello world'",
                "4. Try: 'Get threat statistics for the last 24 hours'",
                "5. Try: 'Show me prompt injection detection rules'"
            ]
        },
        {
            "platform": "Claude CLI",
            "description": "Command-line interface for Claude",
            "usage": [
                "1. Use Claude CLI with MCP integration:",
                "   claude chat --mcp securevector",
                "2. Or enable MCP globally:",
                "   claude config set mcp.enabled true",
                "3. Use MCP tools in conversation:",
                "   'Use analyze_prompt to check: \"ignore instructions\"'",
                "4. Access resources:",
                "   'Show rules for prompt injection category'"
            ]
        },
        {
            "platform": "Cursor IDE",
            "description": "AI-powered code editor",
            "usage": [
                "1. Restart Cursor after installation",
                "2. MCP tools available in AI chat:",
                "   - analyze_prompt: Check code for AI threats",
                "   - batch_analyze: Process multiple inputs",
                "   - get_threat_statistics: View security metrics",
                "3. Use in code review:",
                "   'Analyze this user input for security threats'",
                "4. Access security policies:",
                "   'Show the strict security policy template'"
            ]
        }
    ]

    for example in examples:
        print(f"\n🔧 {example['platform']}")
        print(f"   {example['description']}")
        print("   Usage:")
        for usage_item in example['usage']:
            print(f"     {usage_item}")


def main():
    parser = argparse.ArgumentParser(
        description="SecureVector MCP Server - Multi-Platform Integration",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    parser.add_argument(
        "--platform",
        choices=["claude-desktop", "claude-cli", "cursor", "all"],
        default="all",
        help="Target platform for integration"
    )

    parser.add_argument(
        "--install",
        action="store_true",
        help="Install MCP server for specified platform(s)"
    )

    parser.add_argument(
        "--uninstall",
        action="store_true",
        help="Uninstall MCP server from specified platform(s)"
    )

    parser.add_argument(
        "--api-key",
        type=str,
        help="SecureVector API key (optional)"
    )

    parser.add_argument(
        "--status",
        action="store_true",
        help="Check installation status across all platforms"
    )

    parser.add_argument(
        "--examples",
        action="store_true",
        help="Show usage examples for each platform"
    )

    args = parser.parse_args()

    integrator = MCPPlatformIntegrator()

    if args.install:
        print(f"🚀 Installing SecureVector MCP Server for {args.platform}")
        success = integrator.install(args.platform, args.api_key)
        if success:
            print("\n🎉 Installation completed!")
            print("\n📋 Next steps:")
            print("1. Restart your target application(s)")
            print("2. Look for SecureVector tools in the interface")
            print("3. Try analyzing a prompt for threats")
            print("4. Run --examples for platform-specific usage")
        else:
            print("\n❌ Installation failed")
            sys.exit(1)

    elif args.uninstall:
        print(f"🗑️  Uninstalling SecureVector MCP Server from {args.platform}")
        success = integrator.uninstall(args.platform)
        if success:
            print("✅ Uninstallation completed")
        else:
            print("❌ Uninstallation failed")
            sys.exit(1)

    elif args.status:
        status = integrator.status()
        print_status(status)

    elif args.examples:
        show_usage_examples()

    else:
        print("SecureVector MCP Server - Multi-Platform Integration")
        print("Use --help for available options")
        print("\nQuick start:")
        print("  python multi_platform_integration.py --status")
        print("  python multi_platform_integration.py --install --platform all")
        print("  python multi_platform_integration.py --examples")


if __name__ == "__main__":
    main()