/**
 * Probe Buckeye endpoints and local raw wager payloads before enabling Player 360 pollers.
 *
 * Usage:
 *   $env:BUCKEYE_AGENT_ID='agent'
 *   $env:BUCKEYE_PASSWORD='password'
 *   $env:BUCKEYE_CF_COOKIE='cf_clearance=...'
 *   $env:PLAYER_ID='optional-player-login-or-customer-id'
 *   bun run scripts/probe-player360.ts
 */

import { AppDatabase, normalizeDatabasePath } from '../src/database';
import { BuckeyeAPI, buildManagerOperationBody } from '../src/scrapers/BuckeyeAPI';

const AGENT_ID = process.env.BUCKEYE_AGENT_ID || '';
const PASSWORD = process.env.BUCKEYE_PASSWORD || '';
const CF_COOKIE = process.env.BUCKEYE_CF_COOKIE || process.env.CF_COOKIE || '';
const BASE_URL = (process.env.BUCKEYE_BASE_URL || 'https://fantasy402.com').replace(/\/$/, '');
const PLAYER_ID = process.env.PLAYER_ID || process.env.CUSTOMER_ID || '';
const DB_PATH = normalizeDatabasePath(process.env.DATABASE_URL || './data/terminal.db');

const DEPOSIT_OPERATIONS = [
  'getCustomerDeposits',
  'getDepositHistory',
  'getCustomerTransactions',
  'getTransactionHistory',
  'getTransactions',
];

const CUSTOMER_OPERATIONS = [
  'getCustomerInfo',
  'getCustomerDetails',
  'getCustomerProfile',
  'getCustomer',
];

async function main(): Promise<void> {
  console.log('Player 360 probe');
  console.log('Base URL:', BASE_URL);
  console.log('Player:', PLAYER_ID || '(none supplied)');
  await scanLocalWagerRawJson();

  if (!AGENT_ID || !PASSWORD) {
    console.log('\nSkipping remote Buckeye probes. Set BUCKEYE_AGENT_ID and BUCKEYE_PASSWORD to test candidate endpoints.');
    return;
  }

  const api = new BuckeyeAPI(
    { agentId: AGENT_ID, password: PASSWORD, baseUrl: BASE_URL, cfCookie: CF_COOKIE },
    process.env.DEBUG === 'true'
  );
  const loginOk = await api.login();
  if (!loginOk) {
    console.error('Buckeye login failed; remote probes skipped.');
    process.exit(1);
  }

  console.log('\nRemote deposit/transaction candidates');
  for (const operation of DEPOSIT_OPERATIONS) {
    await probeManagerOperation(api, operation);
  }

  console.log('\nRemote customer-info candidates');
  for (const operation of CUSTOMER_OPERATIONS) {
    await probeManagerOperation(api, operation);
  }
}

async function scanLocalWagerRawJson(): Promise<void> {
  const db = new AppDatabase(DB_PATH);
  try {
    const rows = await db.all<{ wager_number: number; raw_json: string }>(
      `SELECT wager_number, raw_json
       FROM wager_archive
       WHERE raw_json IS NOT NULL AND raw_json <> '{}'
       ORDER BY insert_date_time DESC
       LIMIT 500`
    );
    const clvMatches: Array<{ wagerNumber: number; paths: string[] }> = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.raw_json);
        const paths = findKeys(parsed, /(closing|close|clv|linevalue)/i);
        if (paths.length) clvMatches.push({ wagerNumber: row.wager_number, paths });
      } catch {
        // Ignore malformed historical payloads.
      }
    }

    console.log('\nLocal raw_json CLV scan');
    console.log(`Scanned ${rows.length} recent raw wager payloads.`);
    if (clvMatches.length === 0) {
      console.log('No ClosingLine/CLV-like keys found in recent wager_archive.raw_json rows.');
    } else {
      for (const match of clvMatches.slice(0, 10)) {
        console.log(`#${match.wagerNumber}: ${match.paths.slice(0, 8).join(', ')}`);
      }
    }
  } finally {
    await db.close();
  }
}

async function probeManagerOperation(api: BuckeyeAPI, operation: string): Promise<void> {
  const extra: Record<string, string> = {};
  if (PLAYER_ID) {
    extra.customerID = PLAYER_ID;
    extra.loginID = PLAYER_ID;
    extra.login = PLAYER_ID;
  }
  extra.startDate = process.env.PROBE_START_DATE || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  extra.endDate = process.env.PROBE_END_DATE || new Date().toISOString().slice(0, 10);

  const body = buildManagerOperationBody(AGENT_ID, operation as any, extra);
  const endpoint = `${BASE_URL}/cloud/api/Manager/${operation}`;
  process.stdout.write(`  POST ${operation} ... `);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Authorization: `Bearer ${api.getToken()}`,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Origin: BASE_URL,
        Referer: `${BASE_URL}/manager.html`,
        ...(api.getCookie() ? { Cookie: api.getCookie() } : {}),
      },
      body,
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      console.log(`HTTP ${response.status} ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
      return;
    }
    const parsed = parseMaybeJson(text);
    if (!parsed.ok) {
      console.log(`non-JSON ${text.length} chars`);
      return;
    }
    console.log(`JSON ${text.length} chars`);
    console.log('     summary:', summarizeJson(parsed.value));
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
  }
}

function parseMaybeJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function summarizeJson(value: unknown): string {
  if (Array.isArray(value)) return `array length=${value.length} sampleKeys=${Object.keys(value[0] || {}).slice(0, 8).join('|')}`;
  if (!value || typeof value !== 'object') return typeof value;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const listKey = keys.find((key) => Array.isArray(obj[key]));
  const list = listKey ? (obj[listKey] as unknown[]) : [];
  return `keys=${keys.slice(0, 12).join('|')}${listKey ? ` ${listKey}.length=${list.length} sampleKeys=${Object.keys(list[0] || {}).slice(0, 8).join('|')}` : ''}`;
}

function findKeys(value: unknown, pattern: RegExp, path = '$'): string[] {
  if (!value || typeof value !== 'object') return [];
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.slice(0, 5).forEach((item, index) => found.push(...findKeys(item, pattern, `${path}[${index}]`)));
    return found;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = `${path}.${key}`;
    if (pattern.test(key)) found.push(nextPath);
    found.push(...findKeys(child, pattern, nextPath));
  }
  return found;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
