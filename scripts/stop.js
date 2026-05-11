import { execSync } from "node:child_process";

const isWin = process.platform === "win32";

function findPidsOnPort(port) {
  try {
    if (isWin) {
      const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: "utf-8" });
      return [...new Set(out.split(/\r?\n/).map(l => l.trim().split(/\s+/).pop()).filter(Boolean))];
    }
    const out = execSync(`lsof -ti:${port}`, { encoding: "utf-8" });
    return out.split(/\n/).map(p => p.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function killPids(pids) {
  for (const pid of pids) {
    try {
      if (isWin) execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
      else process.kill(Number(pid), "SIGKILL");
    } catch {}
  }
}

const pids = findPidsOnPort(3000);
if (pids.length === 0) {
  console.log("Port 3000 already free or no permission needed.");
} else {
  killPids(pids);
  console.log(`Killed ${pids.length} process(es) on port 3000.`);
}
