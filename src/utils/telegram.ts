import fetch from "node-fetch";
import { readFile } from "fs/promises";
import { basename } from "path";

const TELEGRAM_MAX_MESSAGE_LENGTH = 4000;

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    date: number;
    chat: {
      id: number;
      type: string;
    };
    from?: {
      id: number;
      is_bot: boolean;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
  };
}

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

  getChatId(): string {
    return this.chatId;
  }

  send(text: string): void {
    if (!this.enabled || !text.trim()) return;

    void this.enqueue(() => this.sendAll(text));
  }

  async sendDocument(filePath: string, caption?: string): Promise<void> {
    if (!this.enabled || !filePath.trim()) return;

    await this.enqueue(async () => {
      await this.sendDocumentMessage(filePath, caption);
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue
      .then(task)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Telegram] ${message}`);
      });

    return this.queue;
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

  private async sendDocumentMessage(filePath: string, caption?: string): Promise<void> {
    const endpoint = `https://api.telegram.org/bot${this.token}/sendDocument`;
    const fileBytes = await readFile(filePath);

    const form = new FormData();
    form.append("chat_id", this.chatId);
    form.append("document", new Blob([fileBytes]), basename(filePath));

    if (caption && caption.trim().length > 0) {
      form.append("caption", caption.trim().slice(0, 900));
    }

    const response = await fetch(endpoint, {
      method: "POST",
      body: form,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram sendDocument failed with HTTP ${response.status}: ${body}`);
    }
  }

  async getUpdates(offset?: number, timeoutSec = 0): Promise<TelegramUpdate[]> {
    if (!this.enabled) {
      return [];
    }

    const endpoint = `https://api.telegram.org/bot${this.token}/getUpdates`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        offset,
        timeout: timeoutSec,
        allowed_updates: ["message"],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram getUpdates failed with HTTP ${response.status}: ${body}`);
    }

    const payload = (await response.json()) as {
      ok?: boolean;
      result?: TelegramUpdate[];
      description?: string;
    };

    if (!payload.ok) {
      throw new Error(`Telegram getUpdates failed: ${payload.description || "Unknown error"}`);
    }

    return Array.isArray(payload.result) ? payload.result : [];
  }
}

export default TelegramNotifier;