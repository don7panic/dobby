import { randomUUID } from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  OUTBOUND_MESSAGE_KIND_METADATA_KEY,
  OUTBOUND_MESSAGE_KIND_PROGRESS,
} from "@dobby.ai/plugin-sdk";
import type {
  ConnectorCapabilities,
  ConnectorContext,
  ConnectorHealth,
  ConnectorHealthStatus,
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
  downloadAttachments?: boolean;
}

export type FeishuMessageFormat = "text" | "card_markdown";

const FEISHU_CARD_MAX_TEXT_LENGTH = 8_000;
const FEISHU_TEXT_MAX_TEXT_LENGTH = 12_000;
const FEISHU_WS_OPEN = 1;
const FEISHU_CONNECT_BOOTSTRAP_MS = 30_000;

function createHealth(status: ConnectorHealthStatus, detail?: string): ConnectorHealth {
  const now = Date.now();
  return {
    status,
    statusSinceMs: now,
    updatedAtMs: now,
    ...(detail ? { detail } : {}),
  };
}

function resolveDomain(domain?: "feishu" | "lark"): string {
  return domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

function textContent(text: string): string {
  return JSON.stringify({ text });
}

function cardContent(text: string, title: string): string {
  return JSON.stringify({
    schema: "2.0",
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
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [
        {
          tag: "markdown",
          content: text.trim().length > 0 ? text : "(empty response)",
        },
      ],
    },
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
  private stopped = false;
  private health = createHealth("stopped");
  private lastReadyAtMs: number | undefined;
  private startRequestedAtMs = 0;

  constructor(
    id: string,
    private readonly config: FeishuConnectorConfig,
    private readonly attachmentsRoot: string,
    private readonly logger: GatewayLogger,
  ) {
    this.id = id;
    this.capabilities = {
      updateStrategy: this.messageFormat === "card_markdown" ? "final_only" : "edit",
      progressUpdateStrategy: "edit",
      supportedSources: ["chat"],
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
    this.stopped = false;
    this.startRequestedAtMs = Date.now();
    this.updateHealth("starting", "Starting Feishu persistent connection");
    this.client = new Lark.Client(baseConfig);
    this.wsClient = new Lark.WSClient(baseConfig);
    await this.logAppSubscriptionState();

    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (event: FeishuMessageEvent) => {
        if (!this.ctx || !this.client) {
          return;
        }

        this.logger.info(
          {
            connectorId: this.id,
            chatId: event.message.chat_id,
            messageId: event.message.message_id,
            chatType: event.message.chat_type,
            messageType: event.message.message_type,
            mentionCount: event.message.mentions?.length ?? 0,
          },
          "Feishu inbound event received",
        );
        this.updateHealth("ready", "Feishu inbound event received");

        const inbound = await mapFeishuMessageEvent({
          event,
          connectorId: this.id,
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
    this.updateHealth("starting", "Feishu websocket bootstrap submitted");

    this.logger.info(
      {
        connectorId: this.id,
        domain: this.config.domain ?? "feishu",
        messageFormat: this.messageFormat,
        replyMode: this.replyMode,
      },
      "Feishu connector ready",
    );
  }

  getHealth(): ConnectorHealth {
    if (this.stopped || !this.wsClient) {
      return this.health;
    }

    if (this.isWsOpen()) {
      this.updateHealth("ready", "Feishu persistent connection open");
      return this.health;
    }

    const reconnectInfo = this.wsClient.getReconnectInfo();
    if (reconnectInfo.nextConnectTime > Date.now()) {
      this.updateHealth("reconnecting", "Feishu websocket reconnect scheduled");
      return this.health;
    }

    if (Date.now() - this.startRequestedAtMs < FEISHU_CONNECT_BOOTSTRAP_MS) {
      this.updateHealth("starting", "Feishu websocket bootstrap in progress");
      return this.health;
    }

    if (reconnectInfo.lastConnectTime > 0) {
      this.updateHealth("degraded", "Feishu websocket is disconnected");
      return this.health;
    }

    return this.health;
  }

  async send(message: OutboundEnvelope): Promise<ConnectorSendResult> {
    if (!this.client) {
      throw new Error("Feishu connector is not started");
    }

    const rendered = this.resolveRenderedMessage(message);

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

      if (rendered.format === "card_markdown") {
        await this.client.im.v1.message.patch({
          path: {
            message_id: message.targetMessageId,
          },
          data: {
            content: rendered.content,
          },
        });
        return { messageId: message.targetMessageId };
      }

      const response = await this.client.im.v1.message.update({
        path: {
          message_id: message.targetMessageId,
        },
        data: {
          msg_type: rendered.msgType,
          content: rendered.content,
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
          msg_type: rendered.msgType,
          content: rendered.content,
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
          msg_type: rendered.msgType,
          content: rendered.content,
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
        msg_type: rendered.msgType,
        content: rendered.content,
        uuid: randomUUID(),
      },
    });
    return toSendResult(response.data?.message_id);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const wsClient = this.wsClient;
    this.wsClient = null;
    this.client = null;
    this.ctx = null;
    wsClient?.close({ force: true });
    this.updateHealth("stopped", "Feishu connector stopped");
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

  private get messageFormat(): FeishuMessageFormat {
    return this.config.messageFormat ?? "card_markdown";
  }

  private get replyMode(): "direct" | "reply" {
    return this.config.replyMode ?? "direct";
  }

  private resolveMessageFormat(message: OutboundEnvelope): FeishuMessageFormat {
    const messageKind = message.metadata?.[OUTBOUND_MESSAGE_KIND_METADATA_KEY];
    if (messageKind === OUTBOUND_MESSAGE_KIND_PROGRESS && this.messageFormat === "card_markdown") {
      return "text";
    }
    return this.messageFormat;
  }

  private renderMessageType(format: FeishuMessageFormat): "text" | "interactive" {
    return format === "card_markdown" ? "interactive" : "text";
  }

  private renderContent(text: string, format: FeishuMessageFormat): string {
    if (format === "card_markdown") {
      return cardContent(text, this.config.cardTitle ?? this.config.botName ?? "dobby");
    }
    return textContent(text);
  }

  private resolveRenderedMessage(message: OutboundEnvelope): {
    format: FeishuMessageFormat;
    msgType: "text" | "interactive";
    content: string;
  } {
    const format = this.resolveMessageFormat(message);
    return {
      format,
      msgType: this.renderMessageType(format),
      content: this.renderContent(message.text, format),
    };
  }

  private isWsOpen(): boolean {
    const wsClient = this.wsClient as unknown as {
      wsConfig?: {
        getWSInstance?: () => { readyState?: number } | null;
      };
    } | null;
    const readyState = wsClient?.wsConfig?.getWSInstance?.()?.readyState;
    return readyState === FEISHU_WS_OPEN;
  }

  private updateHealth(status: ConnectorHealthStatus, detail: string, error?: unknown): void {
    const now = Date.now();
    const lastError = error === undefined ? this.health.lastError : error instanceof Error ? error.message : String(error);
    const lastErrorAtMs = error === undefined ? this.health.lastErrorAtMs : now;
    const statusChanged = this.health.status !== status;
    if (status === "ready") {
      this.lastReadyAtMs = now;
    }

    this.health = {
      ...this.health,
      status,
      detail,
      updatedAtMs: now,
      statusSinceMs: statusChanged ? now : this.health.statusSinceMs,
      ...(this.lastReadyAtMs ? { lastReadyAtMs: this.lastReadyAtMs } : {}),
      ...(lastError ? { lastError } : {}),
      ...(lastErrorAtMs ? { lastErrorAtMs } : {}),
    };
  }
}
