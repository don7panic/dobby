import {
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type MessageCreateOptions,
  type SendableChannels,
} from "discord.js";
import type {
  ConnectorCapabilities,
  ConnectorContext,
  ConnectorPlugin,
  ConnectorSendResult,
  ConnectorTypingEnvelope,
  GatewayLogger,
  OutboundEnvelope,
} from "@dobby.ai/plugin-sdk";
import { mapDiscordMessage } from "./mapper.js";

const DISCORD_MAX_CONTENT_LENGTH = 2000;
const DEFAULT_RECONNECT_STALE_MS = 60_000;
const DEFAULT_RECONNECT_CHECK_INTERVAL_MS = 10_000;

export interface DiscordConnectorConfig {
  botName: string;
  botToken: string;
  reconnectStaleMs?: number;
  reconnectCheckIntervalMs?: number;
}

function clampDiscordContent(text: string): string {
  if (text.length <= DISCORD_MAX_CONTENT_LENGTH) {
    return text;
  }

  const suffix = "\n...(truncated)";
  const budget = DISCORD_MAX_CONTENT_LENGTH - suffix.length;
  if (budget <= 0) {
    return text.slice(0, DISCORD_MAX_CONTENT_LENGTH);
  }

  return `${text.slice(0, budget)}${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export class DiscordConnector implements ConnectorPlugin {
  readonly id: string;
  readonly platform = "discord" as const;
  readonly name = "discord";
  readonly capabilities: ConnectorCapabilities = {
    updateStrategy: "edit",
    supportedSources: ["channel"],
    supportsThread: true,
    supportsTyping: true,
    supportsFileUpload: true,
    maxTextLength: DISCORD_MAX_CONTENT_LENGTH,
  };

  private client: Client | null = null;
  private ctx: ConnectorContext | null = null;
  private botUserId: string | null = null;
  private botToken: string | null = null;
  private reconnectWatchdog: NodeJS.Timeout | null = null;
  private reconnectInFlight = false;
  private lastHealthyAtMs = 0;
  private stopped = false;

  constructor(
    id: string,
    private readonly config: DiscordConnectorConfig,
    private readonly attachmentsRoot: string,
    private readonly logger: GatewayLogger,
  ) {
    this.id = id;
  }

  async start(ctx: ConnectorContext): Promise<void> {
    if (this.client) {
      this.logger.warn({ connectorId: this.id }, "Discord connector start called while already started");
      return;
    }

    const token = this.config.botToken.trim();
    if (!token) {
      throw new Error("Discord bot token is empty");
    }

    this.ctx = ctx;
    this.botToken = token;
    this.stopped = false;
    this.lastHealthyAtMs = Date.now();

    this.client = this.createClient();
    this.bindClientEventHandlers(this.client);
    await this.client.login(token);
    this.startReconnectWatchdog();
  }

  async send(message: OutboundEnvelope): Promise<ConnectorSendResult> {
    if (!this.client) {
      throw new Error("Discord connector is not started");
    }

    const channel = await this.fetchTextChannel(message.chatId);
    const content = clampDiscordContent(message.text);
    if (content !== message.text) {
      this.logger.warn(
        {
          originalLength: message.text.length,
          truncatedLength: content.length,
          mode: message.mode,
          chatId: message.chatId,
        },
        "Outbound Discord message exceeded 2000 characters and was truncated",
      );
    }

    if (message.mode === "update") {
      if (!message.targetMessageId) {
        throw new Error("targetMessageId is required for update mode");
      }

      const existing = await channel.messages.fetch(message.targetMessageId);
      const edited = await existing.edit({ content });
      return { messageId: edited.id };
    }

    const options: MessageCreateOptions = {
      content,
    };

    if (message.replyToMessageId) {
      options.reply = { messageReference: message.replyToMessageId, failIfNotExists: false };
    }

    if (message.attachments && message.attachments.length > 0) {
      options.files = message.attachments.map((attachment) =>
        attachment.title
          ? new AttachmentBuilder(attachment.localPath, { name: attachment.title })
          : new AttachmentBuilder(attachment.localPath),
      );
    }

    const sent = await channel.send(options);
    return { messageId: sent.id };
  }

  async sendTyping(message: ConnectorTypingEnvelope): Promise<void> {
    if (!this.client) {
      throw new Error("Discord connector is not started");
    }

    const channel = await this.fetchTextChannel(message.chatId);
    await channel.sendTyping();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopReconnectWatchdog();
    this.reconnectInFlight = false;
    if (!this.client) return;

    const client = this.client;
    this.client = null;
    client.removeAllListeners();
    client.destroy();
    this.ctx = null;
    this.botUserId = null;
    this.botToken = null;
    this.lastHealthyAtMs = 0;
  }

  private createClient(): Client {
    return new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  private bindClientEventHandlers(client: Client): void {
    client.once("clientReady", () => {
      if (client !== this.client || !client.user) return;
      this.botUserId = client.user.id;
      this.lastHealthyAtMs = Date.now();
      this.logger.info(
        {
          userId: this.botUserId,
          userName: client.user.username,
          configuredBotName: this.config.botName,
        },
        "Discord connector ready",
      );
    });

    client.on("shardDisconnect", (event, shardId) => {
      if (client !== this.client) return;
      this.logger.warn(
        {
          shardId,
          reconnecting: client.ws.shards.get(shardId)?.status === 5,
          ...this.parseCloseEvent(event),
        },
        "Discord shard disconnected",
      );
    });

    client.on("shardReconnecting", (shardId) => {
      if (client !== this.client) return;
      this.logger.warn({ shardId }, "Discord shard reconnecting");
    });

    client.on("shardResume", (shardId, replayedEvents) => {
      if (client !== this.client) return;
      this.lastHealthyAtMs = Date.now();
      this.logger.info({ shardId, replayedEvents }, "Discord shard resumed");
    });

    client.on("error", (error) => {
      if (client !== this.client) return;
      this.logger.warn({ err: error }, "Discord client error");
    });

    client.on("shardError", (error, shardId) => {
      if (client !== this.client) return;
      this.logger.warn({ err: error, shardId }, "Discord shard error");
    });

    client.on("invalidated", () => {
      if (client !== this.client) return;
      this.logger.error("Discord session invalidated; forcing reconnect");
      void this.forceReconnect("session_invalidated");
    });

    client.on("messageCreate", async (message: Message) => {
      if (client !== this.client || !client.user || !this.ctx || !this.botUserId) return;

      if (message.author.bot) return;

      const sourceId = message.channel.isThread() && message.channel.parentId ? message.channel.parentId : message.channelId;

      const inbound = await mapDiscordMessage(
        message,
        this.id,
        this.botUserId,
        sourceId,
        this.attachmentsRoot,
        this.logger,
      );
      if (!inbound) return;

      await this.ctx.emitInbound(inbound);
    });
  }

  private startReconnectWatchdog(): void {
    if (this.reconnectWatchdog) return;
    const intervalMs = this.config.reconnectCheckIntervalMs ?? DEFAULT_RECONNECT_CHECK_INTERVAL_MS;
    this.reconnectWatchdog = setInterval(() => {
      void this.ensureConnected();
    }, intervalMs);
  }

  private stopReconnectWatchdog(): void {
    if (!this.reconnectWatchdog) return;
    clearInterval(this.reconnectWatchdog);
    this.reconnectWatchdog = null;
  }

  private async ensureConnected(): Promise<void> {
    const client = this.client;
    if (!client || this.stopped || this.reconnectInFlight) return;

    if (client.isReady()) {
      this.lastHealthyAtMs = Date.now();
      return;
    }

    const staleMs = Date.now() - this.lastHealthyAtMs;
    const thresholdMs = this.config.reconnectStaleMs ?? DEFAULT_RECONNECT_STALE_MS;
    if (staleMs < thresholdMs) {
      return;
    }

    this.logger.warn({ staleMs, thresholdMs }, "Discord connector remained not-ready for too long; forcing reconnect");
    await this.forceReconnect("watchdog_not_ready");
  }

  private async forceReconnect(reason: string): Promise<void> {
    if (this.stopped || this.reconnectInFlight || !this.botToken) {
      return;
    }

    this.reconnectInFlight = true;
    const previousClient = this.client;

    try {
      if (previousClient) {
        previousClient.removeAllListeners();
        previousClient.destroy();
      }

      this.botUserId = null;
      this.lastHealthyAtMs = Date.now();

      const nextClient = this.createClient();
      this.client = nextClient;
      this.bindClientEventHandlers(nextClient);
      await nextClient.login(this.botToken);
      this.logger.info({ reason }, "Discord reconnect login submitted");
    } catch (error) {
      this.logger.error({ err: error, reason }, "Failed to force Discord reconnect");
    } finally {
      this.reconnectInFlight = false;
    }
  }

  private parseCloseEvent(event: unknown): Record<string, unknown> {
    if (!isRecord(event)) return {};
    const result: Record<string, unknown> = {};
    if (typeof event.code === "number") result.code = event.code;
    if (typeof event.reason === "string" && event.reason.length > 0) result.reason = event.reason;
    if (typeof event.wasClean === "boolean") result.wasClean = event.wasClean;
    return result;
  }

  private async fetchTextChannel(channelId: string): Promise<SendableChannels> {
    if (!this.client) throw new Error("Discord connector is not started");

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isSendable()) {
      throw new Error(`Discord channel '${channelId}' is not text-based`);
    }

    return channel;
  }
}
