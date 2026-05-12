/**
 * ScriptLogger — structured, sectioned logger for CLI scripts and backfills.
 *
 * Provides clean, universal output (no ANSI codes).
 * Emoji + alignment for visual hierarchy.
 * Works on all terminals including Windows.
 */

import {
  formatSection,
  formatTable,
  formatStatusTable,
  formatKeyValue,
  formatProgressBar,
  type TableColumn,
  type TableOptions,
} from './tableFormatter';

interface Timer {
  label: string;
  start: number;
}

export class ScriptLogger {
  private timers = new Map<string, Timer>();
  private quiet: boolean;

  constructor(options: { quiet?: boolean } = {}) {
    this.quiet = options.quiet ?? false;
  }

  // ─── Sections ────────────────────────────────────────────────────────────

  section(title: string): void {
    if (this.quiet) return;
    this.timers.set('_batch_start', { label: '_batch_start', start: performance.now() });
    console.log('');
    console.log(formatSection(title));
    console.log('');
  }

  subSection(title: string): void {
    if (this.quiet) return;
    console.log('');
    console.log(`  ${title}`);
    console.log(`  ${'-'.repeat(title.length)}`);
  }

  step(label: string, icon: string = '>'): void {
    if (this.quiet) return;
    console.log(`  ${icon} ${label}`);
  }

  // ─── Results / Status ────────────────────────────────────────────────────

  result(label: string, value: string | number, unit?: string): void {
    if (this.quiet) return;
    const valStr = unit ? `${value} ${unit}` : String(value);
    console.log(`  [OK] ${label}: ${valStr}`);
  }

  warning(label: string, message: string): void {
    if (this.quiet) return;
    console.log(`  [!] ${label}: ${message}`);
  }

  error(label: string, message: string): void {
    if (this.quiet) return;
    console.log(`  [X] ${label}: ${message}`);
  }

  info(label: string, message: string): void {
    if (this.quiet) return;
    console.log(`  [i] ${label}: ${message}`);
  }

  // ─── Tables ──────────────────────────────────────────────────────────────

  table<T extends Record<string, unknown>>(rows: T[], columns: TableColumn<T>[], options?: TableOptions): void {
    if (this.quiet || rows.length === 0) return;
    console.log(formatTable(rows, columns, { indent: 2, ...options }));
  }

  statusTable(items: Array<{ name: string; count: number; threshold?: { low: number; ok: number } }>, options?: TableOptions): void {
    if (this.quiet || items.length === 0) return;
    console.log(formatStatusTable(items, { indent: 2, ...options }));
  }

  keyValue(entries: Array<{ key: string; value: string | number }>): void {
    if (this.quiet || entries.length === 0) return;
    console.log(formatKeyValue(entries, { indent: 2 }));
  }

  // ─── Progress ────────────────────────────────────────────────────────────

  progress(current: number, total: number, label?: string): void {
    if (this.quiet) return;
    const bar = formatProgressBar(current, total);
    const prefix = label ? `${label} ` : '';
    process.stdout.write(`\r  ${prefix}${bar}`);
    if (current >= total) process.stdout.write('\n');
  }

  progressBatch(done: number, total: number, ok: number, fail: number, label?: string): void {
    if (this.quiet) return;
    const elapsed = (performance.now() - (this.timers.get('_batch_start')?.start ?? performance.now())) / 1000;
    const rate = done > 0 && elapsed > 0 ? (done / elapsed).toFixed(1) : '0.0';
    const bar = formatProgressBar(done, total, 20);
    const prefix = label ? `${label} ` : '';
    const status = `${ok} ok | ${fail} fail`;
    process.stdout.write(`\r  ${prefix}${bar} | ${status} | ${rate}/s`);
    if (done >= total) process.stdout.write('\n');
  }

  // ─── Timing ──────────────────────────────────────────────────────────────

  time(label: string): void {
    this.timers.set(label, { label, start: performance.now() });
  }

  timeEnd(label: string): number | undefined {
    const timer = this.timers.get(label);
    if (!timer) return undefined;
    const elapsed = Math.round(performance.now() - timer.start);
    if (!this.quiet) console.log(`  [time] ${label}: ${elapsed}ms`);
    this.timers.delete(label);
    return elapsed;
  }

  // ─── Summary / Footer ────────────────────────────────────────────────────

  summary(entries: Array<{ label: string; value: string | number; status?: 'ok' | 'warn' | 'error' }>): void {
    if (this.quiet) return;
    console.log('');
    console.log(formatSection('SUMMARY', 55));
    for (const e of entries) {
      const statusIcon = e.status === 'ok' ? '[OK]' : e.status === 'warn' ? '[!]' : e.status === 'error' ? '[X]' : '[*]';
      console.log(`  ${statusIcon} ${e.label.padEnd(30)} ${String(e.value)}`);
    }
    console.log('='.repeat(55));
    console.log('');
  }

  done(): void {
    if (this.quiet) return;
    console.log('');
    console.log('  [OK] Complete');
    console.log('');
  }
}

export const scriptLog = new ScriptLogger();

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
