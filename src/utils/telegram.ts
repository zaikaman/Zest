import fetch from "node-fetch";

export class TelegramNotifier {
  private readonly enabled: boolean;
  private readonly token: string;
  private readonly chatId: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(token: string, chatId: string, enabled: boolean) {
    this.token = token;
    this.chatId = chatId;
    this.enabled = enabled && token.length > 0 && chatId.length > 0;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  send(text: string): void {
    if (!this.enabled || !text.trim()) return;

    this.queue = this.queue
      .then(() => this.sendMessage(text))
      .catch(() => {
        return;
      });
  }

  private async sendMessage(text: string): Promise<void> {
    const endpoint = `https://api.telegram.org/bot${this.token}/sendMessage`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram send failed with HTTP ${response.status}`);
    }
  }
}

export default TelegramNotifier;