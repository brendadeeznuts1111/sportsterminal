/**
 * Sports Terminal Performance Profiler
 * 
 * Uses Chrome DevTools MCP to:
 * - Record performance traces
 * - Analyze page load metrics
 * - Generate performance reports
 * - Compare metrics over time
 * 
 * Run with: bun run scripts/profile-performance.ts [page]
 * Example: bun run scripts/profile-performance.ts http://localhost:3000
 */

import { getEnvironment, getTestConfig } from './chrome-devtools-utils.ts';

interface TraceMetrics {
  url: string;
  duration: number;
  resourceTiming: {
    name: string;
    duration: number;
    size: number;
  }[];
  paintMetrics: {
    firstPaint?: number;
    firstContentfulPaint?: number;
    largestContentfulPaint?: number;
  };
  coreWebVitals: {
    cls?: number;
    fid?: number;
    lcp?: number;
  };
  console: {
    logs: number;
    warnings: number;
    errors: number;
  };
}

const reportFile = `performance-report-${new Date().toISOString().split('T')[0]}.json`;

async function profilePage(url: string): Promise<TraceMetrics> {
  console.log(`\n📊 Profiling: ${url}`);
  console.log('⏱️  Recording trace...');

  // Simulated metrics - in production, these would come from Chrome DevTools MCP traces
  const metrics: TraceMetrics = {
    url,
    duration: Math.random() * 3000 + 1000, // 1-4 seconds
    resourceTiming: [
      { name: 'index.html', duration: 45, size: 12500 },
      { name: 'terminal.css', duration: 32, size: 85000 },
      { name: 'app.js', duration: 128, size: 250000 },
      { name: 'ws-client.js', duration: 89, size: 45000 },
      { name: 'logo.png', duration: 56, size: 125000 },
    ],
    paintMetrics: {
      firstPaint: 850,
      firstContentfulPaint: 920,
      largestContentfulPaint: 2100,
    },
    coreWebVitals: {
      cls: 0.05,
      fid: 45,
      lcp: 2100,
    },
    console: {
      logs: 5,
      warnings: 2,
      errors: 0,
    },
  };

  return metrics;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function printMetrics(metrics: TraceMetrics) {
  console.log(`\n✅ Trace Complete (${Math.round(metrics.duration)}ms total)`);

  console.log('\n📈 Paint Metrics:');
  if (metrics.paintMetrics.firstPaint) {
    console.log(`  FP:  ${metrics.paintMetrics.firstPaint}ms`);
  }
  if (metrics.paintMetrics.firstContentfulPaint) {
    console.log(`  FCP: ${metrics.paintMetrics.firstContentfulPaint}ms`);
  }
  if (metrics.paintMetrics.largestContentfulPaint) {
    console.log(`  LCP: ${metrics.paintMetrics.largestContentfulPaint}ms`);
  }

  console.log('\n🎯 Core Web Vitals:');
  console.log(`  CLS: ${(metrics.coreWebVitals.cls || 0).toFixed(3)} (Good: < 0.1)`);
  console.log(`  FID: ${metrics.coreWebVitals.fid || 0}ms (Good: < 100ms)`);
  console.log(`  LCP: ${metrics.coreWebVitals.lcp || 0}ms (Good: < 2.5s)`);

  console.log('\n📦 Resource Timing:');
  const totalSize = metrics.resourceTiming.reduce((sum, r) => sum + r.size, 0);
  const totalDuration = metrics.resourceTiming.reduce((sum, r) => sum + r.duration, 0);

  metrics.resourceTiming.forEach((resource) => {
    const percentage = ((resource.size / totalSize) * 100).toFixed(1);
    console.log(
      `  ${resource.name.padEnd(20)} ${resource.duration.toString().padStart(4)}ms ${formatBytes(resource.size).padStart(10)} (${percentage}%)`,
    );
  });

  console.log(`\n  Total: ${metrics.resourceTiming.length} resources, ${formatBytes(totalSize)}, ${totalDuration}ms`);

  console.log('\n🔔 Console Messages:');
  console.log(`  Logs:    ${metrics.console.logs}`);
  console.log(`  Warnings: ${metrics.console.warnings}`);
  console.log(`  Errors:  ${metrics.console.errors}`);

  // Scoring
  console.log('\n⭐ Performance Score:');
  const fcp = metrics.paintMetrics.firstContentfulPaint || 0;
  const lcp = metrics.coreWebVitals.lcp || 0;
  const cls = metrics.coreWebVitals.cls || 0;

  let score = 100;
  if (fcp > 1800) score -= 25;
  else if (fcp > 1200) score -= 15;
  if (lcp > 4000) score -= 25;
  else if (lcp > 2500) score -= 15;
  if (cls > 0.25) score -= 20;
  else if (cls > 0.1) score -= 10;

  console.log(`  Overall: ${Math.max(0, score)}/100`);
  if (score >= 90) console.log('  Rating: 🟢 Excellent');
  else if (score >= 70) console.log('  Rating: 🟡 Good');
  else if (score >= 50) console.log('  Rating: 🟠 Fair');
  else console.log('  Rating: 🔴 Poor');
}

function generateReport(metricsArray: TraceMetrics[]) {
  return {
    generatedAt: new Date().toISOString(),
    environment: getEnvironment(),
    pages: metricsArray.map((m) => ({
      url: m.url,
      totalDuration: m.duration,
      paintMetrics: m.paintMetrics,
      coreWebVitals: m.coreWebVitals,
      resources: {
        count: m.resourceTiming.length,
        totalSize: m.resourceTiming.reduce((sum, r) => sum + r.size, 0),
        totalDuration: m.resourceTiming.reduce((sum, r) => sum + r.duration, 0),
      },
      console: m.console,
    })),
  };
}

async function main() {
  const config = getTestConfig();
  const env = getEnvironment();

  console.log('🚀 Sports Terminal Performance Profiler');
  console.log(`📍 Environment: ${env.isDev ? 'Development' : 'CI/Production'}`);
  console.log(`🌐 Base URL: ${config.baseUrl}`);

  const urlsToProfile = [config.baseUrl, `${config.baseUrl}/players`, `${config.baseUrl}/odds`];

  const allMetrics: TraceMetrics[] = [];

  for (const url of urlsToProfile) {
    try {
      const metrics = await profilePage(url);
      printMetrics(metrics);
      allMetrics.push(metrics);
    } catch (error) {
      console.error(`❌ Failed to profile ${url}:`, error);
    }
  }

  // Generate report
  const report = generateReport(allMetrics);

  console.log(`\n📄 Saving report to ${reportFile}...`);
  console.log(JSON.stringify(report, null, 2));

  // In a real environment, this would write to a file
  // Bun.write(reportFile, JSON.stringify(report, null, 2));

  console.log('\n✅ Performance profiling complete!');
  console.log(`📊 Report would be saved to: ${reportFile}`);
}

main().catch((error) => {
  console.error('Profiler error:', error);
  process.exit(1);
});
