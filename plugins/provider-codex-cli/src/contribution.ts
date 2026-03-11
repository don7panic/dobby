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
  ProviderRuntimeCreateOptions,
  ProviderSessionArchiveOptions,
} from "@dobby.ai/plugin-sdk";

type CodexSandboxMode = "read-only" | "workspace-write";

interface CodexCliProviderConfig {
  command: string;
  commandArgs: string[];
  model?: string;
  skipGitRepoCheck: boolean;
}

interface ThreadMeta {
  threadId: string;
  updatedAtMs: number;
}

interface CodexRunState {
  finalText?: string;
  activeCommands: Map<string, string>;
}

interface SpawnedCodexChild {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  readonly pid?: number | undefined;
  readonly killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

interface SpawnChildOptions {
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
  stdio: ["pipe", "pipe", "pipe"];
}

type SpawnChild = (command: string, args: string[], options: SpawnChildOptions) => SpawnedCodexChild;

const codexCliProviderConfigSchema = z.object({
  command: z.string().min(1).default("codex"),
  commandArgs: z.array(z.string()).default([]),
  model: z.string().min(1).optional(),
  skipGitRepoCheck: z.boolean().default(false),
});

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeCommand(configBaseDir: string, value: string): string {
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

export function safeSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
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

export function mapToolProfileToSandbox(toolProfile: ProviderRuntimeCreateOptions["route"]["profile"]["tools"]): CodexSandboxMode {
  return toolProfile === "readonly" ? "read-only" : "workspace-write";
}

export function isResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("resume") && !message.includes("thread") && !message.includes("conversation")) {
    return false;
  }

  return (
    message.includes("not found")
    || message.includes("no conversation")
    || message.includes("unknown")
    || message.includes("invalid")
    || message.includes("missing")
  );
}

function asThreadId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function extractErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) {
    const stringified = String(value);
    return stringified.length > 0 ? stringified : undefined;
  }

  for (const candidate of [value.message, value.error, value.detail]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
    if (isRecord(candidate) && typeof candidate.message === "string" && candidate.message.trim().length > 0) {
      return candidate.message;
    }
  }

  return undefined;
}

function safePreview(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 300 ? `${value.slice(0, 297)}...` : value;
  }

  try {
    const stringified = JSON.stringify(value);
    return stringified.length > 300 ? `${stringified.slice(0, 297)}...` : stringified;
  } catch {
    return String(value);
  }
}

function commandItemSummary(item: Record<string, unknown>, command: string): { isError: boolean; output: string } {
  const parts = [`command: ${command}`];
  const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
  const status = typeof item.status === "string" ? item.status : null;
  const aggregatedOutput = typeof item.aggregated_output === "string" ? item.aggregated_output.trim() : "";

  if (status) {
    parts.push(`status: ${status}`);
  }
  if (exitCode !== null) {
    parts.push(`exitCode: ${exitCode}`);
  }
  if (aggregatedOutput.length > 0) {
    parts.push(aggregatedOutput);
  }

  return {
    isError: exitCode !== null && exitCode !== 0,
    output: parts.join("\n"),
  };
}

function actualSpawn(command: string, args: string[], options: SpawnChildOptions): SpawnedCodexChild {
  return spawn(command, args, options) as ChildProcessWithoutNullStreams;
}

export async function loadStoredThreadId(
  sessionMetaPath: string,
  logger: ProviderInstanceCreateOptions["host"]["logger"],
  providerInstance: string,
  conversationKey: string,
): Promise<string | undefined> {
  try {
    const raw = await readFile(sessionMetaPath, "utf-8");
    const parsed = JSON.parse(raw) as ThreadMeta;
    return asThreadId(parsed.threadId);
  } catch (error) {
    const asErr = error as NodeJS.ErrnoException;
    if (asErr.code !== "ENOENT") {
      logger.warn(
        { err: error, providerInstance, conversationKey },
        "Failed to load Codex CLI thread metadata; starting fresh thread",
      );
    }
    return undefined;
  }
}

export class CodexCliGatewayRuntime implements GatewayAgentRuntime {
  private readonly listeners = new Set<(event: GatewayAgentEvent) => void>();
  private activeChild: SpawnedCodexChild | null = null;
  private activeAbortController: AbortController | null = null;

