import { z, type ZodTypeAny } from "zod";
import { getConfig } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { webSearch, type WebSearchResult } from "../tools/webSearch.js";
import { calculator, type CalculatorResult } from "../tools/calculator.js";
import {
  ProjectBuilder,
  type ProjectBuildResult,
  type ProjectBuildValidationResult,
} from "../tools/projectBuilder.js";
import { buildHackathonSystemPrompt } from "../prompts/hackathonFrontend.js";

const RETRYABLE_ERROR_PATTERNS = [
  "InvalidToolArgumentsError",
  "AI_InvalidToolArgumentsError",
  "JSONParseError",
  "AI_JSONParseError",
  "429",
  "500",
  "502",
  "503",
  "504",
  "timeout",
  "network",
];

function getRetryConfig() {
  const config = getConfig();
  return {
    maxRetries: Math.min(config.llmRetryMaxAttempts, 50),
    baseDelayMs: config.llmRetryBaseDelayMs,
    maxDelayMs: config.llmRetryMaxDelayMs,
    fallbackNoTools: config.llmRetryFallbackNoTools,
    maxToolSteps: config.llmMaxToolSteps,
    maxToolCalls: config.llmMaxToolCalls,
    maxGenerationMs: config.llmMaxGenerationMs,
    global429CooldownMs: config.llmGlobal429CooldownMs,
  };
}

export interface LLMResponse {
  text: string;
  toolCalls?: {
    name: string;
    args: Record<string, unknown>;
    result: unknown;
  }[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  projectBuild?: ProjectBuildResult;
}

let activeProjectBuilder: ProjectBuilder | null = null;
let providerToolCallingUnavailable = false;

function getActiveBuilder(): ProjectBuilder | null {
  return activeProjectBuilder;
}

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const errorName = (error as Error).name || "";
  const errorMessage = (error as Error).message || "";
  const combined = `${errorName} ${errorMessage}`.toLowerCase();

  if (RETRYABLE_ERROR_PATTERNS.some((pattern) => combined.includes(pattern.toLowerCase()))) {
    return true;
  }

  const cause = (error as { cause?: unknown }).cause;
  if (cause) {
    return isRetryableError(cause);
  }

  return false;
}

class GeminiApiError extends Error {
  status: number;
  retryAfterMs?: number;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "GeminiApiError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function getRetryDelay(
  attempt: number,
  retryConfig: ReturnType<typeof getRetryConfig>,
  error?: unknown
): number {
  const exponentialDelay = Math.min(retryConfig.baseDelayMs * Math.pow(2, attempt), retryConfig.maxDelayMs);

  let delay = exponentialDelay;
  const apiError = error instanceof GeminiApiError ? error : null;
  if (apiError?.status === 429) {
    const rateLimitFloor = Math.min(3000 * Math.pow(2, attempt), retryConfig.maxDelayMs);
    const retryAfterDelay = apiError.retryAfterMs ? Math.min(apiError.retryAfterMs, retryConfig.maxDelayMs) : 0;
    delay = Math.max(exponentialDelay, rateLimitFloor, retryAfterDelay);
  }

  const jitter = delay * 0.25 * (Math.random() - 0.5);
  return Math.round(delay + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let globalGeminiCooldownUntil = 0;

async function waitForGlobalGeminiCooldown(): Promise<void> {
  const waitMs = globalGeminiCooldownUntil - Date.now();
  if (waitMs > 0) {
    logger.warn(`Global Gemini cooldown active; waiting ${waitMs}ms before next request`);
    await sleep(waitMs);
  }
}

function setGlobalGeminiCooldown(ms: number): void {
  if (ms <= 0) return;
  const next = Date.now() + ms;
  if (next > globalGeminiCooldownUntil) {
    globalGeminiCooldownUntil = next;
  }
}

export interface GenerateOptions {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: boolean;
}

interface GeminiFunctionCall {
  name: string;
  args?: Record<string, unknown>;
}

interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
}

interface GeminiCandidate {
  content?: {
    parts?: GeminiPart[];
  };
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface ToolDefinition<TArgs extends Record<string, unknown> = Record<string, unknown>, TResult = unknown> {
  description: string;
  schema: ZodTypeAny;
  declaration: GeminiFunctionDeclaration;
  execute: (args: TArgs) => Promise<TResult>;
}

interface OpenAIChatToolCall {
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

interface OpenAIChatCompletionChoice {
  finish_reason?: string;
  tool_calls?: OpenAIChatToolCall[];
  message?: {
    content?: unknown;
    tool_calls?: OpenAIChatToolCall[];
    function_call?: {
      name?: string;
      arguments?: unknown;
    };
  };
}

interface OpenAIChatCompletionResponse {
  choices?: OpenAIChatCompletionChoice[];
  tool_calls?: OpenAIChatToolCall[];
  output?: Array<{
    type?: string;
    name?: string;
    arguments?: unknown;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface OpenAIResponsesApiResponse {
  output_text?: string;
  output?: Array<{
    type?: string;
    name?: string;
    arguments?: unknown;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

function parseToolArguments(rawArgs: unknown): Record<string, unknown> {
  if (isPlainObject(rawArgs)) {
    return rawArgs;
  }

  if (typeof rawArgs === "string" && rawArgs.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawArgs);
      if (isPlainObject(parsed)) {
        return parsed;
      }
    } catch {
      return {};
    }
  }

  return {};
}

function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!isPlainObject(part)) return "";
        if (typeof part.text === "string") return part.text;
        if (isPlainObject(part.text) && typeof part.text.value === "string") {
          return part.text.value;
        }
        return "";
      })
      .filter((text) => text.length > 0)
      .join("\n");
  }

  return "";
}

function extractToolCallsFromChoice(choice?: OpenAIChatCompletionChoice): GeminiFunctionCall[] {
  if (!choice) return [];

  const fromMessage = Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls : [];
  const fromChoice = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];

  const messageRecord = isPlainObject(choice.message) ? (choice.message as Record<string, unknown>) : undefined;
  const camelCaseCalls = Array.isArray(messageRecord?.toolCalls)
    ? (messageRecord.toolCalls as OpenAIChatToolCall[])
    : [];

  const combined = [...fromMessage, ...fromChoice, ...camelCaseCalls];
  const toolCalls: GeminiFunctionCall[] = [];

  for (const toolCall of combined) {
    const name = toolCall.function?.name;
    if (!name) continue;

    toolCalls.push({
      name,
      args: parseToolArguments(toolCall.function?.arguments),
    });
  }

  const legacyName = choice.message?.function_call?.name;
  if (legacyName) {
    toolCalls.push({
      name: legacyName,
      args: parseToolArguments(choice.message?.function_call?.arguments),
    });
  }

  return toolCalls;
}

function extractToolCallsFromResponse(data: OpenAIChatCompletionResponse): GeminiFunctionCall[] {
  const firstChoice = data.choices?.[0];
  const fromChoice = extractToolCallsFromChoice(firstChoice);
  if (fromChoice.length > 0) {
    return fromChoice;
  }

  const topLevelCalls = Array.isArray(data.tool_calls) ? data.tool_calls : [];
  const topLevelParsed = topLevelCalls
    .map((toolCall): GeminiFunctionCall | null => {
      const name = toolCall.function?.name;
      if (!name) return null;
      return {
        name,
        args: parseToolArguments(toolCall.function?.arguments),
      };
    })
    .filter((call): call is GeminiFunctionCall => call !== null);

  if (topLevelParsed.length > 0) {
    return topLevelParsed;
  }

  const outputItems = Array.isArray(data.output) ? data.output : [];
  const outputParsed = outputItems
    .map((item): GeminiFunctionCall | null => {
      const isFunctionCall = item.type === "function_call" || item.type === "tool_call";
      if (!isFunctionCall || typeof item.name !== "string" || item.name.length === 0) {
        return null;
      }

      return {
        name: item.name,
        args: parseToolArguments(item.arguments),
      };
    })
    .filter((call): call is GeminiFunctionCall => call !== null);

  return outputParsed;
}

