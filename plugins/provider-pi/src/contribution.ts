import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import {
  AuthStorage,
  type CreateAgentSessionOptions,
  type ToolDefinition,
  createAgentSession,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type BashOperations,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@mariozechner/pi-coding-agent";
import type { Api, ImageContent, Model } from "@mariozechner/pi-ai";
import { z } from "zod";
import type {
  GatewayAgentEvent,
  GatewayAgentRuntime,
  ProviderContributionModule,
  ProviderInstance,
  ProviderInstanceCreateOptions,
  ProviderRuntimeCreateOptions,
} from "@im-agent-gateway/plugin-sdk";

const BOXLITE_CONTEXT_CONVERSATION_KEY_ENV = "__IM_AGENT_BOXLITE_CONVERSATION_KEY";
const BOXLITE_CONTEXT_PROJECT_ROOT_ENV = "__IM_AGENT_BOXLITE_PROJECT_ROOT";

type RuntimeTool = NonNullable<CreateAgentSessionOptions["tools"]>[number];

interface PiProviderConfig {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  agentDir?: string;
  authFile?: string;
  modelsFile?: string;
}

interface BuiltTools {
  activeTools: RuntimeTool[];
  customTools: ToolDefinition[];
}

const piProviderConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).default("off"),
  agentDir: z.string().optional(),
  authFile: z.string().optional(),
  modelsFile: z.string().optional(),
});

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function assertWithinRoot(absolutePath: string, rootDir: string): void {
  const normalizedRoot = resolve(rootDir);
  const normalizedPath = resolve(absolutePath);
  const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;

  if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(rootPrefix)) {
    throw new Error(`Path '${normalizedPath}' is outside allowed project root '${normalizedRoot}'`);
  }
}

function safeSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

function extractAssistantText(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  const blocks = message.content.filter((block): block is { type: "text"; text: string } => block.type === "text");
  return blocks.map((block) => block.text).join("\n");
}

function extractToolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "(no output)";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "(no output)";

  const textBlocks = content.filter(
    (block): block is { type: "text"; text: string } =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      (block as { type: string }).type === "text" &&
      "text" in block,
  );

  const text = textBlocks.map((block) => block.text).join("\n").trim();
  return text.length > 0 ? text : "(no output)";
}

function normalizeMaybePath(configBaseDir: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === "~") return resolve(process.env.HOME ?? "", ".");
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(process.env.HOME ?? "", trimmed.slice(2));
  }
  return resolve(configBaseDir, trimmed);
}

class PiGatewayRuntime implements GatewayAgentRuntime {
  constructor(private readonly session: AgentSession) {}

  async prompt(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    if (options?.images && options.images.length > 0) {
      await this.session.prompt(text, { images: options.images });
      return;
    }
    await this.session.prompt(text);
  }

  subscribe(listener: (event: GatewayAgentEvent) => void): () => void {
    return this.session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        listener({ type: "message_delta", delta: event.assistantMessageEvent.delta });
        return;
      }

      if (event.type === "message_end" && event.message.role === "assistant") {
        const finalText = extractAssistantText(event.message);
        if (finalText.trim().length > 0) {
          listener({ type: "message_complete", text: finalText });
        }
        return;
      }

      if (event.type === "tool_execution_start") {
        listener({ type: "tool_start", toolName: event.toolName });
        return;
      }

      if (event.type === "tool_execution_end") {
        listener({
          type: "tool_end",
          toolName: event.toolName,
          isError: event.isError,
          output: extractToolResultText(event.result),
        });
        return;
      }

      if (event.type === "auto_compaction_start") {
        listener({ type: "status", message: `Compacting context (${event.reason})...` });
        return;
      }

      if (event.type === "auto_retry_start") {
        listener({ type: "status", message: `Retrying (${event.attempt}/${event.maxAttempts})...` });
      }
    });
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  dispose(): void {
    this.session.dispose();
  }
}

