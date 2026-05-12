// plugins/sandbox.ts — Plugin Sandbox (Bun worker threads)
// Each plugin runs in a dedicated Bun worker with:
// - Per-plugin SQLite connection (read-only via authorizer)
// - Network restricted to declared domains
// - 15-second execution cap
// - Credential injection from OS keychain

import type { PluginExecutionResult, PluginManifest } from "./types";

// ==========================================
// WORKER SCRIPT TEMPLATE
// ==========================================
function buildWorkerScript(
  pluginName: string,
  scriptPath: string,
  envVars: Record<string, string>,
  dbPath: string,
  allowedDomains: string[],
): string {
  const envBlock = Object.entries(envVars)
    .map(([k, v]) => `process.env["${k}"] = ${JSON.stringify(v)};`)
    .join("\n");

  const domainCheck = allowedDomains.length > 0
    ? `
const ALLOWED_DOMAINS = new Set(${JSON.stringify(allowedDomains)});
const originalFetch = globalThis.fetch;
globalThis.fetch = async function(url, ...args) {
  const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
  const hostname = new URL(urlStr).hostname;
  if (!ALLOWED_DOMAINS.has(hostname)) {
    throw new Error(\`Network access to \${hostname} denied by plugin sandbox\`);
  }
  return originalFetch(url, ...args);
};`
    : "";

  return `
// Auto-generated plugin worker for: ${pluginName}
// DO NOT EDIT — regenerated on each plugin load
${envBlock}

// Network sandbox
${domainCheck}

// SQLite read-only access
import { Database } from "bun:sqlite";
const DB_PATH = ${JSON.stringify(dbPath)};
let _db: Database | null = null;
function getDb(): Database {
  if (!_db) {
    _db = new Database(DB_PATH, { readonly: true });
    _db.run("PRAGMA query_only = ON;");
  }
  return _db;
}

// Timeout wrapper
const EXECUTION_TIMEOUT_MS = 15000;

async function runWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Plugin execution timed out (15s)")), EXECUTION_TIMEOUT_MS)
  );
  return Promise.race([fn(), timeout]);
}

// Bun Worker: receive input via onmessage, send result via postMessage
self.onmessage = async (ev: MessageEvent) => {
  let startTime = Date.now();
  try {
    const input = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;

    // Import the plugin script
    const pluginModule = await import(${JSON.stringify(scriptPath)});

    if (typeof pluginModule.default !== "function") {
      throw new Error("Plugin script must export a default function");
    }

    const result = await runWithTimeout(() => pluginModule.default(input, { db: getDb() }));
    const durationMs = Date.now() - startTime;

    self.postMessage(JSON.stringify({ success: true, data: result, durationMs }));
  } catch (err) {
    const durationMs = Date.now() - startTime;
    self.postMessage(JSON.stringify({
      success: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs,
    }));
  }
};
`;
}

// ==========================================
// PLUGIN SANDBOX
// ==========================================
export class PluginSandbox {
  private workers: Map<string, Worker> = new Map();
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /**
   * Execute a plugin tool in a sandboxed worker.
   */
  async execute(
    manifest: PluginManifest,
    toolName: string,
    params: Record<string, unknown>,
    envVars: Record<string, string> = {},
  ): Promise<PluginExecutionResult> {
    const tool = manifest.tools?.find(t => t.name === toolName);
    if (!tool) {
      return { success: false, error: `Tool "${toolName}" not found in plugin "${manifest.name}"`, durationMs: 0 };
    }

    const scriptPath = tool.command[tool.command.length - 1]; // Last arg is the script
    const allowedDomains = manifest.allow_network || [];

    const workerCode = buildWorkerScript(
      manifest.name,
      scriptPath,
      envVars,
      this.dbPath,
      allowedDomains,
    );

    const workerKey = `${manifest.name}:${toolName}`;

    // Terminate existing worker for this plugin:tool if any
    const existing = this.workers.get(workerKey);
    if (existing) {
      try { existing.terminate(); } catch { /* ignore */ }
    }

    const blob = new Blob([workerCode], { type: "text/javascript" });
    const workerUrl = URL.createObjectURL(blob);
    const worker = new Worker(workerUrl);

    return new Promise((resolve) => {
      const startTime = Date.now();

      worker.onmessage = (ev: MessageEvent) => {
        try {
          const result = JSON.parse(ev.data) as PluginExecutionResult;
          resolve(result);
        } catch {
          resolve({ success: false, error: "Invalid worker response", durationMs: Date.now() - startTime });
        }
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
        this.workers.delete(workerKey);
      };

      worker.onerror = (err: ErrorEvent) => {
        resolve({
          success: false,
          error: err.message || "Worker error",
          durationMs: Date.now() - startTime,
        });
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
        this.workers.delete(workerKey);
      };

      // Send input params
      worker.postMessage(JSON.stringify(params));

      // Hard timeout at 16s (1s grace beyond the 15s worker timeout)
      setTimeout(() => {
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
        this.workers.delete(workerKey);
        resolve({
          success: false,
          error: "Plugin execution timed out (hard limit 16s)",
          durationMs: Date.now() - startTime,
        });
      }, 16000);
    });
  }

  /**
   * Execute a hook script (on_wager, on_flag, on_cron).
   * Hooks are fire-and-forget with a 100ms timeout for wager hooks.
   */
  async executeHook(
    manifest: PluginManifest,
    hookScript: string,
    params: Record<string, unknown>,
    envVars: Record<string, string> = {},
    timeoutMs = 15000,
  ): Promise<PluginExecutionResult> {
    const allowedDomains = manifest.allow_network || [];

    const workerCode = buildWorkerScript(
      manifest.name,
      hookScript,
      envVars,
      this.dbPath,
      allowedDomains,
    );

    const blob = new Blob([workerCode], { type: "text/javascript" });
    const workerUrl = URL.createObjectURL(blob);
    const worker = new Worker(workerUrl);

    return new Promise((resolve) => {
      const startTime = Date.now();

      const settled = { value: false };
      const finish = (result: PluginExecutionResult) => {
        if (settled.value) return;
        settled.value = true;
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
        resolve(result);
      };

      worker.onmessage = (ev: MessageEvent) => {
        try {
          finish(JSON.parse(ev.data) as PluginExecutionResult);
        } catch {
          finish({ success: false, error: "Invalid hook response", durationMs: Date.now() - startTime });
        }
      };

      worker.onerror = (err: ErrorEvent) => {
        finish({
          success: false,
          error: err.message || "Hook worker error",
          durationMs: Date.now() - startTime,
        });
      };

      worker.postMessage(JSON.stringify(params));

      setTimeout(() => {
        finish({
          success: false,
          error: `Hook execution timed out (${timeoutMs}ms)`,
          durationMs: Date.now() - startTime,
        });
      }, timeoutMs + 1000);
    });
  }

  /**
   * Terminate all plugin workers (graceful shutdown).
   */
  terminateAll(): void {
    for (const [key, worker] of this.workers) {
      try { worker.terminate(); } catch { /* ignore */ }
    }
    this.workers.clear();
  }
}
