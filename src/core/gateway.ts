import { readFile } from "node:fs/promises";
import type { ImageContent } from "@mariozechner/pi-ai";
import { EventForwarder } from "../agent/event-forwarder.js";
import type { Executor } from "../sandbox/executor.js";
import type { DedupStore } from "./dedup-store.js";
import { RouteResolver } from "./routing.js";
import { RuntimeRegistry } from "./runtime-registry.js";
import type {
  ConnectorPlugin,
  GatewayAgentRuntime,
  GatewayConfig,
  GatewayLogger,
  InboundAttachment,
  InboundEnvelope,
  Platform,
  PromptPayload,
  ProviderInstance,
  RouteResolution,
} from "./types.js";
import { BUILTIN_HOST_SANDBOX_ID } from "./types.js";

interface GatewayOptions {
  config: GatewayConfig;
  connectors: ConnectorPlugin[];
  providers: Map<string, ProviderInstance>;
  executors: Map<string, Executor>;
  routeResolver: RouteResolver;
  dedupStore: DedupStore;
  runtimeRegistry: RuntimeRegistry;
  logger: GatewayLogger;
}

interface StopControlEvent {
  type: "stop";
  connectorId: string;
  platform: Platform;
  accountId: string;
  chatId: string;
  threadId?: string;
}

const INITIAL_REPLY_TIMEOUT_MS = 15_000;

function isImageAttachment(attachment: InboundAttachment): boolean {
  return Boolean(attachment.mimeType?.startsWith("image/") && attachment.localPath);
}

function dedupKey(message: InboundEnvelope): string {
  return `${message.connectorId}:${message.platform}:${message.accountId}:${message.chatId}:${message.messageId}`;
}

function conversationKey(message: InboundEnvelope): string {
  return `${message.connectorId}:${message.platform}:${message.accountId}:${message.chatId}:${message.threadId ?? "root"}`;
}

export class Gateway {
  private readonly connectorsById = new Map<string, ConnectorPlugin>();
  private started = false;

