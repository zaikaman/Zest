import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "fs";
import { LLMClient } from "../src/llm/client.js";
import { cleanupProject } from "../src/tools/projectBuilder.js";

function mockChatCompletion(content: string) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: () => null,
    },
    text: async () =>
      JSON.stringify({
        id: "req_test",
        object: "chat.completion",
        model: "gemini-3-flash-preview",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
        },
      }),
  } as unknown as Response;
}

describe("LLMClient text-json tool protocol", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_API_BASE_URL = "https://ezaiapi.com/v1";
    process.env.GEMINI_MODEL = "gemini-3-flash-preview";
    process.env.LLM_TOOL_CALLING_MODE = "text-json";
    process.env.TOOL_CODE_INTERPRETER_ENABLED = "true";
    process.env.TOOL_WEB_SEARCH_ENABLED = "false";
    process.env.TOOL_CALCULATOR_ENABLED = "false";
    process.env.SOLANA_WALLET_ADDRESS = "TestWalletAddress12345678901234567890";

    vi.mocked(global.fetch).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("continues after tool execution error instead of failing the job", async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        mockChatCompletion(
          '{"type":"tool_calls","calls":[{"name":"edit_file","args":{"path":"README.md","search":"old","replace":"new"}}]}'
        )
      )
      .mockResolvedValueOnce(mockChatCompletion('{"type":"final","text":"Recovered successfully"}'));

    const llm = new LLMClient();
    const result = await llm.generate({
      prompt: "build a project",
      tools: true,
    });

    expect(result.text).toContain("Recovered successfully");
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls?.[0]?.name).toBe("edit_file");

    const firstToolResult = result.toolCalls?.[0]?.result as { error?: string } | undefined;
    expect(firstToolResult?.error).toBeTruthy();
    expect(firstToolResult?.error?.toLowerCase()).toContain("no files have been created");
  });

  it("auto-finalizes generated files and returns project build metadata", async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        mockChatCompletion(
          '{"type":"tool_calls","calls":[{"name":"create_file","args":{"path":"README.md","content":"# test"}}]}'
        )
      )
      .mockResolvedValueOnce(
        mockChatCompletion('{"type":"final","text":"Project scaffold prepared."}')
      );

    const llm = new LLMClient();
    const result = await llm.generate({
      prompt: "build a tiny project",
      tools: true,
    });

    expect(result.projectBuild?.success).toBe(true);
    expect(result.projectBuild?.workspaceProjectDir).toBeTruthy();
    expect(result.projectBuild?.workspaceProjectDir ? existsSync(result.projectBuild.workspaceProjectDir) : false).toBe(
      true
    );

    if (result.projectBuild?.projectDir) {
      cleanupProject(result.projectBuild.projectDir, result.projectBuild.zipPath);
    }
  });
});
