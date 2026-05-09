/**
 * Probe various getBetTicker endpoint variations after successful login.
 *
 * Usage:
 *   $env:BUCKEYE_AGENT_ID='your_agent'; $env:BUCKEYE_PASSWORD='your_pass'; bun run scripts/probe-endpoints.ts
 */

import { BuckeyeAPI } from '../src/scrapers/BuckeyeAPI';

const AGENT_ID = process.env.BUCKEYE_AGENT_ID || '';
const PASSWORD = process.env.BUCKEYE_PASSWORD || '';
const BASE_URL = (process.env.BUCKEYE_BASE_URL || 'https://fantasy402.com').replace(/\/$/, '');

const ENDPOINTS = [
  '/getBetTicker',
  '/api/getBetTicker',
  '/GetBetTicker',
  '/betticker',
  '/betTicker',
  '/api/betticker',
  '/wagers',
  '/api/wagers',
  '/bets',
  '/api/bets',
  '/openBets',
  '/getOpenWagers',
  '/wager/list',
  '/api/wager/list',
  '/ticket/list',
  '/api/ticket/list',
];

async function probe() {
  if (!AGENT_ID || !PASSWORD) {
    console.error('Set BUCKEYE_AGENT_ID and BUCKEYE_PASSWORD');
    process.exit(1);
  }

  console.log('Logging in...');
  const api = new BuckeyeAPI({ agentId: AGENT_ID, password: PASSWORD, baseUrl: BASE_URL }, false);
  const loginOk = await api.login();
  if (!loginOk) {
    console.error('Login failed');
    process.exit(1);
  }
  console.log('Login OK. Cookies:', api.getCookies().substring(0, 80) + '...\n');

  const cookieHeader = api.getCookies();

  for (const endpoint of ENDPOINTS) {
    const url = `${BASE_URL}${endpoint}`;
    process.stdout.write(`  GET ${endpoint} ... `);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Cookie: cookieHeader,
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      const text = await res.text().catch(() => '');
      const isJson = text.trim().startsWith('{') || text.trim().startsWith('[');
      if (res.ok && isJson) {
        console.log(`✅ JSON ${text.length} chars`);
        try {
          const data = JSON.parse(text);
          console.log('     Keys:', Object.keys(data).slice(0, 5).join(', '));
          if (data.LIST || data.list || data.data || data.results) {
            const arr = data.LIST || data.list || data.data || data.results;
            console.log('     Array length:', Array.isArray(arr) ? arr.length : 'N/A');
          }
        } catch {}
      } else if (res.ok) {
        console.log(`⚠️  HTML/text ${text.length} chars`);
      } else {
        console.log(`❌ HTTP ${res.status}`);
      }
    } catch (err: any) {
      console.log(`❌ Error: ${err.message}`);
    }
  }

  console.log('\nTrying POST variants for /getBetTicker...');
  for (const endpoint of ['/getBetTicker', '/api/getBetTicker']) {
    const url = `${BASE_URL}${endpoint}`;
    process.stdout.write(`  POST ${endpoint} ... `);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Cookie: cookieHeader,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: '',
      });
      const text = await res.text().catch(() => '');
      const isJson = text.trim().startsWith('{') || text.trim().startsWith('[');
      if (res.ok && isJson) {
        console.log(`✅ JSON ${text.length} chars`);
      } else if (res.ok) {
        console.log(`⚠️  HTML/text ${text.length} chars`);
      } else {
        console.log(`❌ HTTP ${res.status}`);
      }
    } catch (err: any) {
      console.log(`❌ Error: ${err.message}`);
    }
  }
}

probe().catch(console.error);
