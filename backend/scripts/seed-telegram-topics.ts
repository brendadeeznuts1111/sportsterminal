/**
 * Seed Telegram Topics
 *
 * Sends a welcome/setup message to every topic and pins it.
 * Run with: bun run backend/scripts/seed-telegram-topics.ts
 */
import { Database } from '../src/database';
import { TelegramBotClient } from '../src/services/TelegramBotClient';
import { TelegramTopicService } from '../src/services/TelegramTopicService';

async function main() {
  const dbPath = process.env.DATABASE_URL || 'sqlite:./data/terminal.db';
  const db = new Database(dbPath);
  await db.connect();

  const service = new TelegramTopicService(db);
  const client = new TelegramBotClient();

  if (!client.isConfigured) {
    console.error('❌ TELEGRAM_BOT_TOKEN not set. Export it first.');
    process.exit(1);
  }

  const topics = await service.getTopics('all');
  console.log(`🚀 Seeding ${topics.length} topic(s)\n`);

  let sent = 0;
  let pinned = 0;
  let skipped = 0;

  for (const t of topics) {
    if (t.topic_thread_id <= 0) {
      console.log(`⏭  [${t.topic_name}] skipped — no thread_id`);
      skipped++;
      continue;
    }

    const welcomeText = [
      `⚙️ *Sports Terminal* connected to **${t.topic_name}**`,
      '',
      `Purpose: \`${t.purpose}\``,
      `Thread ID: \`${t.topic_thread_id}\``,
      '',
      `_Messages sent from the terminal will appear here. Pin this message for quick reference._`,
    ].join('\n');

    try {
      const res = await client.sendMessage({
        chat_id: t.supergroup_chat_id,
        message_thread_id: t.topic_thread_id,
        text: welcomeText,
        parse_mode: 'Markdown',
        disable_notification: true,
      });

      if (!res.ok) {
        console.error(`❌ [${t.topic_name}] send failed: ${res.description}`);
        continue;
      }

      const telegramMessageId =
        res.result && typeof res.result === 'object' && 'message_id' in res.result
          ? Number((res.result as Record<string, unknown>).message_id)
          : null;

      if (telegramMessageId) {
        await client.pinChatMessage(t.supergroup_chat_id, telegramMessageId, t.topic_thread_id, true);
        pinned++;
      }

      await service.storeMessage(
        t.id,
        telegramMessageId,
        welcomeText,
        'bot',
        'Markdown',
        true
      );

      sent++;
      console.log(`✅ [${t.topic_name}] sent + pinned (msg ${telegramMessageId})`);
    } catch (err) {
      console.error(`❌ [${t.topic_name}] error: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\n📊 Done — sent ${sent}, pinned ${pinned}, skipped ${skipped}`);
  await db.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
