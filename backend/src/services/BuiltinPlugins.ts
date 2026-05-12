/**
 * Built-in plugins for the risk pipeline.
 *
 * These are registered by default on startup and process every wager
 * through the TickerBuffer → PluginLoader dispatch.
 */

import { Plugin, PluginContext, PluginResult } from './PluginLoader';
import { AppDatabase } from '../database';

/**
 * Risk Sharp Detector Plugin
 *
 * Flags wagers from customers with sharp indicators:
 * - win_rate > 55% + avg_wager > $20
 * - sharp_score > 60
 * - risk_tier in (RED, BLACK)
 * - rule_action = 'review' or 'block'
 */
export const riskSharpDetectorPlugin: Plugin = {
  name: 'risk-sharp-detector',
  version: '1.0.0',
  hooks: {
    async on_wager(ctx: PluginContext, db: AppDatabase): Promise<PluginResult | void> {
      let action: string | undefined;
      let severity: string | undefined;
      let message: string | undefined;

      if (ctx.risk_tier === 'BLACK') {
        action = 'block';
        severity = 'critical';
        message = `BLACK tier wager: ${ctx.login} ($${ctx.amount_wagered.toFixed(2)} on ${ctx.sport})`;
      } else if (ctx.risk_tier === 'RED') {
        action = 'review';
        severity = 'high';
        message = `RED tier wager: ${ctx.login} ($${ctx.amount_wagered.toFixed(2)} on ${ctx.sport})`;
      } else if (ctx.sharp_score > 60) {
        action = 'review';
        severity = 'medium';
        message = `Sharp score ${ctx.sharp_score.toFixed(0)}: ${ctx.login} ($${ctx.amount_wagered.toFixed(2)})`;
      } else if (ctx.win_rate > 0.55 && ctx.avg_wager_size > 20) {
        action = 'alert';
        severity = 'medium';
        message = `High win rate + stakes: ${ctx.login} (${(ctx.win_rate * 100).toFixed(1)}% @ $${ctx.avg_wager_size.toFixed(2)})`;
      } else if (ctx.rule_action === 'block') {
        action = 'block';
        severity = 'critical';
        message = `Rules engine blocked: ${ctx.login}`;
      } else if (ctx.rule_action === 'review') {
        action = 'review';
        severity = 'high';
        message = `Rules engine review: ${ctx.login}`;
      }

      if (action) {
        return { action, severity, message, metadata: { sharp_score: ctx.sharp_score, win_rate: ctx.win_rate, archetype: ctx.archetype } };
      }
    },
  },
};

/**
 * Volume Spike Detector Plugin
 *
 * Detects individual wagers that exceed the customer's historical average
 * by a large margin (>3x avg or >$500 absolute).
 */
export const volumeSpikePlugin: Plugin = {
  name: 'volume-spike-detector',
  version: '1.0.0',
  hooks: {
    async on_wager(ctx: PluginContext): Promise<PluginResult | void> {
      const wagerAmount = ctx.amount_wagered;
      const avgAmount = ctx.avg_wager_size;

      if (avgAmount > 0 && wagerAmount > avgAmount * 3 && wagerAmount > 100) {
        return {
          action: 'alert',
          severity: 'medium',
          message: `Volume spike: $${wagerAmount.toFixed(2)} wager (${(wagerAmount / avgAmount).toFixed(1)}x avg $${avgAmount.toFixed(2)})`,
          metadata: { multiplier: wagerAmount / avgAmount, avg_amount: avgAmount },
        };
      }

      if (wagerAmount > 500) {
        return {
          action: 'alert',
          severity: 'high',
          message: `Large wager: $${wagerAmount.toFixed(2)}`,
          metadata: { absolute_threshold: 500 },
        };
      }
    },
  },
};

/**
 * Archetype Profiler Plugin
 *
 * Logs archetype distribution per wager for analytics dashboards.
 */
export const archetypeProfilerPlugin: Plugin = {
  name: 'archetype-profiler',
  version: '1.0.0',
  hooks: {
    async on_wager(ctx: PluginContext): Promise<PluginResult | void> {
      // Only log every 100th wager to avoid spam
      if (ctx.wager_number % 100 !== 0) return;

      return {
        action: 'log',
        severity: 'info',
        message: `Archetype sample: ${ctx.archetype}`,
        metadata: {
          archetype: ctx.archetype,
          risk_tier: ctx.risk_tier,
          sport: ctx.sport,
          wager_type: ctx.wager_type,
        },
      };
    },
  },
};

/**
 * Register all built-in plugins.
 */
export function registerBuiltinPlugins(register: (p: Plugin) => void): void {
  register(riskSharpDetectorPlugin);
  register(volumeSpikePlugin);
  register(archetypeProfilerPlugin);
}
