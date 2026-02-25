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
    maxRetries: config.llmRetryMaxAttempts,
    baseDelayMs: config.llmRetryBaseDelayMs,
    maxDelayMs: config.llmRetryMaxDelayMs,
    fallbackNoTools: config.llmRetryFallbackNoTools,
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
        content: z.string().describe("The complete content of the file"),
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
            },
            required: ["path", "content"],
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const path = String(args.path || "");
          const content = String(args.content || "");
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

      const finalizeSchema = z.object({
        projectName: z.string().describe("A descriptive name for the project"),
      });

      const validateBuildSchema = z.object({});

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
            properties: {},
            required: [],
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
          logger.debug(
            `Preserved resume state: stepsCompleted=${resumeState.stepsCompleted}, toolCalls=${resumeState.allToolCalls.length}, hasText=${resumeState.finalText.length > 0}`
          );
        }

        if (isRetryableError(error) && attempt < retryConfig.maxRetries) {
          const delay = getRetryDelay(attempt, retryConfig, error);
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

    const contents: Array<{
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

    const maxSteps = hasTools ? Infinity : 1;
    let stepsCompleted = resumeState?.stepsCompleted || 0;
    let previousToolCycleSignature = "";
    let repeatedToolCycleCount = 0;

    if (resumeState) {
      logger.debug(
        `Resuming generation from step ${stepsCompleted + 1} with ${allToolCalls.length} prior tool calls and ${contents.length} prior message blocks`
      );
    }

    for (let step = stepsCompleted; step < maxSteps; step++) {
      const payload: Record<string, unknown> = {
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
            response:
              toolResult && typeof toolResult === "object"
                ? (toolResult as Record<string, unknown>)
                : { result: toolResult },
          },
        });
      }

      contents.push({
        role: "user",
        parts: functionResponseParts,
      });

      stepsCompleted = step + 1;

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
