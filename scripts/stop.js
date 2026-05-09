import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function stop() {
  try {
    // Find PIDs listening on :3000
    const { stdout } = await execAsync('netstat -ano | findstr :3000 | findstr LISTENING');
    const pids = [...new Set(
      stdout
        .split(/\r?\n/)
        .map(line => line.trim().split(/\s+/).pop())
        .filter(Boolean)
    )];

    if (pids.length === 0) {
      console.log('ℹ️  No process found on port 3000.');
      return;
    }

    for (const pid of pids) {
      await execAsync(`taskkill /F /PID ${pid}`).catch(() => {});
    }
    console.log(`🛑 Killed ${pids.length} process(es) on port 3000.`);
  } catch (err) {
    console.log('✅ Port 3000 already free or no permission needed.');
  }
}

stop();
