import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { SupervisedConnector } from "../connector-supervisor.js";
import type {
  ConnectorCapabilities,
  ConnectorContext,
  ConnectorHealth,
  ConnectorHealthStatus,
  ConnectorPlugin,
  GatewayLogger,
  InboundEnvelope,
  OutboundEnvelope,
} from "../types.js";

function createLogger(): GatewayLogger {
  const noop = () => undefined;
  return {
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
  } as unknown as GatewayLogger;
}

function createHealth(status: ConnectorHealthStatus, detail: string): ConnectorHealth {
  const now = Date.now();
  return {
    status,
    detail,
    statusSinceMs: now,
    updatedAtMs: now,
  };
}

function createInbound(connectorId: string, platform: "discord" | "feishu", text: string): InboundEnvelope {
  return {
    connectorId,
    platform,
    accountId: connectorId,
    source: {
      type: platform === "discord" ? "channel" : "chat",
      id: "source-1",
    },
    chatId: "chat-1",
    messageId: `msg-${Date.now()}`,
    userId: "user-1",
    userName: "tester",
    text,
    attachments: [],
    timestampMs: Date.now(),
    raw: {},
    isDirectMessage: platform === "feishu",
    mentionedBot: true,
  };
}

function createOutbound(): OutboundEnvelope {
  return {
    platform: "discord",
    accountId: "discord.main",
    chatId: "chat-1",
    mode: "create",
    text: "hello from supervisor test",
  };
}

class FakeConnector implements ConnectorPlugin {
  readonly name = "discord";
  readonly capabilities: ConnectorCapabilities = {
    updateStrategy: "edit" as const,
    supportedSources: ["channel"],
    supportsThread: true,
    supportsTyping: false,
    supportsFileUpload: false,
    maxTextLength: 2_000,
  };

  startCalls = 0;
  stopCalls = 0;
  sentMessages: OutboundEnvelope[] = [];
  private ctx: ConnectorContext | null = null;
  private health: ConnectorHealth;

  constructor(
    readonly id: string,
    readonly platform: "discord" | "feishu",
    private readonly startStatus: ConnectorHealthStatus = "ready",
  ) {
    this.health = createHealth("stopped", "fake connector stopped");
  }

  async start(ctx: ConnectorContext): Promise<void> {
    this.startCalls += 1;
    this.ctx = ctx;
    this.setHealth(this.startStatus, `fake connector started as ${this.startStatus}`);
  }

  async send(message: OutboundEnvelope): Promise<{ messageId: string }> {
    this.sentMessages.push(message);
    return { messageId: `${this.id}-out-${this.sentMessages.length}` };
  }

  getHealth(): ConnectorHealth {
    return { ...this.health };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.setHealth("stopped", "fake connector stopped");
  }

  setHealth(status: ConnectorHealthStatus, detail: string): void {
    const now = Date.now();
    this.health = {
      ...this.health,
      status,
      detail,
      updatedAtMs: now,
      statusSinceMs: this.health.status === status ? this.health.statusSinceMs : now,
      ...(status === "ready" ? { lastReadyAtMs: now } : {}),
    };
  }

  async emitInbound(text: string): Promise<void> {
    await this.ctx?.emitInbound(createInbound(this.id, this.platform, text));
  }
}

test("supervisor rebuilds degraded connectors and sends through the replacement instance", async () => {
  const first = new FakeConnector("discord.main", "discord", "ready");
  const second = new FakeConnector("discord.main", "discord", "ready");
  let factoryCalls = 0;

  const connector = new SupervisedConnector({
    initialConnector: first,
    createInstance: async () => {
      factoryCalls += 1;
      return second;
    },
    logger: createLogger(),
    monitorIntervalMs: 5,
    degradedRestartThresholdMs: 20,
    reconnectingRestartThresholdMs: 40,
    startTimeoutMs: 20,
    restartBackoffMs: 5,
    maxRestartBackoffMs: 5,
  });

  try {
    await connector.start({
      emitInbound: async () => {},
      emitControl: async () => {},
    });

    first.setHealth("degraded", "simulated disconnect");
    await delay(50);

    assert.equal(factoryCalls, 1);
    assert.equal(first.stopCalls, 1);
    assert.equal(second.startCalls, 1);

    await connector.send(createOutbound());
    assert.equal(second.sentMessages.length, 1);

    const health = connector.getHealth();
    assert.equal(health.status, "ready");
    assert.equal(health.restartCount, 1);
  } finally {
    await connector.stop();
  }
});

test("supervisor ignores stale inbound events from replaced connectors", async () => {
  const first = new FakeConnector("discord.main", "discord", "starting");
  const second = new FakeConnector("discord.main", "discord", "ready");
  const received: string[] = [];

  const connector = new SupervisedConnector({
    initialConnector: first,
    createInstance: async () => second,
    logger: createLogger(),
    monitorIntervalMs: 5,
    degradedRestartThresholdMs: 20,
    reconnectingRestartThresholdMs: 20,
    startTimeoutMs: 20,
    restartBackoffMs: 5,
    maxRestartBackoffMs: 5,
  });

  try {
    await connector.start({
      emitInbound: async (message) => {
        received.push(message.text);
      },
      emitControl: async () => {},
    });

    await delay(50);
    assert.equal(second.startCalls, 1);

    await first.emitInbound("stale");
    await second.emitInbound("fresh");

    assert.deepEqual(received, ["fresh"]);
    assert.equal(connector.getHealth().restartCount, 1);
  } finally {
    await connector.stop();
  }
});
