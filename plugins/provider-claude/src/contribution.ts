import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import type { ImageContent } from "@mariozechner/pi-ai";
import {
  query as runClaudeQuery,
  type HookCallback,
  type HookCallbackMatcher,
  type HookEvent,
  type Options as ClaudeSdkOptions,
  type Query as ClaudeSdkQuery,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnOptions as ClaudeSdkSpawnOptions,
  type SpawnedProcess as ClaudeSdkSpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type {
  GatewayAgentEvent,
  GatewayAgentRuntime,
  ProviderContributionModule,
  ProviderInstance,
  ProviderInstanceCreateOptions,
  ProviderRuntimeCreateOptions,
  SpawnOptions as GatewaySpawnOptions,
  SpawnedProcess as GatewaySpawnedProcess,
} from "@dobby.ai/plugin-sdk";

const BOXLITE_CONTEXT_CONVERSATION_KEY_ENV = "__IM_AGENT_BOXLITE_CONVERSATION_KEY";
const BOXLITE_CONTEXT_PROJECT_ROOT_ENV = "__IM_AGENT_BOXLITE_PROJECT_ROOT";

const DEFAULT_ENV_ALLOW_LIST = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
] as const;

const DEFAULT_AUTH_ENV_KEYS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;
const DEFAULT_READONLY_TOOLS = ["Read", "Grep", "Glob", "LS"] as const;
const DEFAULT_FULL_TOOLS = [...DEFAULT_READONLY_TOOLS, "Edit", "Write", "Bash"] as const;

type SettingSource = "user" | "project" | "local";
type ClaudeImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

interface ClaudeProviderConfig {
  model: string;
  maxTurns: number;
  executable?: string;
  executableArgs: string[];
  sandboxedProcess: boolean;
  requireSandboxSpawn: boolean;
  dangerouslySkipPermissions: boolean;
  settingSources: SettingSource[];
  authMode: "env";
  envAllowList: string[];
  authEnvKeys: string[];
  readonlyTools: string[];
  fullTools: string[];
}

interface SessionMeta {
  sessionId: string;
  updatedAtMs: number;
}

const claudeProviderConfigSchema = z.object({
  model: z.string().min(1),
  maxTurns: z.number().int().positive().default(20),
  executable: z.string().optional(),
  executableArgs: z.array(z.string()).default([]),
  sandboxedProcess: z.boolean().default(true),
  requireSandboxSpawn: z.boolean().default(true),
  dangerouslySkipPermissions: z.boolean().default(true),
  settingSources: z.array(z.enum(["user", "project", "local"]))
    .nonempty()
    .default(["project", "local"]),
  authMode: z.literal("env").default("env"),
  envAllowList: z.array(z.string().min(1)).default([...DEFAULT_ENV_ALLOW_LIST]),
  authEnvKeys: z.array(z.string().min(1)).default([...DEFAULT_AUTH_ENV_KEYS]),
  readonlyTools: z.array(z.string().min(1)).default([...DEFAULT_READONLY_TOOLS]),
  fullTools: z.array(z.string().min(1)).default([...DEFAULT_FULL_TOOLS]),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function normalizeExecutable(configBaseDir: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === "~") return resolve(process.env.HOME ?? "", ".");
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(process.env.HOME ?? "", trimmed.slice(2));
  }

  // Treat bare command names (for example `claude`) as command lookup in PATH.
  const looksLikePath = trimmed.startsWith(".")
    || trimmed.startsWith("/")
    || trimmed.startsWith("\\")
    || /^[a-zA-Z]:[\\/]/.test(trimmed)
    || trimmed.includes("/")
    || trimmed.includes("\\");
  if (!looksLikePath) {
    return trimmed;
  }

  return resolve(configBaseDir, trimmed);
}

function safeSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

function assertWithinRoot(pathToCheck: string, rootDir: string): void {
  const normalizedRoot = resolve(rootDir);
  const normalizedPath = resolve(pathToCheck);
  if (normalizedPath === normalizedRoot) return;

  const rootPrefix = normalizedRoot.endsWith("/") || normalizedRoot.endsWith("\\")
    ? normalizedRoot
    : `${normalizedRoot}${process.platform === "win32" ? "\\" : "/"}`;

  if (!normalizedPath.startsWith(rootPrefix)) {
    throw new Error(`Path '${normalizedPath}' is outside allowed project root '${normalizedRoot}'`);
  }
}

