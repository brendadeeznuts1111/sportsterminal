/**
 * setup-telegram.ts
 * Idempotent topic setup for SportsTerminalMega supergroup.
 * Creates system topics if they don't exist and stores thread IDs in bun:secrets.
 *
 * Usage:
 *   TELEGRAM_SYSTEM_CHAT_ID=-1001234567890 bun run scripts/setup-telegram.ts
 */
import { TelegramBotClient } from '../src/services/TelegramBotClient';
import { TelegramTopicService } from '../src/services/TelegramTopicService';
import { getCredential, setCredential } from '../src/services/secrets';
import { initDatabase } from '../src/database';

interface TopicDef {
  name: string;
  iconColor: number;
  purpose: string;
  secretName: string;
}

const TOPIC_DEFS: TopicDef[] = [
  { name: 'Risk Alerts', iconColor: 0xef4444, purpose: 'risk_alerts', secretName: 'telegram-topic-risk-alerts' },
  { name: 'Webhook Events', iconColor: 0xf59e0b, purpose: 'webhook_events', secretName: 'telegram-topic-webhook-events' },
  { name: 'Service Health', iconColor: 0x3b82f6, purpose: 'service_health', secretName: 'telegram-topic-service-health' },
  { name: 'Domain & DNS', iconColor: 0x22c55e, purpose: 'domain_dns', secretName: 'telegram-topic-domain-dns' },
  { name: 'Analytics', iconColor: 0x8b5cf6, purpose: 'analytics', secretName: 'telegram-topic-analytics' },
  { name: 'Bot & Mini App', iconColor: 0x06b6d4, purpose: 'bot_miniapp', secretName: 'telegram-topic-bot-miniapp' },
];

async function resolveSystemChatId(): Promise<string> {
  const configured = Bun.env.TELEGRAM_SYSTEM_CHAT_ID || await getCredential('telegram-chat-id');
  const chatId = configured?.trim();
  if (!chatId) {
    throw new Error('Set TELEGRAM_SYSTEM_CHAT_ID or store telegram-chat-id in bun:secrets before running setup.');
  }
  return chatId;
}

async function main() {
  const db = await initDatabase();
  const topicService = new TelegramTopicService(db);
  const client = new TelegramBotClient();
  await client.init();
  const chatId = await resolveSystemChatId();

  if (!client.isConfigured) {
    console.error('TELEGRAM_BOT_TOKEN not configured in env or bun:secrets');
    process.exit(1);
  }

  // Save system chat ID
  const existingChatId = await getCredential('telegram-chat-id');
  if (!existingChatId) {
    await setCredential('telegram-chat-id', chatId);
    console.log(`Saved telegram-chat-id = ${chatId}`);
  }

  // Ensure system supergroup exists in DB
  await topicService.ensureSystemSupergroup(chatId);

  const results: Array<{ name: string; message_thread_id: number; action: 'created' | 'existing' | 'error' }> = [];

  for (const def of TOPIC_DEFS) {
    // 1. Check if thread ID already stored in secrets
    const existingThreadId = await getCredential(def.secretName);
    if (existingThreadId) {
      const parsed = parseInt(existingThreadId, 10);
      if (Number.isFinite(parsed)) {
        console.log(`"${def.name}" already stored (thread_id=${parsed})`);
        results.push({ name: def.name, message_thread_id: parsed, action: 'existing' });
        continue;
      }
    }

    // 2. Check if topic exists in DB
    const dbTopic = await topicService.findTopicByPurpose(chatId, def.purpose);
    if (dbTopic && dbTopic.topic_thread_id > 0) {
      await setCredential(def.secretName, String(dbTopic.topic_thread_id));
      console.log(`"${def.name}" synced from DB (thread_id=${dbTopic.topic_thread_id})`);
      results.push({ name: def.name, message_thread_id: dbTopic.topic_thread_id, action: 'existing' });
      continue;
    }

    // 3. Try to create via Telegram API (idempotent — will fail if exists)
    try {
      const res = await client.createForumTopic(chatId, def.name, def.iconColor);
      if (res.ok && res.result?.message_thread_id) {
        await setCredential(def.secretName, String(res.result.message_thread_id));
        // Also save to DB
        await topicService.ensureTopic({
          supergroup_chat_id: chatId,
          topic_name: def.name,
          purpose: def.purpose,
        });
        const ensured = await topicService.findTopicByPurpose(chatId, def.purpose);
        if (ensured) {
          await topicService.updateTopicThreadId(ensured.id, res.result.message_thread_id);
        }
        console.log(`"${def.name}" created (thread_id=${res.result.message_thread_id})`);
        results.push({ name: def.name, message_thread_id: res.result.message_thread_id, action: 'created' });
      } else {
        console.error(`"${def.name}" create failed: ${res.description || 'unknown'}`);
        results.push({ name: def.name, message_thread_id: -1, action: 'error' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If topic already exists, Telegram returns "The topic was already created"
      if (msg.includes('already created') || msg.includes('already exists')) {
        console.log(`"${def.name}" already exists in Telegram (skipped)`);
        results.push({ name: def.name, message_thread_id: -1, action: 'existing' });
      } else {
        console.error(`"${def.name}" error: ${msg}`);
        results.push({ name: def.name, message_thread_id: -1, action: 'error' });
      }
    }
  }

  console.log('\nSetup complete');
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
