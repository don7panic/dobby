import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createTypingKeepAliveController } from "../typing-controller.js";
import type {
  ConnectorPlugin,
  GatewayLogger,
  InboundEnvelope,
} from "../types.js";

function createLogger(): GatewayLogger {
  return {
    error() {},
    warn() {},
    info() {},
    debug() {},
  } as unknown as GatewayLogger;
}

function createInbound(): InboundEnvelope {
  return {
    connectorId: "discord.main",
    platform: "discord",
    accountId: "discord.main",
    source: {
      type: "channel",
      id: "123",
    },
    chatId: "123",
    messageId: "m-1",
    userId: "u-1",
    userName: "tester",
    text: "hello",
    attachments: [],
    timestampMs: Date.now(),
    raw: {},
    isDirectMessage: false,
    mentionedBot: true,
  };
}

function createConnector(sentTyping: number[]): ConnectorPlugin {
  return {
    id: "discord.main",
    platform: "discord",
    name: "discord",
    capabilities: {
      updateStrategy: "edit",
      supportedSources: ["channel"],
      supportsThread: true,
      supportsTyping: true,
      supportsFileUpload: true,
      maxTextLength: 2000,
    },
    async start() {},
    async send() {
      return { messageId: "reply-1" };
    },
    async sendTyping() {
      sentTyping.push(Date.now());
    },
    async stop() {},
  };
}

test("typing is sent before the first visible output when response is slow", async () => {
  const sentTyping: number[] = [];
  const controller = createTypingKeepAliveController(
    createConnector(sentTyping),
    createInbound(),
    createLogger(),
    {
      initialDelayMs: 0,
      keepaliveIntervalMs: 200,
    },
  );

  try {
    await controller.prime();
    assert.equal(sentTyping.length, 1);
  } finally {
    controller.stop();
  }
});

test("visible output before prime suppresses typing", async () => {
  const sentTyping: number[] = [];
  const controller = createTypingKeepAliveController(
    createConnector(sentTyping),
    createInbound(),
    createLogger(),
    {
      initialDelayMs: 0,
      keepaliveIntervalMs: 200,
    },
  );

  try {
    controller.markVisibleOutput();
    await controller.prime();
    assert.deepEqual(sentTyping, []);
  } finally {
    controller.stop();
  }
});

test("visible output stops further typing keepalive", async () => {
  const sentTyping: number[] = [];
  const controller = createTypingKeepAliveController(
    createConnector(sentTyping),
    createInbound(),
    createLogger(),
    {
      initialDelayMs: 0,
      keepaliveIntervalMs: 15,
    },
  );

  try {
    await controller.prime();
    const beforeVisibleOutput = sentTyping.length;
    assert.equal(beforeVisibleOutput > 0, true);
    controller.markVisibleOutput();
    await delay(30);
    assert.equal(sentTyping.length, beforeVisibleOutput);
  } finally {
    controller.stop();
  }
});