function normalizeToolName(toolName: string): string {
  const gatewayMatch = /^gateway__([^_].+)$/.exec(toolName);
  if (gatewayMatch?.[1]) {
    return gatewayMatch[1];
  }
  return toolName;
}

function normalizeClaudeImageMimeType(mimeType: string): ClaudeImageMediaType | null {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "image/jpeg";
  if (normalized === "image/png") return "image/png";
  if (normalized === "image/gif") return "image/gif";
  if (normalized === "image/webp") return "image/webp";
  return null;
}

function stringifyOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "(no output)";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractTextFromToolResponse(value: unknown): string {
  if (!isRecord(value)) return stringifyOutput(value);

  const content = value.content;
  if (!Array.isArray(content)) return stringifyOutput(value);

  const textBlocks = content
    .map((item) => {
      if (!isRecord(item)) return null;
      return typeof item.text === "string" ? item.text : null;
    })
    .filter((item): item is string => typeof item === "string");

  if (textBlocks.length === 0) return stringifyOutput(value);
  return textBlocks.join("\n");
}

function parseToolResult(value: unknown): { isError: boolean; output: string } {
  const text = extractTextFromToolResponse(value);
  const isError = isRecord(value) && (value.isError === true || value.is_error === true);
  return { isError, output: text };
}

function extractAssistantText(message: SDKAssistantMessage): string {
  return message.message.content
    .map((block) => (block.type === "text" ? block.text : null))
    .filter((part): part is string => typeof part === "string")
    .join("\n")
    .trim();
}

function extractTextDelta(message: SDKMessage): string | null {
  if (message.type !== "stream_event") return null;
  const event = message.event;
  if (event.type !== "content_block_delta" || event.delta.type !== "text_delta") {
    return null;
  }

  return event.delta.text;
}

function isResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("session") && !message.includes("resume")) {
    return false;
  }

  return (
    message.includes("not found") ||
    message.includes("no conversation") ||
    message.includes("unknown") ||
    message.includes("invalid") ||
    message.includes("not exist") ||
    message.includes("cannot resume")
  );
}

class ClaudeGatewayRuntime implements GatewayAgentRuntime {
  private readonly listeners = new Set<(event: GatewayAgentEvent) => void>();
  private readonly allowedTools: string[];
  private readonly hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  private readonly activeToolIds = new Set<string>();
  private activeAbortController: AbortController | null = null;
  private lastSpawnCommandPreview: string | null = null;
  private lastSpawnStdoutPreview: string | null = null;
  private lastSpawnStderrPreview: string | null = null;
  private lastApiKeySource: string | null = null;
  private activeQuery: ClaudeSdkQuery | null = null;

  constructor(
    private readonly providerId: string,
    private readonly conversationKey: string,
    private readonly route: ProviderRuntimeCreateOptions["route"],
    private readonly executor: ProviderRuntimeCreateOptions["executor"],
    private readonly logger: ProviderInstanceCreateOptions["host"]["logger"],
    private readonly providerConfig: ClaudeProviderConfig,
    private readonly sessionMetaPath: string,
    private readonly systemPrompt: string | undefined,
    private sessionId: string | undefined,
  ) {
    this.allowedTools = this.buildAllowedTools();
    this.hooks = this.buildHooks();
  }

