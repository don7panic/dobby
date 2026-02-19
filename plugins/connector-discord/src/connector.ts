import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ConnectorCapabilities,
  ConnectorContext,
  ConnectorPlugin,
  ConnectorSendResult,
  GatewayLogger,
  OutboundEnvelope,
} from "@im-agent-gateway/plugin-sdk";
import type { MessageCreateOptions } from "discord.js";
import { mapDiscordMessage } from "./mapper.js";

const DISCORD_MAX_CONTENT_LENGTH = 2000;
const require = createRequire(import.meta.url);

type DiscordJsModule = {
  AttachmentBuilder: typeof import("discord.js").AttachmentBuilder;
  ChannelType: typeof import("discord.js").ChannelType;
  Client: typeof import("discord.js").Client;
  GatewayIntentBits: typeof import("discord.js").GatewayIntentBits;
  Partials: typeof import("discord.js").Partials;
};

type DiscordClient = import("discord.js").Client;

let cachedDiscordJsModule: DiscordJsModule | null = null;

export interface DiscordConnectorConfig {
  botTokenEnv: string;
  allowDirectMessages: boolean;
  allowedGuildIds: string[];
}

interface DiscordEditableMessage {
  id: string;
  edit(options: MessageCreateOptions): Promise<{ id: string }>;
}

interface DiscordMessageStore {
  fetch(messageId: string): Promise<DiscordEditableMessage>;
}

interface DiscordTextChannel {
  type: number;
  isTextBased(): boolean;
  send(options: MessageCreateOptions): Promise<{ id: string }>;
  messages: DiscordMessageStore;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function validateDiscordJsModule(value: unknown): DiscordJsModule | null {
  const loadedModule = asRecord(value);
  if (!loadedModule) {
    return null;
  }

  const moduleRecord = asRecord(loadedModule.default) ?? loadedModule;
  const attachmentBuilder = moduleRecord.AttachmentBuilder;
  const channelType = moduleRecord.ChannelType;
  const client = moduleRecord.Client;
  const gatewayIntentBits = moduleRecord.GatewayIntentBits;
  const partials = moduleRecord.Partials;

  if (typeof attachmentBuilder !== "function") {
    return null;
  }
  if (!channelType || typeof channelType !== "object") {
    return null;
  }
  if (typeof client !== "function") {
    return null;
  }
  if (!gatewayIntentBits || typeof gatewayIntentBits !== "object") {
    return null;
  }
  if (!partials || typeof partials !== "object") {
    return null;
  }

  return {
    AttachmentBuilder: attachmentBuilder as DiscordJsModule["AttachmentBuilder"],
    ChannelType: channelType as DiscordJsModule["ChannelType"],
    Client: client as DiscordJsModule["Client"],
    GatewayIntentBits: gatewayIntentBits as DiscordJsModule["GatewayIntentBits"],
    Partials: partials as DiscordJsModule["Partials"],
  };
}

async function pathExists(pathToCheck: string): Promise<boolean> {
  try {
    await access(pathToCheck);
    return true;
  } catch {
    return false;
  }
}

async function loadDiscordJsModule(): Promise<DiscordJsModule> {
  if (cachedDiscordJsModule) {
    return cachedDiscordJsModule;
  }

  try {
    const loaded = validateDiscordJsModule(await import("discord.js"));
    if (loaded) {
      cachedDiscordJsModule = loaded;
      return loaded;
    }
  } catch {
    // Fall through to local plugin node_modules fallback.
  }

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const fallbackResolveBases = [
    resolve(moduleDir, ".."),
    resolve(moduleDir, "../../../../plugins/connector-discord"),
    resolve(process.cwd(), "plugins/connector-discord"),
  ];

  for (const baseDir of fallbackResolveBases) {
    if (!(await pathExists(baseDir))) {
      continue;
    }

    let resolvedModulePath: string;
    try {
      resolvedModulePath = require.resolve("discord.js", { paths: [baseDir] });
    } catch {
      continue;
    }

    const loaded = validateDiscordJsModule(await import(pathToFileURL(resolvedModulePath).href));
    if (loaded) {
      cachedDiscordJsModule = loaded;
      return loaded;
    }
  }

  throw new Error("Failed to load discord.js");
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

  private discordModule: DiscordJsModule | null = null;
  private client: DiscordClient | null = null;
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
    this.discordModule = await loadDiscordJsModule();

    this.client = new this.discordModule.Client({
      intents: [
        this.discordModule.GatewayIntentBits.Guilds,
        this.discordModule.GatewayIntentBits.GuildMessages,
        this.discordModule.GatewayIntentBits.MessageContent,
        this.discordModule.GatewayIntentBits.DirectMessages,
      ],
      partials: [this.discordModule.Partials.Channel, this.discordModule.Partials.Message],
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

    const discordModule = this.getDiscordModule();
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
          ? new discordModule.AttachmentBuilder(attachment.localPath, { name: attachment.title })
          : new discordModule.AttachmentBuilder(attachment.localPath),
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
    this.discordModule = null;
  }

  private getDiscordModule(): DiscordJsModule {
    if (!this.discordModule) {
      throw new Error("Discord connector is not started");
    }
    return this.discordModule;
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

    const discordModule = this.getDiscordModule();
    if (
      channel.type === discordModule.ChannelType.GuildVoice
      || channel.type === discordModule.ChannelType.GuildStageVoice
    ) {
      throw new Error(`Discord channel '${channelId}' is not text-based`);
    }

    if (!channel.isTextBased()) {
      throw new Error(`Discord channel '${channelId}' is not text-based`);
    }

    return channel;
  }
}
