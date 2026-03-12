import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { EventForwarder } from "../event-forwarder.js";
import {
  OUTBOUND_MESSAGE_KIND_METADATA_KEY,
  OUTBOUND_MESSAGE_KIND_PROGRESS,
} from "../../core/types.js";
import type {
  ConnectorPlugin,
  GatewayLogger,
  InboundEnvelope,
  OutboundEnvelope,
  ProgressUpdateStrategy,
} from "../../core/types.js";

function createLogger(): GatewayLogger {
  const noop = () => undefined;
  return {
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
  } as unknown as GatewayLogger;
}

function createInbound(platform: "discord" | "feishu" = "feishu"): InboundEnvelope {
  return {
    connectorId: `${platform}.main`,
    platform,
    accountId: `${platform}.main`,
    source: {
      type: platform === "feishu" ? "chat" : "channel",
      id: "chat-1",
    },
    chatId: "chat-1",
    messageId: "msg-1",
    userId: "user-1",
    userName: "tester",
    text: "hello",
    attachments: [],
    timestampMs: Date.now(),
    raw: {},
    isDirectMessage: platform === "feishu",
    mentionedBot: true,
  };
}

function createConnector(
  platform: "discord" | "feishu",
  updateStrategy: "edit" | "final_only",
  sentMessages: OutboundEnvelope[],
  progressUpdateStrategy: ProgressUpdateStrategy = "edit",
): ConnectorPlugin {
  return {
    id: `${platform}.main`,
    platform,
    name: platform,
    capabilities: {
      updateStrategy,
      progressUpdateStrategy,
      supportedSources: [platform === "feishu" ? "chat" : "channel"],
      supportsThread: true,
      supportsTyping: false,
      supportsFileUpload: false,
      maxTextLength: 8_000,
    },
    async start() {},
    async send(message) {
      sentMessages.push(message);
      return { messageId: `out-${sentMessages.length}` };
    },
    async stop() {},
  };
}

test("EventForwarder uses one debounced progress message for Feishu local work", async () => {
  const sentMessages: OutboundEnvelope[] = [];
  const forwarder = new EventForwarder(
    createConnector("feishu", "final_only", sentMessages),
    createInbound("feishu"),
    null,
    createLogger(),
    {
      progressDebounceMs: 200,
    },
  );

  forwarder.handleEvent({ type: "status", message: "Codex is thinking..." });
  forwarder.handleEvent({ type: "command_start", command: "/bin/zsh -lc 'git status --short --branch'" });
  forwarder.handleEvent({ type: "command_start", command: "pwd" });
  forwarder.handleEvent({ type: "message_complete", text: "final answer" });
  await forwarder.finalize();

  assert.deepEqual(sentMessages, [
    {
      platform: "feishu",
      accountId: "feishu.main",
      chatId: "chat-1",
      mode: "create",
      text: "Codex is thinking...",
      metadata: {
        [OUTBOUND_MESSAGE_KIND_METADATA_KEY]: OUTBOUND_MESSAGE_KIND_PROGRESS,
      },
    },
    {
      platform: "feishu",
      accountId: "feishu.main",
      chatId: "chat-1",
      mode: "update",
      targetMessageId: "out-1",
      text: "Working locally...",
      metadata: {
        [OUTBOUND_MESSAGE_KIND_METADATA_KEY]: OUTBOUND_MESSAGE_KIND_PROGRESS,
      },
    },
    {
      platform: "feishu",
      accountId: "feishu.main",
      chatId: "chat-1",
      mode: "create",
      text: "final answer",
    },
  ]);
});