  constructor(
    private readonly providerId: string,
    private readonly conversationKey: string,
    private readonly route: ProviderRuntimeCreateOptions["route"],
    private readonly logger: ProviderInstanceCreateOptions["host"]["logger"],
    private readonly providerConfig: CodexCliProviderConfig,
    private readonly sessionMetaPath: string,
    private threadId: string | undefined,
    private readonly ephemeral: boolean,
    private readonly spawnChild: SpawnChild = actualSpawn,
  ) {}

  subscribe(listener: (event: GatewayAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async prompt(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    const images = options?.images ?? [];
    if (images.length > 0) {
      this.logger.warn(
        {
          providerInstance: this.providerId,
          routeId: this.route.routeId,
          imageCount: images.length,
        },
        "provider.codex-cli ignores image attachments in current phase",
      );
    }

    this.emit({ type: "status", message: "Codex is thinking..." });

    const resumeThreadId = this.threadId;
    try {
      await this.runPrompt(text, resumeThreadId);
      return;
    } catch (error) {
      if (!resumeThreadId || !isResumeError(error)) {
        throw error;
      }

      this.logger.warn(
        {
          err: error,
          providerInstance: this.providerId,
          conversationKey: this.conversationKey,
          previousThreadId: resumeThreadId,
        },
        "Failed to resume Codex CLI thread; creating a fresh thread",
      );

      await this.clearThreadMeta();
      this.threadId = undefined;
      await this.runPrompt(text, undefined);
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

  private async runPrompt(text: string, resumeThreadId: string | undefined): Promise<void> {
    const args = this.buildCodexArgs(resumeThreadId);
    const commandPreview = [this.providerConfig.command, ...args].join(" ");
    const abortController = new AbortController();
    const state: CodexRunState = {
      activeCommands: new Map(),
    };

    this.activeAbortController = abortController;
    this.logger.info(
      {
        providerInstance: this.providerId,
        conversationKey: this.conversationKey,
        routeId: this.route.routeId,
        command: this.providerConfig.command,
        resumeThreadId: resumeThreadId ?? null,
      },
      "Starting Codex CLI prompt",
    );

    let child: SpawnedCodexChild;
    try {
      child = this.spawnChild(this.providerConfig.command, args, {
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      throw this.toSpawnError(error, commandPreview, "");
    }

    this.activeChild = child;

    try {
      const onAbort = () => {
        this.killChildProcess(child);
      };

      if (abortController.signal.aborted) {
        onAbort();
      } else {
        child.once("close", () => {
          abortController.signal.removeEventListener("abort", onAbort);
        });
        abortController.signal.addEventListener("abort", onAbort, { once: true });
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
          this.consumeCodexEvent(parsed, state);
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
          child.stdin.write(text);
          child.stdin.end();
        } catch (error) {
          rejectPromise(error);
        }
      }).catch((error) => {
        throw this.toSpawnError(error, commandPreview, stderrTail);
      });

      const trailingLine = stdoutBuffer.trim();
      if (trailingLine.length > 0) {
        handleLine(trailingLine);
      }

      if (parseFailure) {
        throw parseFailure;
      }

      if (closeResult.code !== 0 && !abortController.signal.aborted) {
        const stderr = stderrTail.trim();
        throw new Error(
          `Codex CLI process exited with code ${closeResult.code} (signal=${closeResult.signal ?? "none"}). `
          + `Command: '${commandPreview}'.`
          + (stderr.length > 0 ? ` stderr: ${stderr}` : ""),
        );
      }

      if (abortController.signal.aborted) {
        return;
      }

      for (const [commandId, command] of state.activeCommands.entries()) {
        this.emit({
          type: "tool_end",
          toolName: command,
          isError: false,
          output: "(command completed)",
        });
        state.activeCommands.delete(commandId);
      }

      if (!state.finalText || state.finalText.trim().length === 0) {
        throw new Error("Codex CLI completed without a final assistant message.");
      }

      this.emit({ type: "message_complete", text: state.finalText });
      await this.persistThreadMeta();

      this.logger.info(
        {
          providerInstance: this.providerId,
          conversationKey: this.conversationKey,
          routeId: this.route.routeId,
          threadId: this.threadId ?? null,
        },
        "Codex CLI prompt finished",
      );
    } finally {
      this.activeChild = null;
      this.activeAbortController = null;
    }
  }

  private consumeCodexEvent(message: unknown, state: CodexRunState): void {
    if (!isRecord(message) || typeof message.type !== "string") {
      this.logger.debug({ preview: safePreview(message) }, "Ignoring non-record Codex CLI event");
      return;
    }

    if (message.type === "thread.started") {
      const threadId = asThreadId(message.thread_id);
      if (threadId) {
        this.threadId = threadId;
      }
      return;
    }

    if (message.type === "error" || message.type === "turn.failed") {
      throw new Error(extractErrorMessage(message) ?? `Codex CLI emitted ${message.type}`);
    }

    if (message.type === "item.started") {
      this.consumeStartedItem(message.item, state);
      return;
    }

    if (message.type === "item.completed") {
      this.consumeCompletedItem(message.item, state);
      return;
    }

    if (message.type === "turn.started" || message.type === "turn.completed") {
      return;
    }

    this.logger.debug({ eventType: message.type, preview: safePreview(message) }, "Ignoring unsupported Codex CLI event");
  }

  private consumeStartedItem(itemValue: unknown, state: CodexRunState): void {
    const item = isRecord(itemValue) ? itemValue : null;
    const itemType = item && typeof item.type === "string" ? item.type : "unknown";
    if (!item) {
      this.logger.debug({ preview: safePreview(itemValue) }, "Ignoring invalid Codex CLI started item");
      return;
    }

    if (itemType !== "command_execution") {
      this.logger.debug({ itemType, preview: safePreview(item) }, "Ignoring non-command Codex CLI started item");
      return;
    }

    const itemId = typeof item.id === "string" ? item.id : randomUUID();
    const command = typeof item.command === "string" && item.command.trim().length > 0
      ? item.command
      : "(unknown command)";
    state.activeCommands.set(itemId, command);
    this.emit({ type: "status", message: `Running command: ${command}` });
    this.emit({ type: "tool_start", toolName: command });
  }

  private consumeCompletedItem(itemValue: unknown, state: CodexRunState): void {
    const item = isRecord(itemValue) ? itemValue : null;
    const itemType = item && typeof item.type === "string" ? item.type : "unknown";
    if (!item) {
      this.logger.debug({ preview: safePreview(itemValue) }, "Ignoring invalid Codex CLI completed item");
      return;
    }

    if (itemType === "command_execution") {
      const itemId = typeof item.id === "string" ? item.id : "";
      const command = state.activeCommands.get(itemId)
        ?? (typeof item.command === "string" && item.command.trim().length > 0 ? item.command : "(unknown command)");
      const summary = commandItemSummary(item, command);
      if (itemId.length > 0) {
        state.activeCommands.delete(itemId);
      }
      this.emit({ type: "tool_end", toolName: command, isError: summary.isError, output: summary.output });
      return;
    }

    if (itemType === "agent_message") {
      const text = typeof item.text === "string" ? item.text.trim() : "";
      if (text.length > 0) {
        state.finalText = text;
      }
      return;
    }

    if (itemType === "reasoning") {
      this.logger.debug({ preview: safePreview(item) }, "Ignoring Codex CLI reasoning item");
      return;
    }

    this.logger.debug({ itemType, preview: safePreview(item) }, "Ignoring unsupported Codex CLI completed item");
  }

  private buildCodexArgs(resumeThreadId: string | undefined): string[] {
    const args: string[] = [
      ...this.providerConfig.commandArgs,
      "-a",
      "never",
      "-C",
      this.route.profile.projectRoot,
      "-s",
      mapToolProfileToSandbox(this.route.profile.tools),
    ];

    if (this.providerConfig.model) {
      args.push("-m", this.providerConfig.model);
    }

    args.push("exec");
    if (resumeThreadId) {
      args.push("resume");
    }

    args.push("--json");

    if (this.providerConfig.skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }

    if (this.ephemeral) {
      args.push("--ephemeral");
    }

    if (resumeThreadId) {
      args.push(resumeThreadId);
    }

    args.push("-");
    return args;
  }

  private killChildProcess(child: SpawnedCodexChild): void {
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
        `Codex CLI command not found: '${this.providerConfig.command}'. `
        + "Install Codex CLI and ensure it is available in PATH, or set providers.items.<id>.command to an absolute executable path.",
      );
    }

    const stderr = stderrTail.trim();
    return new Error(
      `${normalized.message}. Command: '${commandPreview}'.`
      + (stderr.length > 0 ? ` stderr: ${stderr}` : ""),
    );
  }

  private async persistThreadMeta(): Promise<void> {
    if (!this.threadId) return;

    await mkdir(dirname(this.sessionMetaPath), { recursive: true });
    const payload: ThreadMeta = {
      threadId: this.threadId,
      updatedAtMs: Date.now(),
    };
    await writeFile(this.sessionMetaPath, JSON.stringify(payload, null, 2), "utf-8");
  }

  private async clearThreadMeta(): Promise<void> {
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

export class CodexCliProviderInstanceImpl implements ProviderInstance {
  constructor(
    readonly id: string,
    private readonly providerConfig: CodexCliProviderConfig,
    private readonly dataConfig: ProviderInstanceCreateOptions["data"],
    private readonly logger: ProviderInstanceCreateOptions["host"]["logger"],
    private readonly spawnChild: SpawnChild = actualSpawn,
  ) {}

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
        "provider.codex-cli is host-only in current phase; sandbox executor is ignored",
      );
    }

    const sessionMetaPath = options.sessionPolicy === "ephemeral"
      ? this.getEphemeralThreadMetaPath(options.conversationKey)
      : this.getThreadMetaPath(options.inbound);
    const restoredThreadId = options.sessionPolicy === "ephemeral"
      ? undefined
      : await loadStoredThreadId(sessionMetaPath, this.logger, this.id, options.conversationKey);

    this.logger.info(
      {
        providerInstance: this.id,
        routeId: options.route.routeId,
        command: this.providerConfig.command,
        model: this.providerConfig.model ?? null,
        restoredThreadId: restoredThreadId ?? null,
      },
      "Codex CLI provider runtime initialized",
    );

    return new CodexCliGatewayRuntime(
      this.id,
      options.conversationKey,
      options.route,
      this.logger,
      this.providerConfig,
      sessionMetaPath,
      restoredThreadId,
      options.sessionPolicy === "ephemeral",
      this.spawnChild,
    );
  }

  async archiveSession(options: ProviderSessionArchiveOptions): Promise<{ archived: boolean; archivePath?: string }> {
    const sessionMetaPath = options.sessionPolicy === "ephemeral"
      ? this.getEphemeralThreadMetaPath(options.conversationKey)
      : this.getThreadMetaPath(options.inbound);
    const archivePath = await archiveSessionPath(
      this.dataConfig.sessionsDir,
      sessionMetaPath,
      options.archivedAtMs ?? Date.now(),
    );
    return archivePath ? { archived: true, archivePath } : { archived: false };
  }

  private getThreadMetaPath(inbound: ProviderRuntimeCreateOptions["inbound"]): string {
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
      `${chatSegment}.codex-cli-session.json`,
    );
  }

  private getEphemeralThreadMetaPath(conversationKey: string): string {
    return join(
      this.dataConfig.sessionsDir,
      "_cron-ephemeral",
      `${safeSegment(conversationKey)}.codex-cli-session.json`,
    );
  }
}

export const providerCodexCliContribution: ProviderContributionModule = {
  kind: "provider",
  configSchema: z.toJSONSchema(codexCliProviderConfigSchema),
  async createInstance(options) {
    const parsed = codexCliProviderConfigSchema.parse(options.config);
    const config: CodexCliProviderConfig = {
      command: normalizeCommand(options.host.configBaseDir, parsed.command),
      commandArgs: parsed.commandArgs,
      skipGitRepoCheck: parsed.skipGitRepoCheck,
      ...(parsed.model ? { model: parsed.model } : {}),
    };

    return new CodexCliProviderInstanceImpl(options.instanceId, config, options.data, options.host.logger);
  },
};

export default providerCodexCliContribution;
