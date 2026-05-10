// types/global.d.ts — Explicit global preload exports for editors and builds

import type { EnvType, StructuredLogger } from "../scripts/preload";

declare global {
  var __ENV: EnvType;
  var __LOGGER: StructuredLogger;
  var sportsTerminalFetch: typeof fetch;
}

export {};
