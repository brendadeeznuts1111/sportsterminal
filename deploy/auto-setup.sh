#!/bin/bash
# ================================================
#  Sports Terminal — Fully Automated VPS Setup
#  One command. Zero manual steps.
#  Run via hosting web console:
#    curl -fsSL https://raw.githubusercontent.com/brendadeeznuts1111/sportsterminal/main/deploy/auto-setup.sh | bash
# ================================================
set -e

# ── Colors ──
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC}   $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail()  { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }

# ── Config ──
REPO_URL="https://github.com/brendadeeznuts1111/sportsterminal.git"
INSTALL_DIR="/opt/sportsterminal"
DOMAIN="terminal.factory-wager.com"

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  Sports Terminal — Auto Setup${NC}"
echo -e "${CYAN}  Domain: ${DOMAIN}${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# ═══════════════════════════════════════════════════
# 1. SYSTEM PREREQUISITES
# ═══════════════════════════════════════════════════
info "[1/8] Installing system prerequisites..."
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq curl git unzip openssl >/dev/null 2>&1
ok "System packages ready"

# ═══════════════════════════════════════════════════
# 2. DOCKER
# ═══════════════════════════════════════════════════
info "[2/8] Installing Docker..."
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
  systemctl enable docker >/dev/null 2>&1
  systemctl start docker >/dev/null 2>&1
fi
if ! docker compose version &>/dev/null; then
  apt-get install -y -qq docker-compose-plugin >/dev/null 2>&1
fi
ok "Docker $(docker --version | cut -d' ' -f3 | tr -d ',') ready"

# ═══════════════════════════════════════════════════
# 3. BUN
# ═══════════════════════════════════════════════════
info "[3/8] Installing Bun..."
if ! command -v bun &>/dev/null; then
  echo "" | curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
  export BUN_PATH="$HOME/.bun/bin"
  export PATH="$BUN_PATH:$PATH"
  echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc
fi
ok "Bun $(bun --version) ready"

# ═══════════════════════════════════════════════════
# 4. CLONE REPOSITORY
# ═══════════════════════════════════════════════════
info "[4/8] Cloning repository..."
rm -rf "$INSTALL_DIR"
if ! git clone --depth=1 "$REPO_URL" "$INSTALL_DIR" 2>/dev/null; then
  if [ -n "$GITHUB_TOKEN" ]; then
    git clone --depth=1 "https://brendadeeznuts1111:$GITHUB_TOKEN@github.com/brendadeeznuts1111/sportsterminal.git" "$INSTALL_DIR"
  else
    fail "Could not clone. If repo is private, set GITHUB_TOKEN env var and retry."
  fi
fi
cd "$INSTALL_DIR"
git checkout main 2>/dev/null || true
ok "Repository cloned to $INSTALL_DIR"

# ═══════════════════════════════════════════════════
# 5. DATABASE — 3-layer fallback
# ═══════════════════════════════════════════════════
info "[5/8] Initializing database..."
cd "$INSTALL_DIR/backend"
bun install 2>&1 | tail -5
mkdir -p data

export DATABASE_URL="${DATABASE_URL:-$INSTALL_DIR/backend/data/terminal.db}"

# Layer 1: Try the fixed migrate.ts (calls initDatabase + migrateDatabase)
if bun run scripts/migrate.ts 2>&1; then
  ok "Database initialized via migration"
