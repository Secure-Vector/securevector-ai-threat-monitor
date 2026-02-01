#!/bin/bash
# Post-installation script for SecureVector on Linux

echo "SecureVector installed successfully!"
echo ""
echo "To start SecureVector as a background service:"
echo "  systemctl --user enable securevector"
echo "  systemctl --user start securevector"
echo ""
echo "To run the desktop app:"
echo "  securevector"
echo ""
echo "API endpoint will be available at: http://localhost:8741/analyze"
