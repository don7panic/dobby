import { randomUUID } from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import type {
  ConnectorCapabilities,
  ConnectorContext,
  ConnectorPlugin,
  ConnectorSendResult,
  GatewayLogger,
  OutboundEnvelope,
} from "@dobby.ai/plugin-sdk";
import { mapFeishuMessageEvent, type FeishuMessageEvent } from "./mapper.js";

export interface FeishuConnectorConfig {
  appId: string;
  appSecret: string;
  domain?: "feishu" | "lark";
  botName?: string;
  botOpenId?: string;
  messageFormat?: "text" | "card_markdown";
  replyMode?: "direct" | "reply";
  cardTitle?: string;
  chatRouteMap: Record<string, string>;
  downloadAttachments?: boolean;
}

const FEISHU_CARD_MAX_TEXT_LENGTH = 8_000;
const FEISHU_TEXT_MAX_TEXT_LENGTH = 12_000;

function resolveDomain(domain?: "feishu" | "lark"): string {
  return domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

function textContent(text: string): string {
  return JSON.stringify({ text });
}

function cardContent(text: string, title: string): string {
  return JSON.stringify({
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: title,
      },
    },
    elements: [
      {
        tag: "markdown",
        content: text.trim().length > 0 ? text : "(empty response)",
      },
    ],
  });
}

function toSendResult(messageId?: string): ConnectorSendResult {
  return messageId ? { messageId } : {};
}

export class FeishuConnector implements ConnectorPlugin {
  readonly id: string;
  readonly platform = "feishu" as const;
  readonly name = "feishu";
  readonly capabilities: ConnectorCapabilities;

  private ctx: ConnectorContext | null = null;
  private client: Lark.Client | null = null;
  private wsClient: Lark.WSClient | null = null;

  constructor(
    id: string,
    private readonly config: FeishuConnectorConfig,
    private readonly attachmentsRoot: string,
    private readonly logger: GatewayLogger,
  ) {
    this.id = id;
    this.capabilities = {
      updateStrategy: this.messageFormat === "card_markdown" ? "final_only" : "edit",
      supportsThread: this.replyMode === "reply",
      supportsTyping: false,
      supportsFileUpload: false,
      maxTextLength: this.messageFormat === "card_markdown" ? FEISHU_CARD_MAX_TEXT_LENGTH : FEISHU_TEXT_MAX_TEXT_LENGTH,
    };
  }

