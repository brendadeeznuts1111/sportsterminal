// plugins/registry.ts — Plugin Registry Service
// Central orchestrator: loads plugins, manages sandbox, integrates with pipelines.
// This is the main entry point consumed by proxy-enhanced.ts.

import { Database } from "bun:sqlite";
import { PluginLoader } from "./loader";
import { PluginSandbox } from "./sandbox";
import type {
  PluginManifest,
  PluginExecutionResult,
  PluginInstallSource,
  PluginInfo,
} from "./types";

// ==========================================
// PLUGIN REGISTRY
// ==========================================
export class PluginRegistry {
  public loader: PluginLoader;
  public sandbox: PluginSandbox;
  private db: Database;
  private cronTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private initialized = false;

  constructor(db: Database) {
    this.db = db;
    this.loader = new PluginLoader(db);
    this.sandbox = new PluginSandbox(db.filename || ":memory:");
  }

  /**
   * Initialize: create tables, load all installed plugins, register cron hooks.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.loader.init();
    const manifests = await this.loader.loadAll();
    console.log(`[PluginRegistry] Loaded ${manifests.length} plugin(s)`);

    // Register cron hooks
    for (const manifest of manifests) {
      if (manifest.hooks?.on_cron) {
        this.registerCronHook(manifest);
      }
    }

    this.initialized = true;
  }

  /**
   * Install a plugin.
   */
  async install(source: PluginInstallSource): Promise<PluginManifest> {
    const manifest = await this.loader.install(source);

    // Register cron hook if present
    if (manifest.hooks?.on_cron) {
      this.registerCronHook(manifest);
    }

    console.log(`[PluginRegistry] Installed plugin: ${manifest.name} v${manifest.version}`);
    return manifest;
  }

  /**
   * Remove a plugin.
   */
  async remove(name: string): Promise<void> {
    // Unregister cron hook
    this.unregisterCronHook(name);

    await this.loader.remove(name);
    console.log(`[PluginRegistry] Removed plugin: ${name}`);
  }

  /**
   * Execute a plugin tool by name.
   */
  async executeTool(
    pluginName: string,
    toolName: string,
    params: Record<string, unknown>,
    envVars: Record<string, string> = {},
  ): Promise<PluginExecutionResult> {
    const manifest = this.loader.getManifest(pluginName);
    if (!manifest) {
      return { success: false, error: `Plugin "${pluginName}" not found or not loaded`, durationMs: 0 };
    }

    const startTime = Date.now();
    const result = await this.sandbox.execute(manifest, toolName, params, envVars);

    // Log execution
    this.loader.logExecution(
      pluginName,
      toolName,
      "manual",
      params,
      result.success ? result.data : null,
      result.error || null,
      result.durationMs,
    );

    return result;
  }

  /**
   * Execute a wager hook for all risk-rules plugins.
   * Called from the SSE broadcast loop with a 100ms timeout.
   */
  async executeWagerHooks(wagerData: Record<string, unknown>): Promise<void> {
    const riskPlugins = this.loader.getByCategory("risk-rules");
    const promises: Promise<void>[] = [];

    for (const manifest of riskPlugins) {
      if (!manifest.hooks?.on_wager) continue;

      const hookScript = manifest.hooks.on_wager;
      const envVars = this.resolveEnvVars(manifest);

      const p = this.sandbox.executeHook(manifest, hookScript, wagerData, envVars, 100)
        .then(result => {
          this.loader.logExecution(
            manifest.name,
            "on_wager",
            "hook_on_wager",
            wagerData,
            result.success ? result.data : null,
            result.error || null,
            result.durationMs,
          );
        })
        .catch(err => {
          console.warn(`[PluginRegistry] Wager hook failed for ${manifest.name}:`, err);
        });

      promises.push(p);
    }

    // Fire-and-forget: don't block the SSE loop
    Promise.allSettled(promises).catch(() => { });
  }

  /**
   * Execute a flag hook for all risk-rules plugins.
   */
  async executeFlagHooks(flagData: Record<string, unknown>): Promise<void> {
    const riskPlugins = this.loader.getByCategory("risk-rules");
    const promises: Promise<void>[] = [];

    for (const manifest of riskPlugins) {
      if (!manifest.hooks?.on_flag) continue;

      const hookScript = manifest.hooks.on_flag;
      const envVars = this.resolveEnvVars(manifest);

      const p = this.sandbox.executeHook(manifest, hookScript, flagData, envVars, 5000)
        .then(result => {
          this.loader.logExecution(
            manifest.name,
            "on_flag",
            "hook_on_flag",
            flagData,
            result.success ? result.data : null,
            result.error || null,
            result.durationMs,
          );
        })
        .catch(err => {
          console.warn(`[PluginRegistry] Flag hook failed for ${manifest.name}:`, err);
        });

      promises.push(p);
    }

    await Promise.allSettled(promises);
  }

