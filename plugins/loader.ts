// plugins/loader.ts — Plugin Loader
// Handles installation, validation, loading, and removal of plugins.
// Plugins live in ~/.sports-terminal/plugins/

import { Database } from "bun:sqlite";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PluginManifestSchema, type PluginInfo, type PluginInstallSource, type PluginManifest } from "./types";

// ==========================================
// CONSTANTS
// ==========================================
const PLUGINS_HOME = (() => {
  const home = process.env.SPORTS_TERMINAL_HOME ||
    (process.env.HOME || process.env.USERPROFILE || ".");
  return join(home, ".sports-terminal", "plugins");
})();

// ==========================================
// PLUGIN LOADER
// ==========================================
export class PluginLoader {
  private db: Database;
  private loadedManifests: Map<string, PluginManifest> = new Map();

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Ensure the plugins home directory and DB tables exist.
   */
  async init(): Promise<void> {
    await mkdir(PLUGINS_HOME, { recursive: true });

    this.db.run(`
      CREATE TABLE IF NOT EXISTS plugin_registry (
        name TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        category TEXT,
        author_agent_login TEXT,
        install_path TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        config_json TEXT,
        installed_at TEXT DEFAULT (datetime('now'))
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS plugin_execution_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plugin_name TEXT,
        tool_name TEXT,
        trigger_type TEXT,
        parameters TEXT,
        result_json TEXT,
        error TEXT,
        duration_ms INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_plugin_exec_log_name ON plugin_execution_log(plugin_name, created_at)`);
  }

  /**
   * Get the plugins home directory path.
   */
  getPluginsHome(): string {
    return PLUGINS_HOME;
  }

  /**
   * Install a plugin from a local directory, zip file, or git URL.
   */
  async install(source: PluginInstallSource): Promise<PluginManifest> {
    let pluginDir: string;

    if (source.type === "local") {
      pluginDir = resolve(source.path);
    } else if (source.type === "zip") {
      pluginDir = await this.extractZip(source.path);
    } else if (source.type === "git") {
      pluginDir = await this.cloneGit(source.url, source.subpath);
    } else {
      throw new Error(`Unknown install source type: ${(source as { type: string }).type}`);
    }

    // Read and validate manifest
    const manifestPath = join(pluginDir, "plugin.json");
    const manifestRaw = await readFile(manifestPath, "utf-8");
    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(manifestRaw);
    } catch {
      throw new Error(`Invalid plugin.json in ${pluginDir}: not valid JSON`);
    }

    const parsed = PluginManifestSchema.safeParse(manifestJson);
    if (!parsed.success) {
      const errors = parsed.error.issues.map(i => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Invalid plugin manifest:\n${errors}`);
    }

    const manifest = parsed.data;

    // Check if already installed
    const existing = this.db.query("SELECT name FROM plugin_registry WHERE name = ?").get(manifest.name) as { name: string } | null;
    if (existing) {
      throw new Error(`Plugin "${manifest.name}" is already installed. Use "plugin remove ${manifest.name}" first.`);
    }

    // Copy to plugins home
    const installDir = join(PLUGINS_HOME, manifest.name);
    await this.copyDir(pluginDir, installDir);

    // Register in DB
    this.db.run(
      `INSERT INTO plugin_registry (name, version, category, author_agent_login, install_path, is_active, config_json, installed_at)
       VALUES (?, ?, ?, ?, ?, 1, NULL, datetime('now'))`,
      [manifest.name, manifest.version, manifest.category, manifest.author || null, installDir],
    );

    // Load manifest into memory
    this.loadedManifests.set(manifest.name, manifest);

    return manifest;
  }

  /**
   * Remove a plugin by name.
   */
  async remove(name: string): Promise<void> {
    const row = this.db.query("SELECT install_path FROM plugin_registry WHERE name = ?").get(name) as { install_path: string } | null;
    if (!row) {
      throw new Error(`Plugin "${name}" is not installed.`);
    }

    // Remove from filesystem
    try {
      await rm(row.install_path, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[PluginLoader] Failed to remove plugin directory: ${row.install_path}`, err);
    }

    // Remove from DB
    this.db.run("DELETE FROM plugin_registry WHERE name = ?", [name]);
    this.db.run("DELETE FROM plugin_execution_log WHERE plugin_name = ?", [name]);