class PiProviderInstanceImpl implements ProviderInstance {
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly model: Model<Api>;

  constructor(
    readonly id: string,
    private readonly providerConfig: PiProviderConfig,
    private readonly dataConfig: ProviderInstanceCreateOptions["data"],
    private readonly logger: ProviderInstanceCreateOptions["host"]["logger"],
  ) {
    this.authStorage = AuthStorage.create(providerConfig.authFile);
    this.modelRegistry = new ModelRegistry(this.authStorage, providerConfig.modelsFile);

    const model = this.modelRegistry.find(providerConfig.provider, providerConfig.model);
    if (!model) {
      throw new Error(`Configured model '${providerConfig.provider}/${providerConfig.model}' not found`);
    }
    this.model = model;
  }

  async createRuntime(options: ProviderRuntimeCreateOptions): Promise<GatewayAgentRuntime> {
    const sessionFile = this.getSessionFilePath(options.inbound);
    const sessionDir = dirname(sessionFile);

    await mkdir(this.dataConfig.sessionsDir, { recursive: true });
    await mkdir(this.dataConfig.logsDir, { recursive: true });
    await mkdir(this.dataConfig.stateDir, { recursive: true });
    await mkdir(this.dataConfig.attachmentsDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    const builtTools = this.buildTools(
      options.conversationKey,
      options.route.profile.projectRoot,
      options.route.profile.tools,
      options,
    );

    const sessionOptions = {
      cwd: options.route.profile.projectRoot,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager: SessionManager.open(sessionFile, sessionDir),
      model: this.model,
      thinkingLevel: this.providerConfig.thinkingLevel,
      tools: builtTools.activeTools,
      customTools: builtTools.customTools,
      ...(this.providerConfig.agentDir ? { agentDir: this.providerConfig.agentDir } : {}),
    };

    const { session } = await createAgentSession(sessionOptions);

    this.logger.info(
      {
        providerInstance: this.id,
        activeTools: builtTools.activeTools.map((tool) => tool.name),
      },
      "Provider runtime initialized",
    );

    if (options.route.profile.systemPromptFile) {
      try {
        const prompt = await readFile(options.route.profile.systemPromptFile, "utf-8");
        session.agent.setSystemPrompt(prompt);
      } catch (error) {
        this.logger.warn(
          { err: error, routeId: options.route.routeId, file: options.route.profile.systemPromptFile },
          "Failed to load route system prompt; continuing with default",
        );
      }
    }

    return new PiGatewayRuntime(session);
  }

  private buildTools(
    conversationKey: string,
    projectRoot: string,
    profile: "full" | "readonly",
    options: ProviderRuntimeCreateOptions,
  ): BuiltTools {
    const readOps: ReadOperations = {
      access: async (absolutePath) => {
        assertWithinRoot(absolutePath, projectRoot);
      },
      readFile: async (absolutePath) => {
        assertWithinRoot(absolutePath, projectRoot);
        return readFile(absolutePath);
      },
      detectImageMimeType: async (absolutePath) => {
        const ext = extname(absolutePath).toLowerCase();
        return IMAGE_MIME_TYPES[ext] ?? null;
      },
    };

    const writeOps: WriteOperations = {
      mkdir: async (dir) => {
        assertWithinRoot(dir, projectRoot);
        await mkdir(dir, { recursive: true });
      },
      writeFile: async (absolutePath, content) => {
        assertWithinRoot(absolutePath, projectRoot);
        await writeFile(absolutePath, content, "utf-8");
      },
    };

    const editOps: EditOperations = {
      access: async (absolutePath) => {
        assertWithinRoot(absolutePath, projectRoot);
      },
      readFile: async (absolutePath) => {
        assertWithinRoot(absolutePath, projectRoot);
        return readFile(absolutePath);
      },
      writeFile: async (absolutePath, content) => {
        assertWithinRoot(absolutePath, projectRoot);
        await writeFile(absolutePath, content, "utf-8");
      },
    };

    const bashOps: BashOperations = {
      exec: async (command, cwd, execOptionsFromTool) => {
        const env: NodeJS.ProcessEnv = {
          ...(execOptionsFromTool.env ?? {}),
          [BOXLITE_CONTEXT_CONVERSATION_KEY_ENV]: conversationKey,
          [BOXLITE_CONTEXT_PROJECT_ROOT_ENV]: projectRoot,
        };

        const execOptions = {
          ...(execOptionsFromTool.signal ? { signal: execOptionsFromTool.signal } : {}),
          ...(execOptionsFromTool.timeout !== undefined ? { timeoutSeconds: execOptionsFromTool.timeout } : {}),
          env,
        };

        this.logger.info(
          {
            providerInstance: this.id,
            sandboxExecutorType: options.executor.constructor?.name ?? "unknown",
            cwd,
            timeoutSeconds: execOptions.timeoutSeconds,
          },
          "Dispatching bash command to sandbox executor",
        );

        const result = await options.executor.exec(command, cwd, execOptions);
        const combined = `${result.stdout}${result.stderr}`;
        if (combined.length > 0) {
          execOptionsFromTool.onData(Buffer.from(combined, "utf-8"));
        }

        this.logger.info(
          {
            providerInstance: this.id,
            sandboxExecutorType: options.executor.constructor?.name ?? "unknown",
            code: result.code,
            killed: result.killed,
            stdoutBytes: Buffer.byteLength(result.stdout, "utf-8"),
            stderrBytes: Buffer.byteLength(result.stderr, "utf-8"),
          },
          "Sandbox executor completed bash command",
        );

        return { exitCode: result.killed ? null : result.code };
      },
    };

    const readTool = createReadTool(projectRoot, { operations: readOps }) as RuntimeTool;
    const bashTool = createBashTool(projectRoot, { operations: bashOps }) as RuntimeTool;
    const editTool = createEditTool(projectRoot, { operations: editOps }) as RuntimeTool;
    const writeTool = createWriteTool(projectRoot, { operations: writeOps }) as RuntimeTool;
    const grepTool = createGrepTool(projectRoot) as RuntimeTool;
    const findTool = createFindTool(projectRoot) as RuntimeTool;
    const lsTool = createLsTool(projectRoot) as RuntimeTool;

    if (profile === "readonly") {
      const activeTools = [readTool, grepTool, findTool, lsTool];
      return {
        activeTools,
        customTools: activeTools.map((tool) => this.toCustomToolDefinition(tool)),
      };
    }

    const activeTools = [readTool, bashTool, editTool, writeTool];
    return {
      activeTools,
      customTools: activeTools.map((tool) => this.toCustomToolDefinition(tool)),
    };
  }

  private toCustomToolDefinition(tool: RuntimeTool): ToolDefinition {
    return {
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      execute: (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
    };
  }

  private getSessionFilePath(inbound: ProviderRuntimeCreateOptions["inbound"]): string {
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
      `${chatSegment}.jsonl`,
    );
  }
}

export const providerPiContribution: ProviderContributionModule = {
  kind: "provider",
  createInstance(options) {
    const parsed = piProviderConfigSchema.parse(options.config);
    const agentDir = normalizeMaybePath(options.host.configBaseDir, parsed.agentDir);
    const authFile = normalizeMaybePath(options.host.configBaseDir, parsed.authFile);
    const modelsFile = normalizeMaybePath(options.host.configBaseDir, parsed.modelsFile);

    const normalizedConfig: PiProviderConfig = {
      provider: parsed.provider,
      model: parsed.model,
      thinkingLevel: parsed.thinkingLevel,
      ...(agentDir ? { agentDir } : {}),
      ...(authFile ? { authFile } : {}),
      ...(modelsFile ? { modelsFile } : {}),
    };

    return new PiProviderInstanceImpl(options.instanceId, normalizedConfig, options.data, options.host.logger);
  },
};

export default providerPiContribution;
