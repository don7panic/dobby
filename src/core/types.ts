import type { ImageContent } from "@mariozechner/pi-ai";
import type { Logger } from "pino";
import type { Executor } from "../sandbox/executor.js";

export type Platform = string;
export type ToolProfile = "full" | "readonly";
export type ExtensionKind = "provider" | "connector" | "sandbox";
export type ExtensionApiVersion = "1.0";
export const BUILTIN_HOST_SANDBOX_ID = "host.builtin";

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

export interface RoutingConfig {
  defaultRouteId?: string;
  routes: Record<string, RouteProfile>;
}

export interface ExtensionPackageConfig {
  package: string;
  enabled?: boolean;
}

export interface ExtensionsConfig {
  allowList: ExtensionPackageConfig[];
}

export interface ExtensionInstanceConfig {
  contributionId: string;
  config: Record<string, unknown>;
}

export interface ProvidersConfig {
  defaultProviderId: string;
  instances: Record<string, ExtensionInstanceConfig>;
}

export interface ConnectorsConfig {
  instances: Record<string, ExtensionInstanceConfig>;
}

export interface SandboxesConfig {
  defaultSandboxId?: string;
  instances: Record<string, ExtensionInstanceConfig>;
}

export interface DataConfig {
  rootDir: string;
  sessionsDir: string;
  attachmentsDir: string;
  logsDir: string;
  stateDir: string;
  dedupTtlMs: number;
}

export interface GatewayConfig {
  extensions: ExtensionsConfig;
  providers: ProvidersConfig;
  connectors: ConnectorsConfig;
  sandboxes: SandboxesConfig;
  routing: RoutingConfig;
  data: DataConfig;
}

export interface RouteResolution {
  routeId: string;
  profile: RouteProfile;
}

export interface PromptPayload {
  text: string;
  images: ImageContent[];
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

export interface ConversationRuntime {
  key: string;
  routeId: string;
  route: RouteProfile;
  providerId: string;
  sandboxId: string;
  runtime: GatewayAgentRuntime;
  close: () => Promise<void>;
}

export interface ExtensionContributionManifest {
  id: string;
  kind: ExtensionKind;
  entry: string;
  capabilities?: Record<string, unknown>;
}

export interface ExtensionManifest {
  apiVersion: ExtensionApiVersion | string;
  name: string;
  version: string;
  contributions: ExtensionContributionManifest[];
}

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

export type ExtensionContributionModule = ProviderContributionModule | ConnectorContributionModule | SandboxContributionModule;

export type GatewayLogger = Logger;
