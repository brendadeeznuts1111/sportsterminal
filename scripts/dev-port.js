const port = process.argv[2];
if (!port) {
  console.error("Usage: bun run dev:port <port>");
  console.error("   Example: bun run dev:port 3001");
  process.exit(1);
}

console.log(`Starting dev server on port ${port}...\n`);
Bun.spawn(["bun", "run", "--cwd", "backend", "dev"], {
  env: { ...Bun.env, PORT: port },
  stdout: "inherit",
  stderr: "inherit",
});