  subscribe(listener: (event: GatewayAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async prompt(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    const images = options?.images ?? [];
    const resumeSessionId = this.sessionId;

    try {
      await this.runPrompt(text, images, resumeSessionId);
      return;
    } catch (error) {
      if (!resumeSessionId || !isResumeError(error)) {
        throw error;
      }

      this.logger.warn(
        {
          err: error,
          providerInstance: this.providerId,
          conversationKey: this.conversationKey,
          previousSessionId: resumeSessionId,
        },
        "Failed to resume Claude session; recreating session",
      );

      await this.clearSessionMeta();
      this.sessionId = undefined;
      await this.runPrompt(text, images, undefined);
    }
  }

  async abort(): Promise<void> {
    const activeQuery = this.activeQuery;
    const activeAbortController = this.activeAbortController;

    if (activeAbortController) {
      activeAbortController.abort();
    }

    if (activeQuery) {
      await activeQuery.interrupt();
    }
  }

  dispose(): void {
    this.listeners.clear();
    this.activeToolIds.clear();

    const activeQuery = this.activeQuery;
    if (activeQuery?.close) {
      activeQuery.close();
    }

    this.activeQuery = null;
    this.activeAbortController = null;
  }

  private emit(event: GatewayAgentEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async runPrompt(text: string, images: ImageContent[], resumeSessionId: string | undefined): Promise<void> {
    const userSessionId = resumeSessionId ?? this.sessionId ?? randomUUID();
    const userMessage = this.buildUserMessage(text, images, userSessionId);
    const abortController = new AbortController();
    const pathToClaudeCodeExecutable = this.resolvePathToClaudeCodeExecutable();

    const queryOptions: ClaudeSdkOptions = {
      cwd: this.route.profile.projectRoot,
      model: this.providerConfig.model,
      abortController,
      maxTurns: this.providerConfig.maxTurns,
      tools: this.allowedTools,
      allowedTools: this.allowedTools,
      hooks: this.hooks,
      env: this.buildSdkEnv(),
      settingSources: this.providerConfig.settingSources,
      permissionMode: this.providerConfig.dangerouslySkipPermissions ? "bypassPermissions" : "default",
      ...(this.providerConfig.dangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
      ...(this.providerConfig.sandboxedProcess
        ? {
          spawnClaudeCodeProcess: (spawnOptions: ClaudeSdkSpawnOptions) => this.spawnClaudeProcess(spawnOptions),
        }
        : {}),
      ...(this.systemPrompt ? { systemPrompt: this.systemPrompt } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
      ...(this.providerConfig.executableArgs.length > 0 ? { executableArgs: this.providerConfig.executableArgs } : {}),
    };

    let queryHandle: ClaudeSdkQuery;
    try {
      queryHandle = runClaudeQuery({
        prompt: this.singleMessageStream(userMessage),
        options: queryOptions,
      });
    } catch (error) {
      throw this.enhanceSandboxSpawnError(error);
    }

    this.activeAbortController = abortController;
    this.activeQuery = queryHandle;
    this.sessionId = userSessionId;

    let assistantFromDeltas = "";
    let assistantFromMessage = "";
    let assistantFromResult = "";

    try {
      for await (const message of queryHandle) {
        if (typeof message.session_id === "string" && message.session_id.trim().length > 0) {
          this.sessionId = message.session_id;
        }

        if (message.type === "system" && message.subtype === "init") {
          this.lastApiKeySource = message.apiKeySource;

          if (this.providerConfig.authMode === "env" && this.lastApiKeySource === "none") {
            throw new Error(
              "Claude Code did not detect credentials from environment (apiKeySource=none). " +
              "Set ANTHROPIC_API_KEY in gateway process env. ANTHROPIC_AUTH_TOKEN alone is not sufficient in this SDK/CLI mode.",
            );
          }
          continue;
        }

        const delta = extractTextDelta(message);
        if (delta !== null) {
          assistantFromDeltas += delta;
          this.emit({ type: "message_delta", delta });
          continue;
        }

        if (message.type === "assistant") {
          const textFromAssistant = extractAssistantText(message);
          if (textFromAssistant.length > 0) {
            assistantFromMessage = textFromAssistant;
          }
          continue;
        }

        if (message.type === "system" && message.subtype === "status" && message.status === "compacting") {
          this.emit({ type: "status", message: "Compacting context..." });
          continue;
        }

        if (message.type === "result") {
          const resultSubtype = message.subtype;
          if (resultSubtype === "success") {
            assistantFromResult = message.result;
          }

          if (resultSubtype === "error_max_turns") {
            this.emit({ type: "status", message: "Reached max turns; returning partial response." });
            continue;
          }

          if (message.is_error === true || resultSubtype.startsWith("error_")) {
            const errors = "errors" in message ? message.errors : [];
            const details = errors.length > 0 ? errors.join("\n") : `Claude query failed (${String(resultSubtype)})`;
            throw new Error(details);
          }
        }
      }

      const finalText = [assistantFromDeltas, assistantFromMessage, assistantFromResult].find(
        (candidate) => candidate.trim().length > 0,
      );

      if (finalText) {
        this.emit({ type: "message_complete", text: finalText });
      }

      await this.persistSessionMeta();
    } catch (error) {
      throw this.enhanceSandboxSpawnError(error);
    } finally {
      this.activeAbortController = null;
      this.activeQuery = null;
    }
  }

  private spawnClaudeProcess(spawnOptions: ClaudeSdkSpawnOptions): ClaudeSdkSpawnedProcess {
    const normalizedCwd = resolve(spawnOptions.cwd ?? this.route.profile.projectRoot);
    assertWithinRoot(normalizedCwd, this.route.profile.projectRoot);
    const attemptedCommand = [spawnOptions.command, ...spawnOptions.args].join(" ").trim();
    this.lastSpawnCommandPreview = attemptedCommand.length <= 240
      ? attemptedCommand
      : `${attemptedCommand.slice(0, 237)}...`;

    const spawned = this.executor.spawn({
      command: spawnOptions.command,
      args: spawnOptions.args,
      cwd: normalizedCwd,
      env: {
        ...spawnOptions.env,
        ...this.buildSandboxProcessEnv(spawnOptions.env),
        ...this.buildSandboxContextEnv(),
      },
      signal: spawnOptions.signal,
      tty: false,
    } satisfies GatewaySpawnOptions);

    this.captureSpawnStderr(spawned);
    return this.toClaudeSdkSpawnedProcess(spawned);
  }

  private toClaudeSdkSpawnedProcess(process: GatewaySpawnedProcess): ClaudeSdkSpawnedProcess {
    if (!(process.stdin instanceof Writable) || !(process.stdout instanceof Readable)) {
      throw new Error("Sandbox executor returned non-Node streams; incompatible with Claude SDK spawn contract");
    }

    return {
      stdin: process.stdin,
      stdout: process.stdout,
      get killed() {
        return process.killed;
      },
      get exitCode() {
        return process.exitCode;
      },
      kill(signal: NodeJS.Signals) {
        return process.kill(signal);
      },
      on(event, listener) {
        if (event === "exit") {
          process.on("exit", listener as (code: number | null, signal: NodeJS.Signals | null) => void);
          return;
        }
        process.on("error", listener as (error: Error) => void);
      },
      once(event, listener) {
        if (event === "exit") {
          process.once("exit", listener as (code: number | null, signal: NodeJS.Signals | null) => void);
          return;
        }
        process.once("error", listener as (error: Error) => void);
      },
      off(event, listener) {
        if (event === "exit") {
          process.off("exit", listener as (code: number | null, signal: NodeJS.Signals | null) => void);
          return;
        }
        process.off("error", listener as (error: Error) => void);
      },
    };
  }

  private resolvePathToClaudeCodeExecutable(): string | undefined {
    if (this.providerConfig.executable) {
      return this.providerConfig.executable;
    }

    // Sandboxed mode must avoid host absolute cli.js path from SDK defaults.
    if (this.providerConfig.sandboxedProcess) {
      return "claude";
    }

    return undefined;
  }

  private buildSandboxProcessEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const fallbackPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    const pathSegments = [`/home/claude/.local/bin`, `/root/.local/bin`, baseEnv.PATH ?? fallbackPath]
      .join(":")
      .split(":")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    const dedupedPath = [...new Set(pathSegments)].join(":");

    return {
      HOME: "/home/claude",
      TMPDIR: "/tmp",
      PATH: dedupedPath,
    };
  }

  private captureSpawnStderr(process: GatewaySpawnedProcess): void {
    let stdoutTail = "";
    let stderrTail = "";
    const maxTailLength = 8_000;

    process.stdout.on("data", (chunk: unknown) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
      if (!text) {
        return;
      }

      stdoutTail += text;
      if (stdoutTail.length > maxTailLength) {
        stdoutTail = stdoutTail.slice(stdoutTail.length - maxTailLength);
      }
    });

    process.stderr.on("data", (chunk: unknown) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
      if (!text) {
        return;
      }

      stderrTail += text;
      if (stderrTail.length > maxTailLength) {
        stderrTail = stderrTail.slice(stderrTail.length - maxTailLength);
      }
    });

    const recordTail = () => {
      const stdoutTrimmed = stdoutTail.trim();
      const trimmed = stderrTail.trim();
      this.lastSpawnStdoutPreview = stdoutTrimmed.length > 0 ? stdoutTrimmed : null;
      this.lastSpawnStderrPreview = trimmed.length > 0 ? trimmed : null;
    };

    process.once("exit", () => {
      recordTail();
    });
    process.once("error", () => {
      recordTail();
    });
  }

  private enhanceSandboxSpawnError(error: unknown): Error {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (!this.providerConfig.sandboxedProcess) {
      return normalized;
    }

    const exitCodeMatch = /claude code process exited with code (\d+)/i.exec(normalized.message);
    const exitCode = exitCodeMatch ? Number.parseInt(exitCodeMatch[1] ?? "", 10) : NaN;
    if (Number.isNaN(exitCode)) {
      return normalized;
    }

    const attempted = this.lastSpawnCommandPreview ?? this.resolvePathToClaudeCodeExecutable() ?? "(unknown)";
    const stdoutSuffix = this.lastSpawnStdoutPreview
      ? ` stdout: ${this.lastSpawnStdoutPreview}`
      : "";
    const stderrSuffix = this.lastSpawnStderrPreview
      ? ` stderr: ${this.lastSpawnStderrPreview}`
      : "";

    if (exitCode === 127) {
      return new Error(
        `${normalized.message}. Sandbox command was not found: '${attempted}'. ` +
        "Ensure the sandbox image has Claude Code installed and available in PATH, " +
        "or set providers.instances.<id>.config.executable to a valid in-sandbox executable." +
        stdoutSuffix +
        stderrSuffix,
      );
    }

    if (exitCode === 1) {
      const authHint = this.lastApiKeySource === "none"
        ? " Claude init reported apiKeySource=none; ensure ANTHROPIC_API_KEY is exported to the gateway process."
        : "";
      return new Error(
        `${normalized.message}. Claude process started but failed during initialization inside sandbox.` +
        ` Command: '${attempted}'.` +
        " Verify ANTHROPIC_* auth/model envs and sandbox runtime HOME/PATH assumptions." +
        authHint +
        stdoutSuffix +
        stderrSuffix,
      );
    }

    return new Error(`${normalized.message}. Command: '${attempted}'.${stdoutSuffix}${stderrSuffix}`);
  }

  private buildSdkEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_AGENT_SDK_CLIENT_APP: "dobby/provider-claude",
    };

    for (const key of this.providerConfig.envAllowList) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }

