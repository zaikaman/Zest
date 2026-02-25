import { config as loadEnv } from "dotenv";

loadEnv();

const apiKey = process.env.GEMINI_API_KEY;
const baseUrl = (process.env.GEMINI_API_BASE_URL || "https://v98store.com/v1beta").replace(/\/$/, "");
const model = process.env.GEMINI_MODEL || "gemini-3-pro-preview";

if (!apiKey) {
  console.error("Missing GEMINI_API_KEY in environment");
  process.exit(1);
}

const endpoint = `${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

const cases = [
  {
    name: "plain_text",
    payload: {
      contents: [{ role: "user", parts: [{ text: "Reply with pong" }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 32 },
    },
  },
  {
    name: "with_system_instruction",
    payload: {
      systemInstruction: { parts: [{ text: "You are a concise coding assistant." }] },
      contents: [{ role: "user", parts: [{ text: "Reply with pong" }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 32 },
    },
  },
  {
    name: "with_tools_declarations",
    payload: {
      contents: [{ role: "user", parts: [{ text: "What is 2+2? You may use tools." }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: "calculator",
              description: "Evaluate a mathematical expression.",
              parameters: {
                type: "OBJECT",
                properties: {
                  expression: {
                    type: "STRING",
                    description: "Math expression",
                  },
                },
                required: ["expression"],
              },
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: { mode: "AUTO" },
      },
      generationConfig: { temperature: 0, maxOutputTokens: 64 },
    },
  },
  {
    name: "with_tool_response_turn",
    payload: {
      contents: [
        { role: "user", parts: [{ text: "Use calculator tool for 2+2" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "calculator",
                args: { expression: "2+2" },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "calculator",
                response: { result: 4 },
              },
            },
          ],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: "calculator",
              description: "Evaluate a mathematical expression.",
              parameters: {
                type: "OBJECT",
                properties: {
                  expression: {
                    type: "STRING",
                    description: "Math expression",
                  },
                },
                required: ["expression"],
              },
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: { mode: "AUTO" },
      },
      generationConfig: { temperature: 0, maxOutputTokens: 64 },
    },
  },
  {
    name: "function_response_role_tool",
    payload: {
      contents: [
        { role: "user", parts: [{ text: "Use calculator tool for 2+2" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "calculator",
                args: { expression: "2+2" },
              },
            },
          ],
        },
        {
          role: "tool",
          parts: [
            {
              functionResponse: {
                name: "calculator",
                response: { result: 4 },
              },
            },
          ],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: "calculator",
              description: "Evaluate a mathematical expression.",
              parameters: {
                type: "OBJECT",
                properties: {
                  expression: {
                    type: "STRING",
                    description: "Math expression",
                  },
                },
                required: ["expression"],
              },
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: { mode: "AUTO" },
      },
      generationConfig: { temperature: 0, maxOutputTokens: 64 },
    },
  },
  {
    name: "model_function_call_without_response",
    payload: {
      contents: [
        { role: "user", parts: [{ text: "Use calculator tool for 2+2" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "calculator",
                args: { expression: "2+2" },
              },
            },
          ],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: "calculator",
              description: "Evaluate a mathematical expression.",
              parameters: {
                type: "OBJECT",
                properties: {
                  expression: {
                    type: "STRING",
                    description: "Math expression",
                  },
                },
                required: ["expression"],
              },
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: { mode: "AUTO" },
      },
      generationConfig: { temperature: 0, maxOutputTokens: 64 },
    },
  },
  {
    name: "simulated_tool_result_as_text",
    payload: {
      contents: [
        { role: "user", parts: [{ text: "Use calculator tool for 2+2" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "calculator",
                args: { expression: "2+2" },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              text: "Tool result: calculator returned 4. Continue and give final answer.",
            },
          ],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: "calculator",
              description: "Evaluate a mathematical expression.",
              parameters: {
                type: "OBJECT",
                properties: {
                  expression: {
                    type: "STRING",
                    description: "Math expression",
                  },
                },
                required: ["expression"],
              },
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: { mode: "AUTO" },
      },
      generationConfig: { temperature: 0, maxOutputTokens: 64 },
    },
  },
  {
    name: "function_response_without_model_turn",
    payload: {
      contents: [
        { role: "user", parts: [{ text: "Use calculator tool for 2+2" }] },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "calculator",
                response: { result: 4 },
              },
            },
          ],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: "calculator",
              description: "Evaluate a mathematical expression.",
              parameters: {
                type: "OBJECT",
                properties: {
                  expression: {
                    type: "STRING",
                    description: "Math expression",
                  },
                },
                required: ["expression"],
              },
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: { mode: "AUTO" },
      },
      generationConfig: { temperature: 0, maxOutputTokens: 64 },
    },
  },
];

async function runCase(testCase) {
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(testCase.payload),
  });
  const text = await response.text();
  const elapsedMs = Date.now() - started;

  return {
    name: testCase.name,
    status: response.status,
    ok: response.ok,
    elapsedMs,
    bodyPreview: text.slice(0, 500),
  };
}

async function main() {
  console.log(`Endpoint: ${baseUrl}/models/${model}:generateContent`);
  console.log(`Cases: ${cases.length}`);

  for (const testCase of cases) {
    try {
      const result = await runCase(testCase);
      console.log("\n---");
      console.log(`Case: ${result.name}`);
      console.log(`Status: ${result.status} | OK: ${result.ok} | Time: ${result.elapsedMs}ms`);
      console.log(`Body: ${result.bodyPreview}`);
    } catch (error) {
      console.log("\n---");
      console.log(`Case: ${testCase.name}`);
      console.log(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

main();
