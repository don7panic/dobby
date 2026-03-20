import {
  OUTBOUND_MESSAGE_KIND_METADATA_KEY,
  OUTBOUND_MESSAGE_KIND_PROGRESS,
} from "../core/types.js";
import type {
  ConnectorPlugin,
  ProgressUpdateStrategy,
  ConnectorUpdateStrategy,
  GatewayAgentEvent,
  GatewayLogger,
  InboundEnvelope,
  Platform,
} from "../core/types.js";

interface ForwarderOptions {
  updateIntervalMs?: number;
  progressDebounceMs?: number;
  longProgressMs?: number;
  toolMessageMode?: "none" | "errors" | "all";
  onOutboundActivity?: () => void;
}

const DEFAULT_PROGRESS_DEBOUNCE_MS = 150;
const DEFAULT_LONG_PROGRESS_MS = 10_000;
const WORKING_LOCALLY_TEXT = "Working locally...";
const STILL_WORKING_LOCALLY_TEXT = "Still working locally...";
const WORKING_WITH_TOOLS_TEXT = "Working with tools...";
const STILL_WORKING_WITH_TOOLS_TEXT = "Still working with tools...";
const RECOVERING_FROM_TOOL_ISSUE_TEXT = "Recovering from a tool issue...";

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
  private progressSerial: Promise<void> = Promise.resolve();
  private readonly pendingOps: Array<Promise<unknown>> = [];
  private readonly updateIntervalMs: number;
  private readonly progressDebounceMs: number;
  private readonly longProgressMs: number;
  private readonly toolMessageMode: "none" | "errors" | "all";
  private readonly maxTextLength: number | undefined;
  private readonly onOutboundActivity: (() => void) | undefined;
  private readonly updateStrategy: ConnectorUpdateStrategy;
  private readonly progressUpdateStrategy: ProgressUpdateStrategy;
  private lastEditPrimaryText: string | null = null;
  private progressMessageId: string | null = null;
  private lastProgressMessageText: string | null = null;
  private pendingProgressText: string | null = null;
  private pendingProgressFlush: NodeJS.Timeout | null = null;
  private hasQueuedProgressMessage = false;
  private longProgressTimer: NodeJS.Timeout | null = null;
  private activeWorkPhase: "local" | "tool" | null = null;

  constructor(
    private readonly connector: ConnectorPlugin,
    private readonly inbound: InboundEnvelope,
    rootMessageId: string | null,
    private readonly logger: GatewayLogger,
    options: ForwarderOptions = {},
  ) {
    this.rootMessageId = rootMessageId;
    this.updateIntervalMs = options.updateIntervalMs ?? 400;
    this.progressDebounceMs = options.progressDebounceMs ?? DEFAULT_PROGRESS_DEBOUNCE_MS;
    this.longProgressMs = options.longProgressMs ?? DEFAULT_LONG_PROGRESS_MS;
    this.toolMessageMode = options.toolMessageMode ?? "none";
    this.onOutboundActivity = options.onOutboundActivity;
    this.updateStrategy = this.connector.capabilities.updateStrategy;
    this.progressUpdateStrategy = this.connector.capabilities.progressUpdateStrategy
      ?? (this.updateStrategy === "edit" ? "edit" : "create");
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

    if (event.type === "command_start") {
      this.enterWorkPhase("local");
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
        this.enqueueSideMessage(this.renderToolStartMessage(event.toolName));
      } else {
        this.enterWorkPhase("tool");
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
        (this.toolMessageMode === "all" || (this.toolMessageMode === "errors" && event.isError))
      ) {
        this.enqueueSideMessage(this.renderToolEndMessage(event.toolName, event.isError, summary));
      } else if (event.isError) {
        this.setProgressMessage(RECOVERING_FROM_TOOL_ISSUE_TEXT);
      }
      return;
    }

    if (event.type === "status") {
      this.setProgressMessage(event.message);
    }
  };

  async finalize(): Promise<void> {
    this.clearLongProgressTimer();
    await this.flushProgressUpdates();

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
        await this.flushProgressUpdates();

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

  private enqueueSideMessage(text: string): void {
    this.enqueueSendWithMetadata(text, this.progressMessageMetadata());
  }

  private setProgressMessage(message: string): void {
    this.activeWorkPhase = null;
    this.clearLongProgressTimer();
    this.scheduleProgressUpdate(this.renderStatusMessage(message));
  }

  private enterWorkPhase(phase: "local" | "tool"): void {
    if (this.activeWorkPhase === "local" && phase === "tool") {
      return;
    }
    if (this.activeWorkPhase === phase) {
      return;
    }

    this.activeWorkPhase = phase;
    this.scheduleProgressUpdate(this.renderWorkPhaseMessage(phase, false));
    this.scheduleLongProgressUpdate(phase);
  }

  private scheduleProgressUpdate(text: string): void {
    const shouldCreateImmediately = !this.hasQueuedProgressMessage;
    this.hasQueuedProgressMessage = true;
    this.pendingProgressText = text;
    if (shouldCreateImmediately) {
      void this.flushProgressNow();
      return;
    }

    if (this.pendingProgressFlush) {
      clearTimeout(this.pendingProgressFlush);
    }
    this.pendingProgressFlush = setTimeout(() => {
      void this.flushProgressNow();
    }, this.progressDebounceMs);
  }

  private async flushProgressNow(): Promise<void> {
    if (this.pendingProgressFlush) {
      clearTimeout(this.pendingProgressFlush);
      this.pendingProgressFlush = null;
    }

    const text = this.pendingProgressText;
    if (text === null) {
      return;
    }
    this.pendingProgressText = null;

    const metadata = this.progressMessageMetadata();
    const run = this.progressSerial.then(async () => {
      if (this.lastProgressMessageText === text) {
        return;
      }

      try {
        if (this.canEditProgressMessage() && this.progressMessageId) {
          await this.connector.send({
            ...this.baseEnvelope(),
            mode: "update",
            targetMessageId: this.progressMessageId,
            text,
            metadata,
          });
          this.lastProgressMessageText = text;
          this.noteOutboundActivity();
          return;
        }

        const created = await this.connector.send({
          ...this.baseEnvelope(),
          mode: "create",
          text,
          metadata,
        });
        this.progressMessageId = this.canEditProgressMessage() ? (created.messageId ?? this.progressMessageId) : null;
        this.lastProgressMessageText = text;
        this.noteOutboundActivity();
      } catch (error) {
        this.logger.warn(
          {
            err: error,
            connectorId: this.inbound.connectorId,
            chatId: this.inbound.chatId,
            progressMessageId: this.progressMessageId,
          },
          "Failed to send or update progress message",
        );
      }
    });

    this.progressSerial = run.catch(() => {
      // keep chain alive for future progress updates
    });
    this.pendingOps.push(run);

    await run;
  }

  private scheduleLongProgressUpdate(phase: "local" | "tool"): void {
    this.clearLongProgressTimer();
    if (this.longProgressMs <= 0) {
      return;
    }

    this.longProgressTimer = setTimeout(() => {
      if (this.activeWorkPhase !== phase) {
        return;
      }
      this.scheduleProgressUpdate(this.renderWorkPhaseMessage(phase, true));
    }, this.longProgressMs);
  }

  private enqueueSendWithMetadata(text: string, metadata?: Record<string, string>): void {
    const promise = this.connector
      .send({
        ...this.baseEnvelope(),
        mode: "create",
        ...(this.rootMessageId ? { replyToMessageId: this.rootMessageId } : {}),
        text,
        ...(metadata ? { metadata } : {}),
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

  private canEditProgressMessage(): boolean {
    return this.progressUpdateStrategy === "edit";
  }

  private progressMessageMetadata(): Record<string, string> {
    return {
      [OUTBOUND_MESSAGE_KIND_METADATA_KEY]: OUTBOUND_MESSAGE_KIND_PROGRESS,
    };
  }

  private renderStatusMessage(message: string): string {
    return truncate(message, this.maxTextLength);
  }

  private renderWorkPhaseMessage(phase: "local" | "tool", isLongRunning: boolean): string {
    if (phase === "local") {
      return truncate(isLongRunning ? STILL_WORKING_LOCALLY_TEXT : WORKING_LOCALLY_TEXT, this.maxTextLength);
    }
    return truncate(isLongRunning ? STILL_WORKING_WITH_TOOLS_TEXT : WORKING_WITH_TOOLS_TEXT, this.maxTextLength);
  }

  private renderToolStartMessage(toolName: string): string {
    return truncate(`Running tool: ${toolName}`, this.maxTextLength);
  }

  private renderToolEndMessage(toolName: string, isError: boolean, summary: string): string {
    const prefix = isError ? "ERR" : "OK";
    const body = summary.trim().length > 0 ? `${prefix} ${toolName}\n${summary}` : `${prefix} ${toolName}`;
    return truncate(body, this.maxTextLength);
  }

  private async flushProgressUpdates(): Promise<void> {
    if (this.pendingProgressText !== null) {
      await this.flushProgressNow();
      return;
    }

    try {
      await this.progressSerial;
    } catch {
      // progress message failures are already logged when they happen
    }
  }

  private clearLongProgressTimer(): void {
    if (this.longProgressTimer) {
      clearTimeout(this.longProgressTimer);
      this.longProgressTimer = null;
    }
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

    try {
      if (this.responseText.trim().length === 0) {
        await this.sendEditPrimary("(completed with no text response)");
        return;
      }

      const chunks = splitForMaxLength(this.responseText, this.maxTextLength);
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
        "Failed to send final response",
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