  /**
   * Execute alert-channel plugins for a given alert payload.
   * Called after the built-in alert dispatch.
   */
  async executeAlertHooks(alertData: Record<string, unknown>): Promise<Array<{ plugin: string; success: boolean; error?: string }>> {
    const alertPlugins = this.loader.getByCategory("alert-channels");
    const results: Array<{ plugin: string; success: boolean; error?: string }> = [];

    for (const manifest of alertPlugins) {
      // Alert plugins use their first tool as the alert handler
      const tool = manifest.tools?.[0];
      if (!tool) continue;

      const envVars = this.resolveEnvVars(manifest);
      const result = await this.sandbox.execute(manifest, tool.name, alertData, envVars);

      this.loader.logExecution(
        manifest.name,
        tool.name,
        "manual",
        alertData,
        result.success ? result.data : null,
        result.error || null,
        result.durationMs,
      );

      results.push({
        plugin: manifest.name,
        success: result.success,
        error: result.error,
      });
    }

    return results;
  }

  /**
   * List all installed plugins.
   */
  listPlugins(): PluginInfo[] {
    return this.loader.listPlugins();
  }

  /**
   * Get info for a single plugin.
   */
  getPluginInfo(name: string): PluginInfo | null {
    return this.loader.getPluginInfo(name);
  }

  /**
   * Get execution logs for a plugin.
   */
  getExecutionLogs(pluginName: string, limit = 50) {
    return this.loader.getExecutionLogs(pluginName, limit);
  }

  /**
   * Get all loaded manifests (for pipeline integration).
   */
  getAllManifests(): PluginManifest[] {
    return this.loader.getAllManifests();
  }

  /**
   * Get manifests by category.
   */
  getByCategory(category: string): PluginManifest[] {
    return this.loader.getByCategory(category);
  }

  /**
   * Shutdown: terminate all workers, clear cron timers.
   */
  shutdown(): void {
    for (const [name, timer] of this.cronTimers) {
      clearInterval(timer);
    }
    this.cronTimers.clear();
    this.sandbox.terminateAll();
    console.log("[PluginRegistry] Shutdown complete");
  }

  // ==========================================
  // PRIVATE
  // ==========================================
  private resolveEnvVars(manifest: PluginManifest): Record<string, string> {
    const env: Record<string, string> = {};
    if (manifest.inject) {
      for (const [key, envVar] of Object.entries(manifest.inject)) {
        const value = process.env[envVar];
        if (value) {
          env[key] = value;
        }
      }
    }
    return env;
  }

  private registerCronHook(manifest: PluginManifest): void {
    if (!manifest.hooks?.on_cron) return;

    const { schedule, script } = manifest.hooks.on_cron;
    const envVars = this.resolveEnvVars(manifest);

    // Parse cron expression to interval
    const intervalMs = this.parseCronToMs(schedule);
    if (intervalMs === null) {
      console.warn(`[PluginRegistry] Cannot parse cron schedule "${schedule}" for plugin "${manifest.name}"`);
      return;
    }

    const timer = setInterval(async () => {
      try {
        const result = await this.sandbox.executeHook(manifest, script, {}, envVars, 15000);
        this.loader.logExecution(
          manifest.name,
          "on_cron",
          "cron",
          { schedule },
          result.success ? result.data : null,
          result.error || null,
          result.durationMs,
        );
      } catch (err) {
        console.warn(`[PluginRegistry] Cron hook failed for ${manifest.name}:`, err);
      }
    }, intervalMs);

    this.cronTimers.set(manifest.name, timer);
    console.log(`[PluginRegistry] Registered cron hook for "${manifest.name}": ${schedule} (${intervalMs}ms)`);
  }

  private unregisterCronHook(name: string): void {
    const timer = this.cronTimers.get(name);
    if (timer) {
      clearInterval(timer);
      this.cronTimers.delete(name);
    }
  }

  /**
   * Parse a simple cron expression to milliseconds.
   * Supports: *\/N * * * * and basic patterns.
   */
  private parseCronToMs(cron: string): number | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minute] = parts;

  // */N pattern
  const everyMatch = minute.match(/^\*\/(\d+)$/);
  if (everyMatch) {
    return parseInt(everyMatch[1], 10) * 60 * 1000;
  }

  // Every N minutes (simple numeric)
  const numMatch = minute.match(/^(\d+)$/);
  if (numMatch) {
    const mins = parseInt(numMatch[1], 10);
    return mins * 60 * 1000;
  }

  // Fallback: every 15 minutes
  return 15 * 60 * 1000;
}
}
