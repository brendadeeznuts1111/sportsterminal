/**
 * TableFormatter — clean, column-aligned table output for CLI scripts.
 *
 * Works universally on all terminals (no ANSI dependencies).
 * Uses emoji + clean ASCII for visual hierarchy.
 */

export interface TableColumn<T = unknown> {
  key: string;
  header: string;
  width?: number;
  align?: 'left' | 'right';
  format?: (value: T, row: Record<string, unknown>) => string;
}

export interface TableOptions {
  title?: string;
  indent?: number;
}

/**
 * Format an array of objects as a clean aligned table.
 */
export function formatTable<T extends Record<string, unknown>>(
  rows: T[],
  columns: TableColumn<T>[],
  options: TableOptions = {}
): string {
  if (rows.length === 0) return '';

  const indent = ' '.repeat(options.indent ?? 0);
  const lines: string[] = [];

  const widths = columns.map((col) => {
    const maxDataLen = rows.reduce((max, row) => {
      const raw = row[col.key as keyof T];
      const formatted = col.format ? col.format(raw as T, row as Record<string, unknown>) : String(raw ?? '');
      return Math.max(max, formatted.length);
    }, 0);
    return Math.max(col.header.length, maxDataLen, col.width ?? 0) + 2;
  });

  const separator = indent + '+' + widths.map((w) => '-'.repeat(w + 1)).join('+') + '+';

  if (options.title) lines.push(`${indent}${options.title}`);

  lines.push(separator);

  const headerRow = indent + '|' + columns.map((col, i) => {
    const padded = pad(col.header, widths[i], col.align ?? 'left');
    return ` ${padded} `;
  }).join('|') + '|';
  lines.push(headerRow);
  lines.push(separator);

  for (const row of rows) {
    const dataRow = indent + '|' + columns.map((col, i) => {
      const raw = row[col.key as keyof T];
      const formatted = col.format ? col.format(raw as T, row as Record<string, unknown>) : String(raw ?? '');
      const padded = pad(formatted, widths[i], col.align ?? 'left');
      return ` ${padded} `;
    }).join('|') + '|';
    lines.push(dataRow);
  }

  lines.push(separator);
  return lines.join('\n');
}

/**
 * Status table with emoji indicators (EMPTY/LOW/OK pattern).
 */
export function formatStatusTable(
  items: Array<{ name: string; count: number; threshold?: { low: number; ok: number } }>,
  options: TableOptions = {}
): string {
  const indent = ' '.repeat(options.indent ?? 0);
  const lines: string[] = [];

  if (options.title) lines.push(`${indent}${options.title}`);

  const maxNameLen = Math.max(...items.map((i) => i.name.length), 4);
  const maxCountLen = Math.max(...items.map((i) => String(i.count).length), 5);

  lines.push(`${indent}${'Name'.padEnd(maxNameLen)}  ${'Count'.padStart(maxCountLen)}  Status`);
  lines.push(`${indent}${'-'.repeat(maxNameLen + maxCountLen + 10)}`);

  for (const item of items) {
    const status = getStatusIndicator(item.count, item.threshold);
    lines.push(`${indent}${item.name.padEnd(maxNameLen)}  ${String(item.count).padStart(maxCountLen)}  ${status}`);
  }

  return lines.join('\n');
}

function getStatusIndicator(count: number, threshold?: { low: number; ok: number }): string {
  if (!threshold) return count === 0 ? 'EMPTY' : 'OK';
  if (count === 0) return 'EMPTY';
  if (count < threshold.low) return 'LOW';
  if (count < threshold.ok) return 'GOOD';
  return 'OK';
}

/**
 * Format a simple key-value list with alignment.
 */
export function formatKeyValue(
  entries: Array<{ key: string; value: string | number }>,
  options: { indent?: number; separator?: string } = {}
): string {
  const indent = ' '.repeat(options.indent ?? 0);
  const sep = options.separator ?? ':';
  const maxKeyLen = Math.max(...entries.map((e) => e.key.length));

  return entries.map((e) => `${indent}${e.key.padEnd(maxKeyLen)} ${sep} ${String(e.value)}`).join('\n');
}

/**
 * Format a progress bar string.
 */
export function formatProgressBar(current: number, total: number, width: number = 30): string {
  const pct = total > 0 ? current / total : 0;
  const filled = Math.round(width * pct);
  const empty = width - filled;
  const bar = '#'.repeat(filled) + '-'.repeat(empty);
  return `${bar} ${(pct * 100).toFixed(1)}% (${current}/${total})`;
}

/**
 * Format a section header with clean borders.
 */
export function formatSection(title: string, width: number = 55): string {
  const pad = Math.max(0, width - title.length - 4);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return `${'='.repeat(left)}  ${title}  ${'='.repeat(right)}`;
}

// ─── Pad helper ────────────────────────────────────────────────────────────

function pad(str: string, width: number, align: 'left' | 'right'): string {
  if (align === 'right') return ' '.repeat(Math.max(0, width - str.length)) + str;
  return str + ' '.repeat(Math.max(0, width - str.length));
}

// ─── Convenience: print directly ───────────────────────────────────────────

export function printTable<T extends Record<string, unknown>>(
  rows: T[], columns: TableColumn<T>[], options?: TableOptions
): void { console.log(formatTable(rows, columns, options)); }

export function printStatusTable(
  items: Array<{ name: string; count: number; threshold?: { low: number; ok: number } }>,
  options?: TableOptions
): void { console.log(formatStatusTable(items, options)); }

export function printKeyValue(
  entries: Array<{ key: string; value: string | number }>,
  options?: { indent?: number; separator?: string }
): void { console.log(formatKeyValue(entries, options)); }

export function printSection(title: string, width?: number): void {
  console.log(formatSection(title, width));
}
