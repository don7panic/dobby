import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ConnectorPlugin, GatewayLogger, InboundEnvelope } from "../core/types.js";

interface ForwarderOptions {
  updateIntervalMs?: number;
  toolMessageMode?: "none" | "errors" | "all";
}

function extractAssistantText(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  const blocks = message.content.filter((block): block is { type: "text"; text: string } => block.type === "text");
  return blocks.map((block) => block.text).join("\n");
}

function extractToolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "(no output)";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "(no output)";

  const textBlocks = content.filter(
    (block): block is { type: "text"; text: string } =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      (block as { type: string }).type === "text" &&
      "text" in block,
  );

  const text = textBlocks.map((block) => block.text).join("\n").trim();
  return text.length > 0 ? text : "(no output)";
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

  handleEvent = (event: AgentSessionEvent): void => {
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        this.responseText += event.assistantMessageEvent.delta;
        this.scheduleFlush();
      }
      return;
    }

    if (event.type === "message_end") {
      if (event.message.role === "assistant") {
        const finalText = extractAssistantText(event.message);
        if (finalText.trim().length > 0) {
          this.responseText = finalText;
          void this.flushNow();
        }
      }
      return;
    }

    if (event.type === "tool_execution_start") {
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

    if (event.type === "tool_execution_end") {
      const summary = extractToolResultText(event.result);
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

    if (event.type === "auto_compaction_start") {
      this.enqueueSend(`_Compacting context (${event.reason})..._`);
      return;
    }

    if (event.type === "auto_retry_start") {
      this.enqueueSend(`_Retrying (${event.attempt}/${event.maxAttempts})..._`);
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

  private baseEnvelope(): { platform: "discord"; accountId: string; chatId: string; threadId?: string } {
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
