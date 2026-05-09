/**
 * Standalone diagnostic script to test Buckeye login & data fetch.
 *
 * Usage:
 *   cd backend
 *   BUCKEYE_AGENT_ID=your_agent BUCKEYE_PASSWORD=your_pass bun run scripts/test-login.ts
 *
 * Or with debug logging:
 *   DEBUG=1 BUCKEYE_AGENT_ID=your_agent BUCKEYE_PASSWORD=your_pass bun run scripts/test-login.ts
 */

import { BuckeyeAPI } from '../src/scrapers/BuckeyeAPI';

async function main() {
  const agentId = process.env.BUCKEYE_AGENT_ID || '';
  const password = process.env.BUCKEYE_PASSWORD || '';
  const baseUrl = process.env.BUCKEYE_BASE_URL || 'https://fantasy402.com';
  const debug = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

  if (!agentId || !password) {
    console.error('Error: Set BUCKEYE_AGENT_ID and BUCKEYE_PASSWORD environment variables.');
    console.error('');
    console.error('Example (PowerShell):');
    console.error("  $env:BUCKEYE_AGENT_ID='your_agent'; $env:BUCKEYE_PASSWORD='your_pass'; bun run scripts/test-login.ts");
    console.error('');
    console.error('Example (Bash):');
    console.error('  BUCKEYE_AGENT_ID=your_agent BUCKEYE_PASSWORD=your_pass bun run scripts/test-login.ts');
    process.exit(1);
  }

  console.log('============================================');
  console.log('  Buckeye Login Diagnostic');
  console.log('============================================');
  console.log(`Agent ID : ${agentId}`);
  console.log(`Base URL : ${baseUrl}`);
  console.log(`Debug    : ${debug}`);
  console.log('');

  const api = new BuckeyeAPI({ agentId, password, baseUrl }, debug);

  console.log('--- Step 1: Login ---');
  const loginOk = await api.login();

  if (!loginOk) {
    console.error('\n❌ LOGIN FAILED');
    console.error('');
    console.error('Troubleshooting:');
    console.error('  1. Verify agent_id and password are correct');
    console.error('  2. Check if the site uses "username" instead of "agent_id"');
    console.error('  3. Try enabling DEBUG=1 for verbose output');
    console.error('  4. Check network connectivity to', baseUrl);
    process.exit(1);
  }

  console.log('\n✅ LOGIN SUCCESS');
  console.log(`Session cookies: ${api.getCookies()}`);

  console.log('\n--- Step 2: Fetch Bet Ticker ---');
  try {
    const wagers = await api.getBetTicker();
    console.log(`✅ Bet ticker fetched: ${wagers.length} wagers`);

    if (wagers.length > 0) {
      console.log('\n--- Sample Wager ---');
      const sample = wagers[0];
      console.log(JSON.stringify(sample, null, 2));
    }

    console.log('\n--- Step 3: Detect Changes ---');
    const changes = api.detectChanges(wagers);
    console.log(`Changes detected: ${changes.length} (all should be 'new' on first fetch)`);
  } catch (err: any) {
    console.error('\n❌ BET TICKER FETCH FAILED');
    console.error(err.message || err);
    process.exit(1);
  }

  console.log('\n============================================');
  console.log('  All checks passed — API is ready');
  console.log('============================================');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
