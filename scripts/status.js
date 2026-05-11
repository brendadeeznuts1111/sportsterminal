import { execSync } from "node:child_process";

const isWin = process.platform === "win32";

function findPidsOnPort(port) {
  try {
    if (isWin) {
      const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: "utf-8" });
      return out.split(/\r?\n/).filter(l => l.trim()).map(l => {
        const parts = l.trim().split(/\s+/);
        return { pid: parts[parts.length - 1] || "", name: "" };
      });
    }
    const out = execSync(`lsof -ti:${port} -P`, { encoding: "utf-8" });
    return out.split(/\n/).filter(l => l.trim()).map(l => ({ pid: l.trim(), name: "" }));
  } catch {
    return [];
  }
}

function findBunProcesses() {
  try {
    if (isWin) {
      const out = execSync("tasklist | findstr bun", { encoding: "utf-8" });
      return out.split(/\r?\n/).filter(l => l.trim()).map(l => {
        const parts = l.trim().split(/\s+/);
        return { name: parts[0], pid: parts[1] };
      });
    }
    const out = execSync("ps aux | grep bun | grep -v grep", { encoding: "utf-8" });
    return out.split(/\n/).filter(l => l.trim()).map(l => {
      const parts = l.trim().split(/\s+/);
      return { name: "bun", pid: parts[1] };
    });
  } catch {
    return [];
  }
}

console.log("SportsTerminal Status\n");

const port3000 = findPidsOnPort(3000);
console.log(`Port 3000: ${port3000.length > 0 ? "IN USE" : "FREE"}`);
for (const { pid } of port3000) console.log(`  PID: ${pid}`);

const port3001 = findPidsOnPort(3001);
console.log(`\nPort 3001 (proxy): ${port3001.length > 0 ? "IN USE" : "FREE"}`);
for (const { pid } of port3001) console.log(`  PID: ${pid}`);

const bunProcs = findBunProcesses();
console.log(`\nBun processes: ${bunProcs.length}`);
for (const { name, pid } of bunProcs) console.log(`  ${name} (PID: ${pid})`);
