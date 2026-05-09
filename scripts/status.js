import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function status() {
  console.log('🔍 SportsTerminal Status\n');

  // Check port 3000
  try {
    const { stdout } = await execAsync('netstat -ano | findstr :3000 | findstr LISTENING');
    const lines = stdout.split(/\r?\n/).filter(line => line.trim());
    console.log(`📡 Port 3000: ${lines.length > 0 ? 'IN USE' : 'FREE'}`);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts.pop();
      console.log(`   PID: ${pid}`);
    }
  } catch {
    console.log('📡 Port 3000: FREE');
  }

  // Check Bun processes
  try {
    const { stdout } = await execAsync('tasklist | findstr bun');
    const lines = stdout.split(/\r?\n/).filter(line => line.trim());
    console.log(`\n🥟 Bun processes: ${lines.length}`);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const name = parts[0];
      const pid = parts[1];
      console.log(`   ${name} (PID: ${pid})`);
    }
  } catch {
    console.log('\n🥟 Bun processes: 0');
  }

  // Check frontend port 3001
  try {
    const { stdout } = await execAsync('netstat -ano | findstr :3001 | findstr LISTENING');
    const lines = stdout.split(/\r?\n/).filter(line => line.trim());
    console.log(`\n📡 Port 3001 (frontend): ${lines.length > 0 ? 'IN USE' : 'FREE'}`);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts.pop();
      console.log(`   PID: ${pid}`);
    }
  } catch {
    console.log('\n📡 Port 3001 (frontend): FREE');
  }
}

status();
