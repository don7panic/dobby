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
  GatewayLogger,
  OutboundEnvelope,
} from "@im-agent-gateway/plugin-sdk";
import { mapDiscordMessage } from "./mapper.js";

const DISCORD_MAX_CONTENT_LENGTH = 2000;

export interface DiscordConnectorConfig {
  botTokenEnv: string;
  allowDirectMessages: boolean;
  allowedGuildIds: string[];
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

export class DiscordConnector implements ConnectorPlugin {
  readonly id: string;
  readonly platform = "discord" as const;
  readonly name = "discord";
  readonly capabilities: ConnectorCapabilities = {
    supportsEdit: true,
    supportsThread: true,
    supportsTyping: true,
    supportsFileUpload: true,
    maxTextLength: DISCORD_MAX_CONTENT_LENGTH,
  };

  private client: Client | null = null;
  private ctx: ConnectorContext | null = null;
  private botUserId: string | null = null;

  constructor(
    id: string,
    private readonly config: DiscordConnectorConfig,
    private readonly attachmentsRoot: string,
    private readonly logger: GatewayLogger,
  ) {
    this.id = id;
  }

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

    this.client.on("messageCreate", async (message: Message) => {
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
          connectorId: this.id,
          platform: "discord",
          accountId: this.botUserId,
          chatId: message.channelId,
          ...(message.channel.isThread() ? { threadId: message.channelId } : {}),
        });
        return;
      }

      const inbound = await mapDiscordMessage(message, this.id, this.botUserId, this.attachmentsRoot, this.logger);
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

  async stop(): Promise<void> {
    if (!this.client) return;
    this.client.destroy();
    this.client = null;
    this.ctx = null;
    this.botUserId = null;
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
