#!/bin/bash
# setup-vps.sh — redirects to the full auto-setup.sh
# Run: bash setup-vps.sh
# The auto-setup.sh script handles: Docker, Bun, git clone, database, .env, build, start
# Run this instead for the complete automated setup:
#   curl -fsSL https://raw.githubusercontent.com/brendadeeznuts1111/sportsterminal/main/deploy/auto-setup.sh | bash
echo "========================================"
echo "  Please use auto-setup.sh instead:" 
echo "========================================"
echo ""
echo "  curl -fsSL https://raw.githubusercontent.com/brendadeeznuts1111/sportsterminal/main/deploy/auto-setup.sh | bash"
echo ""
echo "  This script handles everything:"
echo "  - Installs Docker, Bun"
echo "  - Clones the repository"
echo "  - Initializes the database (3-layer fallback)"
echo "  - Creates .env with secure defaults"
echo "  - Builds and starts containers"
echo "  - Generates SSH deploy keys"
echo "  - Runs health verification"
echo "  - Configures GitHub Actions integration"
echo ""

# If you still want the minimal bootstrap, run:
# bash <(curl -fsSL https://raw.githubusercontent.com/brendadeeznuts1111/sportsterminal/main/deploy/auto-setup.sh) 2>/dev/null || {
#   echo "Full script unavailable — falling back to manual setup"
#   apt-get update -qq && apt-get install -y -qq curl git docker.io docker-compose-plugin
#   mkdir -p /opt/sportsterminal/data /opt/sportsterminal/logs
#   echo "Manual setup incomplete. Please run the curl command above."
# }
