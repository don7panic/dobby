import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
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
  type BashOperations,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import type {
  ConversationRuntime,
  GatewayConfig,
  GatewayLogger,
  InboundEnvelope,
  RouteResolution,
} from "../core/types.js";
import { BOXLITE_CONTEXT_CONVERSATION_KEY_ENV, BOXLITE_CONTEXT_PROJECT_ROOT_ENV } from "../sandbox/boxlite-context.js";
import type { Executor } from "../sandbox/executor.js";

interface SessionFactoryOptions {
  config: GatewayConfig;
  executor: Executor;
  logger: GatewayLogger;
}

type RuntimeTool = NonNullable<CreateAgentSessionOptions["tools"]>[number];

interface BuiltTools {
  activeTools: RuntimeTool[];
  customTools: ToolDefinition[];
}

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

export class SessionFactory {
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly model: Model<Api>;

  constructor(private readonly options: SessionFactoryOptions) {
    this.authStorage = new AuthStorage(options.config.agent.authFile);
    this.modelRegistry = new ModelRegistry(this.authStorage, options.config.agent.modelsFile);

    const model = this.modelRegistry.find(options.config.agent.provider, options.config.agent.model);
    if (!model) {
      throw new Error(`Configured model '${options.config.agent.provider}/${options.config.agent.model}' not found`);
    }

    this.model = model;
  }

  async createRuntime(
    conversationKey: string,
    route: RouteResolution,
    inbound: InboundEnvelope,
  ): Promise<ConversationRuntime> {
    const sessionFile = this.getSessionFilePath(inbound);
    const sessionDir = dirname(sessionFile);

    await mkdir(this.options.config.data.sessionsDir, { recursive: true });
    await mkdir(this.options.config.data.logsDir, { recursive: true });
    await mkdir(this.options.config.data.stateDir, { recursive: true });
    await mkdir(this.options.config.data.attachmentsDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    const builtTools = this.buildTools(conversationKey, route.profile.projectRoot, route.profile.tools);

    const sessionOptions = {
      cwd: route.profile.projectRoot,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager: SessionManager.open(sessionFile, sessionDir),
      model: this.model,
      thinkingLevel: this.options.config.agent.thinkingLevel,
      tools: builtTools.activeTools,
      customTools: builtTools.customTools,
      ...(this.options.config.agent.agentDir ? { agentDir: this.options.config.agent.agentDir } : {}),
    };

    const { session } = await createAgentSession(sessionOptions);

    this.options.logger.info(
      {
        activeTools: builtTools.activeTools.map((tool) => tool.name),
        customTools: builtTools.customTools.map((tool) => tool.name),
      },
      "Registered sandbox custom tools",
    );

    if (route.profile.systemPromptFile) {
      try {
        const prompt = await readFile(route.profile.systemPromptFile, "utf-8");
        session.agent.setSystemPrompt(prompt);
      } catch (error) {
        this.options.logger.warn(
          { err: error, routeId: route.routeId, file: route.profile.systemPromptFile },
          "Failed to load route system prompt; continuing with default",
        );
      }
    }

    return {
      key: conversationKey,
      routeId: route.routeId,
      route: route.profile,
      session,
      onEvent: () => {},
      close: async () => {
        session.dispose();
      },
    };
  }

  private buildTools(conversationKey: string, projectRoot: string, profile: "full" | "readonly"): BuiltTools {
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
      exec: async (command, cwd, options) => {
        const includeBoxliteContext = this.options.config.sandbox.backend === "boxlite";
        const env: NodeJS.ProcessEnv = {
          ...(options.env ?? {}),
          ...(includeBoxliteContext
            ? {
                [BOXLITE_CONTEXT_CONVERSATION_KEY_ENV]: conversationKey,
                [BOXLITE_CONTEXT_PROJECT_ROOT_ENV]: projectRoot,
              }
            : {}),
        };

        const execOptions = {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeout !== undefined ? { timeoutSeconds: options.timeout } : {}),
          ...(Object.keys(env).length > 0 ? { env } : {}),
        };

        this.options.logger.info(
          {
            backend: this.options.config.sandbox.backend,
            executorType: this.options.executor.constructor?.name ?? "unknown",
            cwd,
            timeoutSeconds: execOptions.timeoutSeconds,
          },
          "Dispatching bash command to sandbox executor",
        );

        const result = await this.options.executor.exec(command, cwd, execOptions);

        const combined = `${result.stdout}${result.stderr}`;
        if (combined.length > 0) {
          options.onData(Buffer.from(combined, "utf-8"));
        }

        this.options.logger.info(
          {
            backend: this.options.config.sandbox.backend,
            executorType: this.options.executor.constructor?.name ?? "unknown",
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

  private getSessionFilePath(inbound: InboundEnvelope): string {
    const guildSegment = safeSegment(inbound.guildId ?? "dm");
    const channelSegment = safeSegment(inbound.routeChannelId);
    const threadSegment = safeSegment(inbound.threadId ?? "root");
    const chatSegment = safeSegment(inbound.chatId);

    return join(
      this.options.config.data.sessionsDir,
      inbound.platform,
      safeSegment(inbound.accountId),
      guildSegment,
      channelSegment,
      threadSegment,
      `${chatSegment}.jsonl`,
    );
  }
}
