import type { ConnectorPlugin, GatewayAgentEvent, GatewayLogger, InboundEnvelope, Platform } from "../core/types.js";

interface ForwarderOptions {
  updateIntervalMs?: number;
  toolMessageMode?: "none" | "errors" | "all";
}

function truncate(text: string, max = 2000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 20)}\n...(truncated)`;
}

export class EventForwarder {
  private responseText = "";
  private pendingFlush: NodeJS.Timeout | null = null;
  private readonly pendingOps: Array<Promise<unknown>> = [];
  private readonly updateIntervalMs: number;
  private readonly toolMessageMode: "none" | "errors" | "all";

  constructor(
    private readonly connector: ConnectorPlugin,
    private readonly inbound: InboundEnvelope,
    private readonly rootMessageId: string,
    private readonly logger: GatewayLogger,
    options: ForwarderOptions = {},
  ) {
    this.updateIntervalMs = options.updateIntervalMs ?? 400;
    this.toolMessageMode = options.toolMessageMode ?? "none";
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
        this.enqueueSend(`*${prefix} ${event.toolName}*\n\`\`\`\n${truncate(summary)}\n\`\`\``);
      }
      return;
    }

    if (event.type === "status") {
      this.enqueueSend(`_${event.message}_`);
    }
  };

  async finalize(): Promise<void> {
    await this.flushNow();
    await Promise.allSettled(this.pendingOps);

    if (this.responseText.trim().length === 0) {
      await this.connector.send({
        ...this.baseEnvelope(),
        mode: "update",
        targetMessageId: this.rootMessageId,
        text: "(completed with no text response)",
      });
    }
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

    const content = this.responseText.trim().length > 0 ? this.responseText : "_Thinking..._";

    try {
      await this.connector.send({
        ...this.baseEnvelope(),
        mode: "update",
        targetMessageId: this.rootMessageId,
        text: content,
      });
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to flush streaming update");
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
        this.logger.warn({ err: error }, "Failed to send threaded tool update");
      });

    this.pendingOps.push(promise);
  }
}
