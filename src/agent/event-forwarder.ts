import type {
  ConnectorPlugin,
  ConnectorUpdateStrategy,
  GatewayAgentEvent,
  GatewayLogger,
  InboundEnvelope,
  Platform,
} from "../core/types.js";

interface ForwarderOptions {
  updateIntervalMs?: number;
  toolMessageMode?: "none" | "errors" | "all";
  onOutboundActivity?: () => void;
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

function splitForMaxLength(text: string, max?: number, options: { preserveWhitespace?: boolean } = {}): string[] {
  if (max === undefined) {
    return [text];
  }
  if (max <= 0) {
    return [""];
  }
  if (text.length <= max) {
    return [text];
  }

  const preserveWhitespace = options.preserveWhitespace ?? false;
  const chunks: string[] = [];
  let offset = 0;

  while (offset < text.length) {
    const remainingLength = text.length - offset;
    if (remainingLength <= max) {
      chunks.push(text.slice(offset));
      break;
    }

    if (preserveWhitespace) {
      chunks.push(text.slice(offset, offset + max));
      offset += max;
      continue;
    }

    const hardLimit = offset + max;
    let splitAt = text.lastIndexOf("\n", hardLimit);
    if (splitAt < offset + Math.floor(max * 0.6)) {
      splitAt = hardLimit;
    } else {
      splitAt += 1;
    }
    chunks.push(text.slice(offset, splitAt));
    offset = splitAt;
  }

  return chunks;
}

export class EventForwarder {
  private rootMessageId: string | null;
  private responseText = "";
  private appendEmittedText = "";
  private pendingFlush: NodeJS.Timeout | null = null;
  private flushSerial: Promise<void> = Promise.resolve();
  private readonly pendingOps: Array<Promise<unknown>> = [];
  private readonly updateIntervalMs: number;
  private readonly toolMessageMode: "none" | "errors" | "all";
  private readonly maxTextLength: number | undefined;
  private readonly onOutboundActivity: (() => void) | undefined;
  private readonly updateStrategy: ConnectorUpdateStrategy;
  private lastEditPrimaryText: string | null = null;

  constructor(
    private readonly connector: ConnectorPlugin,
    private readonly inbound: InboundEnvelope,
    rootMessageId: string | null,
    private readonly logger: GatewayLogger,
    options: ForwarderOptions = {},
  ) {
    this.rootMessageId = rootMessageId;
    this.updateIntervalMs = options.updateIntervalMs ?? 400;
    this.toolMessageMode = options.toolMessageMode ?? "none";
    this.onOutboundActivity = options.onOutboundActivity;
    this.updateStrategy = this.connector.capabilities.updateStrategy;
    const capabilityMaxTextLength = this.connector.capabilities.maxTextLength;
    this.maxTextLength = typeof capabilityMaxTextLength === "number" && capabilityMaxTextLength > 0
      ? capabilityMaxTextLength
      : undefined;
  }

  primaryMessageId(): string | null {
    return this.rootMessageId;
  }

