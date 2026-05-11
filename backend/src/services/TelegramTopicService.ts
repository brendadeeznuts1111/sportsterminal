/**
 * TelegramTopicService
 * Idempotent topic management for Telegram supergroups.
 * Prevents duplicate topic creation and syncs remote topics into the database.
 */

import type { Database } from '../database';

export interface TelegramTopic {
  id: number;
  supergroup_id: number;
  topic_thread_id: number;
  topic_name: string;
  purpose: string;
  topic_icon: string | null;
  topic_hex_color: string | null;
  is_managed: number;
  created_at: string;
}

export interface AgentSupergroup {
  id: number;
  supergroup_chat_id: string;
  owner_agent_login: string | null;
  purpose: string;
  created_at: string;
}

export interface EnsureTopicInput {
  supergroup_chat_id: string;
  owner_agent_login?: string | null;
  topic_name: string;
  purpose: string;
  topic_icon?: string | null;
  topic_hex_color?: string | null;
}

export interface SyncTopicInput {
  thread_id: number;
  name: string;
  icon_color?: number;
  icon_custom_emoji_id?: string;
}

export class TelegramTopicService {
  constructor(private readonly db: Database) { }

  /**
   * Ensure a topic exists in the database.
   * If it doesn't exist, insert it (but do NOT call Telegram API here).
   * Returns the existing or newly-inserted topic row.
   */
  async ensureTopic(input: EnsureTopicInput): Promise<TelegramTopic> {
    // Ensure supergroup exists
    const supergroup = await this.db.get<AgentSupergroup>(
      `SELECT * FROM agent_supergroups WHERE supergroup_chat_id = ?`,
      [input.supergroup_chat_id]
    );

    let supergroupId: number;
    if (supergroup) {
      supergroupId = supergroup.id;
      // Update owner_agent_login if provided and currently null
      if (input.owner_agent_login && !supergroup.owner_agent_login) {
        await this.db.run(
          `UPDATE agent_supergroups SET owner_agent_login = ? WHERE id = ?`,
          [input.owner_agent_login, supergroupId]
        );
      }
    } else {
      const result = await this.db.run(
        `INSERT INTO agent_supergroups (supergroup_chat_id, owner_agent_login, purpose)
         VALUES (?, ?, ?)`,
        [input.supergroup_chat_id, input.owner_agent_login ?? null, 'agent']
      );
      supergroupId = result.lastID as number;
    }

    // Check for existing topic by purpose within this supergroup
    const existing = await this.db.get<TelegramTopic>(
      `SELECT * FROM agent_supergroup_topics
       WHERE supergroup_id = ? AND purpose = ?`,
      [supergroupId, input.purpose]
    );

    if (existing) {
      return existing;
    }

    // Insert new topic (thread_id will be set later by the caller after Telegram API creation)
    const result = await this.db.run(
      `INSERT INTO agent_supergroup_topics
       (supergroup_id, topic_thread_id, topic_name, purpose, topic_icon, topic_hex_color, is_managed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        supergroupId,
        -1, // placeholder until Telegram API returns real thread_id
        input.topic_name,
        input.purpose,
        input.topic_icon ?? null,
        input.topic_hex_color ?? null,
        1,
      ]
    );

    const inserted = await this.db.get<TelegramTopic>(
      `SELECT * FROM agent_supergroup_topics WHERE id = ?`,
      [result.lastID]
    );

    if (!inserted) {
      throw new Error(`Failed to insert topic: ${input.topic_name}`);
    }

    return inserted;
  }

  /**
   * Update a topic's thread_id after successful Telegram API creation.
   */
  async updateTopicThreadId(topicId: number, threadId: number): Promise<void> {
    await this.db.run(
      `UPDATE agent_supergroup_topics SET topic_thread_id = ? WHERE id = ?`,
      [threadId, topicId]
    );
  }

  /**
   * Sync remote topics from Telegram into the database.
   * Adds missing rows but never deletes.
   */
  async syncTopics(supergroupChatId: string, remoteTopics: SyncTopicInput[]): Promise<{ added: number; existing: number }> {
    const supergroup = await this.db.get<AgentSupergroup>(
      `SELECT id FROM agent_supergroups WHERE supergroup_chat_id = ?`,
      [supergroupChatId]
    );

    if (!supergroup) {
      throw new Error(`Supergroup ${supergroupChatId} not found in database`);
    }

    const existingTopics = await this.db.all<{ topic_thread_id: number }>(
      `SELECT topic_thread_id FROM agent_supergroup_topics WHERE supergroup_id = ?`,
      [supergroup.id]
    );
    const existingThreadIds = new Set(existingTopics.map((t) => t.topic_thread_id));

    let added = 0;
    for (const rt of remoteTopics) {
      if (!existingThreadIds.has(rt.thread_id)) {
        await this.db.run(
          `INSERT INTO agent_supergroup_topics
           (supergroup_id, topic_thread_id, topic_name, purpose, topic_icon, topic_hex_color, is_managed)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            supergroup.id,
            rt.thread_id,
            rt.name,
            this.inferPurposeFromName(rt.name),
            rt.icon_custom_emoji_id ?? null,
            rt.icon_color ? this.colorToHex(rt.icon_color) : null,
            1,
          ]
        );
        added++;
      }
    }

    return { added, existing: existingThreadIds.size };
  }

  /**
   * Get topics filtered by purpose.
   * @param purposeFilter 'agent' | 'system' | 'all'
   */
  async getTopics(purposeFilter: 'agent' | 'system' | 'all' = 'all'): Promise<Array<TelegramTopic & { supergroup_chat_id: string; owner_agent_login: string | null; supergroup_purpose: string }>> {
    let whereClause = '';
    const params: unknown[] = [];

    if (purposeFilter === 'agent') {
      whereClause = "WHERE sg.purpose = 'agent'";
    } else if (purposeFilter === 'system') {
      whereClause = "WHERE sg.purpose = 'system_internal'";
    }

    const rows = await this.db.all<
      TelegramTopic & { supergroup_chat_id: string; owner_agent_login: string | null; supergroup_purpose: string }
    >(
      `SELECT
         t.*,
         sg.supergroup_chat_id,
         sg.owner_agent_login,
         sg.purpose AS supergroup_purpose
       FROM agent_supergroup_topics t
       JOIN agent_supergroups sg ON sg.id = t.supergroup_id
       ${whereClause}
       ORDER BY sg.owner_agent_login, t.topic_name`,
      params
    );

    return rows;
  }

  /**
   * Get all supergroups.
   */
  async getSupergroups(): Promise<AgentSupergroup[]> {
    return this.db.all<AgentSupergroup>(
      `SELECT * FROM agent_supergroups ORDER BY purpose, owner_agent_login`
    );
  }

  /**
   * Find a topic by supergroup chat ID and purpose.
   */
  async findTopicByPurpose(supergroupChatId: string, purpose: string): Promise<TelegramTopic | null> {
    return this.db.get<TelegramTopic>(
      `SELECT t.* FROM agent_supergroup_topics t
       JOIN agent_supergroups sg ON sg.id = t.supergroup_id
       WHERE sg.supergroup_chat_id = ? AND t.purpose = ?`,
      [supergroupChatId, purpose]
    );
  }

  /**
   * Create a system-internal supergroup if it doesn't exist.
   */
  async ensureSystemSupergroup(supergroupChatId: string): Promise<AgentSupergroup> {
    const existing = await this.db.get<AgentSupergroup>(
      `SELECT * FROM agent_supergroups WHERE supergroup_chat_id = ?`,
      [supergroupChatId]
    );

    if (existing) {
      if (existing.purpose !== 'system_internal') {
        await this.db.run(
          `UPDATE agent_supergroups SET purpose = 'system_internal' WHERE id = ?`,
          [existing.id]
        );
        existing.purpose = 'system_internal';
      }
      return existing;
    }

    const result = await this.db.run(
      `INSERT INTO agent_supergroups (supergroup_chat_id, owner_agent_login, purpose)
       VALUES (?, ?, ?)`,
      [supergroupChatId, null, 'system_internal']
    );

    const inserted = await this.db.get<AgentSupergroup>(
      `SELECT * FROM agent_supergroups WHERE id = ?`,
      [result.lastID]
    );

    if (!inserted) {
      throw new Error(`Failed to create system supergroup: ${supergroupChatId}`);
    }

    return inserted;
  }

  // ─── Private helpers ───────────────────────────────────────────────────

  private inferPurposeFromName(name: string): string {
    const lower = name.toLowerCase().replace(/^#/, '');
    const purposeMap: Record<string, string> = {
      alerts: 'alerts',
      approvals: 'approvals',
      'daily report': 'daily_report',
      general: 'general',
      'risk alerts': 'risk_alerts',
      'webhook events': 'webhook_events',
      'domain & dns': 'domain_dns',
      analytics: 'analytics',
      'service health': 'service_health',
      cloudflare: 'cloudflare',
    };
    return purposeMap[lower] || lower.replace(/[^a-z0-9]/g, '_');
  }

  private colorToHex(color: number): string {
    return color.toString(16).padStart(6, '0');
  }
}