  constructor(private readonly options: GatewayOptions) {
    for (const connector of options.connectors) {
      this.connectorsById.set(connector.id, connector);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;

    await this.options.dedupStore.load();
    this.options.dedupStore.startAutoFlush();

    for (const connector of this.options.connectors) {
      await connector.start({
        emitInbound: async (message) => this.handleInbound(message),
        emitControl: async (event) => this.handleControl(event),
      });
    }

    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;

    for (const connector of this.options.connectors) {
      await connector.stop();
    }

    this.options.dedupStore.stopAutoFlush();
    await this.options.dedupStore.flush();
    await this.options.runtimeRegistry.closeAll();

    this.started = false;
  }

  private outboundBaseFromInbound(message: InboundEnvelope): {
    platform: Platform;
    accountId: string;
    chatId: string;
    threadId?: string;
  } {
    return {
      platform: message.platform,
      accountId: message.accountId,
      chatId: message.chatId,
      ...(message.threadId ? { threadId: message.threadId } : {}),
    };
  }

  private outboundBaseFromControl(event: StopControlEvent): {
    platform: Platform;
    accountId: string;
    chatId: string;
    threadId?: string;
  } {
    return {
      platform: event.platform,
      accountId: event.accountId,
      chatId: event.chatId,
      ...(event.threadId ? { threadId: event.threadId } : {}),
    };
  }

  private async handleInbound(message: InboundEnvelope): Promise<void> {
    const connector = this.connectorsById.get(message.connectorId);
    if (!connector) {
      this.options.logger.warn({ connectorId: message.connectorId }, "No connector found for inbound message");
      return;
    }

    const key = dedupKey(message);
    if (this.options.dedupStore.has(key)) {
      this.options.logger.debug({ dedupKey: key }, "Skipping duplicate message");
      return;
    }
    this.options.dedupStore.add(key);

    const route = this.options.routeResolver.resolve(message.routeId);
    if (!route) {
      await connector.send({
        ...this.outboundBaseFromInbound(message),
        mode: "create",
        replyToMessageId: message.messageId,
        text: `No route configured for route '${message.routeId}'.`,
      });
      return;
    }

    if (route.profile.allowMentionsOnly && !message.isDirectMessage && !message.mentionedBot) {
      this.options.logger.debug({ channelId: message.routeChannelId, routeId: route.routeId }, "Ignoring non-mention message");
      return;
    }

    const providerId = route.profile.providerId ?? this.options.config.providers.defaultProviderId;
    const sandboxId = route.profile.sandboxId ?? this.options.config.sandboxes.defaultSandboxId ?? BUILTIN_HOST_SANDBOX_ID;
    const provider = this.options.providers.get(providerId);
    const executor = this.options.executors.get(sandboxId);

    if (!provider || !executor) {
      await connector.send({
        ...this.outboundBaseFromInbound(message),
        mode: "create",
        replyToMessageId: message.messageId,
        text: `Route runtime not available (provider='${providerId}', sandbox='${sandboxId}')`,
      });
      return;
    }

    const convKey = conversationKey(message);

    await this.options.runtimeRegistry.getOrCreate(convKey, async () => {
      const runtime = await provider.createRuntime({
        conversationKey: convKey,
        route,
        inbound: message,
        executor,
      });

      return {
        key: convKey,
        routeId: route.routeId,
        route: route.profile,
        providerId,
        sandboxId,
        runtime,
        close: async () => {
          runtime.dispose();
        },
      };
    });

    await this.options.runtimeRegistry.enqueue(convKey, async (runtime) => {
      await this.processMessage(connector, runtime.runtime, route, message);
    });
  }

  private async processMessage(
    connector: ConnectorPlugin,
    runtime: GatewayAgentRuntime,
    route: RouteResolution,
    message: InboundEnvelope,
  ): Promise<void> {
    this.options.logger.info(
      {
        connectorId: message.connectorId,
        routeId: route.routeId,
        channelId: message.routeChannelId,
        chatId: message.chatId,
        threadId: message.threadId,
        messageId: message.messageId,
      },
      "Processing inbound message",
    );

    let initial: { messageId?: string };
    try {
      this.options.logger.info(
        {
          connectorId: message.connectorId,
          routeId: route.routeId,
          messageId: message.messageId,
          timeoutMs: INITIAL_REPLY_TIMEOUT_MS,
        },
        "Sending initial thinking message",
      );

      initial = await this.withTimeout(
        connector.send({
          ...this.outboundBaseFromInbound(message),
          mode: "create",
          replyToMessageId: message.messageId,
          text: "_Thinking..._",
        }),
        INITIAL_REPLY_TIMEOUT_MS,
        "send initial thinking message",
      );

      this.options.logger.info(
        {
          connectorId: message.connectorId,
          routeId: route.routeId,
          messageId: message.messageId,
          initialMessageId: initial.messageId ?? null,
        },
        "Initial thinking message sent",
      );
    } catch (error) {
      this.options.logger.error(
        {
          err: error,
          connectorId: message.connectorId,
          routeId: route.routeId,
          messageId: message.messageId,
        },
        "Failed to send initial thinking message",
      );
      return;
    }

    const rootMessageId = initial.messageId ?? message.messageId;
    const forwarder = new EventForwarder(connector, message, rootMessageId, this.options.logger);
    const unsubscribe = runtime.subscribe(forwarder.handleEvent);

    try {
      const payload = await this.buildPromptPayload(message);
      this.options.logger.info(
        {
          routeId: route.routeId,
          messageId: message.messageId,
          rootMessageId,
          hasImages: payload.images.length > 0,
          textLength: payload.text.length,
        },
        "Starting provider prompt",
      );
      await runtime.prompt(payload.text, payload.images.length > 0 ? { images: payload.images } : undefined);
      this.options.logger.info(
        {
          routeId: route.routeId,
          messageId: message.messageId,
          rootMessageId,
        },
        "Provider prompt finished",
      );
      await forwarder.finalize();
      this.options.logger.info({ routeId: route.routeId, messageId: message.messageId }, "Inbound message processed");
    } catch (error) {
      this.options.logger.error({ err: error, routeId: route.routeId }, "Failed to process inbound message");
      await connector.send({
        ...this.outboundBaseFromInbound(message),
        mode: "update",
        targetMessageId: rootMessageId,
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      unsubscribe();
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms while attempting to ${label}`));
        }, timeoutMs);

        promise.finally(() => {
          clearTimeout(timer);
        }).catch(() => {
          // Ignore; timeout race handles errors.
        });
      }),
    ]);
  }

  private async buildPromptPayload(message: InboundEnvelope): Promise<PromptPayload> {
    const textParts: string[] = [];
    const baseText = message.text.trim();
    textParts.push(baseText.length > 0 ? baseText : "(empty message)");

    const images: ImageContent[] = [];
    const otherAttachments: string[] = [];

    for (const attachment of message.attachments) {
      if (isImageAttachment(attachment) && attachment.localPath && attachment.mimeType) {
        try {
          const buffer = await readFile(attachment.localPath);
          images.push({
            type: "image",
            mimeType: attachment.mimeType,
            data: buffer.toString("base64"),
          });
          continue;
        } catch (error) {
          this.options.logger.warn({ err: error, attachment: attachment.localPath }, "Failed to read image attachment");
        }
      }

      if (attachment.localPath) {
        otherAttachments.push(attachment.localPath);
      } else if (attachment.remoteUrl) {
        otherAttachments.push(attachment.remoteUrl);
      }
    }

    if (otherAttachments.length > 0) {
      textParts.push(`<attachments>\n${otherAttachments.join("\n")}\n</attachments>`);
    }

    return {
      text: textParts.join("\n\n"),
      images,
    };
  }

  private async handleControl(event: StopControlEvent): Promise<void> {
    const convKey = `${event.connectorId}:${event.platform}:${event.accountId}:${event.chatId}:${event.threadId ?? "root"}`;
    const connector = this.connectorsById.get(event.connectorId);
    const aborted = await this.options.runtimeRegistry.abort(convKey);

    this.options.logger.info({ conversationKey: convKey, aborted }, "Stop requested");
    if (!connector) return;

    try {
      await connector.send({
        ...this.outboundBaseFromControl(event),
        mode: "create",
        text: aborted ? "_Stopped current run._" : "_No active run to stop._",
      });
    } catch (error) {
      this.options.logger.warn({ err: error, conversationKey: convKey }, "Failed to send stop acknowledgement");
    }
  }
}
