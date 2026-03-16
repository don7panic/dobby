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

async function waitFor(predicate: () => boolean, timeoutMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await delay(5);
  }
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
    private readonly options: {
      startStatus?: ConnectorHealthStatus;
      onStart?: () => Promise<void>;
      onStop?: () => Promise<void>;
      startError?: Error;
    } = {},
  ) {
    this.health = createHealth("stopped", "fake connector stopped");
  }

  async start(ctx: ConnectorContext): Promise<void> {
    this.startCalls += 1;
    this.ctx = ctx;
    const startStatus = this.options.startStatus ?? "ready";
    this.setHealth(startStatus, `fake connector started as ${startStatus}`);
    await this.options.onStart?.();
    if (this.options.startError) {
      throw this.options.startError;
    }
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
    await this.options.onStop?.();
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
  const first = new FakeConnector("discord.main", "discord", { startStatus: "ready" });
  const second = new FakeConnector("discord.main", "discord", { startStatus: "ready" });
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
  const first = new FakeConnector("discord.main", "discord", { startStatus: "starting" });
  const second = new FakeConnector("discord.main", "discord", { startStatus: "ready" });
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

test("supervisor stop waits for in-flight replacement start and cleans the replacement connector", async () => {
  let releaseReplacementStart!: () => void;
  const replacementStarted = new Promise<void>((resolve) => {
    releaseReplacementStart = resolve;
  });
  const first = new FakeConnector("discord.main", "discord", { startStatus: "ready" });
  const second = new FakeConnector("discord.main", "discord", {
    startStatus: "ready",
    onStart: async () => replacementStarted,
  });

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

  await connector.start({
    emitInbound: async () => {},
    emitControl: async () => {},
  });

  try {
    first.setHealth("degraded", "simulated disconnect");
    await waitFor(() => second.startCalls === 1);

    let stopResolved = false;
    const stopPromise = connector.stop().then(() => {
      stopResolved = true;
    });

    await delay(20);
    assert.equal(stopResolved, false);

    releaseReplacementStart();
    await stopPromise;

    assert.equal(second.stopCalls, 1);
    assert.equal(connector.getHealth().status, "stopped");
  } finally {
    releaseReplacementStart();
    await connector.stop();
  }
});

test("supervisor cleans partially started connector after initial start failure", async () => {
  const first = new FakeConnector("discord.main", "discord", {
    startStatus: "starting",
    startError: new Error("initial start failed"),
  });

  const connector = new SupervisedConnector({
    initialConnector: first,
    createInstance: async () => first,
    logger: createLogger(),
  });

  await assert.rejects(
    connector.start({
      emitInbound: async () => {},
      emitControl: async () => {},
    }),
    /initial start failed/,
  );

  assert.equal(first.stopCalls, 1);
});

test("supervisor cleans partially started replacement connector after restart failure", async () => {
  const first = new FakeConnector("discord.main", "discord", { startStatus: "ready" });
  const second = new FakeConnector("discord.main", "discord", {
    startStatus: "starting",
    startError: new Error("replacement start failed"),
  });

  const connector = new SupervisedConnector({
    initialConnector: first,
    createInstance: async () => second,
    logger: createLogger(),
    monitorIntervalMs: 5,
    degradedRestartThresholdMs: 20,
    reconnectingRestartThresholdMs: 20,
    startTimeoutMs: 20,
    restartBackoffMs: 1_000,
    maxRestartBackoffMs: 1_000,
  });

  try {
    await connector.start({
      emitInbound: async () => {},
      emitControl: async () => {},
    });

    first.setHealth("degraded", "simulated disconnect");
    await waitFor(() => second.startCalls === 1);
    await waitFor(() => second.stopCalls === 1);

    assert.match(connector.getHealth().lastError ?? "", /replacement start failed/);
    assert.equal(connector.getHealth().status, "reconnecting");
  } finally {
    await connector.stop();
  }
});
