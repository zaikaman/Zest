import fetch from "node-fetch";

const TELEGRAM_MAX_MESSAGE_LENGTH = 4000;

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
      .then(() => this.sendAll(text))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Telegram] ${message}`);
      });
  }

  private splitMessage(text: string): string[] {
    if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
      return [text];
    }

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + TELEGRAM_MAX_MESSAGE_LENGTH, text.length);
      chunks.push(text.slice(start, end));
      start = end;
    }

    return chunks;
  }

  private async sendAll(text: string): Promise<void> {
    const chunks = this.splitMessage(text);

    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n` : "";
      await this.sendMessage(`${prefix}${chunks[i]}`);
    }
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
      const body = await response.text();
      throw new Error(`Telegram send failed with HTTP ${response.status}: ${body}`);
    }
  }
}

export default TelegramNotifier;