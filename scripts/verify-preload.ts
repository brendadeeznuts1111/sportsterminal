// verify-preload.ts — Quick integration check
console.log("ENV port:", globalThis.__ENV?.PROXY_PORT);
console.log("LOGGER exists:", typeof globalThis.__LOGGER?.log === "function");

const { config, CONFIG, isEnabled } = await import("../config.ts");
console.log("config.port:", config.port);
console.log("config.features.autoRetry:", config.features.autoRetry);
console.log("CONFIG.features.metrics:", CONFIG.features.metrics);
console.log("isEnabled('metrics'):", isEnabled("metrics"));

// Exit cleanly to avoid waiting on intervals
process.exit(0);
