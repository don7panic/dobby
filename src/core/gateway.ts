import { readFile } from "node:fs/promises";
import type { ImageContent } from "@mariozechner/pi-ai";
import { EventForwarder } from "../agent/event-forwarder.js";
import type { Executor } from "../sandbox/executor.js";
import { parseControlCommand, type ControlCommand } from "./control-command.js";
import type { DedupStore } from "./dedup-store.js";
import { BindingResolver, RouteResolver } from "./routing.js";
import { RuntimeRegistry } from "./runtime-registry.js";
import { createTypingKeepAliveController } from "./typing-controller.js";
import type {
  BindingResolution,
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

interface GatewayOptions {
  config: GatewayConfig;
  connectors: ConnectorPlugin[];
  providers: Map<string, ProviderInstance>;
  executors: Map<string, Executor>;
  routeResolver: RouteResolver;
  bindingResolver: BindingResolver;
  dedupStore: DedupStore;
  runtimeRegistry: RuntimeRegistry;
  logger: GatewayLogger;
}

interface MessageHandlingOptions {
  origin: "connector" | "scheduled";
  useDedup: boolean;
  stateless: boolean;
  includeReplyTo: boolean;
  conversationKeyOverride?: string;
  routeIdOverride?: string;
  sessionPolicy?: "shared-session" | "ephemeral";
  timeoutMs?: number;
}

interface StopControlEvent {
  type: "stop";
  connectorId: string;
  platform: Platform;
  accountId: string;
  chatId: string;
  threadId?: string;
}

interface ResolvedMessageRoute {
  route: RouteResolution;
  routeId: string;
  binding?: BindingResolution;
}

export interface ScheduledExecutionRequest {
  jobId: string;
  runId: string;
  connectorId: string;
  routeId: string;
  channelId: string;
  threadId?: string;
  prompt: string;
  timeoutMs?: number;
}

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

  async handleScheduled(request: ScheduledExecutionRequest): Promise<void> {
    const connector = this.connectorsById.get(request.connectorId);
    if (!connector) {
      throw new Error(`No connector found for scheduled run '${request.runId}' (${request.connectorId})`);
    }

    const syntheticInbound: InboundEnvelope = {
      connectorId: request.connectorId,
      platform: connector.platform,
      accountId: request.connectorId,
      source: {
        type: "chat",
        id: request.channelId,
      },
      chatId: request.channelId,
      ...(request.threadId ? { threadId: request.threadId } : {}),
      messageId: `cron:${request.runId}`,
      userId: "cron",
      userName: "cron",
      text: request.prompt,
      attachments: [],
      timestampMs: Date.now(),
      raw: {
        type: "cron",
        jobId: request.jobId,
        runId: request.runId,
      },
      isDirectMessage: false,
      mentionedBot: true,
    };

    await this.handleMessage(syntheticInbound, {
      origin: "scheduled",
      useDedup: true,
      stateless: true,
      includeReplyTo: false,
      conversationKeyOverride: `cron:${request.runId}`,
      routeIdOverride: request.routeId,
      sessionPolicy: "ephemeral",
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    });
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

  private async sendCommandReply(
    connector: ConnectorPlugin,
    message: InboundEnvelope,
    text: string,
  ): Promise<void> {
    await connector.send({
      ...this.outboundBaseFromInbound(message),
      mode: "create",
      text,
    });
  }

  private async handleInbound(message: InboundEnvelope): Promise<void> {
    await this.handleMessage(message, {
      origin: "connector",
      useDedup: true,
      stateless: false,
      includeReplyTo: true,
      sessionPolicy: "shared-session",
    });
  }

  private resolveMessageRoute(message: InboundEnvelope, handling: MessageHandlingOptions): ResolvedMessageRoute | null {
    const overrideRouteId = handling.routeIdOverride?.trim();
    if (overrideRouteId) {
      const route = this.options.routeResolver.resolve(overrideRouteId);
      if (!route) {
        return null;
      }

      return {
        routeId: overrideRouteId,
        route,
      };
    }

    const binding = this.options.bindingResolver.resolve(message.connectorId, message.source, {
      isDirectMessage: message.isDirectMessage,
    });
    if (!binding) {
      if (handling.origin === "connector") {
        this.options.logger.debug(
          {
            connectorId: message.connectorId,
            sourceType: message.source.type,
            sourceId: message.source.id,
          },
          "Ignoring inbound message from unbound source",
        );
      }
      return null;
    }

    const route = this.options.routeResolver.resolve(binding.config.route);
    if (!route) {
      return null;
    }

    return {
      routeId: binding.config.route,
      route,
      binding,
    };
  }

  private async handleMessage(message: InboundEnvelope, handling: MessageHandlingOptions): Promise<void> {
    const connector = this.connectorsById.get(message.connectorId);
    if (!connector) {
      this.options.logger.warn({ connectorId: message.connectorId }, "No connector found for inbound message");
      return;
    }

    if (handling.useDedup) {
      const key = dedupKey(message);
      if (this.options.dedupStore.has(key)) {
        this.options.logger.debug({ dedupKey: key }, "Skipping duplicate message");
        return;
      }
      this.options.dedupStore.add(key);
    }

    const resolvedRoute = this.resolveMessageRoute(message, handling);
    if (!resolvedRoute) {
      if (handling.routeIdOverride) {
        await connector.send({
          ...this.outboundBaseFromInbound(message),
          mode: "create",
          ...(handling.includeReplyTo ? { replyToMessageId: message.messageId } : {}),
          text: `No route configured for route '${handling.routeIdOverride}'.`,
        });
      }
      return;
    }

    if (handling.origin === "connector") {
      const command = parseControlCommand(message.text);
      if (command) {
        try {
          await this.handleCommand(connector, message, command, resolvedRoute.route);
        } catch (error) {
          this.options.logger.error({ err: error, messageId: message.messageId }, "Failed to handle control command");
          await this.sendCommandReply(
            connector,
            message,
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return;
      }
    }

    const { route } = resolvedRoute;
    if (route.profile.mentions === "required" && !message.isDirectMessage && !message.mentionedBot) {
      this.options.logger.debug(
        {
          sourceType: message.source.type,
          sourceId: message.source.id,
          routeId: route.routeId,
        },
        "Ignoring non-mention message",
      );
      return;
    }

    const providerId = route.profile.provider;
    const sandboxId = route.profile.sandbox;
    const provider = this.options.providers.get(providerId);
    const executor = this.options.executors.get(sandboxId);

    if (!provider || !executor) {
      await connector.send({
        ...this.outboundBaseFromInbound(message),
        mode: "create",
        ...(handling.includeReplyTo ? { replyToMessageId: message.messageId } : {}),
        text: `Route runtime not available (provider='${providerId}', sandbox='${sandboxId}')`,
      });
      return;
    }

    const convKey = handling.conversationKeyOverride ?? conversationKey(message);

    if (handling.stateless) {
      const runtime = await provider.createRuntime({
        conversationKey: convKey,
        route,
        inbound: message,
        executor,
        ...(handling.sessionPolicy ? { sessionPolicy: handling.sessionPolicy } : {}),
      });
      try {
        await this.processMessage(connector, runtime, route, message, {
          includeReplyTo: handling.includeReplyTo,
          ...(handling.timeoutMs !== undefined ? { timeoutMs: handling.timeoutMs } : {}),
        });
      } finally {
        runtime.dispose();
      }
      return;
    }

    await this.options.runtimeRegistry.run(
      convKey,
      async () => {
        const runtime = await provider.createRuntime({
          conversationKey: convKey,
          route,
          inbound: message,
          executor,
          ...(handling.sessionPolicy ? { sessionPolicy: handling.sessionPolicy } : {}),
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
      },
      async (runtime) => {
        await this.processMessage(connector, runtime.runtime, route, message, {
          includeReplyTo: handling.includeReplyTo,
        });
      },
    );
  }

  private async processMessage(
    connector: ConnectorPlugin,
    runtime: GatewayAgentRuntime,
    route: RouteResolution,
    message: InboundEnvelope,
    options: {
      includeReplyTo: boolean;
      timeoutMs?: number;
    },
  ): Promise<void> {
    this.options.logger.info(
      {
        connectorId: message.connectorId,
        routeId: route.routeId,
        sourceType: message.source.type,
        sourceId: message.source.id,
        chatId: message.chatId,
        threadId: message.threadId,
        messageId: message.messageId,
      },
      "Processing inbound message",
    );

    const typingController = createTypingKeepAliveController(connector, message, this.options.logger);
    let unsubscribe: (() => void) | null = null;
    const forwarder = new EventForwarder(connector, message, null, this.options.logger, {
      onOutboundActivity: typingController.markVisibleOutput,
    });
    try {
      await typingController.prime();
      unsubscribe = runtime.subscribe(forwarder.handleEvent);

      const payload = await this.buildPromptPayload(message);
      this.options.logger.info(
        {
          routeId: route.routeId,
          messageId: message.messageId,
          rootMessageId: forwarder.primaryMessageId() ?? null,
          hasImages: payload.images.length > 0,
          textLength: payload.text.length,
        },
        "Starting provider prompt",
      );
      await this.promptWithOptionalTimeout(runtime, payload, options.timeoutMs);
      this.options.logger.info(
        {
          routeId: route.routeId,
          messageId: message.messageId,
          rootMessageId: forwarder.primaryMessageId() ?? null,
        },
        "Provider prompt finished",
      );
      await forwarder.finalize();
      this.options.logger.info({ routeId: route.routeId, messageId: message.messageId }, "Inbound message processed");
    } catch (error) {
      this.options.logger.error({ err: error, routeId: route.routeId }, "Failed to process inbound message");
      const rootMessageId = forwarder.primaryMessageId();
      const canEditExisting = connector.capabilities.updateStrategy === "edit" && rootMessageId !== null;
      await connector.send(
        canEditExisting
          ? {
            ...this.outboundBaseFromInbound(message),
            mode: "update",
            targetMessageId: rootMessageId,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }
          : {
            ...this.outboundBaseFromInbound(message),
            mode: "create",
            ...(
              rootMessageId
                ? { replyToMessageId: rootMessageId }
                : options.includeReplyTo
                ? { replyToMessageId: message.messageId }
                : {}
            ),
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
      );
    } finally {
      unsubscribe?.();
      typingController.stop();
    }
  }

  private async promptWithOptionalTimeout(
    runtime: GatewayAgentRuntime,
    payload: PromptPayload,
    timeoutMs?: number,
  ): Promise<void> {
    if (timeoutMs === undefined || timeoutMs <= 0) {
      await runtime.prompt(payload.text, payload.images.length > 0 ? { images: payload.images } : undefined);
      return;
    }

    let timer: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        runtime.prompt(payload.text, payload.images.length > 0 ? { images: payload.images } : undefined),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void runtime.abort().catch(() => {
              // Best-effort abort on timeout.
            });
            reject(new Error(`Cron run timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
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

  private async handleCommand(
    connector: ConnectorPlugin,
    message: InboundEnvelope,
    command: ControlCommand,
    route: RouteResolution,
  ): Promise<void> {
    const convKey = conversationKey(message);
    if (command === "cancel") {
      const cancelled = await this.options.runtimeRegistry.cancel(convKey);
      this.options.logger.info({ conversationKey: convKey, cancelled }, "Conversation cancel requested");
      await this.sendCommandReply(
        connector,
        message,
        cancelled ? "_Cancelled current session tasks._" : "_No active or queued session tasks to cancel._",
      );
      return;
    }

    const providerId = route.profile.provider;
    const provider = this.options.providers.get(providerId);
    if (!provider) {
      throw new Error(`Route provider not available (provider='${providerId}')`);
    }
    if (!provider.archiveSession) {
      throw new Error(`Provider '${providerId}' does not support session archival`);
    }

    const hadRuntime = await this.options.runtimeRegistry.reset(convKey);
    const archiveResult = await provider.archiveSession({
      conversationKey: convKey,
      inbound: message,
      sessionPolicy: "shared-session",
      archivedAtMs: message.timestampMs,
    });

    this.options.logger.info(
      {
        conversationKey: convKey,
        providerId,
        hadRuntime,
        archived: archiveResult.archived,
        archivePath: archiveResult.archivePath ?? null,
      },
      "New session requested",
    );

    await this.sendCommandReply(connector, message, "_Started a new session._");
  }

  private async handleControl(event: StopControlEvent): Promise<void> {
    const convKey = `${event.connectorId}:${event.platform}:${event.accountId}:${event.chatId}:${event.threadId ?? "root"}`;
    const connector = this.connectorsById.get(event.connectorId);
    const cancelled = await this.options.runtimeRegistry.cancel(convKey);

    this.options.logger.info({ conversationKey: convKey, cancelled }, "Stop requested");
    if (!connector) return;

    try {
      await connector.send({
        ...this.outboundBaseFromControl(event),
        mode: "create",
        text: cancelled ? "_Cancelled current session tasks._" : "_No active or queued session tasks to cancel._",
      });
    } catch (error) {
      this.options.logger.warn({ err: error, conversationKey: convKey }, "Failed to send stop acknowledgement");
    }
  }
}
