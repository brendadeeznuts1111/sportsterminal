/**
 * ScriptLogger — structured, sectioned logger for CLI scripts and backfills.
 *
 * Provides clean output with sections, tables, progress bars, and timing.
 * Built on top of the existing logger but adds script-specific formatting.
 */

import { color } from 'bun';
import {
  formatSection,
  formatTable,
  formatStatusTable,
  formatKeyValue,
  formatProgressBar,
  type TableColumn,
  type TableOptions,
} from './tableFormatter';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

interface Timer {
  label: string;
  start: number;
}

export class ScriptLogger {
  private timers = new Map<string, Timer>();
  private sectionLevel = 0;
  private quiet: boolean;

  constructor(options: { quiet?: boolean } = {}) {
    this.quiet = options.quiet ?? false;
  }

  // ─── Sections ────────────────────────────────────────────────────────────

  section(title: string): void {
    if (this.quiet) return;
    this.sectionLevel = 0;
    console.log('');
    console.log(formatSection(title));
    console.log('');
  }

  subSection(title: string): void {
    if (this.quiet) return;
    console.log('');
    console.log(`  ${BOLD}${title}${RESET}`);
    console.log(`  ${'─'.repeat(title.length)}`);
  }

  step(label: string, icon: string = '→'): void {
    if (this.quiet) return;
    console.log(`  ${icon} ${label}`);
  }

  // ─── Results / Status ────────────────────────────────────────────────────

  result(label: string, value: string | number, unit?: string): void {
    if (this.quiet) return;
    const valStr = unit ? `${value} ${unit}` : String(value);
    console.log(`  ✅ ${label}: ${BOLD}${valStr}${RESET}`);
  }

  warning(label: string, message: string): void {
    if (this.quiet) return;
    console.log(`  ⚠️  ${label}: ${color('yellow', 'ansi')}${message}${RESET}`);
  }

  error(label: string, message: string): void {
    if (this.quiet) return;
    console.log(`  ❌ ${label}: ${color('red', 'ansi')}${message}${RESET}`);
  }

  info(label: string, message: string): void {
    if (this.quiet) return;
    console.log(`  ℹ️  ${label}: ${DIM}${message}${RESET}`);
  }

  // ─── Tables ──────────────────────────────────────────────────────────────

  table<T extends Record<string, unknown>>(rows: T[], columns: TableColumn<T>[], options?: TableOptions): void {
    if (this.quiet || rows.length === 0) return;
    console.log(formatTable(rows, columns, { indent: 2, ...options }));
  }

  statusTable(
    items: Array<{ name: string; count: number; threshold?: { low: number; ok: number } }>,
    options?: TableOptions
  ): void {
    if (this.quiet || items.length === 0) return;
    console.log(formatStatusTable(items, { indent: 2, ...options }));
  }

  keyValue(entries: Array<{ key: string; value: string | number; color?: string }>): void {
    if (this.quiet || entries.length === 0) return;
    console.log(formatKeyValue(entries, { indent: 2 }));
  }

  // ─── Progress ────────────────────────────────────────────────────────────

  progress(current: number, total: number, label?: string): void {
    if (this.quiet) return;
    const bar = formatProgressBar(current, total);
    const prefix = label ? `${label} ` : '';
    process.stdout.write(`\r  ${prefix}${bar}`);
    if (current >= total) {
      process.stdout.write('\n');
    }
  }

  progressBatch(done: number, total: number, ok: number, fail: number, label?: string): void {
    if (this.quiet) return;
    const rate = done > 0 ? (done / ((performance.now() - (this.timers.get('_batch_start')?.start ?? performance.now())) / 1000)).toFixed(1) : '0.0';
    const bar = formatProgressBar(done, total, 20);
    const prefix = label ? `${label} ` : '';
    const failColor = color('red', 'ansi') ?? '';
    const status = `${ok} ok ${fail > 0 ? failColor + fail + ' fail' + RESET : '0 fail'}`;
    process.stdout.write(`\r  ${prefix}${bar} | ${status} | ${rate}/s`);
    if (done >= total) {
      process.stdout.write('\n');
    }
  }

  // ─── Timing ──────────────────────────────────────────────────────────────

  time(label: string): void {
    this.timers.set(label, { label, start: performance.now() });
  }

  timeEnd(label: string): number {
    const timer = this.timers.get(label);
    if (!timer) {
      console.warn(`Timer "${label}" does not exist`);
      return 0;
    }
    const elapsed = Math.round(performance.now() - timer.start);
    if (!this.quiet) {
      console.log(`  ⏱️  ${label}: ${elapsed}ms`);
    }
    this.timers.delete(label);
    return elapsed;
  }

  // ─── Summary / Footer ────────────────────────────────────────────────────

  summary(entries: Array<{ label: string; value: string | number; status?: 'ok' | 'warn' | 'error' }>): void {
    if (this.quiet) return;
    console.log('');
    console.log(formatSection('SUMMARY', 55));
    for (const e of entries) {
      const statusIcon = e.status === 'ok' ? '✅' : e.status === 'warn' ? '⚠️' : e.status === 'error' ? '❌' : '•';
      const colored = e.status === 'error'
        ? `${color('red', 'ansi')}${e.value}${RESET}`
        : e.status === 'warn'
          ? `${color('yellow', 'ansi')}${e.value}${RESET}`
          : `${BOLD}${e.value}${RESET}`;
      console.log(`  ${statusIcon} ${e.label.padEnd(30)} ${colored}`);
    }
    console.log('═'.repeat(55));
    console.log('');
  }

  done(): void {
    if (this.quiet) return;
    console.log('');
    console.log(`  ${color('green', 'ansi')}✅ Complete${RESET}`);
    console.log('');
  }
}

// ─── Singleton for convenience ─────────────────────────────────────────────

export const scriptLog = new ScriptLogger();

// ─── Standalone helpers ────────────────────────────────────────────────────

export function printHeader(title: string): void {
  console.log('');
  console.log(formatSection(title));
  console.log('');
}

export function printFooter(): void {
  console.log('');
  console.log(formatSection('COMPLETE', 55));
  console.log('');
}
