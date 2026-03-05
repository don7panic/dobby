import type { ImageContent } from "@mariozechner/pi-ai";
import type { Logger } from "pino";

export type Platform = string;
export type ToolProfile = "full" | "readonly";

export interface InboundAttachment {
  id: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  localPath?: string;
  remoteUrl?: string;
}

export interface InboundEnvelope {
  connectorId: string;
  platform: Platform;
  accountId: string;
  guildId?: string;
  routeId: string;
  routeChannelId: string;
  chatId: string;
  threadId?: string;
  messageId: string;
  userId: string;
  userName?: string;
  text: string;
  attachments: InboundAttachment[];
  timestampMs: number;
  raw: unknown;
  isDirectMessage: boolean;
  mentionedBot: boolean;
}

export interface OutboundAttachment {
  localPath: string;
  title?: string;
}

export interface OutboundEnvelope {
  platform: Platform;
  accountId: string;
  chatId: string;
  threadId?: string;
  replyToMessageId?: string;
  mode: "create" | "update";
  targetMessageId?: string;
  text: string;
  attachments?: OutboundAttachment[];
  metadata?: Record<string, string>;
}

export interface ConnectorSendResult {
  messageId?: string;
}

export interface ConnectorTypingEnvelope {
  platform: Platform;
  accountId: string;
  chatId: string;
  threadId?: string;
}

export interface ConnectorContext {
  emitInbound: (msg: InboundEnvelope) => Promise<void>;
  emitControl: (event: {
    type: "stop";
    connectorId: string;
    platform: Platform;
    accountId: string;
    chatId: string;
    threadId?: string;
  }) => Promise<void>;
}

export interface ConnectorCapabilities {
  supportsEdit: boolean;
  supportsThread: boolean;
  supportsTyping: boolean;
  supportsFileUpload: boolean;
  maxTextLength?: number;
}

export interface ConnectorPlugin {
  readonly id: string;
  readonly platform: Platform;
  readonly name: string;
  readonly capabilities: ConnectorCapabilities;
  start(ctx: ConnectorContext): Promise<void>;
  send(message: OutboundEnvelope): Promise<ConnectorSendResult>;
  sendTyping?(message: ConnectorTypingEnvelope): Promise<void>;
  stop(): Promise<void>;
}

export interface RouteProfile {
  projectRoot: string;
  tools: ToolProfile;
  systemPromptFile?: string;
  allowMentionsOnly: boolean;
  maxConcurrentTurns: number;
  providerId?: string;
  sandboxId?: string;
}

export interface RouteResolution {
  routeId: string;
  profile: RouteProfile;
}

export type GatewayAgentEvent =
  | { type: "message_delta"; delta: string }
  | { type: "message_complete"; text: string }
  | { type: "tool_start"; toolName: string }
  | { type: "tool_end"; toolName: string; isError: boolean; output: string }
  | { type: "status"; message: string };

export interface GatewayAgentRuntime {
  prompt(text: string, options?: { images?: ImageContent[] }): Promise<void>;
  subscribe(listener: (event: GatewayAgentEvent) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
}

export interface ExecOptions {
  timeoutSeconds?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  tty?: boolean;
}

export interface SpawnedProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  off(event: "error", listener: (error: Error) => void): void;
}

export interface Executor {
  exec(command: string, cwd: string, options?: ExecOptions): Promise<ExecResult>;
  spawn(options: SpawnOptions): SpawnedProcess;
  close(): Promise<void>;
}

export interface DataConfig {
  rootDir: string;
  sessionsDir: string;
  attachmentsDir: string;
  logsDir: string;
  stateDir: string;
  dedupTtlMs: number;
}

export type GatewayLogger = Logger;

export interface ExtensionHostContext {
  logger: GatewayLogger;
  configBaseDir: string;
}

export interface ProviderRuntimeCreateOptions {
  conversationKey: string;
  route: RouteResolution;
  inbound: InboundEnvelope;
  executor: Executor;
}

export interface ProviderInstance {
  id: string;
  createRuntime(options: ProviderRuntimeCreateOptions): Promise<GatewayAgentRuntime>;
  close?: () => Promise<void>;
}

export interface ProviderInstanceCreateOptions {
  instanceId: string;
  config: Record<string, unknown>;
  host: ExtensionHostContext;
  data: DataConfig;
}

export interface ProviderContributionModule {
  kind: "provider";
  configSchema?: Record<string, unknown>;
  createInstance(options: ProviderInstanceCreateOptions): Promise<ProviderInstance> | ProviderInstance;
}

export interface ConnectorInstanceCreateOptions {
  instanceId: string;
  config: Record<string, unknown>;
  host: ExtensionHostContext;
  attachmentsRoot: string;
}

export interface ConnectorContributionModule {
  kind: "connector";
  configSchema?: Record<string, unknown>;
  createInstance(options: ConnectorInstanceCreateOptions): Promise<ConnectorPlugin> | ConnectorPlugin;
}

export interface SandboxInstance {
  id: string;
  executor: Executor;
  close?: () => Promise<void>;
}

export interface SandboxInstanceCreateOptions {
  instanceId: string;
  config: Record<string, unknown>;
  host: ExtensionHostContext;
}

export interface SandboxContributionModule {
  kind: "sandbox";
  configSchema?: Record<string, unknown>;
  createInstance(options: SandboxInstanceCreateOptions): Promise<SandboxInstance> | SandboxInstance;
}
