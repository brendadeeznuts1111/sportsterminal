/**
 * TelegramBotClient
 * Minimal Bot API client for sending messages to supergroup topics.
 * Reads token from bun:secrets (OS keychain) using the shared service namespace.
 */
import { getCredential } from './secrets';

export interface TelegramMessageOptions {
  chat_id: string | number;
  message_thread_id?: number;
  text: string;
  parse_mode?: 'Markdown' | 'HTML' | 'MarkdownV2';
  disable_notification?: boolean;
}

export interface TelegramApiResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export class TelegramBotClient {
  private token: string | null = null;
  private baseUrl: string | null = null;
  private initialized = false;

  constructor(token?: string) {
    this.token = token || Bun.env.TELEGRAM_BOT_TOKEN || null;
  }

  /**
   * Resolve token from env or OS keychain (bun:secrets).
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.token) {
      this.token = await getCredential('telegram-bot-token');
    }
    if (this.token) {
      this.baseUrl = `https://api.telegram.org/bot${this.token}`;
    }
    this.initialized = true;
  }

  get isConfigured(): boolean {
    return Boolean(this.token && this.baseUrl);
  }

  private getBaseUrl(): string {
    if (!this.baseUrl) throw new Error('TelegramBotClient not initialized');
    return this.baseUrl;
  }

  async sendMessage(opts: TelegramMessageOptions): Promise<TelegramApiResponse> {
    await this.init();
    if (!this.isConfigured) {
      throw new Error('Telegram bot token not configured');
    }

    const response = await fetch(`${this.getBaseUrl()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: opts.chat_id,
        message_thread_id: opts.message_thread_id,
        text: opts.text,
        parse_mode: opts.parse_mode || 'Markdown',
        disable_notification: opts.disable_notification ?? false,
      }),
    });

    const data = await response.json().catch(() => ({
      ok: false,
      description: `HTTP ${response.status}`,
    }));

    return data as TelegramApiResponse;
  }

  async getChat(chatId: string | number): Promise<TelegramApiResponse<{ id: number; title?: string }>> {
    await this.init();
    if (!this.isConfigured) {
      throw new Error('Telegram bot token not configured');
    }

    const response = await fetch(`${this.getBaseUrl()}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
    });

    return (await response.json().catch(() => ({ ok: false }))) as TelegramApiResponse<{ id: number; title?: string }>;
  }

  async pinChatMessage(
    chatId: string | number,
    messageId: number,
    messageThreadId?: number,
    disableNotification?: boolean
  ): Promise<TelegramApiResponse> {
    await this.init();
    if (!this.isConfigured) {
      throw new Error('Telegram bot token not configured');
    }

    const response = await fetch(`${this.getBaseUrl()}/pinChatMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        message_thread_id: messageThreadId,
        disable_notification: disableNotification ?? false,
      }),
    });

    return (await response.json().catch(() => ({ ok: false, description: `HTTP ${response.status}` }))) as TelegramApiResponse;
  }

  async unpinChatMessage(chatId: string | number, messageId?: number): Promise<TelegramApiResponse> {
    await this.init();
    if (!this.isConfigured) {
      throw new Error('Telegram bot token not configured');
    }

    const response = await fetch(`${this.getBaseUrl()}/unpinChatMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
      }),
    });

    return (await response.json().catch(() => ({ ok: false, description: `HTTP ${response.status}` }))) as TelegramApiResponse;
  }

  async createForumTopic(
    chatId: string | number,
    name: string,
    iconColor?: number,
    iconCustomEmojiId?: string
  ): Promise<TelegramApiResponse<{ message_thread_id: number; name: string }>> {
    await this.init();
    if (!this.isConfigured) {
      throw new Error('Telegram bot token not configured');
    }

    const body: Record<string, unknown> = { chat_id: chatId, name };
    if (iconColor !== undefined) body.icon_color = iconColor;
    if (iconCustomEmojiId !== undefined) body.icon_custom_emoji_id = iconCustomEmojiId;

    const response = await fetch(`${this.getBaseUrl()}/createForumTopic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    return (await response.json().catch(() => ({ ok: false }))) as TelegramApiResponse<{ message_thread_id: number; name: string }>;
  }

  async getForumTopicIconStickers(): Promise<TelegramApiResponse<unknown[]>> {
    await this.init();
    if (!this.isConfigured) {
      throw new Error('Telegram bot token not configured');
    }

    const response = await fetch(`${this.getBaseUrl()}/getForumTopicIconStickers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    return (await response.json().catch(() => ({ ok: false }))) as TelegramApiResponse<unknown[]>;
  }
}