    // Remove from memory
    this.loadedManifests.delete(name);
  }

  /**
   * Load all installed plugins into memory.
   * Called at startup.
   */
  async loadAll(): Promise<PluginManifest[]> {
    const rows = this.db.query("SELECT name, install_path, is_active FROM plugin_registry").all() as Array<{ name: string; install_path: string; is_active: number }>;
    const manifests: PluginManifest[] = [];

    for (const row of rows) {
      if (!row.is_active) continue;

      try {
        const manifestPath = join(row.install_path, "plugin.json");
        const raw = await readFile(manifestPath, "utf-8");
        const json = JSON.parse(raw) as unknown;
        const parsed = PluginManifestSchema.safeParse(json);
        if (parsed.success) {
          this.loadedManifests.set(row.name, parsed.data);
          manifests.push(parsed.data);
        } else {
          console.warn(`[PluginLoader] Skipping invalid plugin "${row.name}":`, parsed.error.issues);
        }
      } catch (err) {
        console.warn(`[PluginLoader] Failed to load plugin "${row.name}":`, err);
      }
    }

    return manifests;
  }

  /**
   * Get a loaded manifest by name.
   */
  getManifest(name: string): PluginManifest | undefined {
    return this.loadedManifests.get(name);
  }

  /**
   * Get all loaded manifests.
   */
  getAllManifests(): PluginManifest[] {
    return Array.from(this.loadedManifests.values());
  }

  /**
   * Get manifests filtered by category.
   */
  getByCategory(category: string): PluginManifest[] {
    return this.getAllManifests().filter(m => m.category === category);
  }

  /**
   * List installed plugins with info.
   */
  listPlugins(): PluginInfo[] {
    const rows = this.db.query(`
      SELECT name, version, category, author_agent_login, install_path, is_active, installed_at
      FROM plugin_registry ORDER BY name
    `).all() as Array<{
      name: string;
      version: string;
      category: string | null;
      author_agent_login: string | null;
      install_path: string;
      is_active: number;
      installed_at: string;
    }>;

    return rows.map(row => {
      const manifest = this.loadedManifests.get(row.name);
      return {
        name: row.name,
        version: row.version,
        description: manifest?.description || "",
        author: manifest?.author || row.author_agent_login || undefined,
        category: (row.category || manifest?.category || "integrations") as PluginInfo["category"],
        installPath: row.install_path,
        isActive: row.is_active === 1,
        toolCount: manifest?.tools?.length || 0,
        hasWagerHook: !!manifest?.hooks?.on_wager,
        hasFlagHook: !!manifest?.hooks?.on_flag,
        hasCronHook: !!manifest?.hooks?.on_cron,
        installedAt: row.installed_at,
      };
    });
  }

  /**
   * Get detailed info for a single plugin.
   */
  getPluginInfo(name: string): PluginInfo | null {
    const plugins = this.listPlugins();
    return plugins.find(p => p.name === name) || null;
  }

  /**
   * Log a plugin execution.
   */
  logExecution(
    pluginName: string,
    toolName: string,
    triggerType: "manual" | "hook_on_wager" | "hook_on_flag" | "cron",
    params: Record<string, unknown> | null,
    result: unknown | null,
    error: string | null,
    durationMs: number,
  ): void {
    this.db.run(
      `INSERT INTO plugin_execution_log (plugin_name, tool_name, trigger_type, parameters, result_json, error, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        pluginName,
        toolName,
        triggerType,
        params ? JSON.stringify(params) : null,
        result ? JSON.stringify(result) : null,
        error,
        durationMs,
      ],
    );
  }

  /**
   * Get execution logs for a plugin.
   */
  getExecutionLogs(pluginName: string, limit = 50): Array<{
    id: number;
    tool_name: string;
    trigger_type: string;
    parameters: string | null;
    result_json: string | null;
    error: string | null;
    duration_ms: number;
    created_at: string;
  }> {
    return this.db.query(`
      SELECT id, tool_name, trigger_type, parameters, result_json, error, duration_ms, created_at
      FROM plugin_execution_log
      WHERE plugin_name = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(pluginName, limit) as Array<{
      id: number;
      tool_name: string;
      trigger_type: string;
      parameters: string | null;
      result_json: string | null;
      error: string | null;
      duration_ms: number;
      created_at: string;
    }>;
  }

  // ==========================================
  // PRIVATE HELPERS
  // ==========================================
  private async extractZip(zipPath: string): Promise<string> {
    // Use Bun's built-in decompression
    const tmpDir = join(PLUGINS_HOME, ".tmp", `zip-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    const file = Bun.file(zipPath);
    const arrayBuffer = await file.arrayBuffer();

    // Bun doesn't have a built-in unzip, so we shell out
    const proc = Bun.spawn(["powershell", "-Command",
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Failed to extract zip: ${stderr}`);
    }

    // Find plugin.json in extracted dir
    const entries = await readdir(tmpDir, { withFileTypes: true });
    const pluginDir = entries.find(e => e.isDirectory())?.name || tmpDir;

    return join(tmpDir, pluginDir);
  }

  private async cloneGit(url: string, subpath?: string): Promise<string> {
    const tmpDir = join(PLUGINS_HOME, ".tmp", `git-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    const proc = Bun.spawn(["git", "clone", "--depth", "1", url, tmpDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Failed to clone git repo: ${stderr}`);
    }

    return subpath ? join(tmpDir, subpath) : tmpDir;
  }

  private async copyDir(src: string, dest: string): Promise<void> {
    // Use PowerShell for reliable recursive copy on Windows
    const proc = Bun.spawn(["powershell", "-Command",
      `Copy-Item -Path '${src}' -Destination '${dest}' -Recurse -Force`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Failed to copy plugin directory: ${stderr}`);
    }
  }
}
