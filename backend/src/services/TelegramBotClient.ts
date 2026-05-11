/**
 * TelegramBotClient
 * Minimal Bot API client for sending messages to supergroup topics.
 */

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
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(token?: string) {
    this.token = token || Bun.env.TELEGRAM_BOT_TOKEN || '';
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
  }

  get isConfigured(): boolean {
    return this.token.length > 0;
  }

  async sendMessage(opts: TelegramMessageOptions): Promise<TelegramApiResponse> {
    if (!this.isConfigured) {
      throw new Error('Telegram bot token not configured (TELEGRAM_BOT_TOKEN)');
    }

    const response = await fetch(`${this.baseUrl}/sendMessage`, {
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

  /**
   * Verify a chat/topic exists by attempting to get chat info.
   */
  async getChat(chatId: string | number): Promise<TelegramApiResponse<{ id: number; title?: string }>> {
    if (!this.isConfigured) {
      throw new Error('Telegram bot token not configured');
    }

    const response = await fetch(`${this.baseUrl}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
    });

    return (await response.json().catch(() => ({ ok: false }))) as TelegramApiResponse<{ id: number; title?: string }>;
  }
}