function convertResponsesApiToGeminiResponse(data: OpenAIResponsesApiResponse): GeminiResponse {
  const parts: GeminiPart[] = [];

  const outputText = typeof data.output_text === "string" ? data.output_text.trim() : "";
  if (outputText.length > 0) {
    parts.push({ text: outputText });
  }

  const outputItems = Array.isArray(data.output) ? data.output : [];
  for (const item of outputItems) {
    const isFunctionCall = item.type === "function_call" || item.type === "tool_call";
    if (isFunctionCall && typeof item.name === "string" && item.name.length > 0) {
      parts.push({
        functionCall: {
          name: item.name,
          args: parseToolArguments(item.arguments),
        },
      });
      continue;
    }

    if (item.type === "message" && Array.isArray(item.content)) {
      const messageText = item.content
        .map((chunk) => (typeof chunk.text === "string" ? chunk.text : ""))
        .filter((chunkText) => chunkText.length > 0)
        .join("\n")
        .trim();

      if (messageText.length > 0) {
        parts.push({ text: messageText });
      }
    }
  }

  return {
    candidates: [
      {
        content: {
          parts,
        },
      },
    ],
    usageMetadata: {
      promptTokenCount: data.usage?.input_tokens,
      candidatesTokenCount: data.usage?.output_tokens,
      totalTokenCount: data.usage?.total_tokens,
    },
  };
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const candidates: string[] = [];

  candidates.push(trimmed);

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    candidates.push(fencedMatch[1].trim());
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  const balancedCandidates: string[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== "{") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let j = i; j < trimmed.length; j++) {
      const char = trimmed[j];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0) {
          balancedCandidates.push(trimmed.slice(i, j + 1));
          break;
        }
      }
    }
  }

  candidates.push(...balancedCandidates);

  const parsedObjects: Record<string, unknown>[] = [];

  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index];
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (isPlainObject(parsed)) {
        parsedObjects.push(parsed);
      }
    } catch {
      continue;
    }
  }

  const protocolObject = parsedObjects.find((parsed) => {
    const typeValue = typeof parsed.type === "string" ? parsed.type : "";
    if (typeValue === "tool_calls" || typeValue === "final") {
      return true;
    }

    if (Array.isArray(parsed.calls)) {
      return true;
    }

    return false;
  });

  if (protocolObject) {
    return protocolObject;
  }

  for (const parsed of parsedObjects) {
    return parsed;
  }

  return null;
}

function normalizeSchemaType(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSchemaType(item));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === "type" && typeof raw === "string") {
      out[key] = raw.toLowerCase();
    } else {
      out[key] = normalizeSchemaType(raw);
    }
  }

  return out;
}

function convertGeminiContentsToOpenAIMessages(
  contents: Array<{
    role: "user" | "model";
    parts: Array<
      | { text: string }
      | { functionCall: { name: string; args: Record<string, unknown> } }
      | { functionResponse: { name: string; response: Record<string, unknown> } }
    >;
  }> = [],
  systemPrompt?: string,
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];

  if (systemPrompt && systemPrompt.length > 0) {
    messages.push({ role: "system", content: systemPrompt });
  }

  for (const entry of contents) {
    const role = entry.role === "model" ? "assistant" : "user";

    const text = entry.parts
      .map((part) => ("text" in part ? part.text : ""))
      .filter((value) => value.length > 0)
      .join("\n");

    if (text.length > 0) {
      messages.push({ role, content: text });
    }

    const functionResponses = entry.parts
      .map((part) => ("functionResponse" in part ? part.functionResponse : null))
      .filter((part): part is { name: string; response: Record<string, unknown> } => !!part);

    if (functionResponses.length > 0) {
      const block = functionResponses
        .map((responsePart) => `Tool ${responsePart.name} result:\n${JSON.stringify(responsePart.response)}`)
        .join("\n\n");

      messages.push({ role: "user", content: block });
    }
  }

  return messages;
}

interface GenerationResumeState {
  contents: Array<{
    role: "user" | "model";
    parts: Array<
      | { text: string }
      | { functionCall: { name: string; args: Record<string, unknown> } }
      | { functionResponse: { name: string; response: Record<string, unknown> } }
    >;
  }>;
  allToolCalls: NonNullable<LLMResponse["toolCalls"]>;
  usage?: LLMResponse["usage"];
  finalText: string;
  stepsCompleted: number;
  consecutiveNonProgressTurns: number;
}

class GenerationInterruptedError extends Error {
  state: GenerationResumeState;
  cause?: unknown;

  constructor(message: string, state: GenerationResumeState, cause?: unknown) {
    super(message);
    this.name = "GenerationInterruptedError";
    this.state = state;
    this.cause = cause;
  }
}

