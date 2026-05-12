// plugins/types.ts — Plugin manifest types & Zod schemas
import { z } from "zod";

// ==========================================
// PLUGIN CATEGORIES
// ==========================================
export const PLUGIN_CATEGORIES = [
  "risk-rules",
  "odds-sources",
  "alert-channels",
  "commission-rules",
  "data-exporters",
  "ui-components",
  "integrations",
] as const;

export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

// ==========================================
// PLUGIN MANIFEST SCHEMA (Zod)
// ==========================================
export const PluginToolSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(512),
  command: z.array(z.string()).min(1),
  parameters: z.object({
    type: z.literal("object"),
    properties: z.record(z.object({
      type: z.string(),
      description: z.string().optional(),
      default: z.unknown().optional(),
    })).optional(),
    required: z.array(z.string()).optional(),
  }).optional(),
  output: z.object({
    type: z.literal("json"),
    schema: z.record(z.string()).optional(),
  }).optional(),
});

export const PluginHookSchema = z.object({
  on_wager: z.string().optional(),
  on_flag: z.string().optional(),
  on_cron: z.object({
    schedule: z.string(),
    script: z.string(),
  }).optional(),
});

export const PluginManifestSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/, "Plugin name must be lowercase alphanumeric with dots, hyphens, underscores"),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9._-]+)?(\+[a-zA-Z0-9._-]+)?$/, "SemVer required"),
  description: z.string().min(1).max(1024),
  author: z.string().optional(),
  category: z.enum(PLUGIN_CATEGORIES),
  config_file: z.string().optional(),
  inject: z.record(z.string()).optional(),
  allow_network: z.array(z.string()).optional(),
  tools: z.array(PluginToolSchema).optional().default([]),
  hooks: PluginHookSchema.optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginTool = z.infer<typeof PluginToolSchema>;
export type PluginHooks = z.infer<typeof PluginHookSchema>;

// ==========================================
// PLUGIN REGISTRY ROW (DB)
// ==========================================
export interface PluginRegistryRow {
  name: string;
  version: string;
  category: PluginCategory | null;
  author_agent_login: string | null;
  install_path: string;
  is_active: number;
  config_json: string | null;
  installed_at: string;
}

// ==========================================
// PLUGIN EXECUTION LOG ROW (DB)
// ==========================================
export interface PluginExecutionLogRow {
  id: number;
  plugin_name: string;
  tool_name: string;
  trigger_type: "manual" | "hook_on_wager" | "hook_on_flag" | "cron";
  parameters: string | null;
  result_json: string | null;
  error: string | null;
  duration_ms: number;
  created_at: string;
}

// ==========================================
// PLUGIN EXECUTION RESULT
// ==========================================
export interface PluginExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  durationMs: number;
}

// ==========================================
// PLUGIN INSTALL SOURCE
// ==========================================
export type PluginInstallSource =
  | { type: "local"; path: string }
  | { type: "zip"; path: string }
  | { type: "git"; url: string; subpath?: string };

// ==========================================
// PLUGIN INFO (for list/info commands)
// ==========================================
export interface PluginInfo {
  name: string;
  version: string;
  description: string;
  author?: string;
  category: PluginCategory;
  installPath: string;
  isActive: boolean;
  toolCount: number;
  hasWagerHook: boolean;
  hasFlagHook: boolean;
  hasCronHook: boolean;
  installedAt: string;
}
