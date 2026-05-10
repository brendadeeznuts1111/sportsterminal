import { stat } from 'node:fs/promises';

const riskyPathPatterns = [
  /^docs[\/\\]agentslistharz\.md$/i,
  /^docs[\/\\]agentobject\.md$/i,
  /^docs[\/\\]playerprofileartifact\.html$/i,
  /^docs[\/\\]New Text Document\.txt$/i,
  /^htmlartifact[\/\\]/i,
  /^data[\/\\]/i,
  /^backend[\/\\]check-.*\.ts$/i,
  /^backend[\/\\]data[\/\\].*\.(db|db-journal|db-shm|db-wal)$/i,
];

const riskyLocalPaths = [
  'docs/agentslistharz.md',
  'docs/agentobject.md',
  'docs/playerprofileartifact.html',
  'docs/New Text Document.txt',
  'htmlartifact',
  'data',
  'backend/check-db.ts',
  'backend/check-ops.ts',
];

function isRiskyPath(path: string): boolean {
  return riskyPathPatterns.some((pattern) => pattern.test(path));
}

async function gitLines(args: string[]): Promise<string[]> {
  const proc = Bun.spawn(['git', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  }

  return stdout.split(/\r?\n/).filter(Boolean);
}

function statusPath(line: string): string {
  const raw = line.slice(3).trim();
  if (raw.includes(' -> ')) return raw.split(' -> ').at(-1) || raw;
  return raw.replace(/^"|"$/g, '');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const tracked = await gitLines(['ls-files']);
const status = await gitLines(['status', '--porcelain=v1', '--untracked-files=all']);

const trackedRisk = tracked.filter(isRiskyPath);
const unignoredRisk = status.map(statusPath).filter(isRiskyPath);
const localRiskChecks = await Promise.all(
  riskyLocalPaths.map(async (path) => ({
    path,
    exists: await exists(path),
  }))
);
const localRisk = localRiskChecks.filter((item) => item.exists).map((item) => item.path);

if (trackedRisk.length || unignoredRisk.length) {
  console.error('Sensitive/local artifact guard failed.');
  if (trackedRisk.length) {
    console.error('\nTracked risky paths:');
    for (const path of trackedRisk) console.error(`- ${path}`);
  }
  if (unignoredRisk.length) {
    console.error('\nUnignored risky paths:');
    for (const path of unignoredRisk) console.error(`- ${path}`);
  }
  console.error('\nKeep raw Buckeye exports, scratch checks, and local databases ignored.');
  process.exit(1);
}

if (localRisk.length) {
  console.warn('Sensitive/local artifacts exist locally but are ignored:');
  for (const path of localRisk) console.warn(`- ${path}`);
}

console.log('Sensitive artifact check passed.');