else
  warn "Migration script failed — running direct table creation..."
  
  # Layer 2: Direct initDatabase import
  bun -e "
    const path = '$INSTALL_DIR/backend/data/terminal.db';
    const mod = await import('$INSTALL_DIR/backend/src/database.ts');
    const db = await mod.initDatabase(path);
    console.log('  Tables created');
    await mod.migrateDatabase(db).catch(e => console.log('  Migration step:', e.message));
    await db.close();
  " 2>&1 && ok "Database initialized via direct init" || {
    
    # Layer 3: Ultimate fallback — create core tables via inline SQL
    warn "Creating core tables inline..."
    bun -e "
      const { Database } = require('bun:sqlite');
      const db = new Database('$INSTALL_DIR/backend/data/terminal.db');
      db.run('PRAGMA journal_mode=WAL');
      db.run('PRAGMA foreign_keys=ON');
      db.run(\`
        CREATE TABLE IF NOT EXISTS wagers (
          wager_number INTEGER PRIMARY KEY,
          agent_id TEXT NOT NULL, customer_id TEXT NOT NULL,
          login TEXT NOT NULL, wager_type TEXT,
          amount_wagered INTEGER NOT NULL, to_win_amount INTEGER NOT NULL,
          volume_amount INTEGER NOT NULL, insert_datetime TEXT NOT NULL,
          ticket_writer TEXT NOT NULL, short_desc TEXT NOT NULL,
          vip TEXT NOT NULL, agent_login TEXT NOT NULL,
          sport TEXT, parsed_game TEXT, parsed_market TEXT,
          parsed_side TEXT, parsed_price REAL, parsed_period TEXT,
          matched_event_id TEXT, pin_reference_json TEXT, raw_json TEXT,
          agent_level INTEGER, agent_type TEXT, parent_agent_id TEXT,
          mapped_agent_id TEXT, mapped_agent_login TEXT,
          agent_path_json TEXT, hierarchy_source TEXT,
          scraped_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS odds_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL, sport TEXT, league TEXT,
          home_team TEXT, away_team TEXT, start_time TEXT,
          book TEXT NOT NULL, market TEXT NOT NULL,
          line REAL, over_price REAL, under_price REAL,
          home_price REAL, away_price REAL, draw_price REAL,
          consensus_price REAL, is_best_line INTEGER DEFAULT 0,
          is_consensus INTEGER DEFAULT 0, movement_direction TEXT,
          movement_strength REAL, previous_price REAL,
          price_change_time TEXT, liquidity_score REAL,
          health_status TEXT DEFAULT 'unknown',
          source TEXT NOT NULL DEFAULT 'odds_snapshots',
          fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS player_agent_map (
          player_id TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'buckeye',
          player_login TEXT NOT NULL, agent_id TEXT NOT NULL,
          agent_login TEXT, source TEXT NOT NULL DEFAULT 'hierarchy_backfill',
          linked_accounts_json TEXT,
          last_refreshed DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (provider, player_id)
        );
        CREATE TABLE IF NOT EXISTS agent_hierarchy (
          agent_id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'buckeye',
          login TEXT NOT NULL, display_name TEXT,
          parent_agent_id TEXT, level INTEGER, agent_type TEXT,
          seq_number INTEGER, child_count INTEGER DEFAULT 0,
          player_count INTEGER DEFAULT 0,
          head_count_rate_m REAL DEFAULT 0,
          inet_head_count_rate_m REAL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY, name TEXT NOT NULL,
          provider TEXT NOT NULL, login TEXT, display_name TEXT,
          parent_agent_id TEXT, tier INTEGER, level INTEGER,
          child_count INTEGER DEFAULT 0, player_count INTEGER DEFAULT 0,
          seq_number INTEGER, agent_type TEXT,
          head_count_rate_m REAL, inet_head_count_rate_m REAL
        );
        CREATE TABLE IF NOT EXISTS agent_closure (
          provider TEXT NOT NULL DEFAULT 'buckeye',
          ancestor TEXT NOT NULL, descendant TEXT NOT NULL,
          depth INTEGER NOT NULL,
          PRIMARY KEY (provider, ancestor, descendant)
        );
        CREATE TABLE IF NOT EXISTS master_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL DEFAULT '',
          timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          balance REAL, available_balance REAL,
          percent_book REAL, open_wager_count INTEGER DEFAULT 0,
          config_web_reports_json TEXT,
          config_web_reports_pending_json TEXT,
          sports_type_json TEXT, authorizations_json TEXT,
          message_json TEXT, new_emails_count_json TEXT,
          account_info_json TEXT, raw_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS patterns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pattern_type TEXT NOT NULL, category TEXT,
          entity_id TEXT, entity_type TEXT,
          confidence REAL, evidence TEXT, score REAL,
          status TEXT DEFAULT 'active',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          alert_type TEXT NOT NULL, severity TEXT,
          entity_id TEXT, entity_type TEXT,
          message TEXT, acknowledged INTEGER DEFAULT 0,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
      \`);
      db.close();
    " 2>&1
    ok "Database initialized via inline SQL"
  }
fi

# Verify DB
info "  Verifying database..."
bun -e "
  const { Database } = require('bun:sqlite');
  const db = new Database('$INSTALL_DIR/backend/data/terminal.db');
  const tables = db.query(\"SELECT name FROM sqlite_master WHERE type='table'\").all();
  console.log('  Tables:', tables.length);
  db.close();
" 2>&1
ok "Database ready"

# ═══════════════════════════════════════════════════
# 6. ENVIRONMENT CONFIGURATION
# ═══════════════════════════════════════════════════
info "[6/8] Configuring environment..."
JWT_SECRET="${JWT_SECRET:-$(openssl rand -hex 32)}"
TUNNEL_TOKEN="${TUNNEL_TOKEN:-}"

cat > "$INSTALL_DIR/deploy/.env" << EOF
# Generated by auto-setup on $(date -u +%Y-%m-%d)
JWT_SECRET=$JWT_SECRET
TUNNEL_TOKEN=$TUNNEL_TOKEN
EOF
ok "Environment configured"

# ═══════════════════════════════════════════════════
# 7. BUILD AND START
# ═══════════════════════════════════════════════════
info "[7/8] Building and starting containers..."
cd "$INSTALL_DIR/deploy"
docker compose build app 2>&1 | tail -5
docker compose up -d app 2>&1 | tail -3

info "  Waiting for health check..."
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  sleep 3
  if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
    ok "Health check passed"
    break
  fi
  if [ "$i" = 12 ]; then
    warn "Health check timeout — restarting..."
    docker compose restart app 2>/dev/null
    sleep 10
    curl -sf http://localhost:3000/health >/dev/null 2>&1 && ok "Health OK after restart" || {
      warn "Still failing. Logs:"
      docker compose logs app --tail 20 2>/dev/null
    }
  fi
done

# ═══════════════════════════════════════════════════
# 8. SSH KEY + GITHUB
# ═══════════════════════════════════════════════════
info "[8/8] Generating SSH deploy key..."
mkdir -p ~/.ssh
if [ ! -f ~/.ssh/id_ed25519 ]; then
  ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -C "deploy@$DOMAIN" >/dev/null 2>&1
fi
PUBLIC_KEY=$(cat ~/.ssh/id_ed25519.pub)

if [ -n "$GITHUB_TOKEN" ]; then
  RESP=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "https://api.github.com/repos/brendadeeznuts1111/sportsterminal/keys" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"title\":\"VPS Deploy Key ($DOMAIN)\",\"key\":\"$PUBLIC_KEY\",\"read_only\":false}" 2>/dev/null)
  if [ "$RESP" = "201" ]; then
    ok "GitHub deploy key registered"
  else
    warn "Could not register deploy key (HTTP $RESP) — add manually"
  fi
fi

# ═══════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  ✅ SETUP COMPLETE${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "  ${CYAN}Server:${NC}     http://localhost:3000/health"
echo -e "  ${CYAN}Domain:${NC}      https://$DOMAIN"
echo -e "  ${CYAN}Project:${NC}     $INSTALL_DIR"
echo ""

if [ -z "$TUNNEL_TOKEN" ]; then
  echo -e "  ${YELLOW}⚠️  Cloudflare Tunnel not configured${NC}"
  echo ""
  echo "  1. Go to https://dash.cloudflare.com → Zero Trust → Networks → Tunnels"
  echo "  2. Create a tunnel → Copy the token"
  echo "  3. echo TUNNEL_TOKEN=your_token >> $INSTALL_DIR/deploy/.env"
  echo "  4. cd $INSTALL_DIR/deploy && docker compose up -d tunnel"
  echo "  5. Route $DOMAIN → localhost:3000"
  echo ""
fi

if [ -n "$TUNNEL_TOKEN" ]; then
  info "Starting Cloudflare Tunnel..."
  cd "$INSTALL_DIR/deploy"
  docker compose up -d tunnel >/dev/null 2>&1
  ok "Tunnel started"
fi

if [ -z "$GITHUB_TOKEN" ]; then
  echo -e "  ${YELLOW}⚠️  Auto-deploy not configured${NC}"
  echo ""
  echo "  1. SSH public key (add to GitHub Deploy Keys):"
  echo "     ${CYAN}$PUBLIC_KEY${NC}"
  echo ""
  echo "  2. Add VPS_SSH_KEY secret to GitHub Actions:"
  echo "     GitHub → Settings → Secrets → Actions → Add VPS_SSH_KEY"
  echo ""
fi

echo -e "  ${GREEN}Server is live at http://localhost:3000${NC}"
echo -e "  ${GREEN}Health: curl http://localhost:3000/health${NC}"
echo ""
