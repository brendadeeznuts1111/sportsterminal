const baseUrl = Bun.env.AGENT_API_URL || 'http://localhost:3000';

console.log('Agent CLI ready. Commands: ipcheck <player>, ipmatch <ip>, ipblock <ip> [reason], suspicious [limit], exit');

for await (const line of console) {
  const [cmd, ...args] = line.trim().split(/\s+/);
  if (!cmd) continue;

  try {
    if (cmd === 'exit' || cmd === 'quit') break;

    if (cmd === 'ipcheck') {
      const [playerId] = args;
      if (!playerId) {
        console.log('Usage: ipcheck <player>');
        continue;
      }
      const ips = await fetchJson(`/api/agent/ip-lookup?player=${encodeURIComponent(playerId)}`);
      console.log('[IP] Player %s IPs: %j', playerId, ips);
      continue;
    }

    if (cmd === 'ipmatch') {
      const [ip] = args;
      if (!ip) {
        console.log('Usage: ipmatch <ip>');
        continue;
      }
      const res = await fetchJson(`/api/agent/ip-lookup?ip=${encodeURIComponent(ip)}`);
      console.log('[IP] Accounts using IP %s: %j', ip, res.accounts || []);
      continue;
    }

    if (cmd === 'suspicious') {
      const limit = Number(args[0] || 20);
      const res = await fetchJson(`/api/agent/ip-suspicious?limit=${encodeURIComponent(String(limit))}`);
      console.log('[IP] Suspicious activity: %j', res);
      continue;
    }

    if (cmd === 'ipblock') {
      const [ip, ...reasonParts] = args;
      if (!ip) {
        console.log('Usage: ipblock <ip> [reason]');
        continue;
      }
      const reason = reasonParts.join(' ') || 'CLI command';
      await fetchJson('/api/agent/ip-block', {
        method: 'POST',
        headers: cliHeaders(),
        body: JSON.stringify({ ip, reason }),
      });
      console.log('IP %s blocked.', ip);
      continue;
    }

    console.log('Unknown command: %s', cmd);
  } catch (error) {
    console.error('[CLI] %s', error instanceof Error ? error.message : String(error));
  }
}

async function fetchJson(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body && typeof body === 'object' && 'error' in body
      ? String((body as { error: unknown }).error)
      : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body;
}

function cliHeaders(): HeadersInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (Bun.env.ADMIN_API_TOKEN) headers['X-Admin-Token'] = Bun.env.ADMIN_API_TOKEN;
  return headers;
}
