import { config as loadEnv } from "dotenv";

loadEnv();

const base = (process.env.GEMINI_API_BASE_URL || "https://v98store.com/v1beta").replace(/\/$/, "");
const model = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
const key = process.env.GEMINI_API_KEY;

if (!key) {
  console.error("Missing GEMINI_API_KEY");
  process.exit(1);
}

const endpoint = `${base}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

const toolDecl = {
  name: "web_search",
  description: "search",
  parameters: {
    type: "OBJECT",
    properties: {
      query: { type: "STRING" },
    },
    required: ["query"],
  },
};

const payload = {
  contents: [
    { role: "user", parts: [{ text: "Use web_search to find top solana protocols" }] },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "web_search",
            response: {
              result: [{ title: "x", url: "u", snippet: "s" }],
            },
          },
        },
      ],
    },
  ],
  tools: [{ functionDeclarations: [toolDecl] }],
  toolConfig: {
    functionCallingConfig: { mode: "AUTO" },
  },
  generationConfig: { temperature: 0, maxOutputTokens: 64 },
};

const response = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const text = await response.text();
console.log("status", response.status);
console.log(text.slice(0, 500));
