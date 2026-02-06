#!/bin/bash
# SecureVector AI Threat Monitor - macOS Installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Secure-Vector/securevector-ai-threat-monitor/master/src/securevector/app/installers/macos/install.sh | bash
#
# Or download and run:
#   chmod +x install.sh
#   ./install.sh

set -e

APP_NAME="SecureVector"
SERVICE_NAME="io.securevector.threatmonitor"
INSTALL_DIR="$HOME/.securevector"
PLIST_PATH="$HOME/Library/LaunchAgents/$SERVICE_NAME.plist"

# Security: Validate and sanitize port
validate_port() {
    local port="$1"
    if [[ ! "$port" =~ ^[0-9]+$ ]]; then
        echo "Invalid port: not a number"
        return 1
    fi
    if [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
        echo "Invalid port: must be between 1024 and 65535"
        return 1
    fi
    echo "$port"
}

# Get port with validation
RAW_PORT="${SECUREVECTOR_PORT:-8741}"
PORT=$(validate_port "$RAW_PORT") || { echo "Error: $PORT"; exit 1; }

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo ""
echo -e "${CYAN}========================================"
echo "  SecureVector AI Threat Monitor"
echo "  macOS Installer"
echo -e "========================================${NC}"
echo ""

# Check for uninstall flag
if [[ "$1" == "--uninstall" ]] || [[ "$1" == "-u" ]]; then
    echo -e "${YELLOW}Uninstalling SecureVector...${NC}"
    echo ""

    # Stop service
    echo "[1/4] Stopping service..."
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    echo -e "  ${GREEN}Done${NC}"

    # Remove LaunchAgent
    echo "[2/4] Removing LaunchAgent..."
    rm -f "$PLIST_PATH"
    echo -e "  ${GREEN}Done${NC}"

    # Remove install directory
    echo "[3/4] Removing app data..."
    rm -rf "$INSTALL_DIR"
    echo -e "  ${GREEN}Done${NC}"

    # Uninstall pip package
    echo "[4/4] Uninstalling pip package..."
    pip3 uninstall securevector-ai-monitor -y 2>/dev/null || true
    echo -e "  ${GREEN}Done${NC}"

    echo ""
    echo -e "${GREEN}SecureVector has been uninstalled.${NC}"
    exit 0
fi

# Install
echo -e "${YELLOW}[1/5] Checking Python installation...${NC}"
if command -v python3 &> /dev/null; then
    PYTHON_VERSION=$(python3 --version)
    echo -e "  ${GREEN}Found: $PYTHON_VERSION${NC}"
else
    echo -e "  ${RED}ERROR: Python 3 not found.${NC}"
    echo "  Install with: brew install python3"
    exit 1
fi

echo ""
echo -e "${YELLOW}[2/5] Installing SecureVector via pip...${NC}"
pip3 install --upgrade securevector-ai-monitor[app]
echo -e "  ${GREEN}SecureVector installed successfully!${NC}"

echo ""
echo -e "${YELLOW}[3/5] Creating install directory...${NC}"
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/logs"
chmod 700 "$INSTALL_DIR"
echo -e "  ${GREEN}Created: $INSTALL_DIR${NC}"

echo ""
echo -e "${YELLOW}[4/5] Creating LaunchAgent for autostart...${NC}"

# Find the securevector-app path and validate it exists
SECUREVECTOR_PATH=$(which securevector-app 2>/dev/null || python3 -c "import sys; print(sys.prefix + '/bin/securevector-app')")

# Security: Validate the path exists and is executable
if [[ ! -x "$SECUREVECTOR_PATH" ]]; then
    echo -e "  ${RED}ERROR: securevector-app not found or not executable${NC}"
    echo "  Path checked: $SECUREVECTOR_PATH"
    exit 1
fi

# Security: Ensure path doesn't contain dangerous characters
if [[ "$SECUREVECTOR_PATH" =~ [^a-zA-Z0-9/_.-] ]]; then
    echo -e "  ${RED}ERROR: Invalid characters in securevector-app path${NC}"
    exit 1
fi

# Create plist with properly escaped values
cat > "$PLIST_PATH" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_NAME}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${SECUREVECTOR_PATH}</string>
        <string>--port</string>
        <string>${PORT}</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>StandardOutPath</key>
    <string>${INSTALL_DIR}/logs/securevector.log</string>

    <key>StandardErrorPath</key>
    <string>${INSTALL_DIR}/logs/securevector-error.log</string>

    <key>WorkingDirectory</key>
    <string>${INSTALL_DIR}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
PLIST_EOF

# Security: Set restrictive permissions
chmod 600 "$PLIST_PATH"

echo -e "  ${GREEN}Created: $PLIST_PATH${NC}"

echo ""
echo -e "${YELLOW}[5/5] Starting SecureVector service...${NC}"

# Load the LaunchAgent
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

# Wait for service to start
sleep 3

# Check if running
if curl -s "http://127.0.0.1:${PORT}/health" > /dev/null 2>&1; then
    echo -e "  ${GREEN}SecureVector is running on port ${PORT}${NC}"
else
    echo -e "  ${YELLOW}SecureVector started (health check pending)${NC}"
fi

echo ""
echo -e "${GREEN}========================================"
echo "  Installation Complete!"
echo -e "========================================${NC}"
echo ""
echo "SecureVector is now running as a background service."
echo ""
echo -e "${CYAN}API Endpoint: http://localhost:${PORT}/analyze${NC}"
echo ""
echo "Commands:"
echo -e "  ${YELLOW}securevector-app${NC}              - Open desktop app"
echo -e "  ${YELLOW}launchctl stop ${SERVICE_NAME}${NC}  - Stop service"
echo -e "  ${YELLOW}launchctl start ${SERVICE_NAME}${NC} - Start service"
echo ""
echo "Logs:"
echo -e "  ${YELLOW}tail -f ${INSTALL_DIR}/logs/securevector.log${NC}"
echo ""
echo "To uninstall:"
echo -e "  ${YELLOW}./install.sh --uninstall${NC}"
echo ""
