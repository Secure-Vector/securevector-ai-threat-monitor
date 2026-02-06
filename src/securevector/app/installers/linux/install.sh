#!/bin/bash
# SecureVector AI Threat Monitor - Linux Installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Secure-Vector/securevector-ai-threat-monitor/master/src/securevector/app/installers/linux/install.sh | bash
#
# Or download and run:
#   chmod +x install.sh
#   ./install.sh

set -e

APP_NAME="SecureVector"
SERVICE_NAME="securevector"
INSTALL_DIR="$HOME/.securevector"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SYSTEMD_USER_DIR/$SERVICE_NAME.service"

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
echo "  Linux Installer"
echo -e "========================================${NC}"
echo ""

# Check for uninstall flag
if [[ "$1" == "--uninstall" ]] || [[ "$1" == "-u" ]]; then
    echo -e "${YELLOW}Uninstalling SecureVector...${NC}"
    echo ""

    # Stop and disable service
    echo "[1/4] Stopping service..."
    systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
    systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
    echo -e "  ${GREEN}Done${NC}"

    # Remove systemd service
    echo "[2/4] Removing systemd service..."
    rm -f "$SERVICE_FILE"
    systemctl --user daemon-reload
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
echo -e "${YELLOW}[1/6] Checking Python installation...${NC}"
if command -v python3 &> /dev/null; then
    PYTHON_VERSION=$(python3 --version)
    echo -e "  ${GREEN}Found: $PYTHON_VERSION${NC}"
else
    echo -e "  ${RED}ERROR: Python 3 not found.${NC}"
    echo "  Install with: sudo apt install python3 python3-pip"
    exit 1
fi

echo ""
echo -e "${YELLOW}[2/6] Installing SecureVector via pip...${NC}"
pip3 install --upgrade securevector-ai-monitor[app]
echo -e "  ${GREEN}SecureVector installed successfully!${NC}"

echo ""
echo -e "${YELLOW}[3/6] Creating install directory...${NC}"
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/logs"
chmod 700 "$INSTALL_DIR"
echo -e "  ${GREEN}Created: $INSTALL_DIR${NC}"

echo ""
echo -e "${YELLOW}[4/6] Creating systemd user service...${NC}"
mkdir -p "$SYSTEMD_USER_DIR"

# Find the securevector-app path and validate
SECUREVECTOR_PATH=$(which securevector-app 2>/dev/null || echo "$HOME/.local/bin/securevector-app")

# Security: Validate the path exists and is executable
if [[ ! -x "$SECUREVECTOR_PATH" ]]; then
    echo -e "  ${RED}ERROR: securevector-app not found or not executable${NC}"
    echo "  Path checked: $SECUREVECTOR_PATH"
    echo "  Try: pip3 install --user securevector-ai-monitor[app]"
    exit 1
fi

# Security: Ensure path doesn't contain dangerous characters
if [[ "$SECUREVECTOR_PATH" =~ [^a-zA-Z0-9/_.-] ]]; then
    echo -e "  ${RED}ERROR: Invalid characters in securevector-app path${NC}"
    exit 1
fi

# Escape paths for systemd
ESCAPED_SECUREVECTOR_PATH=$(systemd-escape --path "$SECUREVECTOR_PATH" 2>/dev/null || echo "$SECUREVECTOR_PATH")
ESCAPED_INSTALL_DIR=$(systemd-escape --path "$INSTALL_DIR" 2>/dev/null || echo "$INSTALL_DIR")

cat > "$SERVICE_FILE" << SERVICE_EOF
[Unit]
Description=SecureVector AI Threat Monitor
Documentation=https://github.com/Secure-Vector/securevector-ai-threat-monitor
After=network.target

[Service]
Type=simple
ExecStart=${SECUREVECTOR_PATH} --port ${PORT}
Restart=on-failure
RestartSec=10
WorkingDirectory=${INSTALL_DIR}
StandardOutput=append:${INSTALL_DIR}/logs/securevector.log
StandardError=append:${INSTALL_DIR}/logs/securevector-error.log

# Security hardening
NoNewPrivileges=true
ProtectHome=read-only
ProtectSystem=strict
ReadWritePaths=${INSTALL_DIR}

# Environment
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=default.target
SERVICE_EOF

# Security: Set restrictive permissions
chmod 600 "$SERVICE_FILE"

echo -e "  ${GREEN}Created: $SERVICE_FILE${NC}"

echo ""
echo -e "${YELLOW}[5/6] Enabling systemd user service...${NC}"

# Reload systemd
systemctl --user daemon-reload

# Enable service to start on login
systemctl --user enable "$SERVICE_NAME"

# Enable lingering so service runs even when not logged in (optional)
if command -v loginctl &> /dev/null; then
    loginctl enable-linger "$USER" 2>/dev/null || true
fi

echo -e "  ${GREEN}Service enabled${NC}"

echo ""
echo -e "${YELLOW}[6/6] Starting SecureVector service...${NC}"

systemctl --user start "$SERVICE_NAME"

# Wait for service to start
sleep 3

# Check if running
if curl -s "http://127.0.0.1:${PORT}/health" > /dev/null 2>&1; then
    echo -e "  ${GREEN}SecureVector is running on port ${PORT}${NC}"
elif systemctl --user is-active --quiet "$SERVICE_NAME"; then
    echo -e "  ${YELLOW}SecureVector started (health check pending)${NC}"
else
    echo -e "  ${RED}Service may have failed to start. Check logs:${NC}"
    echo "  journalctl --user -u $SERVICE_NAME -f"
fi

echo ""
echo -e "${GREEN}========================================"
echo "  Installation Complete!"
echo -e "========================================${NC}"
echo ""
echo "SecureVector is now running as a systemd user service."
echo ""
echo -e "${CYAN}API Endpoint: http://localhost:${PORT}/analyze${NC}"
echo ""
echo "Commands:"
echo -e "  ${YELLOW}securevector-app${NC}                         - Open desktop app"
echo -e "  ${YELLOW}systemctl --user status ${SERVICE_NAME}${NC}    - Check status"
echo -e "  ${YELLOW}systemctl --user stop ${SERVICE_NAME}${NC}      - Stop service"
echo -e "  ${YELLOW}systemctl --user start ${SERVICE_NAME}${NC}     - Start service"
echo -e "  ${YELLOW}systemctl --user restart ${SERVICE_NAME}${NC}   - Restart service"
echo ""
echo "Logs:"
echo -e "  ${YELLOW}journalctl --user -u ${SERVICE_NAME} -f${NC}"
echo -e "  ${YELLOW}tail -f ${INSTALL_DIR}/logs/securevector.log${NC}"
echo ""
echo "To uninstall:"
echo -e "  ${YELLOW}./install.sh --uninstall${NC}"
echo ""

# Desktop entry for application menu (optional)
DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP_FILE="$DESKTOP_DIR/securevector.desktop"
mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_FILE" << DESKTOP_EOF
[Desktop Entry]
Name=SecureVector
Comment=AI Threat Monitor
Exec=${SECUREVECTOR_PATH}
Icon=security
Terminal=false
Type=Application
Categories=Security;Development;
Keywords=security;ai;threat;monitor;
DESKTOP_EOF
chmod 644 "$DESKTOP_FILE"
echo "Desktop entry created: $DESKTOP_FILE"
