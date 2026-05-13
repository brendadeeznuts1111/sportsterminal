#!/bin/bash
set -e
echo "========================================"
echo "  Sports Terminal VPS Bootstrap"
echo "  Server: 2.24.96.9"
echo "========================================"
echo ""

# 1. Install Docker
echo "[1/5] Installing Docker..."
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
  systemctl enable docker >/dev/null 2>&1
  systemctl start docker >/dev/null 2>&1
  echo "  Docker installed."
else
  echo "  Docker already installed."
fi

# 2. Install Docker Compose
echo "[2/5] Installing Docker Compose..."
if ! docker compose version &>/dev/null; then
  apt-get install -y -qq docker-compose-plugin >/dev/null 2>&1
  echo "  Docker Compose installed."
else
  echo "  Docker Compose already installed."
fi

# 3. Create project directory
echo "[3/5] Setting up project structure..."
mkdir -p /opt/sportsterminal/backend
cd /opt/sportsterminal

# 4. Create env file with production defaults
echo "[4/5] Creating environment file..."
cat > /opt/sportsterminal/.env << 'EOF'
# Production Environment
# Fill in your real values after setup
JWT_SECRET=change-me-in-production-min-32-chars
TUNNEL_TOKEN=REPLACE_WITH_YOUR_CLOUDFLARE_TUNNEL_TOKEN
EOF

# 5. Create data directories
echo "[5/5] Creating data directories..."
mkdir -p data logs
chmod 755 data logs

echo ""
echo "========================================"
echo "  ✅ VPS Base Setup Complete"
echo "========================================"
echo ""
echo "  Project: /opt/sportsterminal"
echo ""
echo "  NEXT STEPS (in order):"
echo ""
echo "  1. SSH into the server and clone the code:"
echo "     cd /opt/sportsterminal"
echo "     git clone https://github.com/brendadeeznuts1111/sportsterminal.git ."
echo ""
echo "  2. Create a Cloudflare Tunnel:"
echo "     - Go to https://dash.cloudflare.com"
echo "     - Zero Trust → Networks → Tunnels"
echo "     - Create a tunnel → Copy TUNNEL_TOKEN"
echo "     - Route terminal.factory-wager.com to localhost:3000"
echo ""
echo "  3. Edit the env file:"
echo "     nano /opt/sportsterminal/.env"
echo "     Set: JWT_SECRET=your-secure-random-string"
echo "     Set: TUNNEL_TOKEN=your-cloudflare-tunnel-token"
echo ""
echo "  4. Start everything:"
echo "     cd /opt/sportsterminal && docker compose up -d --build"
echo ""
echo "  5. Verify health:"
echo "     curl http://localhost:3000/health"
echo ""
echo "  6. Add SSH deploy key to GitHub:"
echo "     - On VPS: cat ~/.ssh/id_ed25519.pub"
echo "     - On GitHub: Settings → Deploy keys → Add key"
echo "     - On GitHub: Settings → Secrets → Actions → VPS_SSH_KEY"
echo ""
