/**
 * PluginLoader — lightweight plugin registry and hook dispatcher.
 *
 * Plugins register hooks (e.g. on_wager, on_alert) that receive
 * enriched context and optionally produce side-effects.
 */

import { AppDatabase } from '../database';

export interface PluginContext {
  wager_number: number;
  customer_id: string;
  login: string;
  agent_login: string;
  amount_wagered: number;
  to_win_amount: number;
  sport: string;
  wager_type: string;
  insert_datetime: string;
  parsed_price: number | null;
  parsed_side: string | null;
  parsed_market: string | null;
  archetype: string;
  risk_tier: string;
  sharp_score: number;
  lifetime_wagers: number;
  avg_wager_size: number;
  win_rate: number;
  violation_count: number;
  flag_count: number;
  ai_risk_level: string | null;
  ai_suggested_action: string | null;
  rule_action: string | null;
}

export interface PluginResult {
  action?: string;
  severity?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export type PluginHook = (ctx: PluginContext, db: AppDatabase) => Promise<PluginResult | void>;

export interface Plugin {
  name: string;
  version: string;
  hooks: Partial<Record<string, PluginHook>>;
}

export class PluginLoader {
  private plugins: Map<string, Plugin> = new Map();

  register(plugin: Plugin): void {
    this.plugins.set(plugin.name, plugin);
  }

  unregister(name: string): boolean {
    return this.plugins.delete(name);
  }

  list(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  async dispatch(hookName: string, ctx: PluginContext, db: AppDatabase): Promise<Map<string, PluginResult | undefined>> {
    const results = new Map<string, PluginResult | undefined>();

    for (const [name, plugin] of this.plugins) {
      const hook = plugin.hooks[hookName];
      if (!hook) continue;

      const start = performance.now();
      let status = 'success';
      let errorMessage: string | undefined;
      let result: PluginResult | undefined;

      try {
        result = (await hook(ctx, db)) ?? undefined;
        results.set(name, result);
      } catch (err) {
        status = 'error';
        errorMessage = err instanceof Error ? err.message : String(err);
        results.set(name, undefined);
      }

      const duration = Math.round(performance.now() - start);

      // Audit log
      try {
        await db.run(
          `INSERT INTO plugin_execution_log (
            plugin_name, hook_name, wager_number, customer_id,
            payload_json, result_json, status, duration_ms, error_message
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            name,
            hookName,
            ctx.wager_number,
            ctx.customer_id,
            JSON.stringify(ctx),
            result ? JSON.stringify(result) : '{}',
            status,
            duration,
            errorMessage ?? null,
          ]
        );
      } catch {
        // Best-effort audit logging; don't fail the pipeline
      }
    }

    return results;
  }
}

// Singleton instance
export const pluginLoader = new PluginLoader();
