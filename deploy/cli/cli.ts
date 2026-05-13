#!/usr/bin/env bun
/**
 * st — Sports Terminal VPS Management CLI
 * Usage: bunx st <command>
 * 
 * Commands:
 *   deploy   — Deploy app to VPS
 *   status   — Full health check
 *   logs     — View container logs
 *   restart  — Restart container
 *   stop     — Stop container
 *   update   — Pull latest code + rebuild + restart
 *   ssh      — SSH into VPS
 *   env      — Manage environment variables
 *   tunnel   — Cloudflare Tunnel management
 *   help     — Show this message
 */

const VPS_IP = "2.24.96.9";
const VPS_USER = "root";
const PROJECT = "/opt/sportsterminal";
const REPO = "brendadeeznuts1111/sportsterminal";
const DOMAIN = "terminal.factory-wager.com";

function run(cmd: string): { stdout: string; exitCode: number } {
  try {
    const result = Bun.spawnSync(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
    return { stdout: result.stdout.toString(), exitCode: result.exitCode };
  } catch {
    return { stdout: "", exitCode: -1 };
  }
}

function ssh(cmd: string): string {
  const result = run(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${VPS_USER}@${VPS_IP} ${Bun.$.escape(cmd)} 2>&1`);
  return result.stdout.trim();
}

async function confirm(msg: string): Promise<boolean> {
  console.log(`\n  ${msg} (y/n): `);
  const input = await Bun.stdin.read();
  return input?.toString().trim().toLowerCase() === "y";
}

const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
function info(m: string) { console.log(`${colors.cyan}[INFO]${colors.reset}  ${m}`); }
function ok(m: string)   { console.log(`${colors.green}[OK]${colors.reset}    ${m}`); }
function warn(m: string) { console.log(`${colors.yellow}[WARN]${colors.reset}  ${m}`); }
function fail(m: string) { console.log(`${colors.red}[FAIL]${colors.reset}  ${m}`); process.exit(1); }

async function cmdDeploy() {
  info("Deploying to VPS...");
  const cmd = `curl -fsSL https://raw.githubusercontent.com/${REPO}/master/deploy/auto-setup.sh | bash`;
  console.log(`\n  ${colors.cyan}${cmd}${colors.reset}\n`);
  if (!await confirm("Continue?")) { info("Cancelled"); return; }
  console.log(ssh(cmd));
}

async function cmdStatus() {
  info("Checking VPS...\n");

  // Reachability
  if (run(`ping -c 1 -W 3 ${VPS_IP}`).exitCode === 0) ok("VPS reachable");
  else warn("VPS ping blocked");

  // SSH
  const test = run(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${VPS_USER}@${VPS_IP} "echo ok" 2>/dev/null`).stdout.trim();
  if (test === "ok") ok("SSH connected");
  else { warn("SSH failed — run: st ssh"); return; }

  // Docker
  console.log(`\n${colors.cyan}  Docker:${colors.reset}`);
  console.log(ssh("docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || echo 'Docker not available'"));

  // Health
  console.log(`\n${colors.cyan}  Health:${colors.reset}`);
  const health = ssh("curl -sf http://localhost:3000/health 2>/dev/null || echo 'FAIL'");
  if (health.includes("FAIL")) { warn("Not responding — check: st logs"); }
  else { ok("Responding"); console.log(`  ${health.slice(0, 300)}`); }

  // Disk
  console.log(`\n${colors.cyan}  Disk:${colors.reset}`);
  console.log(`  ${ssh("df -h / | tail -1 | awk '{print $3 \"/\" $2 \" used (\" $5 \")\"}'")}`);

  // Uptime
  console.log(`\n${colors.cyan}  VPS Uptime:${colors.reset}`);
  console.log(`  ${ssh("uptime -p")}`);
}

async function cmdLogs(n = 30) {
  info(`Last ${n} lines:`);
  const logCmd = [
    `docker logs st-proxy --tail ${n} 2>/dev/null`,
    `docker compose -f ${PROJECT}/deploy/docker-compose.yml logs app --tail ${n} 2>/dev/null`,
    `docker ps -q --filter name=sportsterminal --filter name=st-proxy 2>/dev/null | head -1 | xargs -I{} docker logs {} --tail ${n} 2>/dev/null`,
  ].join(" || ");
  const out = ssh(logCmd);
  console.log(out || "No logs available");
}

async function cmdRestart() {
  info("Restarting container...\n");
  ssh(`cd ${PROJECT}/deploy && docker compose restart app 2>/dev/null || docker restart $(docker ps -q --filter name=sportsterminal 2>/dev/null) 2>/dev/null || true`);
  ok("Restart sent");
  await new Promise(r => setTimeout(r, 5000));
  const h = ssh("curl -sf http://localhost:3000/health 2>/dev/null || echo 'FAIL'");
  if (h.includes("FAIL")) warn("Not responding — check: st logs");
  else ok("Healthy");
}

async function cmdStop() {
  if (!await confirm("Stop the container?")) { info("Cancelled"); return; }
  ssh(`cd ${PROJECT}/deploy && docker compose down app 2>/dev/null || docker stop $(docker ps -q --filter name=sportsterminal 2>/dev/null) 2>/dev/null || true`);
  ok("Stopped");
}

async function cmdUpdate() {
  info("Updating...\n");
  const out = ssh(`
    cd ${PROJECT} && git fetch origin && git reset --hard origin/master && cd ${PROJECT}/deploy && docker compose build app && docker compose up -d app
  `);
  console.log(out);
  await new Promise(r => setTimeout(r, 5000));
  await cmdStatus();
}

async function cmdEnv(action?: string, keyval?: string) {
  if (action === "set" && keyval) {
    const [key, val] = [keyval.split("=")[0], keyval.split("=").slice(1).join("=")];
    info(`Setting ${key}...`);
    ssh(`cd ${PROJECT}/deploy && grep -q '^${key}=' .env 2>/dev/null && sed -i 's|^${key}=.*|${key}=${val}|' .env || echo '${key}=${val}' >> .env`);
    ok(`${key}=${val}`);
    await cmdRestart();
  } else {
    info("Current env:");
    console.log(ssh(`cat ${PROJECT}/deploy/.env 2>/dev/null || echo 'No .env file'`));
  }
}

async function cmdTunnel(action?: string) {
  if (action === "start") {
    info("Starting tunnel...");
    const out = ssh(`cd ${PROJECT}/deploy && docker compose up -d tunnel 2>/dev/null || echo 'Tunnel compose unavailable'`);
    console.log(out);
    info(`Route ${DOMAIN} → localhost:3000 in Cloudflare Dashboard`);
  } else if (action === "status") {
    info("Tunnel status:");
    console.log(ssh("docker ps --filter name=cloudflared --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null || echo 'No tunnel'"));
  } else {
    console.log("Usage: st tunnel {start|status}");
  }
}

async function cmdSSH() {
  info(`Connecting to ${VPS_USER}@${VPS_IP}...`);
  Bun.spawnSync(["ssh", "-o", "StrictHostKeyChecking=no", `${VPS_USER}@${VPS_IP}`], { stdio: ["inherit", "inherit", "inherit"] });
}

async function cmdShell(args: string[]) {
  if (args.length === 0) { warn("Usage: st shell '<command>'"); return; }
  info(`Running: ${args.join(" ")}`);
  Bun.spawnSync(["ssh", "-o", "StrictHostKeyChecking=no", `${VPS_USER}@${VPS_IP}`, args.join(" ")], { stdio: ["inherit", "inherit", "inherit"] });
}

function showHelp() {
  console.log(`
${colors.cyan}Sports Terminal VPS CLI${colors.reset}
Usage: bunx st <command> [options]

Commands:
  deploy             Deploy app (auto-setup.sh on VPS)
  status             Full health check (Docker, app, disk, uptime)
  logs [n]           View last N log lines (default: 30)
  restart            Restart container
  stop               Stop container
  update             Git pull + rebuild + restart
  ssh                SSH into VPS
  shell '<cmd>'      Run command on VPS (e.g., st shell 'ls /opt')
  env                Show env vars
  env set K=V        Set env var + restart
  tunnel start       Start Cloudflare Tunnel
  tunnel status      Check tunnel
  help               Show this message

Examples:
  bunx st status     # Check everything
  bunx st logs 50    # Last 50 lines
  bunx st update     # Deploy latest code
`);
}

// ── Main ──
const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "deploy":     await cmdDeploy(); break;
  case "status":     await cmdStatus(); break;
  case "logs":       await cmdLogs(Number(args[0]) || 30); break;
  case "restart":    await cmdRestart(); break;
  case "stop":       await cmdStop(); break;
  case "update":     await cmdUpdate(); break;
  case "env":        await cmdEnv(args[0], args[1]); break;
  case "tunnel":     await cmdTunnel(args[0]); break;
  case "ssh":        await cmdSSH(); break;
  case "shell":      await cmdShell(args); break;
  default:           showHelp();
}
