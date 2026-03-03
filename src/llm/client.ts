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
  parameters: {
    type: "OBJECT";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface ToolDefinition<TArgs extends Record<string, unknown> = Record<string, unknown>, TResult = unknown> {
  description: string;
  schema: ZodTypeAny;
  declaration: GeminiFunctionDeclaration;
  execute: (args: TArgs) => Promise<TResult>;
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

    const tools = enableTools ? this.getTools() : undefined;
    const hasTools = !!tools && Object.keys(tools).length > 0;

    let lastError: unknown;
    let attempt = 0;
    const retryConfig = getRetryConfig();
    const generationStartedAt = Date.now();
    let resumeState: GenerationResumeState | undefined;

    while (attempt <= retryConfig.maxRetries) {
      try {
        return await this.executeGeneration({
          prompt,
          systemPrompt,
          maxTokens,
          temperature,
          tools: hasTools ? tools : undefined,
          resumeState,
        });
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
    const endpoint = `${base}/models/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    await waitForGlobalGeminiCooldown();

    logger.debug(
      `Gemini request -> model=${this.model}, endpoint=${base}/models/{model}:generateContent, payloadBytes=${JSON.stringify(payload).length}`
    );

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    logger.debug(`Gemini response <- status=${response.status}, bodyPreview=${text.substring(0, 220)}`);

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
        `Gemini API request failed (${response.status}): ${text.substring(0, 300)}`,
        response.status,
        retryAfterMs
      );
    }

    let data: GeminiResponse;
    try {
      data = JSON.parse(text) as GeminiResponse;
    } catch {
      throw new Error(`Gemini API returned non-JSON response: ${text.substring(0, 300)}`);
    }

    return data;
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
    const finalizeCall = allToolCalls.find((toolCall) => toolCall.name === "finalize_project");
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
