/**
 * Probe different login field names to find the one the real site expects.
 *
 * Usage:
 *   $env:BUCKEYE_AGENT_ID='your_agent'; $env:BUCKEYE_PASSWORD='your_pass'; bun run scripts/probe-login.ts
 *
 * This tries: agent_id, username, user, email, login, id, account, agentid
 * and reports which combination produced cookies.
 */

const BASE_URL = (process.env.BUCKEYE_BASE_URL || 'https://fantasy402.com').replace(/\/$/, '');
const AGENT_ID = process.env.BUCKEYE_AGENT_ID || '';
const PASSWORD = process.env.BUCKEYE_PASSWORD || '';

const FIELD_NAMES = ['agent_id', 'username', 'user', 'email', 'login', 'id', 'account', 'agentid', 'name'];

async function probe(fieldName: string): Promise<{ ok: boolean; status: number; cookies: string }> {
  const body = new URLSearchParams();
  body.set(fieldName, AGENT_ID);
  body.set('password', PASSWORD);

  try {
    const response = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Origin: BASE_URL,
        Referer: `${BASE_URL}/login`,
      },
      body,
      redirect: 'manual',
    });

    const cookie = response.headers.get('set-cookie') || '';
    return { ok: cookie.length > 0 && cookie.includes('='), status: response.status, cookies: cookie };
  } catch (err: any) {
    return { ok: false, status: 0, cookies: err.message };
  }
}

async function main() {
  if (!AGENT_ID || !PASSWORD) {
    console.error('Set BUCKEYE_AGENT_ID and BUCKEYE_PASSWORD');
    process.exit(1);
  }

  console.log(`Probing ${BASE_URL}/login with ${FIELD_NAMES.length} field name variants...\n`);
  console.log(`Agent ID: ${AGENT_ID}`);
  console.log(`Password: ${'*'.repeat(PASSWORD.length)}`);
  console.log('');

  let best: string | null = null;

  for (const field of FIELD_NAMES) {
    process.stdout.write(`  Trying "${field}" ... `);
    const result = await probe(field);
    if (result.ok) {
      console.log(`✅ COOKIES RECEIVED (HTTP ${result.status})`);
      console.log(`     Cookies: ${result.cookies.substring(0, 120)}...`);
      best = field;
      break;
    } else {
      console.log(`❌ No cookies (HTTP ${result.status})`);
    }
  }

  console.log('');
  if (best) {
    console.log(`✅ WINNER: Use field name "${best}"`);
    console.log(`   Update BuckeyeAPI.ts if different from "agent_id"`);
  } else {
    console.log('❌ No field name produced cookies.');
    console.log('   Possible causes:');
    console.log('   - Wrong credentials');
    console.log('   - Site blocks automated requests (needs more headers/proxy)');
    console.log('   - Login endpoint is different (e.g., /auth/login, /api/login)');
    console.log('   - Site uses JSON body instead of form-encoded');
  }
}

main().catch((e) => console.error(e));