  async start(ctx: ConnectorContext): Promise<void> {
    if (this.wsClient) {
      this.logger.warn({ connectorId: this.id }, "Feishu connector start called while already started");
      return;
    }

    const baseConfig = {
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: resolveDomain(this.config.domain),
    };

    this.ctx = ctx;
    this.client = new Lark.Client(baseConfig);
    this.wsClient = new Lark.WSClient(baseConfig);
    await this.logAppSubscriptionState();

    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (event: FeishuMessageEvent) => {
        if (!this.ctx || !this.client) {
          return;
        }

        const routeId = this.config.chatRouteMap[event.message.chat_id];
        if (!routeId) {
          this.logger.debug(
            {
              connectorId: this.id,
              chatId: event.message.chat_id,
            },
            "Ignoring Feishu message from unmapped chat",
          );
          return;
        }

        this.logger.info(
          {
            connectorId: this.id,
            routeId,
            chatId: event.message.chat_id,
            messageId: event.message.message_id,
            chatType: event.message.chat_type,
            messageType: event.message.message_type,
            mentionCount: event.message.mentions?.length ?? 0,
          },
          "Feishu inbound event received",
        );

        const inbound = await mapFeishuMessageEvent({
          event,
          connectorId: this.id,
          routeId,
          attachmentsRoot: this.attachmentsRoot,
          client: this.client,
          logger: this.logger,
          downloadAttachments: this.config.downloadAttachments !== false,
          ...(this.config.botOpenId ? { botOpenId: this.config.botOpenId } : {}),
          ...(this.config.botName ? { botName: this.config.botName } : {}),
        });
        if (!inbound) {
          return;
        }

        this.logger.info(
          {
            connectorId: this.id,
            routeId,
            chatId: inbound.chatId,
            messageId: inbound.messageId,
            isDirectMessage: inbound.isDirectMessage,
            mentionedBot: inbound.mentionedBot,
            textLength: inbound.text.length,
            attachmentCount: inbound.attachments.length,
          },
          "Feishu inbound event mapped",
        );

        await this.ctx.emitInbound(inbound);
      },
    });

    await this.wsClient.start({
      eventDispatcher: dispatcher,
    });

    this.logger.info(
      {
        connectorId: this.id,
        mappedChats: Object.keys(this.config.chatRouteMap).length,
        domain: this.config.domain ?? "feishu",
        messageFormat: this.messageFormat,
        replyMode: this.replyMode,
      },
      "Feishu connector ready",
    );
  }

  async send(message: OutboundEnvelope): Promise<ConnectorSendResult> {
    if (!this.client) {
      throw new Error("Feishu connector is not started");
    }

    if (message.attachments && message.attachments.length > 0) {
      this.logger.warn(
        {
          connectorId: this.id,
          chatId: message.chatId,
          attachmentCount: message.attachments.length,
        },
        "Outbound Feishu attachments are not supported yet; sending text only",
      );
    }

    if (message.mode === "update") {
      if (!message.targetMessageId) {
        throw new Error("targetMessageId is required for update mode");
      }

      if (this.messageFormat === "card_markdown") {
        await this.client.im.v1.message.patch({
          path: {
            message_id: message.targetMessageId,
          },
          data: {
            content: this.renderContent(message.text),
          },
        });
        return { messageId: message.targetMessageId };
      }

      const response = await this.client.im.v1.message.update({
        path: {
          message_id: message.targetMessageId,
        },
        data: {
          msg_type: "text",
          content: this.renderContent(message.text),
        },
      });
      return { messageId: response.data?.message_id ?? message.targetMessageId };
    }

    if (this.replyMode === "reply" && message.replyToMessageId) {
      const response = await this.client.im.v1.message.reply({
        path: {
          message_id: message.replyToMessageId,
        },
        data: {
          msg_type: this.renderMessageType(),
          content: this.renderContent(message.text),
          reply_in_thread: Boolean(message.threadId),
          uuid: randomUUID(),
        },
      });
      return toSendResult(response.data?.message_id);
    }

    if (this.replyMode === "reply" && message.threadId) {
      const response = await this.client.im.v1.message.reply({
        path: {
          message_id: message.threadId,
        },
        data: {
          msg_type: this.renderMessageType(),
          content: this.renderContent(message.text),
          reply_in_thread: true,
          uuid: randomUUID(),
        },
      });
      return toSendResult(response.data?.message_id);
    }

    const response = await this.client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: message.chatId,
        msg_type: this.renderMessageType(),
        content: this.renderContent(message.text),
        uuid: randomUUID(),
      },
    });
    return toSendResult(response.data?.message_id);
  }

  async stop(): Promise<void> {
    const wsClient = this.wsClient;
    this.wsClient = null;
    this.client = null;
    this.ctx = null;
    wsClient?.close({ force: true });
  }

  private async logAppSubscriptionState(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      const response = await this.client.application.v6.application.get({
        path: {
          app_id: this.config.appId,
        },
        params: {
          lang: "zh_cn",
        },
      });

      const subscribedEvents = response.data?.app?.event?.subscribed_events ?? [];
      this.logger.info(
        {
          connectorId: this.id,
          appId: this.config.appId,
          appName: response.data?.app?.app_name ?? this.config.botName ?? null,
          onlineVersionId: response.data?.app?.online_version_id ?? null,
          draftVersionId: response.data?.app?.unaudit_version_id ?? null,
          subscriptionType: response.data?.app?.event?.subscription_type ?? null,
          subscribedEvents,
        },
        "Feishu published application info loaded",
      );

      if (!subscribedEvents.includes("im.message.receive_v1")) {
        this.logger.warn(
          {
            connectorId: this.id,
            appId: this.config.appId,
            onlineVersionId: response.data?.app?.online_version_id ?? null,
            draftVersionId: response.data?.app?.unaudit_version_id ?? null,
            subscribedEvents,
          },
          "Published Feishu app config does not show im.message.receive_v1",
        );
      }
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          connectorId: this.id,
          appId: this.config.appId,
        },
        "Failed to load Feishu application info",
      );
    }
  }

  private get messageFormat(): "text" | "card_markdown" {
    return this.config.messageFormat ?? "card_markdown";
  }

  private get replyMode(): "direct" | "reply" {
    return this.config.replyMode ?? "direct";
  }

  private renderMessageType(): "text" | "interactive" {
    return this.messageFormat === "card_markdown" ? "interactive" : "text";
  }

  private renderContent(text: string): string {
    if (this.messageFormat === "card_markdown") {
      return cardContent(text, this.config.cardTitle ?? this.config.botName ?? "dobby");
    }
    return textContent(text);
  }
}
