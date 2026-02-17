import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { Logger } from "pino";

export type Platform = "discord";
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
  platform: Platform;
  accountId: string;
  guildId?: string;
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
  emitControl: (event: { type: "stop"; platform: Platform; accountId: string; chatId: string; threadId?: string }) => Promise<void>;
}

export interface ConnectorCapabilities {
  supportsEdit: boolean;
  supportsThread: boolean;
  supportsTyping: boolean;
  supportsFileUpload: boolean;
}

export interface ConnectorPlugin {
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
}

export interface RoutingConfig {
  defaultRouteId?: string;
  channelMap: Record<string, string>;
  routes: Record<string, RouteProfile>;
}

export interface DiscordConfig {
  enabled: boolean;
  botTokenEnv: string;
  allowDirectMessages: boolean;
  allowedGuildIds: string[];
}

export interface AgentConfig {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  agentDir?: string;
  authFile?: string;
  modelsFile?: string;
}

export type SandboxConfig =
  | { backend: "host" }
  | {
      backend: "docker";
      docker: {
        container: string;
        hostWorkspaceRoot: string;
        containerWorkspaceRoot: string;
      };
    }
  | {
      backend: "boxlite";
      boxlite: {
        workspaceRoot: string;
        image: string;
        cpus?: number;
        memoryMib?: number;
        containerWorkspaceRoot: string;
        reuseMode: "conversation" | "workspace";
        autoRemove: boolean;
        securityProfile: "development" | "standard" | "maximum";
      };
    };

export interface DataConfig {
  rootDir: string;
  sessionsDir: string;
  attachmentsDir: string;
  logsDir: string;
  stateDir: string;
  dedupTtlMs: number;
}

export interface GatewayConfig {
  discord: DiscordConfig;
  routing: RoutingConfig;
  agent: AgentConfig;
  sandbox: SandboxConfig;
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

export interface ConversationRuntime {
  key: string;
  routeId: string;
  route: RouteProfile;
  session: AgentSession;
  onEvent: (event: AgentSessionEvent) => void;
  close: () => Promise<void>;
}

export type GatewayLogger = Logger;
