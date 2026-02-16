import {
  AttachmentBuilder,
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  type MessageCreateOptions,
} from "discord.js";
import type {
  ConnectorCapabilities,
  ConnectorContext,
  ConnectorPlugin,
  ConnectorSendResult,
  DiscordConfig,
  GatewayLogger,
  OutboundEnvelope,
} from "../../core/types.js";
import { mapDiscordMessage } from "./mapper.js";

interface DiscordEditableMessage {
  id: string;
  edit(options: MessageCreateOptions): Promise<{ id: string }>;
}

interface DiscordMessageStore {
  fetch(messageId: string): Promise<DiscordEditableMessage>;
}

interface DiscordTextChannel {
  type: ChannelType;
  isTextBased(): boolean;
  send(options: MessageCreateOptions): Promise<{ id: string }>;
  messages: DiscordMessageStore;
}

function hasMessagingApi(channel: unknown): channel is DiscordTextChannel {
  if (!channel || typeof channel !== "object") return false;

  const maybeChannel = channel as {
    send?: unknown;
    messages?: unknown;
    isTextBased?: unknown;
    type?: unknown;
  };

  return (
    typeof maybeChannel.send === "function" &&
    typeof maybeChannel.isTextBased === "function" &&
    typeof maybeChannel.type === "number" &&
    typeof maybeChannel.messages === "object" &&
    maybeChannel.messages !== null &&
    typeof (maybeChannel.messages as { fetch?: unknown }).fetch === "function"
  );
}

export class DiscordConnector implements ConnectorPlugin {
  readonly platform = "discord" as const;
  readonly name = "discord";
  readonly capabilities: ConnectorCapabilities = {
    supportsEdit: true,
    supportsThread: true,
    supportsTyping: true,
    supportsFileUpload: true,
  };

  private client: Client | null = null;
  private ctx: ConnectorContext | null = null;
  private botUserId: string | null = null;

  constructor(
    private readonly config: DiscordConfig,
    private readonly attachmentsRoot: string,
    private readonly logger: GatewayLogger,
  ) {}

  async start(ctx: ConnectorContext): Promise<void> {
    const token = process.env[this.config.botTokenEnv];
    if (!token) {
      throw new Error(`Discord bot token env '${this.config.botTokenEnv}' is not set`);
    }

    this.ctx = ctx;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.client.once("clientReady", () => {
      if (!this.client?.user) return;
      this.botUserId = this.client.user.id;
      this.logger.info({ userId: this.botUserId, userName: this.client.user.username }, "Discord connector ready");
    });

    this.client.on("messageCreate", async (message) => {
      if (!this.client?.user || !this.ctx || !this.botUserId) return;

      if (message.guildId && this.config.allowedGuildIds.length > 0 && !this.config.allowedGuildIds.includes(message.guildId)) {
        return;
      }

      if (!message.guildId && !this.config.allowDirectMessages) {
        return;
      }

      if (message.author.bot) return;

      if (message.content.trim().toLowerCase() === "stop") {
        await this.ctx.emitControl({
          type: "stop",
          platform: "discord",
          accountId: this.botUserId,
          chatId: message.channelId,
          ...(message.channel.isThread() ? { threadId: message.channelId } : {}),
        });
        return;
      }

      const inbound = await mapDiscordMessage(message, this.botUserId, this.attachmentsRoot, this.logger);
      if (!inbound) return;

      await this.ctx.emitInbound(inbound);
    });

    await this.client.login(token);
  }

  async send(message: OutboundEnvelope): Promise<ConnectorSendResult> {
    if (!this.client) {
      throw new Error("Discord connector is not started");
    }

    const channel = await this.fetchTextChannel(message.chatId);

    if (message.mode === "update") {
      if (!message.targetMessageId) {
        throw new Error("targetMessageId is required for update mode");
      }

      const existing = await channel.messages.fetch(message.targetMessageId);
      const edited = await existing.edit({ content: message.text });
      return { messageId: edited.id };
    }

    const options: MessageCreateOptions = {
      content: message.text,
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

  async stop(): Promise<void> {
    if (!this.client) return;
    this.client.destroy();
    this.client = null;
    this.ctx = null;
    this.botUserId = null;
  }

  private async fetchTextChannel(channelId: string): Promise<DiscordTextChannel> {
    if (!this.client) throw new Error("Discord connector is not started");

    const channel = await this.client.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`Discord channel '${channelId}' not found`);
    }

    if (!hasMessagingApi(channel)) {
      throw new Error(`Discord channel '${channelId}' is not text-based`);
    }

    if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
      throw new Error(`Discord channel '${channelId}' is not text-based`);
    }

    if (!channel.isTextBased()) {
      throw new Error(`Discord channel '${channelId}' is not text-based`);
    }

    return channel;
  }
}