function getErrorMessage(error: unknown): string {
  if (!error) return "Unknown error";

  if (error instanceof GenerationInterruptedError && error.cause) {
    return getErrorMessage(error.cause);
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateText(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, maxLength)}\n...[truncated ${input.length - maxLength} chars]`;
}

const MAX_GATEWAY_PAYLOAD_BYTES = 16000;

function pruneForGateway(value: unknown, depth = 0): unknown {
  if (depth >= 4) {
    return "[truncated-depth]";
  }

  if (typeof value === "string") {
    return truncateText(value, 500);
  }

  if (Array.isArray(value)) {
    return value.slice(0, 6).map((item) => pruneForGateway(item, depth + 1));
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value).slice(0, 12);
    const compacted = Object.fromEntries(
      entries.map(([key, item]) => [key, pruneForGateway(item, depth + 1)])
    );
    return compacted;
  }

  return value;
}

function compactContentsForGateway(
  contents: Array<{
    role: "user" | "model";
    parts: Array<
      | { text: string }
      | { functionCall: { name: string; args: Record<string, unknown> } }
      | { functionResponse: { name: string; response: Record<string, unknown> } }
    >;
  }>,
  keepRecentUserTurns = 2,
): Array<{
  role: "user" | "model";
  parts: Array<
    | { text: string }
    | { functionCall: { name: string; args: Record<string, unknown> } }
    | { functionResponse: { name: string; response: Record<string, unknown> } }
  >;
}> {
  if (contents.length <= 3) {
    return contents.map((message) => ({
      role: message.role,
      parts: message.parts.map((part) => {
        if ("text" in part) {
          return { text: truncateText(part.text, 800) };
        }

        if ("functionCall" in part) {
          return {
            functionCall: {
              name: part.functionCall.name,
              args: pruneForGateway(part.functionCall.args) as Record<string, unknown>,
            },
          };
        }

        return {
          functionResponse: {
            name: part.functionResponse.name,
            response: pruneForGateway(part.functionResponse.response) as Record<string, unknown>,
          },
        };
      }),
    }));
  }

  const first = contents[0];
  const recent = contents.slice(-Math.max(1, keepRecentUserTurns));
  const compacted = [first, ...recent].map((message) => ({
    role: message.role,
    parts: message.parts
      .slice(-8)
      .map((part) => {
        if ("text" in part) {
          return { text: truncateText(part.text, 800) };
        }

        if ("functionCall" in part) {
          return {
            functionCall: {
              name: part.functionCall.name,
              args: pruneForGateway(part.functionCall.args) as Record<string, unknown>,
            },
          };
        }

        return {
          functionResponse: {
            name: part.functionResponse.name,
            response: pruneForGateway(part.functionResponse.response) as Record<string, unknown>,
          },
        };
      }),
  }));

  return compacted;
}

function compactToolResultForModel(toolName: string, toolResult: unknown): Record<string, unknown> {
  if (toolName === "list_files" && isPlainObject(toolResult)) {
    const files = Array.isArray(toolResult.files) ? toolResult.files : [];
    return {
      success: toolResult.success,
      totalFiles: toolResult.totalFiles,
      files: files.slice(0, 300),
      hasMore: files.length > 300,
    };
  }

  if (toolName === "search_files" && isPlainObject(toolResult)) {
    const matches = Array.isArray(toolResult.matches) ? toolResult.matches : [];
    return {
      success: toolResult.success,
      totalMatches: toolResult.totalMatches,
      matches: matches.slice(0, 120),
      hasMore: matches.length > 120,
    };
  }

  if (toolName === "read_file" && isPlainObject(toolResult)) {
    const content = typeof toolResult.content === "string" ? toolResult.content : "";
    return {
      success: toolResult.success,
      path: toolResult.path,
      size: toolResult.size,
      content: truncateText(content, 5000),
    };
  }

  if (toolName === "edit_file" && isPlainObject(toolResult)) {
    return {
      success: toolResult.success,
      path: toolResult.path,
      replacements: toolResult.replacements,
      size: toolResult.size,
      totalFiles: toolResult.totalFiles,
    };
  }

  if (toolName === "create_file" && isPlainObject(toolResult)) {
    return {
      success: toolResult.success,
      path: toolResult.path,
      size: toolResult.size,
      totalFiles: toolResult.totalFiles,
    };
  }

  if (toolName === "validate_project_build" && isPlainObject(toolResult)) {
    const output = typeof toolResult.output === "string" ? toolResult.output : "";
    return {
      success: toolResult.success,
      projectDir: toolResult.projectDir,
      installRan: toolResult.installRan,
      buildScriptDetected: toolResult.buildScriptDetected,
      output: truncateText(output, 3000),
    };
  }

  if (toolName === "web_search" && Array.isArray(toolResult)) {
    return {
      results: toolResult.slice(0, 5).map((item) => {
        if (!isPlainObject(item)) return { value: String(item) };
        return {
          title: typeof item.title === "string" ? truncateText(item.title, 180) : "",
          url: typeof item.url === "string" ? item.url : "",
          snippet: typeof item.snippet === "string" ? truncateText(item.snippet, 320) : "",
        };
      }),
      totalResults: toolResult.length,
    };
  }

  if (toolName === "finalize_project" && isPlainObject(toolResult)) {
    const files = Array.isArray(toolResult.files) ? toolResult.files : [];
    return {
      success: toolResult.success,
      projectName: toolResult.projectName,
      zipPath: toolResult.zipPath,
      workspaceProjectDir: toolResult.workspaceProjectDir,
      totalSize: toolResult.totalSize,
      fileCount: files.length,
      filesPreview: files.slice(0, 20),
      error: toolResult.error,
    };
  }

  if (isPlainObject(toolResult)) {
    return toolResult;
  }

  return { result: toolResult };
}

function getLatestFunctionResponseParts(
  contents: Array<{
    role: "user" | "model";
    parts: Array<
      | { text: string }
      | { functionCall: { name: string; args: Record<string, unknown> } }
      | { functionResponse: { name: string; response: Record<string, unknown> } }
    >;
  }>
): Array<{ functionResponse: { name: string; response: Record<string, unknown> } }> {
  for (let i = contents.length - 1; i >= 0; i--) {
    const message = contents[i];
    if (message.role !== "user") continue;

    const functionResponses = message.parts.filter(
      (part): part is { functionResponse: { name: string; response: Record<string, unknown> } } =>
        "functionResponse" in part
    );

    if (functionResponses.length > 0) {
      return functionResponses;
    }
  }

  return [];
}

function buildWorkingMemorySummary(params: {
  allToolCalls: NonNullable<LLMResponse["toolCalls"]>;
  finalText: string;
  hasProjectBuilder: boolean;
  fileList: string[];
}): string {
  const { allToolCalls, finalText, hasProjectBuilder, fileList } = params;
  const recentCalls = allToolCalls.slice(-24);

  const recentLines = recentCalls.map((toolCall, index) => {
    const result = toolCall.result as { success?: boolean; error?: string } | undefined;
    const status = result?.success === true ? "success" : result?.error ? `error=${String(result.error)}` : "done";
    return `${index + 1}. ${toolCall.name} (${status})`;
  });

  const filesSummary = hasProjectBuilder
    ? fileList.slice(0, 80).join(", ") || "(none yet)"
    : "(project builder not initialized)";

  const sections = [
    "State summary for continuation:",
    `- Total tool calls so far: ${allToolCalls.length}`,
    `- Recent tool calls:\n${recentLines.length ? recentLines.join("\n") : "(none)"}`,
    `- Current files: ${filesSummary}`,
    finalText ? `- Latest assistant draft text:\n${truncateText(finalText, 2200)}` : "- Latest assistant draft text: (none)",
    "Continue from this state and avoid repeating unchanged file rewrites.",
  ];

  return truncateText(sections.join("\n\n"), 7000);
}

function rebuildToolLoopContents(params: {
  prompt: string;
  contents: Array<{
    role: "user" | "model";
    parts: Array<
      | { text: string }
      | { functionCall: { name: string; args: Record<string, unknown> } }
      | { functionResponse: { name: string; response: Record<string, unknown> } }
    >;
  }>;
  allToolCalls: NonNullable<LLMResponse["toolCalls"]>;
  finalText: string;
  projectFiles: string[];
}): Array<{
  role: "user" | "model";
  parts: Array<
    | { text: string }
    | { functionCall: { name: string; args: Record<string, unknown> } }
    | { functionResponse: { name: string; response: Record<string, unknown> } }
  >;
}> {
  const { prompt, contents, allToolCalls, finalText, projectFiles } = params;
  const latestFunctionResponses = getLatestFunctionResponseParts(contents).map((part) => ({
    functionResponse: {
      name: part.functionResponse.name,
      response: pruneForGateway(part.functionResponse.response) as Record<string, unknown>,
    },
  }));

  const summaryText = buildWorkingMemorySummary({
    allToolCalls,
    finalText,
    hasProjectBuilder: projectFiles.length >= 0,
    fileList: projectFiles,
  });

  const rebuilt: Array<{
    role: "user" | "model";
    parts: Array<
      | { text: string }
      | { functionCall: { name: string; args: Record<string, unknown> } }
      | { functionResponse: { name: string; response: Record<string, unknown> } }
    >;
  }> = [
    {
      role: "user",
      parts: [{ text: truncateText(prompt, 5000) }],
    },
    {
      role: "model",
      parts: [{ text: summaryText }],
    },
  ];

  if (latestFunctionResponses.length > 0) {
    rebuilt.push({
      role: "user",
      parts: latestFunctionResponses,
    });
  }

  return rebuilt;
}

function getLatestFinalizeCall(
  toolCalls: NonNullable<LLMResponse["toolCalls"]>
): (typeof toolCalls)[number] | undefined {
  for (let index = toolCalls.length - 1; index >= 0; index--) {
    if (toolCalls[index].name === "finalize_project") {
      return toolCalls[index];
    }
  }

  return undefined;
}

function generateDefaultProjectName(prompt: string): string {
  const stopWords = new Set([
    "build",
    "create",
    "make",
    "generate",
    "a",
    "an",
    "the",
    "for",
    "to",
    "of",
    "and",
    "with",
    "in",
    "on",
    "app",
    "project",
  ]);

  const tokens = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !stopWords.has(token));

  const topic = tokens.slice(0, 3).join("-") || "generated-app";
  const styleWords = ["studio", "forge", "lab", "works", "atelier", "factory"];
  const style = styleWords[Math.floor(Math.random() * styleWords.length)];
  const suffix = Math.random().toString(36).slice(2, 6);

  return `${topic}-${style}-${suffix}`.slice(0, 60);
}

export class LLMClient {
  private apiKey: string;
  private apiBaseUrl: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor() {
    const config = getConfig();

    if (!config.geminiApiKey) {
      throw new Error("GEMINI_API_KEY is required");
    }

    this.apiKey = config.geminiApiKey;
    this.apiBaseUrl = config.geminiApiBaseUrl;
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    this.temperature = config.temperature;
  }

  private async executeGenerationWithTextToolProtocol(params: {
    prompt: string;
    systemPrompt?: string;
    maxTokens: number;
    temperature: number;
    tools: Record<string, ToolDefinition>;
  }): Promise<LLMResponse> {
    const { prompt, systemPrompt, maxTokens, temperature, tools } = params;
    const retryConfig = getRetryConfig();
    const maxSteps = Math.max(1, retryConfig.maxToolSteps);
    const allToolCalls: NonNullable<LLMResponse["toolCalls"]> = [];
    let usage: LLMResponse["usage"];
    let finalText = "";
    let previousCycleSignature = "";
    let repeatedCycleCount = 0;
    const defaultProjectName = generateDefaultProjectName(prompt);
    const likelyProjectRequest = /\b(build|create|develop|generate|app|website|site|game|dashboard|project|landing page|web app)\b/i.test(
      prompt
    );

    const toolCatalog = Object.entries(tools).map(([name, toolDef]) => ({
      name,
      description: toolDef.description,
      parameters: normalizeSchemaType(toolDef.declaration.parameters),
    }));

    const compactToolCatalog = toolCatalog.map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));

    let runningContext = `Original user request:\n${prompt}`;

    const protocolInstruction = [
      systemPrompt || "",
      "You are operating in TOOL_PROTOCOL_JSON mode because native tool calls are unavailable.",
      "Respond with ONLY one JSON object and no extra prose.",
      "Allowed JSON responses:",
      '{"type":"tool_calls","calls":[{"name":"tool_name","args":{}}]}',
      '{"type":"final","text":"final answer"}',
      "Use tool_calls whenever work is required before finalizing.",
      `Available tools (names + purpose): ${JSON.stringify(compactToolCatalog)}`,
      "Only include arguments needed by the selected tool.",
    ]
      .filter((line) => line.length > 0)
      .join("\n\n");

    for (let step = 0; step < maxSteps; step++) {
      let stepResult = await this.executeGeneration({
        prompt: `${runningContext}\n\nReturn ONLY valid JSON now.`,
        systemPrompt: protocolInstruction,
        maxTokens,
        temperature,
        tools: undefined,
      });

      if (stepResult.text.trim().length === 0) {
        logger.warn(`Text-json step ${step + 1} returned empty text; retrying once with compact rescue prompt`);
        stepResult = await this.executeGeneration({
          prompt:
            `${runningContext}\n\nReturn exactly one JSON object only. ` +
            `Use either {"type":"tool_calls","calls":[{"name":"...","args":{}}]} or {"type":"final","text":"..."}.`,
          maxTokens,
          temperature,
          tools: undefined,
        });
      }

      usage = stepResult.usage || usage;

      let parsed = extractJsonObject(stepResult.text);
      if (!parsed) {
        logger.warn(`Text-json step ${step + 1} returned non-JSON content; forcing strict JSON correction turn`);
        const correction = await this.executeGeneration({
          prompt:
            `${runningContext}\n\nYour last response was invalid for TOOL_PROTOCOL_JSON mode. ` +
            `Respond now with exactly one JSON object only: ` +
            `{"type":"tool_calls","calls":[{"name":"...","args":{}}]} or {"type":"final","text":"..."}.`,
          maxTokens,
          temperature,
          tools: undefined,
        });
        usage = correction.usage || usage;
        if (correction.text.trim().length > 0) {
          // Keep correction text only if we cannot parse a valid protocol object.
          // Protocol-shaped content is sanitized later and never shown to end users directly.
          finalText = correction.text;
        }
        parsed = extractJsonObject(correction.text);
      }

      if (!parsed) {
        break;
      }

      const responseType = typeof parsed.type === "string" ? parsed.type : "";
      if (responseType === "final") {
        if (likelyProjectRequest && allToolCalls.length === 0) {
          logger.warn("Ignoring premature final response in project request; requiring at least one tool call first");
          runningContext =
            `${runningContext}\n\nDo not finalize yet. First call tools to create and validate files, then finalize_project.`;
          continue;
        }

        if (typeof parsed.text === "string" && parsed.text.trim().length > 0) {
          finalText = parsed.text;
        }
        break;
      }

      if (responseType !== "tool_calls") {
        break;
      }

      const calls = Array.isArray(parsed.calls) ? parsed.calls : [];
      if (calls.length === 0) {
        break;
      }

      const currentCycleSignature = JSON.stringify(calls);
      if (currentCycleSignature === previousCycleSignature) {
        repeatedCycleCount++;
      } else {
        repeatedCycleCount = 0;
        previousCycleSignature = currentCycleSignature;
      }

      if (repeatedCycleCount >= 3) {
        logger.warn("Text-json tool protocol detected repeated call cycle; stopping to avoid infinite loop");
        break;
      }

      const toolOutputs: Array<{ name: string; result: unknown }> = [];
      let finalizedProjectThisStep = false;

      for (const call of calls) {
        if (!isPlainObject(call)) continue;
        const toolName = typeof call.name === "string" ? call.name : "";
        const rawArgs = isPlainObject(call.args) ? { ...call.args } : {};
        if (!toolName) continue;

        const args: Record<string, unknown> = { ...rawArgs };
        if (toolName === "edit_file") {
          if (typeof args.path !== "string" && typeof rawArgs.file_path === "string") {
            args.path = rawArgs.file_path;
          }
          if (typeof args.search !== "string" && typeof rawArgs.search_text === "string") {
            args.search = rawArgs.search_text;
          }
          if (typeof args.replace !== "string" && typeof rawArgs.replace_text === "string") {
            args.replace = rawArgs.replace_text;
          }
        }
        if (toolName === "finalize_project" && typeof args.projectName !== "string") {
          args.projectName = defaultProjectName;
        }

        const toolDef = tools[toolName];
        let toolResult: unknown;

        if (!toolDef) {
          toolResult = { error: `Unknown tool: ${toolName}` };
        } else {
          const validated = toolDef.schema.safeParse(args);
          if (!validated.success) {
            toolResult = {
              error: "Invalid arguments",
              details: validated.error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
              })),
            };
          } else {
            try {
              toolResult = await toolDef.execute(validated.data as Record<string, unknown>);
            } catch (error) {
              toolResult = {
                error: getErrorMessage(error),
              };
            }
          }
        }

        allToolCalls.push({
          name: toolName,
          args,
          result: toolResult,
        });

        toolOutputs.push({
          name: toolName,
          result: compactToolResultForModel(toolName, toolResult),
        });

        if (
          toolName === "finalize_project" &&
          isPlainObject(toolResult) &&
          toolResult.success === true
        ) {
          finalizedProjectThisStep = true;
        }

        if (allToolCalls.length >= retryConfig.maxToolCalls) {
          break;
        }
      }

      if (allToolCalls.length >= retryConfig.maxToolCalls) {
        break;
      }

      if (finalizedProjectThisStep) {
        logger.info("Text-json tool protocol finalized project successfully; stopping loop");
        break;
      }

      runningContext = `${runningContext}\n\nTool outputs from step ${step + 1}:\n${JSON.stringify(toolOutputs)}`;
    }

    const protocolLikeFinal = extractJsonObject(finalText);
    if (protocolLikeFinal) {
      const protocolType = typeof protocolLikeFinal.type === "string" ? protocolLikeFinal.type : "";
      const hasCalls = Array.isArray(protocolLikeFinal.calls);

      if (protocolType === "final" && typeof protocolLikeFinal.text === "string") {
        finalText = protocolLikeFinal.text;
      } else if (protocolType === "tool_calls" || hasCalls) {
        finalText = "";
      }
    }

    const hasSuccessfulFinalize = allToolCalls.some(
      (toolCall) =>
        toolCall.name === "finalize_project" &&
        isPlainObject(toolCall.result) &&
        toolCall.result.success === true
    );

    const builderAfterLoop = getActiveBuilder();
    const hasGeneratedFiles = !!builderAfterLoop && builderAfterLoop.getFiles().length > 0;

    if (hasGeneratedFiles && !hasSuccessfulFinalize) {
      logger.warn("Generated files detected without finalize_project; auto-finalizing to persist workspace project folder");

      const validateDef = tools.validate_project_build;
      if (validateDef) {
        let validateResult: unknown;
        try {
          validateResult = await validateDef.execute({});
        } catch (error) {
          validateResult = { error: getErrorMessage(error) };
        }
        allToolCalls.push({
          name: "validate_project_build",
          args: {},
          result: validateResult,
        });
      }

      const finalizeDef = tools.finalize_project;
      if (finalizeDef) {
        let finalizeResult: unknown;
        const finalizeArgs: Record<string, unknown> = { projectName: defaultProjectName };
        try {
          finalizeResult = await finalizeDef.execute(finalizeArgs);
        } catch (error) {
          finalizeResult = { error: getErrorMessage(error) };
        }
        allToolCalls.push({
          name: "finalize_project",
          args: finalizeArgs,
          result: finalizeResult,
        });
      }
    }

    if (!finalText) {
      if (allToolCalls.length > 0) {
        const finalizeText = await this.executeGeneration({
          prompt:
            `${prompt}\n\nTools executed: ${JSON.stringify(allToolCalls.slice(-12))}\n\n` +
            "Provide a concise final answer for the user summarizing what was produced.",
          maxTokens,
          temperature,
          tools: undefined,
        });
        finalText = finalizeText.text.trim() || "Task complete.";
      } else {
        const plainFallback = await this.executeGeneration({
          prompt: `${prompt}\n\nProvide a complete direct response in plain text.`,
          maxTokens,
          temperature,
          tools: undefined,
        });
        finalText = plainFallback.text.trim() || "Task complete.";
      }
    }

    let projectBuild: ProjectBuildResult | undefined;
    const finalizeCall = getLatestFinalizeCall(allToolCalls);
    if (finalizeCall && finalizeCall.result) {
      const finalizeResult = finalizeCall.result as {
        success: boolean;
        zipPath: string;
        workspaceProjectDir?: string;
        files: string[];
        totalSize: number;
      };

      const builder = getActiveBuilder();
      if (finalizeResult.success && builder) {
        projectBuild = {
          success: true,
          projectDir: builder.getProjectDir(),
          zipPath: finalizeResult.zipPath,
          workspaceProjectDir: finalizeResult.workspaceProjectDir,
          files: finalizeResult.files,
          totalSize: finalizeResult.totalSize,
        };
      }
    }

    return {
      text: finalText,
      toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
      usage,
      projectBuild,
    };
  }

  private getTools(): Record<string, ToolDefinition> {
    const config = getConfig();
    const tools: Record<string, ToolDefinition> = {};

    if (config.tools.webSearchEnabled) {
      const schema = z.object({
        query: z.string().describe("The search query to look up on the web"),
      });

      tools.web_search = {
        description:
          "Search the web for current information. Use this when you need up-to-date information, facts, news, prices, or data that might not be in your training data. Returns an array of search results with title, url, and snippet containing the relevant information.",
        schema,
        declaration: {
          name: "web_search",
          description:
            "Search the web for current information. Returns result objects with title, url, and snippet.",
          parameters: {
            type: "OBJECT",
            properties: {
              query: {
                type: "STRING",
                description: "The search query to look up on the web",
              },
            },
            required: ["query"],
          },
        },
        execute: async (args: Record<string, unknown>): Promise<WebSearchResult[]> => {
          const query = String(args.query || "");
          logger.tool("web_search", "start", `Query: ${query}`);
          try {
            const results = await webSearch(query);
            logger.tool("web_search", "success", `Found ${results.length} results`);
            for (const result of results.slice(0, 2)) {
              logger.debug(`Search result: "${result.title}" - ${result.snippet.substring(0, 100)}...`);
            }
            return results;
          } catch (error) {
            logger.tool("web_search", "error", String(error));
            throw error;
          }
        },
      };
    }

    if (config.tools.calculatorEnabled) {
      const schema = z.object({
        expression: z
          .string()
          .describe("The mathematical expression to evaluate (e.g., '2 + 2', 'sqrt(16)', 'sin(45)')"),
      });

      tools.calculator = {
        description: "Perform mathematical calculations. Use this for any math operations, equations, or numerical computations.",
        schema,
        declaration: {
          name: "calculator",
          description: "Evaluate a mathematical expression.",
          parameters: {
            type: "OBJECT",
            properties: {
              expression: {
                type: "STRING",
                description: "The mathematical expression to evaluate",
              },
            },
            required: ["expression"],
          },
        },
        execute: async (args: Record<string, unknown>): Promise<CalculatorResult> => {
          const expression = String(args.expression || "");
          logger.tool("calculator", "start", `Expression: ${expression}`);
          try {
            const result = calculator(expression);
            logger.tool("calculator", "success", `Result: ${result.result}`);
            return result;
          } catch (error) {
            logger.tool("calculator", "error", String(error));
            throw error;
          }
        },
      };
    }

    if (config.tools.codeInterpreterEnabled) {
      const codeSchema = z.object({
        code: z.string().describe("The code snippet to analyze"),
        language: z.string().optional().describe("The programming language of the code"),
        task: z.enum(["explain", "debug", "improve", "review"]).describe("What to do with the code"),
      });

      tools.code_analysis = {
        description:
          "Analyze code snippets, explain code logic, identify bugs, or suggest improvements. This tool helps with code-related questions.",
        schema: codeSchema,
        declaration: {
          name: "code_analysis",
          description: "Analyze code for explanation, debugging, improvements, or review.",
          parameters: {
            type: "OBJECT",
            properties: {
              code: { type: "STRING", description: "The code snippet to analyze" },
              language: { type: "STRING", description: "The programming language of the code" },
              task: {
                type: "STRING",
                enum: ["explain", "debug", "improve", "review"],
                description: "What to do with the code",
              },
            },
            required: ["code", "task"],
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const code = String(args.code || "");
          const language = typeof args.language === "string" ? args.language : undefined;
          const task = String(args.task || "explain") as "explain" | "debug" | "improve" | "review";
          logger.tool("code_analysis", "start", `Task: ${task}`);
          return {
            code,
            language: language || "unknown",
            task,
            note: "Analyze this code and provide the requested information.",
          };
        },
      };

      const createFileSchema = z.object({
        path: z.string().describe("The file path relative to the project root"),
        content: z.string().optional().describe("The complete content of the file"),
        contents: z.string().optional().describe("Alias of content; accepted for model compatibility"),
      });

      const readFileSchema = z.object({
        path: z.string().describe("The file path relative to the project root"),
      });

      const listFilesSchema = z.object({
        pathContains: z
          .string()
          .optional()
          .describe("Optional substring filter for file paths, e.g. 'src/' or '.tsx'"),
      });

      const searchFilesSchema = z.object({
        query: z.string().describe("Text or regex pattern to search for"),
        isRegex: z.boolean().optional().describe("Whether query is a regex pattern"),
        pathContains: z
          .string()
          .optional()
          .describe("Optional substring filter for file paths"),
        maxResults: z.number().int().positive().max(500).optional().describe("Maximum number of matches"),
      });

      const editFileSchema = z.object({
        path: z.string().describe("The file path relative to the project root"),
        search: z.string().describe("Exact text to find in the target file"),
        replace: z.string().describe("Replacement text"),
        allOccurrences: z
          .boolean()
          .optional()
          .describe("When true, replace all occurrences; otherwise replace first match only"),
      });

      tools.create_file = {
        description:
          "Create a file for a deliverable code project (website, app, script, tool). Only use this for real downloadable projects.",
        schema: createFileSchema,
        declaration: {
          name: "create_file",
          description:
            "Create a file for a code project. Call multiple times for multi-file projects, then call finalize_project.",
          parameters: {
            type: "OBJECT",
            properties: {
              path: {
                type: "STRING",
                description: "Path relative to project root (e.g. index.html, src/App.tsx)",
              },
              content: {
                type: "STRING",
                description: "Full file content",
              },
              contents: {
                type: "STRING",
                description: "Alias of content",
              },
            },
            required: ["path"],
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const path = String(args.path || "");
          const rawContent = args.content ?? args.contents ?? "";
          const content = String(rawContent || "");
          logger.tool("create_file", "start", `Creating: ${path}`);
          try {
            if (!activeProjectBuilder) {
              activeProjectBuilder = new ProjectBuilder();
            }

            activeProjectBuilder.addFile(path, content);

            const files = activeProjectBuilder.getFiles();
            logger.tool("create_file", "success", `Created ${path}, total files: ${files.length}`);

            return {
              success: true,
              path,
              size: content.length,
              totalFiles: files.length,
              allFiles: files,
            };
          } catch (error) {
            logger.tool("create_file", "error", String(error));
            throw error;
          }
        },
      };

      tools.read_file = {
        description:
          "Read an existing file in the current generated project. Use this before editing to avoid rewriting the entire file.",
        schema: readFileSchema,
        declaration: {
          name: "read_file",
          description: "Read and return the full contents of a generated project file.",
          parameters: {
            type: "OBJECT",
            properties: {
              path: {
                type: "STRING",
                description: "Path relative to project root",
              },
            },
            required: ["path"],
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const path = String(args.path || "");
          logger.tool("read_file", "start", `Reading: ${path}`);
          if (!activeProjectBuilder) {
            throw new Error("No files have been created. Use create_file first.");
          }

          const content = activeProjectBuilder.readFile(path);
          logger.tool("read_file", "success", `Read ${path} (${content.length} bytes)`);
          return {
            success: true,
            path,
            size: content.length,
            content,
          };
        },
      };

      tools.list_files = {
        description:
          "List all current files in the generated project, optionally filtered by path substring.",
        schema: listFilesSchema,
        declaration: {
          name: "list_files",
          description: "List files in the current generated project.",
          parameters: {
            type: "OBJECT",
            properties: {
              pathContains: {
                type: "STRING",
                description: "Optional path substring filter",
              },
            },
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const pathContains = typeof args.pathContains === "string" ? args.pathContains : undefined;
          logger.tool("list_files", "start", pathContains ? `Filter: ${pathContains}` : "Listing all files");

          if (!activeProjectBuilder) {
            throw new Error("No files have been created. Use create_file first.");
          }

          const files = activeProjectBuilder.listFiles(pathContains);
          logger.tool("list_files", "success", `Found ${files.length} files`);
          return {
            success: true,
            totalFiles: files.length,
            files,
          };
        },
      };

      tools.search_files = {
        description:
          "Search text across generated project files. Supports plain text and regex. Use this before edit_file to target exact locations.",
        schema: searchFilesSchema,
        declaration: {
          name: "search_files",
          description: "Search text in generated project files and return line-level matches.",
          parameters: {
            type: "OBJECT",
            properties: {
              query: {
                type: "STRING",
                description: "Text or regex pattern to search for",
              },
              isRegex: {
                type: "BOOLEAN",
                description: "Whether query is regex",
              },
              pathContains: {
                type: "STRING",
                description: "Optional file path filter",
              },
              maxResults: {
                type: "NUMBER",
                description: "Maximum number of matches",
              },
            },
            required: ["query"],
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const query = String(args.query || "");
          const isRegex = Boolean(args.isRegex);
          const pathContains = typeof args.pathContains === "string" ? args.pathContains : undefined;
          const maxResults = typeof args.maxResults === "number" ? args.maxResults : undefined;

          logger.tool("search_files", "start", `Query: ${query}`);
          if (!activeProjectBuilder) {
            throw new Error("No files have been created. Use create_file first.");
          }

          const matches = activeProjectBuilder.searchText(query, {
            isRegex,
            pathContains,
            maxResults,
          });

          logger.tool("search_files", "success", `Found ${matches.length} matches`);
          return {
            success: true,
            totalMatches: matches.length,
            matches,
          };
        },
      };

      tools.edit_file = {
        description:
          "Edit an existing file using precise search/replace without rewriting unrelated parts of the file.",
        schema: editFileSchema,
        declaration: {
          name: "edit_file",
          description: "Edit a generated file by replacing text patterns.",
          parameters: {
            type: "OBJECT",
            properties: {
              path: {
                type: "STRING",
                description: "Path relative to project root",
              },
              search: {
                type: "STRING",
                description: "Exact text to find",
              },
              replace: {
                type: "STRING",
                description: "Replacement text",
              },
              allOccurrences: {
                type: "BOOLEAN",
                description: "Replace all matches when true",
              },
            },
            required: ["path", "search", "replace"],
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const path = String(args.path || "");
          const search = String(args.search || "");
          const replace = String(args.replace || "");
          const allOccurrences = Boolean(args.allOccurrences);

          logger.tool("edit_file", "start", `Editing: ${path}`);
          if (!activeProjectBuilder) {
            throw new Error("No files have been created. Use create_file first.");
          }

          const result = activeProjectBuilder.editFile(path, search, replace, {
            allOccurrences,
          });
          logger.tool("edit_file", "success", `Edited ${path}, replacements: ${result.replacements}`);
          return {
            success: true,
            ...result,
          };
        },
      };

      const finalizeSchema = z.object({
        projectName: z.string().describe("A descriptive name for the project"),
      });

      const validateBuildSchema = z.object({
        trigger: z.string().optional().describe("Optional note for when to run build validation"),
      });

      tools.validate_project_build = {
        description:
          "Run npm build validation for the generated project and return compiler/build output for debugging.",
        schema: validateBuildSchema,
        declaration: {
          name: "validate_project_build",
          description:
            "Run npm install (if needed) and npm run build inside the generated project, returning errors or success output.",
          parameters: {
            type: "OBJECT",
            properties: {
              trigger: {
                type: "STRING",
                description: "Optional note for when this validation run was requested",
              },
            },
          },
        },
        execute: async () => {
          logger.tool("validate_project_build", "start", "Running npm build validation");
          if (!activeProjectBuilder) {
            throw new Error("No files have been created. Use create_file first.");
          }

          const result: ProjectBuildValidationResult = await activeProjectBuilder.validateNodeBuild();
          logger.tool(
            "validate_project_build",
            result.success ? "success" : "error",
            result.success ? "Build validation passed" : "Build validation failed"
          );

          return result;
        },
      };

      tools.finalize_project = {
        description: "Package all files created with create_file into a downloadable zip.",
        schema: finalizeSchema,
        declaration: {
          name: "finalize_project",
          description: "Zip all created project files.",
          parameters: {
            type: "OBJECT",
            properties: {
              projectName: {
                type: "STRING",
                description: "A descriptive project name (e.g. react-todo-app)",
              },
            },
            required: ["projectName"],
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const projectName = String(args.projectName || "project");
          logger.tool("finalize_project", "start", `Finalizing: ${projectName}`);
          try {
            if (!activeProjectBuilder) {
              throw new Error("No files have been created. Use create_file first.");
            }

            activeProjectBuilder.ensureReadme(projectName);

            const buildValidation = await activeProjectBuilder.validateNodeBuild();
            if (!buildValidation.success) {
              return {
                success: false,
                projectName,
                error:
                  "Build validation failed. Fix project files, rerun validate_project_build, and only then call finalize_project.",
                buildValidation,
              };
            }

            const result = await activeProjectBuilder.createZip(`${projectName}.zip`);
            logger.tool("finalize_project", "success", `Created ${result.zipPath} (${result.totalSize} bytes)`);

            return {
              success: result.success,
              projectName,
              zipPath: result.zipPath,
              workspaceProjectDir: result.workspaceProjectDir,
              files: result.files,
              totalSize: result.totalSize,
              buildValidation,
              error: result.error,
            };
          } catch (error) {
            logger.tool("finalize_project", "error", String(error));
            throw error;
          }
        },
      };
    }

    return tools;
  }

  async generate(options: GenerateOptions): Promise<LLMResponse> {
    const {
      prompt,
      systemPrompt,
      maxTokens = this.maxTokens,
      temperature = this.temperature,
      tools: enableTools = true,
    } = options;

    logger.debug(`Generating response with model: ${this.model}`);

    activeProjectBuilder = null;

    const config = getConfig();
    const availableTools = enableTools ? this.getTools() : undefined;
    const hasTools = !!availableTools && Object.keys(availableTools).length > 0;
    const useTextJsonToolProtocol = config.llmToolCallingMode === "text-json";

    if (enableTools && hasTools && availableTools && useTextJsonToolProtocol) {
      logger.info("Using text-json tool protocol as primary tool-calling mode");
      return await this.executeGenerationWithTextToolProtocol({
        prompt,
        systemPrompt,
        maxTokens,
        temperature,
        tools: availableTools,
      });
    }

    if (enableTools && providerToolCallingUnavailable && hasTools && availableTools) {
      logger.warn("Provider lacks native tool-calling; using JSON text tool protocol fallback");
      return await this.executeGenerationWithTextToolProtocol({
        prompt,
        systemPrompt,
        maxTokens,
        temperature,
        tools: availableTools,
      });
    }

    if (enableTools && providerToolCallingUnavailable) {
      logger.warn("Skipping tool-calling: provider/model marked as tool-call incompatible in this process");
    }

    let lastError: unknown;
    let attempt = 0;
    const retryConfig = getRetryConfig();
    const generationStartedAt = Date.now();
    let resumeState: GenerationResumeState | undefined;
    let attemptedEmptyFallback = false;

    while (attempt <= retryConfig.maxRetries) {
      try {
        const generationResult = await this.executeGeneration({
          prompt,
          systemPrompt,
          maxTokens,
          temperature,
          tools: hasTools ? availableTools : undefined,
          resumeState,
        });

        const hasNoToolCalls = !generationResult.toolCalls || generationResult.toolCalls.length === 0;
        if (
          hasTools &&
          retryConfig.fallbackNoTools &&
          !attemptedEmptyFallback &&
          hasNoToolCalls &&
          generationResult.text.trim().length === 0
        ) {
          attemptedEmptyFallback = true;
          providerToolCallingUnavailable = true;
          logger.warn(
            "Tool-enabled generation returned empty text and no tool calls; switching to JSON text tool protocol fallback"
          );

          activeProjectBuilder = null;
          if (availableTools) {
            return await this.executeGenerationWithTextToolProtocol({
              prompt,
              systemPrompt,
              maxTokens,
              temperature,
              tools: availableTools,
            });
          }

          return await this.executeGeneration({
            prompt: `${prompt}\n\n[Return a complete text response only. Tool calls are unavailable for this provider/model.]`,
            systemPrompt,
            maxTokens,
            temperature,
            tools: undefined,
          });
        }

        return generationResult;
      } catch (error) {
        lastError = error;

        if (error instanceof GenerationInterruptedError) {
          resumeState = error.state;

          const rootCause = error.cause;
          const apiError = rootCause instanceof GeminiApiError ? rootCause : null;
          if (apiError && (apiError.status === 429 || apiError.status >= 500)) {
            const builder = getActiveBuilder();
            const rebuiltContents = rebuildToolLoopContents({
              prompt,
              contents: resumeState.contents,
              allToolCalls: resumeState.allToolCalls,
              finalText: resumeState.finalText,
              projectFiles: builder?.getFiles() || [],
            });
            const rebuiltBytes = JSON.stringify(rebuiltContents).length;
            resumeState.contents = rebuiltContents;
            logger.warn(
              `Rebuilt resume-state context after ${apiError.status} to compact working memory (messageBlocks=${resumeState.contents.length}, payloadBytes=${rebuiltBytes})`
            );
          }

          logger.debug(
            `Preserved resume state: stepsCompleted=${resumeState.stepsCompleted}, toolCalls=${resumeState.allToolCalls.length}, hasText=${resumeState.finalText.length > 0}`
          );
        }

        if (isRetryableError(error) && attempt < retryConfig.maxRetries) {
          if (Date.now() - generationStartedAt >= retryConfig.maxGenerationMs) {
            throw new Error(
              `LLM generation exceeded max duration (${retryConfig.maxGenerationMs}ms); aborting job to avoid retry storm`
            );
          }

          const delay = getRetryDelay(attempt, retryConfig, error);
          const rootCause = error instanceof GenerationInterruptedError ? error.cause : error;
          if (rootCause instanceof GeminiApiError && rootCause.status === 429) {
            setGlobalGeminiCooldown(Math.max(delay, retryConfig.global429CooldownMs));
          }
          const reason = getErrorMessage(error);
          logger.warn(
            `LLM generation failed with retryable error (attempt ${attempt + 1}/${retryConfig.maxRetries + 1}), retrying in ${delay}ms: ${reason.substring(0, 240)}`
          );

          await sleep(delay);
          attempt++;
          continue;
        }

        if (hasTools && retryConfig.fallbackNoTools && attempt >= retryConfig.maxRetries && isRetryableError(error)) {
          logger.warn(`Exhausted ${retryConfig.maxRetries} retries for tool calling, attempting fallback without tools`);

          try {
            activeProjectBuilder = null;
            const fallbackResult = await this.executeGeneration({
              prompt: `${prompt}\n\n[Note: Please provide a text response only, as tool execution is temporarily unavailable.]`,
              systemPrompt,
              maxTokens,
              temperature,
              tools: undefined,
            });

            logger.info("Fallback generation without tools succeeded");
            return fallbackResult;
          } catch (fallbackError) {
            logger.error("Fallback generation also failed:", fallbackError);
            throw lastError;
          }
        }

        throw error;
      }
    }

    throw lastError;
  }

  private async invokeGemini(payload: Record<string, unknown>): Promise<GeminiResponse> {
    const base = this.apiBaseUrl.replace(/\/$/, "");
    const endpoint = `${base}/chat/completions`;

    await waitForGlobalGeminiCooldown();

    const sourceContents = Array.isArray(payload.contents)
      ? (payload.contents as Parameters<typeof convertGeminiContentsToOpenAIMessages>[0])
      : [];

    const systemPrompt = isPlainObject(payload.systemInstruction)
      ? (() => {
          const parts = (payload.systemInstruction as { parts?: Array<{ text?: string }> }).parts;
          return Array.isArray(parts) && typeof parts[0]?.text === "string" ? parts[0].text : undefined;
        })()
      : undefined;

    const generationConfig = isPlainObject(payload.generationConfig)
      ? (payload.generationConfig as { temperature?: number; maxOutputTokens?: number })
      : {};

    const toolDeclarations = Array.isArray(payload.tools)
      ? (payload.tools as Array<{ functionDeclarations?: GeminiFunctionDeclaration[] }>)
      : [];

    const openAIPayload: Record<string, unknown> = {
      model: this.model,
      messages: convertGeminiContentsToOpenAIMessages(sourceContents, systemPrompt),
      temperature: typeof generationConfig.temperature === "number" ? generationConfig.temperature : this.temperature,
      max_tokens:
        typeof generationConfig.maxOutputTokens === "number" ? generationConfig.maxOutputTokens : this.maxTokens,
    };

    const firstToolBlock = toolDeclarations[0];
    if (firstToolBlock?.functionDeclarations?.length) {
      openAIPayload.tools = firstToolBlock.functionDeclarations.map((declaration) => ({
        type: "function",
        function: {
          name: declaration.name,
          description: declaration.description,
          parameters: normalizeSchemaType(declaration.parameters),
        },
      }));
      openAIPayload.tool_choice = "auto";
    }

    logger.debug(
      `LLM request -> model=${this.model}, endpoint=${base}/chat/completions, payloadBytes=${JSON.stringify(openAIPayload).length}`
    );

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(openAIPayload),
    });

    const text = await response.text();
    logger.debug(`LLM response <- status=${response.status}, bodyPreview=${text.substring(0, 220)}`);

    if (!response.ok) {
      const retryAfterHeader = response.headers.get("retry-after");
      let retryAfterMs: number | undefined;
      if (retryAfterHeader) {
        const parsedSeconds = Number(retryAfterHeader);
        if (!Number.isNaN(parsedSeconds) && parsedSeconds >= 0) {
          retryAfterMs = Math.round(parsedSeconds * 1000);
        } else {
          const parsedDate = Date.parse(retryAfterHeader);
          if (!Number.isNaN(parsedDate)) {
            retryAfterMs = Math.max(0, parsedDate - Date.now());
          }
        }
      }

      throw new GeminiApiError(
        `OpenAI-compatible API request failed (${response.status}): ${text.substring(0, 300)}`,
        response.status,
        retryAfterMs
      );
    }

    let data: OpenAIChatCompletionResponse;
    try {
      data = JSON.parse(text) as OpenAIChatCompletionResponse;
    } catch {
      throw new Error(`OpenAI-compatible API returned non-JSON response: ${text.substring(0, 300)}`);
    }

    const firstChoice = data.choices?.[0];
    const assistantMessage = firstChoice?.message;
    const parts: GeminiPart[] = [];

    const assistantText = extractTextFromMessageContent(assistantMessage?.content);
    if (assistantText.length > 0) {
      parts.push({ text: assistantText });
    }

    const extractedToolCalls = extractToolCallsFromResponse(data);
    for (const toolCall of extractedToolCalls) {
      parts.push({
        functionCall: {
          name: toolCall.name,
          args: toolCall.args || {},
        },
      });
    }

    if (firstChoice?.finish_reason === "tool_calls" && extractedToolCalls.length === 0) {
      logger.warn(
        `Provider signaled tool_calls but none parsed; raw choice preview=${JSON.stringify(firstChoice || {}).substring(0, 1200)}, raw response preview=${JSON.stringify(data).substring(0, 2200)}`
      );

      const responsesEndpoint = `${base}/responses`;
      const chatMessages = Array.isArray(openAIPayload.messages)
        ? (openAIPayload.messages as Array<{ role?: string; content?: unknown }>)
        : [];

      const responsesPayload: Record<string, unknown> = {
        model: this.model,
        input: chatMessages.filter((message) => message.role !== "system"),
        max_output_tokens: openAIPayload.max_tokens,
        temperature: openAIPayload.temperature,
      };

      if (systemPrompt) {
        responsesPayload.instructions = systemPrompt;
      }

      if (Array.isArray(openAIPayload.tools) && openAIPayload.tools.length > 0) {
        responsesPayload.tools = openAIPayload.tools;
        responsesPayload.tool_choice = "auto";
      }

      logger.warn(
        `Falling back to Responses API for missing tool_calls shape: endpoint=${responsesEndpoint}, payloadBytes=${JSON.stringify(responsesPayload).length}`
      );

      const responsesResult = await fetch(responsesEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(responsesPayload),
      });

      const responsesText = await responsesResult.text();
      logger.debug(`Responses API <- status=${responsesResult.status}, bodyPreview=${responsesText.substring(0, 300)}`);

      if (!responsesResult.ok) {
        throw new GeminiApiError(
          `Responses API fallback failed (${responsesResult.status}): ${responsesText.substring(0, 300)}`,
          responsesResult.status,
        );
      }

      try {
        const responsesJson = JSON.parse(responsesText) as OpenAIResponsesApiResponse;
        const converted = convertResponsesApiToGeminiResponse(responsesJson);
        const convertedParts = converted.candidates?.[0]?.content?.parts || [];
        if (convertedParts.length > 0) {
          return converted;
        }
      } catch {
        logger.warn("Responses API fallback returned non-JSON payload");
      }
    }

    return {
      candidates: [
        {
          content: {
            parts,
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: data.usage?.prompt_tokens,
        candidatesTokenCount: data.usage?.completion_tokens,
        totalTokenCount: data.usage?.total_tokens,
      },
    };
  }

  private async executeGeneration(params: {
    prompt: string;
    systemPrompt?: string;
    maxTokens: number;
    temperature: number;
    tools?: Record<string, ToolDefinition>;
    resumeState?: GenerationResumeState;
  }): Promise<LLMResponse> {
    const { prompt, systemPrompt, maxTokens, temperature, tools, resumeState } = params;
    const hasTools = !!tools && Object.keys(tools).length > 0;
    const retryConfig = getRetryConfig();

    let contents: Array<{
      role: "user" | "model";
      parts: Array<
        | { text: string }
        | { functionCall: { name: string; args: Record<string, unknown> } }
        | { functionResponse: { name: string; response: Record<string, unknown> } }
      >;
    }> = resumeState?.contents || [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ];

    const allToolCalls: NonNullable<LLMResponse["toolCalls"]> = resumeState?.allToolCalls || [];
    let usage: LLMResponse["usage"] = resumeState?.usage;
    let finalText = resumeState?.finalText || "";
    let consecutiveNonProgressTurns = resumeState?.consecutiveNonProgressTurns || 0;

    const maxSteps = hasTools ? Math.max(1, retryConfig.maxToolSteps) : 1;
    let stepsCompleted = resumeState?.stepsCompleted || 0;
    let previousToolCycleSignature = "";
    let repeatedToolCycleCount = 0;

    if (resumeState) {
      logger.debug(
        `Resuming generation from step ${stepsCompleted + 1} with ${allToolCalls.length} prior tool calls and ${contents.length} prior message blocks`
      );
    }

    for (let step = stepsCompleted; step < maxSteps; step++) {
      let payload: Record<string, unknown> = {
        contents,
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
        },
      };

      if (systemPrompt) {
        payload.systemInstruction = {
          parts: [{ text: systemPrompt }],
        };
      }

      if (hasTools && tools) {
        payload.tools = [
          {
            functionDeclarations: Object.values(tools).map((toolDef) => toolDef.declaration),
          },
        ];
        payload.toolConfig = {
          functionCallingConfig: {
            mode: "AUTO",
          },
        };
      }

      let payloadBytes = JSON.stringify(payload).length;
      if (hasTools && (contents.length > 4 || allToolCalls.length > Math.floor(retryConfig.maxToolCalls * 0.5))) {
        const builder = getActiveBuilder();
        const rebuiltContents = rebuildToolLoopContents({
          prompt,
          contents,
          allToolCalls,
          finalText,
          projectFiles: builder?.getFiles() || [],
        });
        const rebuiltPayload: Record<string, unknown> = {
          ...payload,
          contents: rebuiltContents,
        };
        const rebuiltBytes = JSON.stringify(rebuiltPayload).length;

        if (rebuiltBytes < payloadBytes) {
          logger.warn(
            `Rebuilt tool-loop context at step ${step + 1} from ${payloadBytes} bytes to ${rebuiltBytes} bytes using working memory`
          );
          contents = rebuiltContents;
          payload = rebuiltPayload;
          payloadBytes = rebuiltBytes;
        }
      }

      if (hasTools && payloadBytes > MAX_GATEWAY_PAYLOAD_BYTES) {
        const compactedContents = compactContentsForGateway(contents);
        const compactedPayload: Record<string, unknown> = {
          ...payload,
          contents: compactedContents,
        };
        const compactedPayloadBytes = JSON.stringify(compactedPayload).length;

        if (compactedPayloadBytes < payloadBytes) {
          logger.warn(
            `Compacted tool-loop payload at step ${step + 1} from ${payloadBytes} bytes to ${compactedPayloadBytes} bytes to improve gateway compatibility`
          );
          contents = compactedContents;
          payload = compactedPayload;
          payloadBytes = compactedPayloadBytes;
        }
      }

      let result: GeminiResponse;
      try {
        result = await this.invokeGemini(payload);
      } catch (error) {
        if (isRetryableError(error)) {
          logger.debug(
            `Retryable error at generation step ${step + 1}: ${getErrorMessage(error).substring(0, 240)}`
          );
          throw new GenerationInterruptedError(
            "Generation interrupted by retryable API error; preserving state for resume",
            {
              contents,
              allToolCalls,
              usage,
              finalText,
              stepsCompleted,
              consecutiveNonProgressTurns,
            },
            error
          );
        }
        throw error;
      }

      if (result.usageMetadata) {
        usage = {
          promptTokens: result.usageMetadata.promptTokenCount || 0,
          completionTokens: result.usageMetadata.candidatesTokenCount || 0,
          totalTokens: result.usageMetadata.totalTokenCount || 0,
        };
      }

      const candidate = result.candidates?.[0];
      const parts = candidate?.content?.parts || [];

      const textParts = parts
        .map((part) => part.text)
        .filter((value): value is string => typeof value === "string" && value.length > 0);

      if (textParts.length > 0) {
        finalText = textParts.join("\n").trim();
        logger.debug(`Gemini step ${step + 1} text preview: ${finalText.substring(0, 220)}`);
      }

      const functionCalls = parts
        .map((part) => part.functionCall)
        .filter((call): call is GeminiFunctionCall => !!call && typeof call.name === "string");

      if (functionCalls.length > 0) {
        logger.debug(
          `Gemini requested tool calls at step ${step + 1}: ${functionCalls.map((call) => call.name).join(", ")}`
        );

        const currentCycleSignature = functionCalls
          .map((call) => `${call.name}:${JSON.stringify(call.args || {})}`)
          .join("|");

        if (currentCycleSignature === previousToolCycleSignature) {
          repeatedToolCycleCount++;
        } else {
          repeatedToolCycleCount = 0;
          previousToolCycleSignature = currentCycleSignature;
        }

        if (repeatedToolCycleCount >= 3) {
          logger.warn(
            `Detected repeated tool-call cycle at step ${step + 1}; stopping further tool iterations to avoid loop`
          );
          break;
        }
      }

      logger.debug(
        `Gemini step ${step + 1} complete - textParts: ${textParts.length}, functionCalls: ${functionCalls.length}`
      );

      if (functionCalls.length === 0) {
        const hasProjectFiles = !!activeProjectBuilder && activeProjectBuilder.getFiles().length > 0;
        const hasSuccessfulFinalize = allToolCalls.some(
          (toolCall) =>
            toolCall.name === "finalize_project" &&
            toolCall.result &&
            typeof toolCall.result === "object" &&
            (toolCall.result as { success?: boolean }).success === true
        );

        if (hasTools && hasProjectFiles && !hasSuccessfulFinalize) {
          consecutiveNonProgressTurns += 1;

          if (consecutiveNonProgressTurns <= 3) {
            logger.warn(
              `Model returned no tool calls before finalize (step ${step + 1}, non-progress streak=${consecutiveNonProgressTurns}); nudging to continue build-fix-finalize loop`
            );

            contents.push({
              role: "user",
              parts: [
                {
                  text:
                    "Continue from your last state. The project is not finalized yet. Run validate_project_build, fix any reported compiler/build errors using create_file, repeat validation until it passes, then call finalize_project with a projectName.",
                },
              ],
            });

            stepsCompleted = step + 1;
            continue;
          }

          logger.warn(
            `Stopping after ${consecutiveNonProgressTurns} consecutive non-progress turns before finalize to avoid infinite looping`
          );
        }

        stepsCompleted = step + 1;
        break;
      }

      consecutiveNonProgressTurns = 0;

      if (!hasTools || !tools) {
        throw new Error("Model requested tool call but tools are disabled");
      }

      const functionResponseParts: Array<{ functionResponse: { name: string; response: Record<string, unknown> } }> = [];

      let finalizedProjectThisStep = false;

      for (const functionCall of functionCalls) {
        const toolDef = tools[functionCall.name];
        const args = functionCall.args || {};
        let toolResult: unknown;

        if (!toolDef) {
          toolResult = { error: `Unknown tool: ${functionCall.name}` };
        } else {
          const parsed = toolDef.schema.safeParse(args);

          if (!parsed.success) {
            toolResult = {
              error: "Invalid arguments",
              details: parsed.error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
              })),
            };
          } else {
            toolResult = await toolDef.execute(parsed.data as Record<string, unknown>);
          }
        }

        allToolCalls.push({
          name: functionCall.name,
          args,
          result: toolResult,
        });

        if (hasTools && allToolCalls.length >= retryConfig.maxToolCalls) {
          logger.warn(
            `Reached max tool call limit (${retryConfig.maxToolCalls}); stopping tool loop to prevent runaway generation`
          );
          break;
        }

        logger.debug(
          `Tool result recorded for ${functionCall.name}: ${JSON.stringify(toolResult).substring(0, 220)}`
        );

        if (
          functionCall.name === "finalize_project" &&
          toolResult &&
          typeof toolResult === "object" &&
          (toolResult as { success?: boolean }).success === true
        ) {
          finalizedProjectThisStep = true;
        }

        functionResponseParts.push({
          functionResponse: {
            name: functionCall.name,
            response: compactToolResultForModel(functionCall.name, toolResult),
          },
        });
      }

      contents.push({
        role: "user",
        parts: functionResponseParts,
      });

      stepsCompleted = step + 1;

      if (hasTools && allToolCalls.length >= retryConfig.maxToolCalls) {
        break;
      }

      if (finalizedProjectThisStep) {
        logger.info("Project finalized successfully; stopping tool loop early");
        break;
      }
    }

    if (!finalText && allToolCalls.length > 0) {
      finalText = "Task complete.";
      logger.warn("Model completed tool calls without a final text response. Returning fallback text.");
    }

    let projectBuild: ProjectBuildResult | undefined;
    const finalizeCall = getLatestFinalizeCall(allToolCalls);
    if (finalizeCall && finalizeCall.result) {
      const finalizeResult = finalizeCall.result as {
        success: boolean;
        zipPath: string;
        workspaceProjectDir?: string;
        files: string[];
        totalSize: number;
      };

      const builder = getActiveBuilder();
      if (finalizeResult.success && builder) {
        projectBuild = {
          success: true,
          projectDir: builder.getProjectDir(),
          zipPath: finalizeResult.zipPath,
          workspaceProjectDir: finalizeResult.workspaceProjectDir,
          files: finalizeResult.files,
          totalSize: finalizeResult.totalSize,
        };
      }
    }

    return {
      text: finalText,
      toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
      usage,
      projectBuild,
    };
  }

  getActiveProjectBuilder(): ProjectBuilder | null {
    return activeProjectBuilder;
  }

  async generateJobResponse(job: { prompt: string; budget: number }): Promise<string> {
    const systemPrompt = buildHackathonSystemPrompt({
      budget: job.budget,
    });

    const result = await this.generate({
      prompt: job.prompt,
      systemPrompt,
      tools: true,
    });

    return result.text;
  }
}

let llmClientInstance: LLMClient | null = null;

export function getLLMClient(): LLMClient {
  if (!llmClientInstance) {
    llmClientInstance = new LLMClient();
  }
  return llmClientInstance;
}

export default LLMClient;
