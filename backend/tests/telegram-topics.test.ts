// tests/telegram-topics.test.ts — Clean topic validation with Bun.inspect.table

const BASE = 'http://localhost:3000';

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

console.log('\n🚀 Telegram Topics Validation\n');

// ─── 1. Health Check ───────────────────────────────────────────────────────
try {
  const health = await get('/api/health/system-status');
  const status = health?.status ?? 'unknown';
  console.log(`✅ Server healthy — status: ${status}\n`);
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`❌ Server unreachable: ${msg}`);
  process.exit(1);
}

// ─── 2. List All Topics ────────────────────────────────────────────────────
try {
  const topicsData = await get('/api/telegram/topics?purpose=all');
  const topics: any[] = topicsData.topics || [];

  console.log(`📋 ${topics.length} topic(s) found (filter: ${topicsData.filter || 'all'})\n`);

  if (topics.length === 0) {
    console.log('⚠️  No topics found in database\n');
  } else {
    console.log(
      Bun.inspect.table(
        topics.map((t: any) => ({
          Agent: t.agent_login ?? t.supergroup_purpose ?? '-',
          Topic: t.topic_name,
          Purpose: t.purpose ?? '-',
          Group: t.supergroup_purpose ?? '-',
          Icon: t.topic_icon ?? '-',
          Hex: t.topic_hex_color ? `#${t.topic_hex_color}` : '-',
          Thread: t.topic_thread_id ?? '-',
          Deeplink: t.supergroup_chat_id && t.topic_thread_id
            ? `t.me/c/${String(t.supergroup_chat_id).replace('-100', '')}/${t.topic_thread_id}`
            : '-',
        }))
      )
    );
  }
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`❌ Topics endpoint failed: ${msg}`);
}

// ─── 3. List System Topics ─────────────────────────────────────────────────
try {
  const systemData = await get('/api/telegram/topics?purpose=system');
  const systemTopics: any[] = systemData.topics || [];
  console.log(`\n🔧 ${systemTopics.length} system-internal topic(s)\n`);
  if (systemTopics.length > 0) {
    console.log(
      Bun.inspect.table(
        systemTopics.map((t: any) => ({
          Topic: t.topic_name,
          Purpose: t.purpose ?? '-',
          Thread: t.topic_thread_id ?? '-',
        }))
      )
    );
  }
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`❌ System topics endpoint failed: ${msg}`);
}

// ─── 4. List Agent Topics ──────────────────────────────────────────────────
try {
  const agentData = await get('/api/telegram/topics?purpose=agent');
  const agentTopics: any[] = agentData.topics || [];
  console.log(`\n👤 ${agentTopics.length} agent-facing topic(s)\n`);
  if (agentTopics.length > 0) {
    console.log(
      Bun.inspect.table(
        agentTopics.map((t: any) => ({
          Agent: t.agent_login ?? '-',
          Topic: t.topic_name,
          Purpose: t.purpose ?? '-',
          Thread: t.topic_thread_id ?? '-',
        }))
      )
    );
  }
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`❌ Agent topics endpoint failed: ${msg}`);
}

// ─── 5. List Channels ──────────────────────────────────────────────────────
try {
  const channelsData = await get('/api/telegram/channels');
  const channels: any[] = channelsData.channels || [];
  console.log(`\n📡 ${channels.length} broadcast channel(s)\n`);

  if (channels.length > 0) {
    console.log(
      Bun.inspect.table(
        channels.map((c: any) => ({
          Name: c.channel_name,
          Type: c.channel_type ?? 'broadcast',
          Purpose: c.purpose ?? '-',
          Active: c.is_active ? 'Yes' : 'No',
          ChatID: c.telegram_chat_id ?? '-',
        }))
      )
    );
  } else {
    console.log('   ⚠️  No channels registered — broadcasts will fallback to private chats\n');
  }
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`❌ Channels endpoint failed: ${msg}`);
}

// ─── 6. Summary ────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════');
console.log('📊 Validation Complete');
console.log('═══════════════════════════════════════════════════\n');
