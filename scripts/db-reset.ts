import { unlinkSync } from "node:fs";
import { resolve } from "node:path";

const dbPath = resolve(import.meta.dir, "..", "backend", "data", "terminal.db");

try {
  unlinkSync(dbPath);
  console.log("Database reset. Run bun run dev to recreate.");
} catch (err: unknown) {
  if ((err as NodeJS.ErrnoException).code === "ENOENT") {
    console.log("No database file found. Run bun run dev to create one.");
  } else {
    throw err;
  }
}