/**
 * Chrome DevTools MCP Utilities
 * 
 * Provides helpers for browser automation, testing, and performance profiling
 * using the Chrome DevTools MCP server.
 */

export interface TestConfig {
  baseUrl: string;
  headless: boolean;
  timeout: number;
  viewport: { width: number; height: number };
  slowMo?: number;
}

export interface PerformanceMetrics {
  name: string;
  url: string;
  fcp?: number; // First Contentful Paint
  lcp?: number; // Largest Contentful Paint
  cls?: number; // Cumulative Layout Shift
  fid?: number; // First Input Delay
  ttfb?: number; // Time to First Byte
  resourceCount?: number;
  totalSize?: number;
  timestamp: Date;
}

/**
 * Get default test configuration based on environment
 */
export function getTestConfig(): TestConfig {
  const isDev = !process.env.CI;
  const baseUrl = process.env.TEST_URL || 'http://localhost:3000';

  return {
    baseUrl,
    headless: !isDev,
    timeout: isDev ? 30000 : 60000,
    viewport: { width: 1280, height: 720 },
    slowMo: isDev ? 100 : 0,
  };
}

/**
 * Performance profiling utilities
 */
export class PerformanceProfiler {
  private metrics: PerformanceMetrics[] = [];
  private config: TestConfig;

  constructor(config: TestConfig) {
    this.config = config;
  }

  /**
   * Record a performance metric
   */
  recordMetric(metric: Partial<PerformanceMetrics>) {
    this.metrics.push({
      name: metric.name || 'unknown',
      url: metric.url || this.config.baseUrl,
      timestamp: new Date(),
      ...metric,
    });
  }

  /**
   * Get all recorded metrics
   */
  getMetrics(): PerformanceMetrics[] {
    return this.metrics;
  }

  /**
   * Format metrics for logging/reporting
   */
  formatMetrics(): string {
    return this.metrics
      .map(
        (m) =>
          `${m.name} (${m.url}): FCP=${m.fcp}ms, LCP=${m.lcp}ms, CLS=${m.cls}, Resources=${m.resourceCount}`,
      )
      .join('\n');
  }

  /**
   * Export metrics as JSON
   */
  exportJSON() {
    return JSON.stringify(this.metrics, null, 2);
  }
}

/**
 * Test utilities
 */
export class BrowserTestHelper {
  private config: TestConfig;

  constructor(config: TestConfig) {
    this.config = config;
  }

  /**
   * Wait for specific selectors
   */
  async waitForSelectors(selectors: string[], timeout?: number) {
    return {
      baseUrl: this.config.baseUrl,
      selectors,
      timeout: timeout || this.config.timeout,
    };
  }

  /**
   * Collect console messages
   */
  async captureConsole() {
    return {
      type: 'console_capture',
      includeErrors: true,
      includeWarnings: true,
    };
  }

  /**
   * Capture network activity
   */
  async captureNetwork() {
    return {
      type: 'network_capture',
      recordRequests: true,
    };
  }

  /**
   * Generate test report
   */
  generateReport(passed: number, failed: number, metrics?: PerformanceMetrics[]) {
    return {
      passed,
      failed,
      total: passed + failed,
      success: failed === 0,
      timestamp: new Date(),
      metrics,
    };
  }
}

/**
 * Environment detection utilities
 */
export function getEnvironment() {
  return {
    isDev: !process.env.CI,
    isCI: !!process.env.CI,
    isHeadless: process.env.HEADLESS === 'true' || !!process.env.CI,
    baseUrl: process.env.TEST_URL || 'http://localhost:3000',
    proxyUrl: process.env.PROXY_URL || 'http://localhost:3001',
  };
}

/**
 * Retry helper for flaky operations
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts?: number; delayMs?: number } = {},
): Promise<T> {
  const { maxAttempts = 3, delayMs = 1000 } = options;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxAttempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error('Retry exhausted');
}
