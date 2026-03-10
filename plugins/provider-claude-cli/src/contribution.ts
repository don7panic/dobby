import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ImageContent } from "@mariozechner/pi-ai";
import { z } from "zod";
import type {
  GatewayAgentEvent,
  GatewayAgentRuntime,
  ProviderContributionModule,
  ProviderInstance,
  ProviderInstanceCreateOptions,
  ProviderSessionArchiveOptions,
  ProviderRuntimeCreateOptions,
} from "@dobby.ai/plugin-sdk";

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

const DEFAULT_READONLY_TOOLS = ["Read", "Grep", "Glob", "LS"] as const;
const DEFAULT_FULL_TOOLS = [...DEFAULT_READONLY_TOOLS, "Edit", "Write", "Bash"] as const;

const DEFAULT_AUTH_STATUS_TIMEOUT_MS = 10_000;
const EMPTY_SUCCESS_FALLBACK_TEXT = "_Claude completed this turn without user-visible text._";

type ClaudeImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
type AuthMode = "auto" | "subscription" | "apiKey";
type PermissionMode = "acceptEdits" | "bypassPermissions" | "default" | "dontAsk" | "plan";

interface ClaudeCliProviderConfig {
  model: string;
  maxTurns: number;
  command: string;
  commandArgs: string[];
  authMode: AuthMode;
  envAllowList: string[];
  readonlyTools: string[];
  fullTools: string[];
  permissionMode: PermissionMode;
  streamVerbose: boolean;
}

interface SessionMeta {
  sessionId: string;
  updatedAtMs: number;
}

interface ClaudeStreamState {
  assistantFromDeltas: string;
  assistantFromMessage: string;
  assistantFromResult: string;
  sawMaxTurnsError: boolean;
  messageTypeCounts: Record<string, number>;
  streamEventTypeCounts: Record<string, number>;
  streamBlockTypeByIndex: Map<number, string>;
  lastResultSubtype: string | null;
  lastAssistantPreview: string | null;
  lastResultPreview: string | null;
  lastStreamEventPreview: string | null;
}

interface JsonFallbackOutput {
  text: string;
  subtype: string | null;
}

const claudeCliProviderConfigSchema = z.object({
  model: z.string().min(1).default("claude-sonnet-4-5"),
  maxTurns: z.number().int().positive().default(1024),
  command: z.string().min(1).default("claude"),
  commandArgs: z.array(z.string()).default([]),
  authMode: z.enum(["auto", "subscription", "apiKey"]).default("auto"),
  envAllowList: z.array(z.string().min(1)).default([...DEFAULT_ENV_ALLOW_LIST]),
  readonlyTools: z.array(z.string().min(1)).default([...DEFAULT_READONLY_TOOLS]),
  fullTools: z.array(z.string().min(1)).default([...DEFAULT_FULL_TOOLS]),
  permissionMode: z.enum(["acceptEdits", "bypassPermissions", "default", "dontAsk", "plan"]).default("bypassPermissions"),
  streamVerbose: z.boolean().default(true),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function normalizeCommand(configBaseDir: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") {
    return resolve(process.env.HOME ?? "", ".");
  }

  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(process.env.HOME ?? "", trimmed.slice(2));
  }

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

function parseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = parseJsonString(value);
    if (isRecord(parsed)) {
      return parsed;
    }
  }
  return null;
}

function toMessageBody(message: unknown): Record<string, unknown> | null {
  if (!isRecord(message)) {
    return null;
  }

  const wrapped = toRecord(message.message);
  if (wrapped) {
    return wrapped;
  }
  return message;
}

