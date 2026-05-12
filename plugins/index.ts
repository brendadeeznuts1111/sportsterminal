// plugins/index.ts — Barrel export for the plugin system
export { PluginLoader } from "./loader";
export { PluginRegistry } from "./registry";
export { PluginSandbox } from "./sandbox";
export {
  PLUGIN_CATEGORIES, PluginHookSchema, PluginManifestSchema,
  PluginToolSchema
} from "./types";
export type {
  PluginCategory, PluginExecutionLogRow,
  PluginExecutionResult, PluginHooks, PluginInfo, PluginInstallSource, PluginManifest, PluginRegistryRow, PluginTool
} from "./types";
