// alert-telegram-enhanced/scripts/send-alert.ts
// Sends rich Telegram alerts with inline keyboards for risk actions.

interface AlertInput {
  agent_id: string;
  alerts: string[];
  risk_score?: number;
  timestamp?: number;
}

interface AlertResult {
  delivered: boolean;
  message_id?: number;
  error?: string;
}

export default async function sendAlert(input: AlertInput): Promise<AlertResult> {
  const botToken = process.env["telegram_bot_token"];
  const chatId = process.env["telegram_chat_id"];

  if (!botToken || !chatId) {
    return { delivered: false, error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured" };
  }

  const { agent_id, alerts, risk_score = 0, timestamp = Date.now() } = input;

  // Build rich message with emoji indicators
  const riskEmoji = risk_score > 70 ? "🔴" : risk_score > 40 ? "🟡" : "🟢";
  const timeStr = new Date(timestamp).toISOString().replace("T", " ").slice(0, 19);

  const message = [
    `${riskEmoji} *Risk Alert — Agent ${agent_id}*`,
    `⏰ _${timeStr}_`,
    `📊 Risk Score: \`${risk_score}/100\``,
    "",
    ...alerts.map((a, i) => `  ${i + 1}. ${a}`),
  ].join("\n");

  // Inline keyboard with actions
  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: "📋 View Player", url: `https://fantasy402.com/manager.html#player=${agent_id}` },
        { text: "📊 Dashboard", callback_data: `dashboard_${agent_id}` },
      ],
      [
        { text: "🚫 Limit Wagers", callback_data: `limit_${agent_id}` },
        { text: "🔍 Investigate", callback_data: `investigate_${agent_id}` },
      ],
    ],
  };

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "Markdown",
          reply_markup: inlineKeyboard,
        }),
      },
    );

    const data = (await response.json()) as {
      ok: boolean;
      result?: { message_id: number };
      description?: string;
    };

    if (!data.ok) {
      return { delivered: false, error: data.description || "Telegram API error" };
    }

    return {
      delivered: true,
      message_id: data.result?.message_id,
    };
  } catch (err) {
    return {
      delivered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