function formatArchiveStamp(timestampMs: number): string {
  return new Date(timestampMs).toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function archiveSessionPath(
  sessionsDir: string,
  sourcePath: string,
  archivedAtMs: number,
): Promise<string | undefined> {
  const relativePath = relative(sessionsDir, sourcePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Session path '${sourcePath}' is outside sessions dir '${sessionsDir}'`);
  }

  const archiveRoot = join(sessionsDir, "_archived", `${formatArchiveStamp(archivedAtMs)}-${randomUUID().slice(0, 8)}`);
  const archivePath = join(archiveRoot, relativePath);
  await mkdir(dirname(archivePath), { recursive: true });

  try {
    await rename(sourcePath, archivePath);
    return archivePath;
  } catch (error) {
    const asErr = error as NodeJS.ErrnoException;
    if (asErr.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isReasoningLikeEventType(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes("thinking") || normalized.includes("reasoning");
}

function collectTextFromContent(content: unknown, includeThinking: boolean): string {
  if (typeof content === "string") {
    const trimmed = content.trim();
    const looksLikeStructured = trimmed.startsWith("{") || trimmed.startsWith("[");
    const parsed = parseJsonString(content);
    if (parsed !== content) {
      const structured = collectTextFromContent(parsed, includeThinking);
      if (structured.length > 0) {
        return structured;
      }
    }

    // Avoid leaking raw JSON-ish blobs (often assistant thinking payloads).
    if (looksLikeStructured) {
      return "";
    }

    return trimmed;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const rawItem of content) {
    if (typeof rawItem === "string") {
      const trimmed = rawItem.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
      continue;
    }

    const item = toRecord(rawItem);
    if (!item) {
      continue;
    }

    const itemType = typeof item.type === "string" ? item.type : "";
    if ((itemType === "text" || itemType === "output_text" || itemType === "input_text") && typeof item.text === "string") {
      const trimmed = item.text.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
      continue;
    }

    if (itemType === "output_text" && typeof item.output_text === "string") {
      const trimmed = item.output_text.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
      continue;
    }

    if (includeThinking && itemType === "thinking" && typeof item.thinking === "string") {
      const trimmed = item.thinking.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
      continue;
    }

    if (itemType.length === 0) {
      for (const candidate of [item.text, item.output_text, item.content]) {
        if (typeof candidate !== "string") {
          continue;
        }

        const trimmed = candidate.trim();
        if (trimmed.length > 0) {
          parts.push(trimmed);
          break;
        }
      }
    }
  }

  return parts.join("\n").trim();
}

function collectTextFromChoices(choices: unknown, includeThinking: boolean): string {
  if (!Array.isArray(choices)) {
    return "";
  }

  const parts: string[] = [];
  for (const rawChoice of choices) {
    const choice = toRecord(rawChoice);
    if (!choice) {
      continue;
    }

    const messageText = collectTextFromRecord(toRecord(choice.message), includeThinking, 1);
    if (messageText.length > 0) {
      parts.push(messageText);
      continue;
    }

    const delta = toRecord(choice.delta);
    let pushedFromDelta = false;
    if (delta) {
      const deltaContent = collectTextFromContent(delta.content, includeThinking);
      if (deltaContent.length > 0) {
        parts.push(deltaContent);
        pushedFromDelta = true;
      } else {
        for (const candidate of [delta.text, delta.output_text]) {
          if (typeof candidate !== "string") {
            continue;
          }
          const trimmed = candidate.trim();
          if (trimmed.length > 0) {
            parts.push(trimmed);
            pushedFromDelta = true;
            break;
          }
        }
      }

      if (pushedFromDelta) {
        continue;
      }
    }

    if (typeof choice.text === "string") {
      const trimmed = choice.text.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
    }
  }

  return parts.join("\n").trim();
}

function collectTextFromRecord(record: Record<string, unknown> | null, includeThinking: boolean, depth = 0): string {
  if (!record || depth > 4) {
    return "";
  }

  const fromContent = collectTextFromContent(record.content, includeThinking);
  if (fromContent.length > 0) {
    return fromContent;
  }

  const fromChoices = collectTextFromChoices(record.choices, includeThinking);
  if (fromChoices.length > 0) {
    return fromChoices;
  }

  for (const candidate of [record.text, record.output_text, record.output]) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  if (includeThinking && typeof record.thinking === "string") {
    const trimmed = record.thinking.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  for (const nested of [record.message, record.result, record.response]) {
    const nestedRecord = toRecord(nested);
    if (!nestedRecord) {
      continue;
    }

    const nestedText = collectTextFromRecord(nestedRecord, includeThinking, depth + 1);
    if (nestedText.length > 0) {
      return nestedText;
    }
  }

  return "";
}

function extractAssistantTextFromMessage(message: unknown): string {
  const body = toMessageBody(message);
  return collectTextFromRecord(body, false);
}

function extractAssistantTextFromResultField(result: unknown): string {
  if (typeof result === "string") {
    const parsed = parseJsonString(result);
    if (parsed !== result) {
      const fromContent = collectTextFromContent(parsed, false);
      if (fromContent.length > 0) {
        return fromContent;
      }

      const parsedText = collectTextFromRecord(toRecord(parsed), false);
      if (parsedText.length > 0) {
        return parsedText;
      }
    }

    return result.trim();
  }

  const fromContent = collectTextFromContent(result, false);
  if (fromContent.length > 0) {
    return fromContent;
  }

  return collectTextFromRecord(toRecord(result), false);
}

function extractAssistantTextFromStructuredOutputField(structuredOutput: unknown): string {
  const fromContent = collectTextFromContent(structuredOutput, false);
  if (fromContent.length > 0) {
    return fromContent;
  }

  const fromRecord = collectTextFromRecord(toRecord(structuredOutput), false);
  if (fromRecord.length > 0) {
    return fromRecord;
  }

  if (typeof structuredOutput === "string") {
    return structuredOutput.trim();
  }
  if (typeof structuredOutput === "number" || typeof structuredOutput === "boolean") {
    return String(structuredOutput);
  }

  try {
    return JSON.stringify(structuredOutput, null, 2).trim();
  } catch {
    return "";
  }
}

function safePreview(value: unknown, maxLength = 500): string | null {
  try {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    if (!raw) return null;
    if (raw.length <= maxLength) return raw;
    return `${raw.slice(0, maxLength)}...(truncated)`;
  } catch {
    return null;
  }
}

function extractTextDelta(message: unknown, state: ClaudeStreamState): string | null {
  if (!isRecord(message) || message.type !== "stream_event") {
    return null;
  }

  const event = toRecord(message.event);
  if (!event) {
    return null;
  }

  const eventType = typeof event.type === "string" ? event.type : "";
  if (isReasoningLikeEventType(eventType)) {
    return null;
  }

  if (eventType === "message_start") {
    state.streamBlockTypeByIndex.clear();
    return null;
  }

  if (eventType === "content_block_start") {
    const index = typeof event.index === "number" ? event.index : -1;
    const contentBlock = toRecord(event.content_block);
    const blockType = typeof contentBlock?.type === "string" ? contentBlock.type.toLowerCase() : "";
    if (index >= 0) {
      state.streamBlockTypeByIndex.set(index, blockType);
    }
    return null;
  }

  const delta = toRecord(event.delta);

  if (eventType === "content_block_delta" && delta) {
    const index = typeof event.index === "number" ? event.index : -1;
    const blockType = index >= 0 ? (state.streamBlockTypeByIndex.get(index) ?? "") : "";
    if (isReasoningLikeEventType(blockType)) {
      return null;
    }
    if (blockType.length > 0 && blockType !== "text" && blockType !== "output_text") {
      return null;
    }

    const deltaType = typeof delta.type === "string" ? delta.type : "";
    if (isReasoningLikeEventType(deltaType)) {
      return null;
    }

    if ((deltaType === "text_delta" || deltaType === "output_text_delta") && typeof delta.text === "string") {
      return delta.text;
    }
    if (deltaType === "output_text_delta" && typeof delta.output_text === "string") {
      return delta.output_text;
    }

    if (deltaType.length > 0) {
      return null;
    }

    // Be tolerant to non-standard payloads only when delta type is absent.
    if (typeof delta.text === "string") return delta.text;
    if (typeof delta.output_text === "string") return delta.output_text;
    return null;
  }

  // OpenAI-compatible streamed text delta shape.
  if (eventType.endsWith("output_text.delta") && typeof event.delta === "string") {
    return event.delta;
  }

  if (eventType.endsWith("text.delta") && typeof event.delta === "string") {
    return event.delta;
  }

  if (delta) {
    if (typeof delta.text === "string") return delta.text;
    if (typeof delta.output_text === "string") return delta.output_text;
    const deltaContent = collectTextFromContent(delta.content, false);
    if (deltaContent.length > 0) {
      return deltaContent;
    }
  }

  const nestedMessage = toRecord(event.message);
  if (nestedMessage) {
    const nestedText = collectTextFromRecord(nestedMessage, false);
    if (nestedText.length > 0) {
      return nestedText;
    }
  }

  return null;
}

function extractSessionId(value: unknown): string | null {
  if (!isRecord(value)) return null;

  const direct = value.session_id;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct;
  }

  const camel = value.sessionId;
  if (typeof camel === "string" && camel.trim().length > 0) {
    return camel;
  }

  return null;
}

function isResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("session") && !message.includes("resume")) {
    return false;
  }

  return (
    message.includes("not found")
    || message.includes("no conversation")
    || message.includes("unknown")
    || message.includes("invalid")
    || message.includes("not exist")
    || message.includes("cannot resume")
  );
}

class ClaudeCliGatewayRuntime implements GatewayAgentRuntime {
  private readonly listeners = new Set<(event: GatewayAgentEvent) => void>();
  private readonly allowedTools: string[];
  private readonly activeToolUses = new Map<string, string>();
  private activeChild: ChildProcessWithoutNullStreams | null = null;
  private activeAbortController: AbortController | null = null;
  private authChecked = false;

  constructor(
    private readonly providerId: string,
    private readonly conversationKey: string,
    private readonly route: ProviderRuntimeCreateOptions["route"],
    private readonly logger: ProviderInstanceCreateOptions["host"]["logger"],
    private readonly providerConfig: ClaudeCliProviderConfig,
    private readonly sessionMetaPath: string,
    private readonly systemPrompt: string | undefined,
    private sessionId: string | undefined,
  ) {
    this.allowedTools = this.route.profile.tools === "readonly"
      ? [...this.providerConfig.readonlyTools]
      : [...this.providerConfig.fullTools];
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
        "Failed to resume Claude CLI session; recreating session",
      );

      await this.clearSessionMeta();
      this.sessionId = undefined;
      await this.runPrompt(text, images, undefined);
    }
  }

  async abort(): Promise<void> {
    const controller = this.activeAbortController;
    if (controller) {
      controller.abort();
    }

    const child = this.activeChild;
    if (child) {
      this.killChildProcess(child);
    }
  }

  dispose(): void {
    this.listeners.clear();
    this.activeToolUses.clear();

    const child = this.activeChild;
    if (child) {
      this.killChildProcess(child);
    }

    this.activeChild = null;
    this.activeAbortController = null;
  }

  private emit(event: GatewayAgentEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async ensureAuthReady(): Promise<void> {
    if (this.authChecked) {
      return;
    }

    if (this.providerConfig.authMode === "apiKey") {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey || apiKey.trim().length === 0) {
        throw new Error("provider.claude-cli requires ANTHROPIC_API_KEY when authMode is 'apiKey'");
      }
      this.authChecked = true;
      return;
    }

    if (this.providerConfig.authMode !== "subscription") {
      this.authChecked = true;
      return;
    }

    const args = [...this.providerConfig.commandArgs, "auth", "status", "--json"];
    const env = this.buildCliEnv();

    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolvePromise, rejectPromise) => {
      const child = spawn(this.providerConfig.command, args, {
        cwd: this.route.profile.projectRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      const timeoutHandle = setTimeout(() => {
        this.killChildProcess(child as unknown as ChildProcessWithoutNullStreams);
      }, DEFAULT_AUTH_STATUS_TIMEOUT_MS);

      child.stdout.on("data", (chunk) => {
        stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
      });

      child.stderr.on("data", (chunk) => {
        stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
      });

      child.once("error", (error) => {
        clearTimeout(timeoutHandle);
        rejectPromise(error);
      });

      child.once("close", (code) => {
        clearTimeout(timeoutHandle);
        resolvePromise({ stdout, stderr, code });
      });
    });

    if (result.code !== 0) {
      const stderr = result.stderr.trim();
      throw new Error(
        `Claude CLI auth check failed (authMode=subscription). `
        + `Run 'claude auth login' or 'claude setup-token'.`
        + (stderr.length > 0 ? ` stderr: ${stderr}` : ""),
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error("Claude CLI auth status returned invalid JSON; cannot verify subscription login state");
    }

    if (!isRecord(parsed) || parsed.loggedIn !== true) {
      throw new Error(
        "Claude CLI is not logged in for subscription mode. "
        + "Run 'claude auth login' or 'claude setup-token' before starting gateway.",
      );
    }

    this.authChecked = true;
  }

  private async runPrompt(text: string, images: ImageContent[], resumeSessionId: string | undefined): Promise<void> {
    await this.ensureAuthReady();

    const sessionId = resumeSessionId ?? randomUUID();
    const args = this.buildCliArgs(sessionId, resumeSessionId);
    const inputPayload = this.buildInputPayload(text, images);
    const env = this.buildCliEnv();

    const commandPreview = [this.providerConfig.command, ...args].join(" ");
    const abortController = new AbortController();

    const state: ClaudeStreamState = {
      assistantFromDeltas: "",
      assistantFromMessage: "",
      assistantFromResult: "",
      sawMaxTurnsError: false,
      messageTypeCounts: {},
      streamEventTypeCounts: {},
      streamBlockTypeByIndex: new Map<number, string>(),
      lastResultSubtype: null,
      lastAssistantPreview: null,
      lastResultPreview: null,
      lastStreamEventPreview: null,
    };

    this.activeAbortController = abortController;
    this.activeToolUses.clear();

    this.logger.info(
      {
        providerInstance: this.providerId,
        conversationKey: this.conversationKey,
        routeId: this.route.routeId,
        resumeSessionId: resumeSessionId ?? null,
        sessionId,
        command: this.providerConfig.command,
      },
      "Starting Claude CLI prompt",
    );

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.providerConfig.command, args, {
        cwd: this.route.profile.projectRoot,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      throw this.toSpawnError(error, commandPreview, "");
    }

    this.activeChild = child;
    this.sessionId = sessionId;

    try {
      const onAbort = () => {
        this.killChildProcess(child);
      };

      if (abortController.signal.aborted) {
        onAbort();
      } else {
        abortController.signal.addEventListener("abort", onAbort, { once: true });
        child.once("close", () => {
          abortController.signal.removeEventListener("abort", onAbort);
        });
      }

      let stdoutBuffer = "";
      let stderrTail = "";
      let parseFailure: Error | null = null;

      const handleLine = (line: string) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }

        try {
          this.consumeClaudeMessage(parsed, state);
        } catch (error) {
          parseFailure = error instanceof Error ? error : new Error(String(error));
          this.killChildProcess(child);
        }
      };

      child.stdout.on("data", (chunk) => {
        const textChunk = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
        if (!textChunk) return;

        stdoutBuffer += textChunk;
        let newlineIndex = stdoutBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            handleLine(line);
          }
          newlineIndex = stdoutBuffer.indexOf("\n");
        }
      });

      child.stderr.on("data", (chunk) => {
        const textChunk = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
        if (!textChunk) return;

        stderrTail += textChunk;
        if (stderrTail.length > 8_000) {
          stderrTail = stderrTail.slice(stderrTail.length - 8_000);
        }
      });

      const closeResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
        child.once("error", (error) => {
          rejectPromise(error);
        });
        child.once("close", (code, signal) => {
          resolvePromise({ code, signal });
        });

        try {
          child.stdin.write(`${inputPayload}\n`);
          child.stdin.end();
        } catch (error) {
          rejectPromise(error);
        }
      }).catch((error) => {
        throw this.toSpawnError(error, commandPreview, stderrTail);
      });

      const restLine = stdoutBuffer.trim();
      if (restLine.length > 0) {
        handleLine(restLine);
      }

      if (parseFailure) {
        throw parseFailure;
      }

      if (closeResult.code !== 0 && !abortController.signal.aborted) {
        const stderr = stderrTail.trim();
        throw new Error(
          `Claude CLI process exited with code ${closeResult.code} (signal=${closeResult.signal ?? "none"}). `
          + `Command: '${commandPreview}'.`
          + (stderr.length > 0 ? ` stderr: ${stderr}` : ""),
        );
      }

      if (state.sawMaxTurnsError) {
        this.emit({ type: "status", message: "Reached max turns; returning partial response." });
      }

      for (const [toolUseId, toolName] of this.activeToolUses.entries()) {
        this.emit({
          type: "tool_end",
          toolName,
          isError: false,
          output: "(tool completed)",
        });
        this.activeToolUses.delete(toolUseId);
      }

      const candidateLengths = {
        message: state.assistantFromMessage.trim().length,
        result: state.assistantFromResult.trim().length,
        deltas: state.assistantFromDeltas.trim().length,
      };

      let finalTextSource: "result" | "message" | "deltas" | "fallback_json" | "empty_success" | "none" = "none";
      const finalText = (() => {
        const result = state.assistantFromResult.trim();
        if (result.length > 0) {
          finalTextSource = "result";
          return result;
        }

        const messageText = state.assistantFromMessage.trim();
        const deltaText = state.assistantFromDeltas.trim();
        if (messageText.length === 0) {
          if (deltaText.length > 0) {
            finalTextSource = "deltas";
            return deltaText;
          }
          return undefined;
        }
        if (deltaText.length === 0) {
          finalTextSource = "message";
          return messageText;
        }

        // Prefer the more complete stream text when assistant message contains only an intro line.
        if (deltaText.length > messageText.length + 30) {
          finalTextSource = "deltas";
          return deltaText;
        }
        finalTextSource = "message";
        return messageText;
      })();

      let resolvedFinalText = finalText;
      if (!resolvedFinalText && !abortController.signal.aborted && state.lastResultSubtype !== "success") {
        this.logger.warn(
          {
            providerInstance: this.providerId,
            conversationKey: this.conversationKey,
            messageTypeCounts: state.messageTypeCounts,
            streamEventTypeCounts: state.streamEventTypeCounts,
            lastResultSubtype: state.lastResultSubtype,
            lastAssistantPreview: state.lastAssistantPreview,
            lastResultPreview: state.lastResultPreview,
            lastStreamEventPreview: state.lastStreamEventPreview,
          },
          "Claude CLI stream produced no assistant text; retrying with output-format=json",
        );

        const fallback = await this.runJsonFallback(text, sessionId, resumeSessionId, abortController);
        if (fallback) {
          resolvedFinalText = fallback.text;
          finalTextSource = "fallback_json";
          if (fallback.subtype) {
            state.lastResultSubtype = fallback.subtype;
          }
        }
      }

      if (!resolvedFinalText && !abortController.signal.aborted && state.lastResultSubtype === "success") {
        resolvedFinalText = EMPTY_SUCCESS_FALLBACK_TEXT;
        finalTextSource = "empty_success";

        this.logger.warn(
          {
            providerInstance: this.providerId,
            conversationKey: this.conversationKey,
            messageTypeCounts: state.messageTypeCounts,
            streamEventTypeCounts: state.streamEventTypeCounts,
            lastResultSubtype: state.lastResultSubtype,
            lastAssistantPreview: state.lastAssistantPreview,
            lastResultPreview: state.lastResultPreview,
            lastStreamEventPreview: state.lastStreamEventPreview,
          },
          "Claude CLI returned success without user-visible assistant text; using fallback placeholder",
        );
      }

      if (resolvedFinalText) {
        this.emit({ type: "message_complete", text: resolvedFinalText });
      } else if (!abortController.signal.aborted) {
        this.logger.warn(
          {
            providerInstance: this.providerId,
            conversationKey: this.conversationKey,
            messageTypeCounts: state.messageTypeCounts,
            streamEventTypeCounts: state.streamEventTypeCounts,
            lastResultSubtype: state.lastResultSubtype,
            lastAssistantPreview: state.lastAssistantPreview,
            lastResultPreview: state.lastResultPreview,
            lastStreamEventPreview: state.lastStreamEventPreview,
          },
          "Claude CLI finished without assistant text",
        );
        throw new Error(
          "Claude CLI completed without assistant text output. "
          + "Likely stream event shape mismatch or non-text-only completion.",
        );
      }

      if (!abortController.signal.aborted) {
        await this.persistSessionMeta();
      }

      this.logger.info(
        {
          providerInstance: this.providerId,
          conversationKey: this.conversationKey,
          routeId: this.route.routeId,
          sessionId: this.sessionId ?? null,
          messageTypeCounts: state.messageTypeCounts,
          streamEventTypeCounts: state.streamEventTypeCounts,
          lastResultSubtype: state.lastResultSubtype,
          finalTextSource,
          candidateLengths,
        },
        "Claude CLI prompt finished",
      );
    } finally {
      this.activeToolUses.clear();
      this.activeChild = null;
      this.activeAbortController = null;
    }
  }

  private async runJsonFallback(
    text: string,
    sessionId: string,
    resumeSessionId: string | undefined,
    abortController: AbortController,
  ): Promise<JsonFallbackOutput | null> {
    const args = this.buildCliArgsJsonFallback(text, sessionId, resumeSessionId);
    const commandPreview = [this.providerConfig.command, ...args].join(" ");
    const env = this.buildCliEnv();

    this.logger.info(
      {
        providerInstance: this.providerId,
        conversationKey: this.conversationKey,
        routeId: this.route.routeId,
        resumeSessionId: resumeSessionId ?? null,
        sessionId: this.sessionId ?? sessionId,
        command: this.providerConfig.command,
      },
      "Starting Claude CLI json fallback",
    );

    const child = spawn(this.providerConfig.command, args, {
      cwd: this.route.profile.projectRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    this.activeChild = child;

    const onAbort = () => {
      this.killChildProcess(child);
    };

    if (abortController.signal.aborted) {
      onAbort();
    } else {
      abortController.signal.addEventListener("abort", onAbort, { once: true });
      child.once("close", () => {
        abortController.signal.removeEventListener("abort", onAbort);
      });
    }

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
    });

    try {
      child.stdin.end();
    } catch {
      // Best-effort close for parity with primary stream runner behavior.
    }

    const closeResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
      child.once("error", (error) => {
        rejectPromise(error);
      });
      child.once("close", (code, signal) => {
        resolvePromise({ code, signal });
      });
    }).catch((error) => {
      throw this.toSpawnError(error, commandPreview, stderr);
    });

    if (closeResult.code !== 0 && !abortController.signal.aborted) {
      const stderrTrimmed = stderr.trim();
      throw new Error(
        `Claude CLI json fallback exited with code ${closeResult.code} (signal=${closeResult.signal ?? "none"}). `
        + `Command: '${commandPreview}'.`
        + (stderrTrimmed.length > 0 ? ` stderr: ${stderrTrimmed}` : ""),
      );
    }

    if (abortController.signal.aborted) {
      return null;
    }

    const raw = stdout.trim();
    if (raw.length === 0) {
      this.logger.warn(
        {
          providerInstance: this.providerId,
          conversationKey: this.conversationKey,
          routeId: this.route.routeId,
        },
        "Claude CLI json fallback returned empty stdout",
      );
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { text: raw, subtype: null };
    }

    const recoveredSessionId = extractSessionId(parsed);
    if (recoveredSessionId) {
      this.sessionId = recoveredSessionId;
    }

    if (isRecord(parsed) && parsed.type === "result") {
      const subtype = typeof parsed.subtype === "string" ? parsed.subtype : null;
      const isError = parsed.is_error === true || (subtype ?? "").startsWith("error_");
      if (isError) {
        const details = Array.isArray(parsed.errors)
          ? parsed.errors.filter((item): item is string => typeof item === "string").join("\n")
          : "";
        throw new Error(details.length > 0 ? details : `Claude query failed (${subtype ?? "unknown_error"})`);
      }

      const fromResult = extractAssistantTextFromResultField(parsed.result);
      if (fromResult.length > 0) {
        return { text: fromResult, subtype };
      }

      const fromStructuredOutput = extractAssistantTextFromStructuredOutputField(parsed.structured_output);
      if (fromStructuredOutput.length > 0) {
        return { text: fromStructuredOutput, subtype };
      }
    }

    const fromMessage = extractAssistantTextFromMessage(parsed);
    if (fromMessage.length > 0) {
      return { text: fromMessage, subtype: null };
    }

    const fromGeneric = collectTextFromRecord(toRecord(parsed), false);
    if (fromGeneric.length > 0) {
      return { text: fromGeneric, subtype: null };
    }

    this.logger.warn(
      {
        providerInstance: this.providerId,
        conversationKey: this.conversationKey,
        routeId: this.route.routeId,
        outputPreview: safePreview(parsed),
      },
      "Claude CLI json fallback produced no assistant text",
    );

    return null;
  }

  private consumeClaudeMessage(message: unknown, state: ClaudeStreamState): void {
    if (isRecord(message) && typeof message.type === "string") {
      state.messageTypeCounts[message.type] = (state.messageTypeCounts[message.type] ?? 0) + 1;
    }

    if (isRecord(message) && message.type === "stream_event") {
      const event = toRecord(message.event);
      if (event && typeof event.type === "string" && event.type.length > 0) {
        state.streamEventTypeCounts[event.type] = (state.streamEventTypeCounts[event.type] ?? 0) + 1;
      } else {
        state.streamEventTypeCounts.unknown = (state.streamEventTypeCounts.unknown ?? 0) + 1;
      }
      state.lastStreamEventPreview = safePreview(event ?? message.event);
    }

    const sessionId = extractSessionId(message);
    if (sessionId) {
      this.sessionId = sessionId;
    }

    const delta = extractTextDelta(message, state);
    if (delta !== null) {
      state.assistantFromDeltas += delta;
      this.emit({ type: "message_delta", delta });
      return;
    }

    if (!isRecord(message)) {
      return;
    }

    if (message.type === "assistant" || (message.type === "message" && message.role === "assistant")) {
      state.lastAssistantPreview = safePreview(message.message ?? message);
      const text = extractAssistantTextFromMessage(message);
      if (text.length > 0) {
        state.assistantFromMessage = text;
      }
      return;
    }

    if (message.type === "system") {
      const subtype = message.subtype;
      if (subtype === "status" && message.status === "compacting") {
        this.emit({ type: "status", message: "Compacting context..." });
      }
      return;
    }

    if (message.type === "tool_progress") {
      const toolUseId = typeof message.tool_use_id === "string" ? message.tool_use_id : "";
      const rawToolName = typeof message.tool_name === "string" ? message.tool_name : "unknown";
      const toolName = normalizeToolName(rawToolName);

      if (toolUseId.length > 0 && !this.activeToolUses.has(toolUseId)) {
        this.activeToolUses.set(toolUseId, toolName);
        this.emit({ type: "tool_start", toolName });
      }
      return;
    }

    if (message.type === "tool_use_summary") {
      const summary = typeof message.summary === "string" ? message.summary : "(tool completed)";
      const preceding = Array.isArray(message.preceding_tool_use_ids)
        ? message.preceding_tool_use_ids.filter((item): item is string => typeof item === "string")
        : [];

      for (const toolUseId of preceding) {
        const toolName = this.activeToolUses.get(toolUseId);
        if (!toolName) {
          continue;
        }

        this.activeToolUses.delete(toolUseId);
        this.emit({
          type: "tool_end",
          toolName,
          isError: false,
          output: summary,
        });
      }
      return;
    }

    if (message.type === "result") {
      state.lastResultPreview = safePreview(message.result ?? message.structured_output ?? message);
      const subtype = typeof message.subtype === "string" ? message.subtype : "";
      state.lastResultSubtype = subtype || null;
      const isError = message.is_error === true || subtype.startsWith("error_");

      if (subtype === "success") {
        const resultText = extractAssistantTextFromResultField(message.result);
        if (resultText.length > 0) {
          state.assistantFromResult = resultText;
        } else {
          const structuredOutputText = extractAssistantTextFromStructuredOutputField(message.structured_output);
          if (structuredOutputText.length > 0) {
            state.assistantFromResult = structuredOutputText;
          }
        }
      }

      if (subtype === "error_max_turns") {
        state.sawMaxTurnsError = true;
        return;
      }

      if (isError) {
        const details = Array.isArray(message.errors)
          ? message.errors.filter((item): item is string => typeof item === "string").join("\n")
          : "";
        throw new Error(details.length > 0 ? details : `Claude query failed (${subtype || "unknown_error"})`);
      }
    }
  }

  private buildCliArgs(sessionId: string, resumeSessionId: string | undefined): string[] {
    const args: string[] = [
      ...this.providerConfig.commandArgs,
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--model",
      this.providerConfig.model,
      "--max-turns",
      String(this.providerConfig.maxTurns),
      "--permission-mode",
      this.providerConfig.permissionMode,
      "--allowedTools",
      ...this.allowedTools,
    ];

    if (this.providerConfig.streamVerbose) {
      args.push("--verbose");
    }

    if (this.providerConfig.permissionMode === "bypassPermissions") {
      args.push("--dangerously-skip-permissions");
    }

    if (this.systemPrompt) {
      args.push("--system-prompt", this.systemPrompt);
    }

    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    } else {
      args.push("--session-id", sessionId);
    }

    return args;
  }

  private buildCliArgsJsonFallback(text: string, sessionId: string, resumeSessionId: string | undefined): string[] {
    const args: string[] = [
      ...this.providerConfig.commandArgs,
      "-p",
      "--output-format",
      "json",
      "--model",
      this.providerConfig.model,
      "--max-turns",
      String(this.providerConfig.maxTurns),
      "--permission-mode",
      this.providerConfig.permissionMode,
      "--allowedTools",
      ...this.allowedTools,
    ];

    if (this.providerConfig.permissionMode === "bypassPermissions") {
      args.push("--dangerously-skip-permissions");
    }

    if (this.systemPrompt) {
      args.push("--append-system-prompt", this.systemPrompt);
    }

    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    } else {
      args.push("--session-id", sessionId);
    }

    args.push(text);
    return args;
  }

  private buildCliEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_AGENT_SDK_CLIENT_APP: "dobby/provider-claude-cli",
    };

    for (const key of this.providerConfig.envAllowList) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }

    if (this.providerConfig.authMode === "subscription") {
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }

    return env;
  }

  private buildInputPayload(text: string, images: ImageContent[]): string {
    const content: Array<Record<string, unknown>> = [
      {
        type: "text",
        text,
      },
    ];

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

    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content,
      },
    });
  }

  private killChildProcess(child: ChildProcessWithoutNullStreams): void {
    if (child.killed) {
      return;
    }

    const pid = child.pid;
    if (pid && process.platform !== "win32") {
      try {
        process.kill(-pid, "SIGKILL");
        return;
      } catch {
        // Fall through to direct child kill.
      }
    }

    child.kill("SIGKILL");
  }

  private toSpawnError(error: unknown, commandPreview: string, stderrTail: string): Error {
    const normalized = error instanceof Error ? error : new Error(String(error));
    const asErr = normalized as NodeJS.ErrnoException;

    if (asErr.code === "ENOENT") {
      return new Error(
        `Claude CLI command not found: '${this.providerConfig.command}'. `
        + "Install Claude Code CLI and ensure it is available in PATH, or set providers.instances.<id>.config.command to an absolute executable path.",
      );
    }

    const stderr = stderrTail.trim();
    return new Error(
      `${normalized.message}. Command: '${commandPreview}'.`
      + (stderr.length > 0 ? ` stderr: ${stderr}` : ""),
    );
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

class ClaudeCliProviderInstanceImpl implements ProviderInstance {
  constructor(
    readonly id: string,
    private readonly providerConfig: ClaudeCliProviderConfig,
    private readonly dataConfig: ProviderInstanceCreateOptions["data"],
    private readonly logger: ProviderInstanceCreateOptions["host"]["logger"],
  ) { }

  async createRuntime(options: ProviderRuntimeCreateOptions): Promise<GatewayAgentRuntime> {
    await mkdir(this.dataConfig.sessionsDir, { recursive: true });

    const executorName = options.executor.constructor?.name ?? "unknown";
    if (executorName !== "HostExecutor") {
      this.logger.warn(
        {
          providerInstance: this.id,
          routeId: options.route.routeId,
          sandboxExecutorType: executorName,
        },
        "provider.claude-cli is host-only in current phase; sandbox executor is ignored",
      );
    }

    const isEphemeral = options.sessionPolicy === "ephemeral";
    const sessionMetaPath = isEphemeral
      ? this.getEphemeralSessionMetaPath(options.conversationKey)
      : this.getSessionMetaPath(options.inbound);
    let restoredSessionId: string | undefined;

    if (!isEphemeral) {
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
            "Failed to load Claude CLI session metadata; starting fresh session",
          );
        }
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
        command: this.providerConfig.command,
        permissionMode: this.providerConfig.permissionMode,
        authMode: this.providerConfig.authMode,
        restoredSession: restoredSessionId ?? null,
      },
      "Claude CLI provider runtime initialized",
    );

    return new ClaudeCliGatewayRuntime(
      this.id,
      options.conversationKey,
      options.route,
      this.logger,
      this.providerConfig,
      sessionMetaPath,
      systemPrompt,
      restoredSessionId,
    );
  }

  async archiveSession(options: ProviderSessionArchiveOptions): Promise<{ archived: boolean; archivePath?: string }> {
    const sessionMetaPath = options.sessionPolicy === "ephemeral"
      ? this.getEphemeralSessionMetaPath(options.conversationKey)
      : this.getSessionMetaPath(options.inbound);
    const archivePath = await archiveSessionPath(
      this.dataConfig.sessionsDir,
      sessionMetaPath,
      options.archivedAtMs ?? Date.now(),
    );
    return archivePath ? { archived: true, archivePath } : { archived: false };
  }

  private getSessionMetaPath(inbound: ProviderRuntimeCreateOptions["inbound"]): string {
    const guildSegment = safeSegment(inbound.guildId ?? "dm");
    const connectorSegment = safeSegment(inbound.connectorId);
    const sourceSegment = safeSegment(inbound.source.id);
    const threadSegment = safeSegment(inbound.threadId ?? "root");
    const chatSegment = safeSegment(inbound.chatId);

    return join(
      this.dataConfig.sessionsDir,
      connectorSegment,
      inbound.platform,
      safeSegment(inbound.accountId),
      guildSegment,
      sourceSegment,
      threadSegment,
      `${chatSegment}.claude-cli-session.json`,
    );
  }

  private getEphemeralSessionMetaPath(conversationKey: string): string {
    return join(
      this.dataConfig.sessionsDir,
      "_cron-ephemeral",
      `${safeSegment(conversationKey)}.claude-cli-session.json`,
    );
  }
}

export const providerClaudeCliContribution: ProviderContributionModule = {
  kind: "provider",
  configSchema: z.toJSONSchema(claudeCliProviderConfigSchema),
  async createInstance(options) {
    const parsed = claudeCliProviderConfigSchema.parse(options.config);
    const command = normalizeCommand(options.host.configBaseDir, parsed.command);

    if (parsed.authMode === "apiKey") {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey || apiKey.trim().length === 0) {
        throw new Error(
          `Provider instance '${options.instanceId}' requires ANTHROPIC_API_KEY when authMode is 'apiKey'`,
        );
      }
    }

    const config: ClaudeCliProviderConfig = {
      model: parsed.model,
      maxTurns: parsed.maxTurns,
      command,
      commandArgs: parsed.commandArgs,
      authMode: parsed.authMode,
      envAllowList: parsed.envAllowList,
      readonlyTools: parsed.readonlyTools,
      fullTools: parsed.fullTools,
      permissionMode: parsed.permissionMode,
      streamVerbose: parsed.streamVerbose,
    };

    return new ClaudeCliProviderInstanceImpl(options.instanceId, config, options.data, options.host.logger);
  },
};

export default providerClaudeCliContribution;
