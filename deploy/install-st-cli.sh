#!/bin/bash
# install-st-cli.sh — Install the st CLI tool
# Run: curl -fsSL https://raw.githubusercontent.com/brendadeeznuts1111/sportsterminal/master/deploy/install-st-cli.sh | bash

set -e
INSTALL_DIR="/usr/local/bin"
REPO="brendadeeznuts1111/sportsterminal"

echo "== Installing st CLI =="

# Download the CLI script
sudo curl -fsSL "https://raw.githubusercontent.com/$REPO/master/deploy/st" -o "$INSTALL_DIR/st" 2>/dev/null || {
  curl -fsSL "https://raw.githubusercontent.com/$REPO/master/deploy/st" -o "$INSTALL_DIR/st"
}

chmod +x "$INSTALL_DIR/st"

echo "✅ st CLI installed to $INSTALL_DIR/st"
echo ""
echo "Usage:"
echo "  st deploy     # Deploy app to VPS"
echo "  st status     # Check health"
echo "  st logs       # View logs"
echo "  st ssh        # SSH into VPS"
echo "  st help       # Show all commands"
echo ""
