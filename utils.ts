// utils.ts — Shared utilities for Buckeye Proxy
import { randomUUID } from "node:crypto";

export type JsonObject = Record<string, unknown>;

type GlobalLogger = {
  log?: (level: "debug" | "info" | "warn" | "error", source: string, message: string, meta?: JsonObject) => void;
};

interface CircuitBreakerState {
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  failures: number;
  nextAttempt: number;
}

function writeStructuredLog(level: "info" | "warn" | "error", message: string, meta: JsonObject = {}) {
  const globalLogger = (globalThis as typeof globalThis & { __LOGGER?: GlobalLogger }).__LOGGER;
  if (typeof globalLogger?.log === "function") {
    globalLogger.log(level, "proxy", message, meta);
    return;
  }

  if (level === "error") {
    const entry = {
      level,
      timestamp: new Date().toISOString(),
      reqId: (meta.reqId as string) || "global",
      service: "buckeye-proxy",
      ...meta,
      msg: message,
    };
    console.error(JSON.stringify(entry));
    return;
  }

  const entry = {
    level,
    timestamp: new Date().toISOString(),
    reqId: (meta.reqId as string) || "global",
    service: "buckeye-proxy",
    ...meta,
    msg: message,
  };
  console.log(JSON.stringify(entry));
}

export const logger = {
  info: (message: string, meta: JsonObject = {}) => {
    writeStructuredLog("info", message, meta);
  },
  warn: (message: string, meta: JsonObject = {}) => {
    writeStructuredLog("warn", message, meta);
  },
  error: (message: string, meta: JsonObject = {}) => {
    writeStructuredLog("error", message, meta);
  },
};

export class CircuitBreaker {
  private failures = 0;
  private state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED";
  private nextAttempt = 0;
  readonly threshold = 5;
  readonly resetTimeout = 30000;

  async call<T>(fn: () => Promise<T>, meta: JsonObject = {}): Promise<T> {
    if (this.state === "OPEN") {
      if (Date.now() > this.nextAttempt) {
        this.state = "HALF_OPEN";
        logger.info("Circuit breaker half-open", { ...meta, state: this.state });
      } else {
        throw new Error("CIRCUIT_OPEN - Buckeye upstream unavailable");
      }
    }
    try {
      const result = await fn();
      if (this.state !== "CLOSED") {
        this.state = "CLOSED";
        this.failures = 0;
        logger.info("Circuit breaker closed", { ...meta, state: this.state });
      }
      return result;
    } catch (err) {
      this.failures++;
      if (this.failures >= this.threshold) {
        this.state = "OPEN";
        this.nextAttempt = Date.now() + this.resetTimeout;
        logger.error("Circuit breaker opened", {
          ...meta,
          failures: this.failures,
          nextAttempt: this.nextAttempt,
        });
      }
      throw err;
    }
  }

  getStatus(): CircuitBreakerState {
    return { state: this.state, failures: this.failures, nextAttempt: this.nextAttempt };
  }

  reset(): void {
    this.failures = 0;
    this.state = "CLOSED";
    this.nextAttempt = 0;
  }
}

export function requestContext(req: Request): { reqId: string; start: number } {
  return {
    reqId: req.headers.get("X-Request-ID") || randomUUID(),
    start: performance.now(),
  };
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3
): Promise<Response> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status >= 500 && attempt < retries - 1) {
        const delay = 1000 * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt === retries - 1) throw err;
      const delay = 1000 * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("Max retries exceeded");
}

export function hashPayload(payload: unknown): string {
  return Bun.hash(JSON.stringify(payload)).toString(36);
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-Request-ID",
  };
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...cors, ...headers },
  });
}