test("EventForwarder reuses one progress message for editable connectors too", async () => {
  const sentMessages: OutboundEnvelope[] = [];
  const forwarder = new EventForwarder(
    createConnector("discord", "edit", sentMessages),
    createInbound("discord"),
    null,
    createLogger(),
  );

  forwarder.handleEvent({ type: "status", message: "Codex is thinking..." });
  forwarder.handleEvent({ type: "command_start", command: "git diff --stat" });
  forwarder.handleEvent({ type: "message_complete", text: "done" });
  await forwarder.finalize();

  assert.deepEqual(sentMessages, [
    {
      platform: "discord",
      accountId: "discord.main",
      chatId: "chat-1",
      mode: "create",
      text: "Codex is thinking...",
      metadata: {
        [OUTBOUND_MESSAGE_KIND_METADATA_KEY]: OUTBOUND_MESSAGE_KIND_PROGRESS,
      },
    },
    {
      platform: "discord",
      accountId: "discord.main",
      chatId: "chat-1",
      mode: "update",
      targetMessageId: "out-1",
      text: "Working locally...",
      metadata: {
        [OUTBOUND_MESSAGE_KIND_METADATA_KEY]: OUTBOUND_MESSAGE_KIND_PROGRESS,
      },
    },
    {
      platform: "discord",
      accountId: "discord.main",
      chatId: "chat-1",
      mode: "create",
      text: "done",
    },
  ]);
});

test("EventForwarder escalates long-running generic progress states without exposing commands", async () => {
  const sentMessages: OutboundEnvelope[] = [];
  const forwarder = new EventForwarder(
    createConnector("discord", "edit", sentMessages),
    createInbound("discord"),
    null,
    createLogger(),
    {
      progressDebounceMs: 5,
      longProgressMs: 10,
    },
  );

  forwarder.handleEvent({ type: "status", message: "Thinking..." });
  forwarder.handleEvent({ type: "command_start", command: "git status --short" });
  await delay(20);
  await forwarder.finalize();

  assert.deepEqual(sentMessages, [
    {
      platform: "discord",
      accountId: "discord.main",
      chatId: "chat-1",
      mode: "create",
      text: "Thinking...",
      metadata: {
        [OUTBOUND_MESSAGE_KIND_METADATA_KEY]: OUTBOUND_MESSAGE_KIND_PROGRESS,
      },
    },
    {
      platform: "discord",
      accountId: "discord.main",
      chatId: "chat-1",
      mode: "update",
      targetMessageId: "out-1",
      text: "Working locally...",
      metadata: {
        [OUTBOUND_MESSAGE_KIND_METADATA_KEY]: OUTBOUND_MESSAGE_KIND_PROGRESS,
      },
    },
    {
      platform: "discord",
      accountId: "discord.main",
      chatId: "chat-1",
      mode: "update",
      targetMessageId: "out-1",
      text: "Still working locally...",
      metadata: {
        [OUTBOUND_MESSAGE_KIND_METADATA_KEY]: OUTBOUND_MESSAGE_KIND_PROGRESS,
      },
    },
    {
      platform: "discord",
      accountId: "discord.main",
      chatId: "chat-1",
      mode: "create",
      text: "(completed with no text response)",
    },
  ]);
});

test("EventForwarder renders visible tool side-messages as plain text for Feishu mixed rendering", async () => {
  const sentMessages: OutboundEnvelope[] = [];
  const forwarder = new EventForwarder(
    createConnector("feishu", "final_only", sentMessages),
    createInbound("feishu"),
    null,
    createLogger(),
    {
      toolMessageMode: "all",
    },
  );

  forwarder.handleEvent({ type: "tool_start", toolName: "bash" });
  forwarder.handleEvent({ type: "tool_end", toolName: "bash", isError: false, output: "pwd\n/tmp/project" });
  forwarder.handleEvent({ type: "message_complete", text: "done" });
  await forwarder.finalize();

  assert.deepEqual(sentMessages, [
    {
      platform: "feishu",
      accountId: "feishu.main",
      chatId: "chat-1",
      mode: "create",
      text: "Running tool: bash",
      metadata: {
        [OUTBOUND_MESSAGE_KIND_METADATA_KEY]: OUTBOUND_MESSAGE_KIND_PROGRESS,
      },
    },
    {
      platform: "feishu",
      accountId: "feishu.main",
      chatId: "chat-1",
      mode: "create",
      text: "OK bash\npwd\n/tmp/project",
      metadata: {
        [OUTBOUND_MESSAGE_KIND_METADATA_KEY]: OUTBOUND_MESSAGE_KIND_PROGRESS,
      },
    },
    {
      platform: "feishu",
      accountId: "feishu.main",
      chatId: "chat-1",
      mode: "create",
      text: "done",
    },
  ]);
});
