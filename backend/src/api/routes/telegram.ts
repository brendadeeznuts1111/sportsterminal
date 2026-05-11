/**
 * Telegram Topics & Channels Routes
 *
 * Supports dual topic classes:
 *   - System Internal: terminal ops visibility (#risk-alerts, #service-health, etc.)
 *   - Agent Facing: per-agent player management (#alerts, #approvals, etc.)
 *
 * Query params:
 *   ?purpose=agent    → agent-facing topics only
 *   ?purpose=system   → system-internal topics only
 *   ?purpose=all      → both (default)
 */
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';
import { TelegramTopicService } from '../../services/TelegramTopicService';
import { logger } from '../../utils/logger';
import { corsHeaders, handleAsync } from '../helpers';

interface TelegramTopic {
  id: number;
  agent_login: string | null;
  topic_name: string;
  purpose: string;
  topic_icon: string | null;
  topic_hex_color: string | null;
  topic_icon_color: number | null;
  topic_thread_id: number;
  supergroup_chat_id: string;
  supergroup_purpose: string;
  is_managed: number;
  created_at: string;
}

interface TelegramChannel {
  id: number;
  channel_name: string;
  channel_type: string;
  purpose: string | null;
  is_active: number;
  telegram_chat_id: string | null;
  created_at: string;
  updated_at: string;
}

function parsePurposeParam(url: URL): 'agent' | 'system' | 'all' {
  const raw = url.searchParams.get('purpose');
  if (raw === 'agent' || raw === 'system') return raw;
  return 'all';
}

export function registerTelegramTopicsRoutes(
  url: URL,
  _request: Request,
  scraperManager: BuckeyeScraperManager
): Response | Promise<Response> | null {
  if (url.pathname !== '/api/telegram/topics') return null;

  const purposeFilter = parsePurposeParam(url);
  logger.info(`GET /api/telegram/topics?purpose=${purposeFilter}`);

  return handleAsync(async () => {
    const db = scraperManager.getDatabase();
    const service = new TelegramTopicService(db);

    // Primary source: new agent_supergroup_topics table
    const topics = await service.getTopics(purposeFilter);

    // Fallback: legacy telegram_topics for backwards compatibility
    const legacyTopics = await db.all<{
      id: number;
      agent_login: string;
      topic_name: string;
      purpose: string | null;
      topic_icon: string | null;
      topic_hex_color: string | null;
      topic_icon_color: number | null;
      topic_thread_id: number | null;
      supergroup_chat_id: string | null;
      created_at: string;
    }>(
      `SELECT * FROM telegram_topics
       WHERE supergroup_chat_id IS NOT NULL AND topic_thread_id IS NOT NULL
       ORDER BY agent_login, topic_name`
    );

    // Merge legacy topics that aren't already in the new table
    const merged: TelegramTopic[] = topics.map((t) => ({
      id: t.id,
      agent_login: t.owner_agent_login,
      topic_name: t.topic_name,
      purpose: t.purpose,
      topic_icon: t.topic_icon,
      topic_hex_color: t.topic_hex_color,
      topic_icon_color: null,
      topic_thread_id: t.topic_thread_id,
      supergroup_chat_id: t.supergroup_chat_id,
      supergroup_purpose: t.supergroup_purpose,
      is_managed: t.is_managed,
      created_at: t.created_at,
    }));

    const knownThreadIds = new Set(merged.map((t) => `${t.supergroup_chat_id}:${t.topic_thread_id}`));

    for (const lt of legacyTopics) {
      const key = `${lt.supergroup_chat_id}:${lt.topic_thread_id}`;
      if (!knownThreadIds.has(key)) {
        merged.push({
          id: lt.id,
          agent_login: lt.agent_login,
          topic_name: lt.topic_name,
          purpose: lt.purpose || 'unknown',
          topic_icon: lt.topic_icon,
          topic_hex_color: lt.topic_hex_color,
          topic_icon_color: lt.topic_icon_color,
          topic_thread_id: lt.topic_thread_id ?? -1,
          supergroup_chat_id: lt.supergroup_chat_id ?? '',
          supergroup_purpose: 'agent',
          is_managed: 1,
          created_at: lt.created_at,
        });
      }
    }

    // Filter by purpose if requested (legacy topics default to 'agent')
    const filtered = purposeFilter === 'all'
      ? merged
      : merged.filter((t) => t.supergroup_purpose === purposeFilter || (purposeFilter === 'agent' && t.supergroup_purpose === 'agent'));

    return {
      topics: filtered,
      count: filtered.length,
      filter: purposeFilter,
    };
  }, corsHeaders);
}

export function registerTelegramChannelsRoutes(
  url: URL,
  _request: Request,
  scraperManager: BuckeyeScraperManager
): Response | Promise<Response> | null {
  if (url.pathname !== '/api/telegram/channels') return null;

  logger.info('GET /api/telegram/channels');

  return handleAsync(async () => {
    const db = scraperManager.getDatabase();
    const channels = await db.all(
      'SELECT * FROM telegram_channels ORDER BY channel_name'
    ) as TelegramChannel[];

    return {
      channels,
      count: channels.length,
    };
  }, corsHeaders);
}
