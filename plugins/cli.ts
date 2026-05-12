// plugins/cli.ts — Plugin CLI commands
// Usage: bun run plugins/cli.ts <command> [args...]
// Integrated into the agent-cli and proxy startup.

import { Database } from "bun:sqlite";
import { PluginRegistry } from "./registry";
import type { PluginInstallSource } from "./types";

const DB_PATH = process.env.DB_PATH || "buckeye_cache.sqlite";

function printHelp(): void {
  console.log(`
Sports Terminal Plugin CLI
==========================

Commands:
  plugin install <path>       Install from local directory
  plugin install --zip <path> Install from .zip file
  plugin install --git <url> [--subpath <path>]  Install from git repo
  plugin list                 List installed plugins
  plugin info <name>          Show plugin details
  plugin remove <name>        Remove a plugin
  plugin marketplace          Browse available plugins (coming soon)
  plugin logs <name> [limit]  Show execution logs for a plugin

Examples:
  bun run plugins/cli.ts plugin install ./my-plugin
  bun run plugins/cli.ts plugin install --zip ./risk-sharp-detector.zip
  bun run plugins/cli.ts plugin install --git https://github.com/user/repo.git --subpath plugins/my-plugin
  bun run plugins/cli.ts plugin list
  bun run plugins/cli.ts plugin info risk-sharp-detector
  bun run plugins/cli.ts plugin remove risk-sharp-detector
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  const command = args[0];

  if (command !== "plugin") {
    console.error(`Unknown command: ${command}`);
    console.error("Use 'plugin' to manage plugins.");
    process.exit(1);
  }

  const subcommand = args[1];
  if (!subcommand) {
    printHelp();
    process.exit(0);
  }

  const db = new Database(DB_PATH, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 5000;");
  db.run("PRAGMA foreign_keys = ON;");

  const registry = new PluginRegistry(db);
  await registry.init();

  try {
    switch (subcommand) {
      case "install": {
        const source = parseInstallSource(args.slice(2));
        const manifest = await registry.install(source);
        console.log(`✅ Installed plugin: ${manifest.name} v${manifest.version}`);
        console.log(`   Category: ${manifest.category}`);
        console.log(`   Tools: ${manifest.tools?.length || 0}`);
        if (manifest.hooks?.on_wager) console.log(`   Wager hook: ${manifest.hooks.on_wager}`);
        if (manifest.hooks?.on_cron) console.log(`   Cron hook: ${manifest.hooks.on_cron.schedule}`);
        break;
      }

      case "list": {
        const plugins = registry.listPlugins();
        if (plugins.length === 0) {
          console.log("No plugins installed.");
          console.log(`Plugins directory: ${registry.loader.getPluginsHome()}`);
          break;
        }
        console.log(`\nInstalled plugins (${plugins.length}):`);
        console.log("─".repeat(80));
        for (const p of plugins) {
          const status = p.isActive ? "🟢" : "🔴";
          const hooks: string[] = [];
          if (p.hasWagerHook) hooks.push("wager");
          if (p.hasFlagHook) hooks.push("flag");
          if (p.hasCronHook) hooks.push("cron");
          console.log(`  ${status} ${p.name} v${p.version}  [${p.category}]`);
          console.log(`     ${p.description}`);
          console.log(`     Tools: ${p.toolCount} | Hooks: ${hooks.join(", ") || "none"} | Installed: ${p.installedAt}`);
        }
        console.log("─".repeat(80));
        break;
      }

      case "info": {
        const name = args[2];
        if (!name) {
          console.error("Usage: plugin info <name>");
          process.exit(1);
        }
        const info = registry.getPluginInfo(name);
        if (!info) {
          console.error(`Plugin "${name}" not found.`);
          process.exit(1);
        }
        console.log(`\nPlugin: ${info.name}`);
        console.log("─".repeat(60));
        console.log(`  Version:     ${info.version}`);
        console.log(`  Description: ${info.description}`);
        console.log(`  Author:      ${info.author || "N/A"}`);
        console.log(`  Category:    ${info.category}`);
        console.log(`  Status:      ${info.isActive ? "Active" : "Inactive"}`);
        console.log(`  Tools:       ${info.toolCount}`);
        console.log(`  Wager Hook:  ${info.hasWagerHook ? "Yes" : "No"}`);
        console.log(`  Flag Hook:   ${info.hasFlagHook ? "Yes" : "No"}`);
        console.log(`  Cron Hook:   ${info.hasCronHook ? "Yes" : "No"}`);
        console.log(`  Installed:   ${info.installedAt}`);
        console.log(`  Path:        ${info.installPath}`);
        console.log("─".repeat(60));
        break;
      }

      case "remove": {
        const name = args[2];
        if (!name) {
          console.error("Usage: plugin remove <name>");
          process.exit(1);
        }
        await registry.remove(name);
        console.log(`✅ Removed plugin: ${name}`);
        break;
      }

      case "logs": {
        const name = args[2];
        if (!name) {
          console.error("Usage: plugin logs <name> [limit]");
          process.exit(1);
        }
        const limit = parseInt(args[3] || "20", 10);
        const logs = registry.getExecutionLogs(name, limit);
        if (logs.length === 0) {
          console.log(`No execution logs for plugin "${name}".`);
          break;
        }
        console.log(`\nExecution logs for ${name} (last ${logs.length}):`);
        console.log("─".repeat(80));
        for (const log of logs) {
          const status = log.error ? "❌" : "✅";
          console.log(`  ${status} [${log.created_at}] ${log.tool_name} (${log.trigger_type}) — ${log.duration_ms}ms`);
          if (log.error) console.log(`     Error: ${log.error}`);
        }
        console.log("─".repeat(80));
        break;
      }

      case "marketplace": {
        console.log("🏪 Plugin Marketplace — Coming Soon!");
        console.log("");
        console.log("Available built-in plugins:");
        console.log("  risk-sharp-detector     — CLV-based sharp money detection");
        console.log("  risk-bonus-abuse        — Bonus wagering pattern analysis");
        console.log("  alert-telegram-enhanced — Rich Telegram alerts with inline keyboards");
        console.log("  commission-tiered       — Multi-tier agent commission calculator");
        console.log("  export-parquet-nightly  — Nightly Parquet export for AI training");
        console.log("  buckeye-writeback       — Automatic limit enforcement via updateByColumn");
        console.log("  agent-leaderboard       — Top agents by volume/commission widget");
        console.log("");
        console.log("Install with: bun run plugins/cli.ts plugin install --git <url>");
        break;
      }

      default:
        console.error(`Unknown plugin subcommand: ${subcommand}`);
        printHelp();
        process.exit(1);
    }
  } finally {
    registry.shutdown();
    db.close();
  }
}

function parseInstallSource(args: string[]): PluginInstallSource {
  if (args.length === 0) {
    console.error("Usage: plugin install <path> | --zip <path> | --git <url> [--subpath <path>]");
    process.exit(1);
  }

  if (args[0] === "--zip") {
    const path = args[1];
    if (!path) {
      console.error("Missing zip path. Usage: plugin install --zip <path>");
      process.exit(1);
    }
    return { type: "zip", path };
  }

  if (args[0] === "--git") {
    const url = args[1];
    if (!url) {
      console.error("Missing git URL. Usage: plugin install --git <url> [--subpath <path>]");
      process.exit(1);
    }
    const subpathIdx = args.indexOf("--subpath");
    const subpath = subpathIdx !== -1 ? args[subpathIdx + 1] : undefined;
    return { type: "git", url, subpath };
  }

  return { type: "local", path: args[0] };
}

main().catch(err => {
  console.error("[Plugin CLI] Fatal error:", err);
  process.exit(1);
});