    // Claude Code SDK/CLI auth detection relies on ANTHROPIC_API_KEY.
    // If user only provides ANTHROPIC_AUTH_TOKEN (common with gateway/proxy setups),
    // alias it to ANTHROPIC_API_KEY for the spawned sandbox process.
    if (!env.ANTHROPIC_API_KEY && env.ANTHROPIC_AUTH_TOKEN) {
      env.ANTHROPIC_API_KEY = env.ANTHROPIC_AUTH_TOKEN;
    }

    return env;
  }

  private buildSandboxContextEnv(): NodeJS.ProcessEnv {
    return {
      [BOXLITE_CONTEXT_CONVERSATION_KEY_ENV]: this.conversationKey,
      [BOXLITE_CONTEXT_PROJECT_ROOT_ENV]: this.route.profile.projectRoot,
    };
  }

  private buildUserMessage(text: string, images: ImageContent[], sessionId: string): SDKUserMessage {
    const content: NonNullable<SDKUserMessage["message"]["content"]> = [{ type: "text", text }];

    for (const image of images) {
      const mimeType = normalizeClaudeImageMimeType(image.mimeType);
      if (!mimeType) {
        continue;
      }

      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mimeType,
          data: image.data,
        },
      });
    }

    return {
      type: "user",
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content,
      },
    };
  }

  private async *singleMessageStream(message: SDKUserMessage): AsyncGenerator<SDKUserMessage, void, undefined> {
    yield message;
  }

  private buildAllowedTools(): string[] {
    const source = this.route.profile.tools === "readonly"
      ? this.providerConfig.readonlyTools
      : this.providerConfig.fullTools;
    return [...source];
  }

  private buildHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const preToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") {
        return { continue: true };
      }

      const rawToolName = input.tool_name;
      const displayToolName = normalizeToolName(rawToolName);
      const toolUseId = input.tool_use_id;

      if (toolUseId.length > 0 && this.activeToolIds.has(toolUseId)) {
        return { continue: true };
      }

      if (toolUseId.length > 0) {
        this.activeToolIds.add(toolUseId);
      }

      this.emit({ type: "tool_start", toolName: displayToolName });
      return { continue: true };
    };

    const postToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== "PostToolUse") {
        return { continue: true };
      }

      const rawToolName = input.tool_name;
      const displayToolName = normalizeToolName(rawToolName);
      const toolUseId = input.tool_use_id;
      const parsed = parseToolResult(input.tool_response);

      if (toolUseId.length > 0) {
        this.activeToolIds.delete(toolUseId);
      }

      this.emit({
        type: "tool_end",
        toolName: displayToolName,
        isError: parsed.isError,
        output: parsed.output,
      });
      return { continue: true };
    };

    const postToolUseFailure: HookCallback = async (input) => {
      if (input.hook_event_name !== "PostToolUseFailure") {
        return { continue: true };
      }

      const rawToolName = input.tool_name;
      const displayToolName = normalizeToolName(rawToolName);
      const toolUseId = input.tool_use_id;

      if (toolUseId.length > 0) {
        this.activeToolIds.delete(toolUseId);
      }

      const errorText = input.error || "Tool failed";
      this.emit({
        type: "tool_end",
        toolName: displayToolName,
        isError: true,
        output: errorText,
      });
      return { continue: true };
    };

    const notification: HookCallback = async (input) => {
      if (input.hook_event_name !== "Notification") {
        return { continue: true };
      }

      const message = input.message;
      if (message && message.trim().length > 0) {
        this.emit({ type: "status", message });
      }
      return { continue: true };
    };

    const sessionStart: HookCallback = async (input) => {
      if (input.hook_event_name === "SessionStart" && input.source === "resume") {
        this.emit({ type: "status", message: "Resumed previous Claude session." });
      }
      return { continue: true };
    };

    return {
      PreToolUse: [{ hooks: [preToolUse] }],
      PostToolUse: [{ hooks: [postToolUse] }],
      PostToolUseFailure: [{ hooks: [postToolUseFailure] }],
      Notification: [{ hooks: [notification] }],
      SessionStart: [{ hooks: [sessionStart] }],
    };
  }

  private async persistSessionMeta(): Promise<void> {
    if (!this.sessionId) return;
    await mkdir(dirname(this.sessionMetaPath), { recursive: true });
    const payload: SessionMeta = {
      sessionId: this.sessionId,
      updatedAtMs: Date.now(),
    };
    await writeFile(this.sessionMetaPath, JSON.stringify(payload, null, 2), "utf-8");
  }

  private async clearSessionMeta(): Promise<void> {
    try {
      await unlink(this.sessionMetaPath);
    } catch (error) {
      const asErr = error as NodeJS.ErrnoException;
      if (asErr.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

class ClaudeProviderInstanceImpl implements ProviderInstance {
  constructor(
    readonly id: string,
    private readonly providerConfig: ClaudeProviderConfig,
    private readonly dataConfig: ProviderInstanceCreateOptions["data"],
    private readonly logger: ProviderInstanceCreateOptions["host"]["logger"],
  ) { }

  async createRuntime(options: ProviderRuntimeCreateOptions): Promise<GatewayAgentRuntime> {
    await mkdir(this.dataConfig.sessionsDir, { recursive: true });

    const sessionMetaPath = this.getSessionMetaPath(options.inbound);
    let restoredSessionId: string | undefined;

    try {
      const raw = await readFile(sessionMetaPath, "utf-8");
      const parsed = JSON.parse(raw) as SessionMeta;
      if (typeof parsed.sessionId === "string" && parsed.sessionId.trim().length > 0) {
        restoredSessionId = parsed.sessionId;
      }
    } catch (error) {
      const asErr = error as NodeJS.ErrnoException;
      if (asErr.code !== "ENOENT") {
        this.logger.warn(
          { err: error, providerInstance: this.id, conversationKey: options.conversationKey },
          "Failed to load Claude session metadata; starting fresh session",
        );
      }
    }

    let systemPrompt: string | undefined;
    if (options.route.profile.systemPromptFile) {
      try {
        systemPrompt = await readFile(options.route.profile.systemPromptFile, "utf-8");
      } catch (error) {
        this.logger.warn(
          {
            err: error,
            providerInstance: this.id,
            routeId: options.route.routeId,
            file: options.route.profile.systemPromptFile,
          },
          "Failed to load route system prompt; continuing without custom system prompt",
        );
      }
    }

    this.logger.info(
      {
        providerInstance: this.id,
        model: this.providerConfig.model,
        routeId: options.route.routeId,
        tools: options.route.profile.tools,
        sandboxedProcess: this.providerConfig.sandboxedProcess,
        dangerouslySkipPermissions: this.providerConfig.dangerouslySkipPermissions,
        settingSources: this.providerConfig.settingSources,
        restoredSession: restoredSessionId ?? null,
      },
      "Claude provider runtime initialized",
    );

    return new ClaudeGatewayRuntime(
      this.id,
      options.conversationKey,
      options.route,
      options.executor,
      this.logger,
      this.providerConfig,
      sessionMetaPath,
      systemPrompt,
      restoredSessionId,
    );
  }

  private getSessionMetaPath(inbound: ProviderRuntimeCreateOptions["inbound"]): string {
    const guildSegment = safeSegment(inbound.guildId ?? "dm");
    const connectorSegment = safeSegment(inbound.connectorId);
    const channelSegment = safeSegment(inbound.routeChannelId);
    const threadSegment = safeSegment(inbound.threadId ?? "root");
    const chatSegment = safeSegment(inbound.chatId);

    return join(
      this.dataConfig.sessionsDir,
      connectorSegment,
      inbound.platform,
      safeSegment(inbound.accountId),
      guildSegment,
      channelSegment,
      threadSegment,
      `${chatSegment}.claude-session.json`,
    );
  }
}

export const providerClaudeContribution: ProviderContributionModule = {
  kind: "provider",
  async createInstance(options) {
    const parsed = claudeProviderConfigSchema.parse(options.config);
    const executable = normalizeExecutable(options.host.configBaseDir, parsed.executable);

    const authCandidates = [...new Set(parsed.authEnvKeys)];
    const hasAuthEnv = authCandidates.some((key) => {
      const value = process.env[key];
      return typeof value === "string" && value.trim().length > 0;
    });
    const hasApiKey = typeof process.env.ANTHROPIC_API_KEY === "string"
      && process.env.ANTHROPIC_API_KEY.trim().length > 0;
    const hasAuthToken = typeof process.env.ANTHROPIC_AUTH_TOKEN === "string"
      && process.env.ANTHROPIC_AUTH_TOKEN.trim().length > 0;

    if (!hasAuthEnv) {
      throw new Error(
        `Provider instance '${options.instanceId}' requires one of auth envs: ${authCandidates.join(", ")}`,
      );
    }

    if (!hasApiKey && hasAuthToken) {
      options.host.logger.info(
        {
          providerInstance: options.instanceId,
        },
        "ANTHROPIC_AUTH_TOKEN detected without ANTHROPIC_API_KEY; provider.claude will alias token to ANTHROPIC_API_KEY for sandbox process",
      );
    }

    const config: ClaudeProviderConfig = {
      model: parsed.model,
      maxTurns: parsed.maxTurns,
      executableArgs: parsed.executableArgs,
      sandboxedProcess: parsed.sandboxedProcess,
      requireSandboxSpawn: parsed.requireSandboxSpawn,
      dangerouslySkipPermissions: parsed.dangerouslySkipPermissions,
      settingSources: parsed.settingSources,
      authMode: parsed.authMode,
      envAllowList: parsed.envAllowList,
      authEnvKeys: parsed.authEnvKeys,
      readonlyTools: parsed.readonlyTools,
      fullTools: parsed.fullTools,
      ...(executable ? { executable } : {}),
    };

    return new ClaudeProviderInstanceImpl(options.instanceId, config, options.data, options.host.logger);
  },
};

export default providerClaudeContribution;