  handleEvent = (event: GatewayAgentEvent): void => {
    if (event.type === "message_delta") {
      this.responseText += event.delta;
      if (this.updateStrategy !== "final_only") {
        this.scheduleFlush();
      }
      return;
    }

    if (event.type === "message_complete") {
      if (event.text.trim().length > 0) {
        this.responseText = event.text;
        if (this.updateStrategy !== "final_only") {
          void this.flushNow();
        }
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
      if (this.updateStrategy !== "final_only" && this.toolMessageMode === "all") {
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
      if (
        this.updateStrategy !== "final_only" &&
        (this.toolMessageMode === "all" || (this.toolMessageMode === "errors" && event.isError))
      ) {
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
      if (this.updateStrategy === "final_only") {
        return;
      }
      this.enqueueSend(`_${event.message}_`);
    }
  };

  async finalize(): Promise<void> {
    if (this.updateStrategy === "final_only") {
      await this.finalizeFinalOnly();
      await Promise.allSettled(this.pendingOps);
      return;
    }

    if (this.updateStrategy === "append") {
      await this.finalizeAppend();
      await Promise.allSettled(this.pendingOps);
      return;
    }

    await this.finalizeEdit();
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
    const run = this.flushSerial.then(async () => {
      if (this.pendingFlush) {
        clearTimeout(this.pendingFlush);
        this.pendingFlush = null;
      }

      if (this.responseText.trim().length === 0) {
        return;
      }

      try {
        if (this.updateStrategy === "append") {
          await this.flushAppendProgress();
          return;
        }

        if (this.updateStrategy === "edit") {
          const content = truncate(this.responseText, this.maxTextLength);
          await this.sendEditPrimary(content);
        }
      } catch (error) {
        this.logger.warn(
          {
            err: error,
            connectorId: this.inbound.connectorId,
            chatId: this.inbound.chatId,
            targetMessageId: this.rootMessageId,
            contentLength: this.responseText.length,
            updateStrategy: this.updateStrategy,
          },
          "Failed to flush streaming update",
        );
      }
    });

    this.flushSerial = run.catch(() => {
      // keep chain alive for future flush calls
    });

    await run;
  }

  private enqueueSend(text: string): void {
    const promise = this.connector
      .send({
        ...this.baseEnvelope(),
        mode: "create",
        ...(this.rootMessageId ? { replyToMessageId: this.rootMessageId } : {}),
        text,
      })
      .then(() => {
        this.noteOutboundActivity();
      })
      .catch((error) => {
        this.logger.warn(
          {
            err: error,
            connectorId: this.inbound.connectorId,
            chatId: this.inbound.chatId,
            replyToMessageId: this.rootMessageId,
          },
          "Failed to send connector update message",
        );
      });

    this.pendingOps.push(promise);
  }

  private async sendEditPrimary(text: string): Promise<void> {
    if (this.rootMessageId && this.lastEditPrimaryText === text) {
      return;
    }

    if (this.rootMessageId) {
      await this.connector.send({
        ...this.baseEnvelope(),
        mode: "update",
        targetMessageId: this.rootMessageId,
        text,
      });
      this.lastEditPrimaryText = text;
      this.noteOutboundActivity();
      return;
    }

    const created = await this.connector.send({
      ...this.baseEnvelope(),
      mode: "create",
      text,
    });
    this.rootMessageId = created.messageId ?? this.rootMessageId;
    this.lastEditPrimaryText = text;
    this.noteOutboundActivity();
  }

  private async sendCreate(text: string): Promise<void> {
    const created = await this.connector.send({
      ...this.baseEnvelope(),
      mode: "create",
      ...(this.rootMessageId ? { replyToMessageId: this.rootMessageId } : {}),
      text,
    });
    this.rootMessageId = this.rootMessageId ?? created.messageId ?? null;
    this.noteOutboundActivity();
  }

  private async flushAppendProgress(): Promise<void> {
    if (this.responseText.startsWith(this.appendEmittedText)) {
      const unsent = this.responseText.slice(this.appendEmittedText.length);
      if (unsent.length === 0) {
        return;
      }
      const chunks = splitForMaxLength(unsent, this.maxTextLength, { preserveWhitespace: true });
      for (const chunk of chunks) {
        await this.sendCreate(chunk);
      }
      this.appendEmittedText = this.responseText;
      return;
    }

    const snapshotChunks = splitForMaxLength(this.responseText, this.maxTextLength);
    for (const chunk of snapshotChunks) {
      await this.sendCreate(chunk);
    }
    this.appendEmittedText = this.responseText;
  }

  private async finalizeEdit(): Promise<void> {
    await this.flushNow();

    if (this.responseText.trim().length === 0) {
      await this.sendEditPrimary("(completed with no text response)");
      return;
    }

    const chunks = splitForMaxLength(this.responseText, this.maxTextLength);
    try {
      await this.sendEditPrimary(chunks[0] ?? "");

      for (const chunk of chunks.slice(1)) {
        await this.sendCreate(chunk);
      }
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          connectorId: this.inbound.connectorId,
          chatId: this.inbound.chatId,
          targetMessageId: this.rootMessageId,
        },
        "Failed to send split final response",
      );
    }
  }

  private async finalizeFinalOnly(): Promise<void> {
    if (this.pendingFlush) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = null;
    }

    try {
      if (this.responseText.trim().length === 0) {
        await this.sendCreate("(completed with no text response)");
        return;
      }

      const chunks = splitForMaxLength(this.responseText, this.maxTextLength);
      for (const chunk of chunks) {
        await this.sendCreate(chunk);
      }
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          connectorId: this.inbound.connectorId,
          chatId: this.inbound.chatId,
          updateStrategy: this.updateStrategy,
        },
        "Failed to send final-only response",
      );
    }
  }

  private async finalizeAppend(): Promise<void> {
    await this.flushNow();

    if (this.responseText.trim().length > 0 || this.appendEmittedText.trim().length > 0) {
      return;
    }

    try {
      await this.sendCreate("(completed with no text response)");
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          connectorId: this.inbound.connectorId,
          chatId: this.inbound.chatId,
          updateStrategy: this.updateStrategy,
        },
        "Failed to send append fallback response",
      );
    }
  }

  private noteOutboundActivity(): void {
    this.onOutboundActivity?.();
  }
}
