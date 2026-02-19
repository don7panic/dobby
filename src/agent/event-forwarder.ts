import type { ConnectorPlugin, GatewayAgentEvent, GatewayLogger, InboundEnvelope, Platform } from "../core/types.js";

interface ForwarderOptions {
  updateIntervalMs?: number;
  toolMessageMode?: "none" | "errors" | "all";
}

function truncate(text: string, max?: number): string {
  if (max === undefined) return text;
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const suffix = "\n...(truncated)";
  if (max <= suffix.length) {
    return text.slice(0, max);
  }
  return `${text.slice(0, max - suffix.length)}${suffix}`;
}

function splitForMaxLength(text: string, max?: number): string[] {
  if (max === undefined) {
    return [text];
  }
  if (text.length <= max) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > max) {
    let splitAt = remaining.lastIndexOf("\n", max);
    if (splitAt < Math.floor(max * 0.6)) {
      splitAt = max;
    }

    const chunk = remaining.slice(0, splitAt).trimEnd();
    chunks.push(chunk.length > 0 ? chunk : remaining.slice(0, max));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

export class EventForwarder {
  private responseText = "";
  private pendingFlush: NodeJS.Timeout | null = null;
  private readonly pendingOps: Array<Promise<unknown>> = [];
  private readonly updateIntervalMs: number;
  private readonly toolMessageMode: "none" | "errors" | "all";
  private readonly maxTextLength: number | undefined;

  constructor(
    private readonly connector: ConnectorPlugin,
    private readonly inbound: InboundEnvelope,
    private readonly rootMessageId: string,
    private readonly logger: GatewayLogger,
    options: ForwarderOptions = {},
  ) {
    this.updateIntervalMs = options.updateIntervalMs ?? 400;
    this.toolMessageMode = options.toolMessageMode ?? "none";
    const capabilityMaxTextLength = this.connector.capabilities.maxTextLength;
    this.maxTextLength = typeof capabilityMaxTextLength === "number" && capabilityMaxTextLength > 0
      ? capabilityMaxTextLength
      : undefined;
  }

  handleEvent = (event: GatewayAgentEvent): void => {
    if (event.type === "message_delta") {
      this.responseText += event.delta;
      this.scheduleFlush();
      return;
    }

    if (event.type === "message_complete") {
      if (event.text.trim().length > 0) {
        this.responseText = event.text;
        void this.flushNow();
      }
      return;
    }

    if (event.type === "tool_start") {
      this.logger.info(
        {
          toolName: event.toolName,
          conversation: `${this.inbound.platform}:${this.inbound.accountId}:${this.inbound.chatId}:${this.inbound.threadId ?? "root"}`,
        },
        "Tool execution started",
      );
      if (this.toolMessageMode === "all") {
        this.enqueueSend(`_-> Running tool: ${event.toolName}_`);
      }
      return;
    }

    if (event.type === "tool_end") {
      const summary = event.output;
      this.logger.info(
        {
          toolName: event.toolName,
          isError: event.isError,
          conversation: `${this.inbound.platform}:${this.inbound.accountId}:${this.inbound.chatId}:${this.inbound.threadId ?? "root"}`,
        },
        event.isError ? "Tool execution finished with error" : "Tool execution finished",
      );
      if (this.toolMessageMode === "all" || (this.toolMessageMode === "errors" && event.isError)) {
        const prefix = event.isError ? "ERR" : "OK";
        const header = `*${prefix} ${event.toolName}*\n\`\`\`\n`;
        const footer = "\n```";
        const availableSummaryLength = this.maxTextLength === undefined
          ? undefined
          : Math.max(0, this.maxTextLength - header.length - footer.length);
        this.enqueueSend(`${header}${truncate(summary, availableSummaryLength)}${footer}`);
      }
      return;
    }

    if (event.type === "status") {
      this.enqueueSend(`_${event.message}_`);
    }
  };

  async finalize(): Promise<void> {
    await this.flushNow();

    if (this.responseText.trim().length === 0) {
      await this.connector.send({
        ...this.baseEnvelope(),
        mode: "update",
        targetMessageId: this.rootMessageId,
        text: "(completed with no text response)",
      });
      await Promise.allSettled(this.pendingOps);
      return;
    }

    const chunks = splitForMaxLength(this.responseText, this.maxTextLength);
    if (chunks.length > 1) {
      try {
        await this.connector.send({
          ...this.baseEnvelope(),
          mode: "update",
          targetMessageId: this.rootMessageId,
          text: chunks[0] ?? "",
        });

        for (const chunk of chunks.slice(1)) {
          await this.connector.send({
            ...this.baseEnvelope(),
            mode: "create",
            replyToMessageId: this.rootMessageId,
            text: chunk,
          });
        }
      } catch (error) {
        this.logger.warn(
          {
            err: error,
            connectorId: this.inbound.connectorId,
            chatId: this.inbound.chatId,
            targetMessageId: this.rootMessageId,
          },
          "Failed to send split final response to Discord",
        );
      }
    }

    await Promise.allSettled(this.pendingOps);
  }

  private baseEnvelope(): { platform: Platform; accountId: string; chatId: string; threadId?: string } {
    return {
      platform: this.inbound.platform,
      accountId: this.inbound.accountId,
      chatId: this.inbound.chatId,
      ...(this.inbound.threadId ? { threadId: this.inbound.threadId } : {}),
    };
  }

  private scheduleFlush(): void {
    if (this.pendingFlush) return;
    this.pendingFlush = setTimeout(() => {
      void this.flushNow();
    }, this.updateIntervalMs);
  }

  private async flushNow(): Promise<void> {
    if (this.pendingFlush) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = null;
    }

    const content = this.responseText.trim().length > 0
      ? truncate(this.responseText, this.maxTextLength)
      : "_Thinking..._";

    try {
      await this.connector.send({
        ...this.baseEnvelope(),
        mode: "update",
        targetMessageId: this.rootMessageId,
        text: content,
      });
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          connectorId: this.inbound.connectorId,
          chatId: this.inbound.chatId,
          targetMessageId: this.rootMessageId,
          contentLength: content.length,
        },
        "Failed to flush streaming update",
      );
    }
  }

  private enqueueSend(text: string): void {
    const promise = this.connector
      .send({
        ...this.baseEnvelope(),
        mode: "create",
        replyToMessageId: this.rootMessageId,
        text,
      })
      .catch((error) => {
        this.logger.warn(
          {
            err: error,
            connectorId: this.inbound.connectorId,
            chatId: this.inbound.chatId,
            replyToMessageId: this.rootMessageId,
          },
          "Failed to send threaded tool update",
        );
      });

    this.pendingOps.push(promise);
  }
}
