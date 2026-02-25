import { describe, it, expect } from "vitest";
import fetch from "node-fetch";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";

const runLive = process.env.RUN_LIVE_API_TEST === "true";
const describeLive = runLive ? describe : describe.skip;

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function loadEnvFile(): Record<string, string> {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return {};
  }

  const raw = readFileSync(envPath, "utf8");
  return parse(raw);
}

describeLive("Gemini endpoint live check", () => {
  it(
    "should return a valid generateContent response from gemini-3-pro-preview",
    async () => {
      const fileEnv = loadEnvFile();
      const apiKey = fileEnv.GEMINI_API_KEY || process.env.GEMINI_API_KEY || "";
      const baseUrl = fileEnv.GEMINI_API_BASE_URL || process.env.GEMINI_API_BASE_URL || "https://v98store.com/v1beta";
      const model = "gemini-3-pro-preview";

      if (!apiKey || apiKey.includes("your-") || apiKey.includes("test-")) {
        throw new Error("Live test requires a real GEMINI_API_KEY in .env or environment");
      }

      const endpoint = `${baseUrl.replace(/\/$/, "")}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const payload = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Reply with exactly one short word: pong" }],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 32,
        },
      };

      let lastStatus = 0;
      let lastBody = "";

      for (let attempt = 1; attempt <= 3; attempt++) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        const text = await response.text();
        lastStatus = response.status;
        lastBody = text;

        if (response.ok) {
          const data = JSON.parse(text) as {
            candidates?: Array<{
              content?: {
                parts?: Array<{ text?: string }>;
              };
            }>;
          };

          const outputText =
            data.candidates?.[0]?.content?.parts
              ?.map((part) => part.text || "")
              .join("\n")
              .trim() || "";

          expect(data.candidates?.length).toBeGreaterThan(0);
          expect(outputText.length).toBeGreaterThan(0);
          return;
        }

        if (response.status === 429 && attempt < 3) {
          await sleep(attempt * 1500);
          continue;
        }

        break;
      }

      throw new Error(`Live endpoint check failed with status ${lastStatus}: ${lastBody.slice(0, 400)}`);
    },
    60000
  );
});
