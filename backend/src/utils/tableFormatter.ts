/**
 * TableFormatter — clean, column-aligned table output for CLI scripts.
 *
 * Uses Bun.inspect.table when available, falls back to manual column alignment
 * for full control over headers, colors, and status indicators.
 */

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

export interface TableColumn<T = unknown> {
  key: string;
  header: string;
  width?: number;
  align?: 'left' | 'right';
  format?: (value: T, row: Record<string, unknown>) => string;
  color?: (value: T, row: Record<string, unknown>) => string;
}

export interface TableOptions {
  title?: string;
  indent?: number;
  maxWidth?: number;
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

  // Calculate column widths
  const widths = columns.map((col) => {
    const headerLen = stripAnsi(col.header).length;
    const maxDataLen = rows.reduce((max, row) => {
      const raw = row[col.key as keyof T];
      const formatted = col.format ? col.format(raw as T, row as Record<string, unknown>) : String(raw ?? '');
      return Math.max(max, stripAnsi(formatted).length);
    }, 0);
    return Math.max(headerLen, maxDataLen, col.width ?? 0) + 2;
  });

  // Build separator
  const separator = indent + '+' + widths.map((w) => '-'.repeat(w + 1)).join('+') + '+';

  // Title
  if (options.title) {
    lines.push('');
    lines.push(`${indent}${BOLD}${options.title}${RESET}`);
  }

  lines.push(separator);

  // Header row
  const headerRow =
    indent +
    '|' +
    columns
      .map((col, i) => {
        const padded = pad(col.header, widths[i], col.align ?? 'left');
        return ` ${BOLD}${padded}${RESET} `;
      })
      .join('|') +
    '|';
  lines.push(headerRow);
  lines.push(separator);

  // Data rows
  for (const row of rows) {
    const dataRow =
      indent +
      '|' +
      columns
        .map((col, i) => {
          const raw = row[col.key as keyof T];
          let formatted = col.format ? col.format(raw as T, row as Record<string, unknown>) : String(raw ?? '');
          if (col.color) {
            const colorCode = col.color(raw as T, row as Record<string, unknown>);
            formatted = `${colorCode}${formatted}${RESET}`;
          }
          const padded = pad(formatted, widths[i], col.align ?? 'left');
          return ` ${padded} `;
        })
        .join('|') +
      '|';
    lines.push(dataRow);
  }

  lines.push(separator);
  return lines.join('\n');
}

/**
 * Quick-status table with emoji indicators (EMPTY/LOW/OK pattern).
 */
export function formatStatusTable(
  items: Array<{ name: string; count: number; threshold?: { low: number; ok: number } }>,
  options: TableOptions = {}
): string {
  const indent = ' '.repeat(options.indent ?? 0);
  const lines: string[] = [];

  if (options.title) {
    lines.push(`${indent}${BOLD}${options.title}${RESET}`);
  }

  const maxNameLen = Math.max(...items.map((i) => i.name.length), 4);
  const maxCountLen = Math.max(...items.map((i) => String(i.count).length), 5);

  // Header
  lines.push(
    `${indent}${BOLD}${'Name'.padEnd(maxNameLen)}  ${'Count'.padStart(maxCountLen)}  Status${RESET}`
  );
  lines.push(`${indent}${'-'.repeat(maxNameLen + maxCountLen + 10)}`);

  for (const item of items) {
    const status = getStatusIndicator(item.count, item.threshold);
    lines.push(
      `${indent}${item.name.padEnd(maxNameLen)}  ${String(item.count).padStart(maxCountLen)}  ${status}`
    );
  }

  return lines.join('\n');
}

function getStatusIndicator(
  count: number,
  threshold?: { low: number; ok: number }
): string {
  if (!threshold) {
    return count === 0 ? '🔴 EMPTY' : '🟢 OK';
  }
  if (count === 0) return '🔴 EMPTY';
  if (count < threshold.low) return '🟡 LOW';
  if (count < threshold.ok) return '🔵 GOOD';
  return '🟢 OK';
}

/**
 * Format a simple key-value list with alignment.
 */
export function formatKeyValue(
  entries: Array<{ key: string; value: string | number; color?: string }>,
  options: { indent?: number; separator?: string } = {}
): string {
  const indent = ' '.repeat(options.indent ?? 0);
  const sep = options.separator ?? ':';
  const maxKeyLen = Math.max(...entries.map((e) => e.key.length));

  return entries
    .map((e) => {
      const val = String(e.value);
      const colored = e.color ? `${e.color}${val}${RESET}` : val;
      return `${indent}${e.key.padEnd(maxKeyLen)} ${sep} ${colored}`;
    })
    .join('\n');
}

/**
 * Format a progress bar string.
 */
export function formatProgressBar(
  current: number,
  total: number,
  width: number = 30
): string {
  const pct = total > 0 ? current / total : 0;
  const filled = Math.round(width * pct);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const pctStr = `${(pct * 100).toFixed(1)}%`;
  return `${bar} ${pctStr} (${current}/${total})`;
}

/**
 * Format a section header with borders.
 */
export function formatSection(title: string, width: number = 55): string {
  const pad = Math.max(0, width - title.length - 4);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return `${'═'.repeat(left)}  ${BOLD}${title}${RESET}  ${'═'.repeat(right)}`;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function stripAnsi(str: string): string {
  let output = '';
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 27 && str[i + 1] === '[') {
      i += 2;
      while (i < str.length && str[i] !== 'm') i++;
      continue;
    }
    output += str[i];
  }
  return output;
}

function pad(str: string, width: number, align: 'left' | 'right'): string {
  const len = stripAnsi(str).length;
  if (align === 'right') {
    return ' '.repeat(Math.max(0, width - len)) + str;
  }
  return str + ' '.repeat(Math.max(0, width - len));
}

// ─── Convenience: print directly ───────────────────────────────────────────

export function printTable<T extends Record<string, unknown>>(
  rows: T[],
  columns: TableColumn<T>[],
  options?: TableOptions
): void {
  console.log(formatTable(rows, columns, options));
}

export function printStatusTable(
  items: Array<{ name: string; count: number; threshold?: { low: number; ok: number } }>,
  options?: TableOptions
): void {
  console.log(formatStatusTable(items, options));
}

export function printKeyValue(
  entries: Array<{ key: string; value: string | number; color?: string }>,
  options?: { indent?: number; separator?: string }
): void {
  console.log(formatKeyValue(entries, options));
}

export function printSection(title: string, width?: number): void {
  console.log(formatSection(title, width));
}
