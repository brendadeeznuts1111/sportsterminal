import { spawn } from 'child_process';

const port = process.argv[2];

if (!port) {
  console.error('❌ Usage: bun run dev:port <port>');
  console.error('   Example: bun run dev:port 3001');
  process.exit(1);
}

console.log(`🚀 Starting dev server on port ${port}...\n`);

const child = spawn('bun', ['run', '--cwd', 'backend', 'dev'], {
  stdio: 'inherit',
  env: { ...process.env, PORT: port },
});

child.on('exit', (code) => {
  process.exit(code);
});
