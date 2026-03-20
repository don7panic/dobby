import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Gateway } from "../gateway.js";
import { DedupStore } from "../dedup-store.js";
import { BindingResolver, RouteResolver } from "../routing.js";
import { RuntimeRegistry } from "../runtime-registry.js";
import { BUILTIN_HOST_SANDBOX_ID } from "../types.js";
import type {
  ConnectorCapabilities,
  ConnectorContext,
  ConnectorPlugin,
  GatewayAgentRuntime,
  GatewayConfig,
  GatewayLogger,
  InboundEnvelope,
  OutboundEnvelope,
  ProviderInstance,
} from "../types.js";
import type { Executor } from "../../sandbox/executor.js";

function createLogger(): GatewayLogger {
  const noop = () => undefined;
  return {
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
  } as unknown as GatewayLogger;
}

function createInbound(): InboundEnvelope {
  return {
    connectorId: "discord.main",
    platform: "discord",
    accountId: "discord.main",
    source: {
      type: "channel",
      id: "channel-1",
    },
    chatId: "channel-1",
    messageId: "msg-1",
    userId: "user-1",
    userName: "tester",
    text: "hello",
    attachments: [],
    timestampMs: Date.now(),
    raw: {},
    isDirectMessage: false,
    mentionedBot: true,
  };
}

function createConfig(rootDir: string): GatewayConfig {
  return {
    extensions: {
      allowList: [],
    },
    providers: {
      default: "pi.main",
      items: {
        "pi.main": {
          type: "provider.pi",
          config: {},
        },
      },
    },
    connectors: {
      items: {
        "discord.main": {
          type: "connector.discord",
          config: {},
        },
      },
    },
    sandboxes: {
      default: BUILTIN_HOST_SANDBOX_ID,
      items: {},
    },
    routes: {
      default: {
        projectRoot: rootDir,
        provider: "pi.main",
        sandbox: BUILTIN_HOST_SANDBOX_ID,
        tools: "readonly",
        mentions: "optional",
      },
      items: {
        main: {
          projectRoot: rootDir,
          provider: "pi.main",
          sandbox: BUILTIN_HOST_SANDBOX_ID,
          tools: "readonly",
          mentions: "optional",
        },
      },
    },
    bindings: {
      items: {
        main: {
          connector: "discord.main",
          source: {
            type: "channel",
            id: "channel-1",
          },
          route: "main",
        },
      },
    },
    data: {
      rootDir,
      sessionsDir: join(rootDir, "sessions"),
      attachmentsDir: join(rootDir, "attachments"),
      logsDir: join(rootDir, "logs"),
      stateDir: join(rootDir, "state"),
      dedupTtlMs: 60_000,
    },
  };
}

class FakeConnector implements ConnectorPlugin {
  readonly id = "discord.main";
  readonly platform = "discord" as const;
  readonly name = "discord";
  readonly capabilities: ConnectorCapabilities = {
    updateStrategy: "edit",
    progressUpdateStrategy: "edit",
    supportedSources: ["channel"],
    supportsThread: true,
    supportsTyping: false,
    supportsFileUpload: false,
    maxTextLength: 2_000,
  };

  sent: OutboundEnvelope[] = [];
  stopCalls = 0;
  failSends = false;
  private ctx: ConnectorContext | null = null;

  async start(ctx: ConnectorContext): Promise<void> {
    this.ctx = ctx;
  }

  async send(message: OutboundEnvelope): Promise<{ messageId: string }> {
    if (this.failSends) {
      throw new Error("connector unavailable");
    }

    this.sent.push(message);
    return { messageId: `out-${this.sent.length}` };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.failSends = true;
  }

  async emitInbound(message: InboundEnvelope): Promise<void> {
    await this.ctx?.emitInbound(message);
  }
}

class AbortableRuntime implements GatewayAgentRuntime {
  private readonly startedPromise: Promise<void>;
  private resolveStarted!: () => void;
  private resolvePrompt!: () => void;
  private readonly promptPromise: Promise<void>;

  constructor() {
    this.startedPromise = new Promise<void>((resolve) => {
      this.resolveStarted = resolve;
    });
    this.promptPromise = new Promise<void>((resolve) => {
      this.resolvePrompt = resolve;
    });
  }

  async prompt(): Promise<void> {
    this.resolveStarted();
    await this.promptPromise;
  }

  subscribe(): () => void {
    return () => {};
  }

  async abort(): Promise<void> {
    this.resolvePrompt();
  }

  dispose(): void {}

  async waitUntilStarted(): Promise<void> {
    await this.startedPromise;
  }
}

function createExecutor(): Executor {
  return {
    async exec() {
      return {
        stdout: "",
        stderr: "",
        code: 0,
        killed: false,
      };
    },
    spawn() {
      throw new Error("spawn not implemented in gateway test");
    },
    async close() {},
  };
}

test("Gateway stops active runtimes before stopping connectors", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "dobby-gateway-test-"));
  const config = createConfig(rootDir);
  const connector = new FakeConnector();
  const runtime = new AbortableRuntime();
  const provider: ProviderInstance = {
    id: "pi.main",
    async createRuntime() {
      return runtime;
    },
  };
  const gateway = new Gateway({
    config,
    connectors: [connector],
    providers: new Map([["pi.main", provider]]),
    executors: new Map([[BUILTIN_HOST_SANDBOX_ID, createExecutor()]]),
    routeResolver: new RouteResolver(config.routes),
    bindingResolver: new BindingResolver(config.bindings),
    dedupStore: new DedupStore(join(rootDir, "dedup.json"), config.data.dedupTtlMs, createLogger()),
    runtimeRegistry: new RuntimeRegistry(createLogger()),
    logger: createLogger(),
  });

  try {
    await gateway.start();

    const inboundPromise = connector.emitInbound(createInbound());
    await runtime.waitUntilStarted();

    await gateway.stop();
    await inboundPromise;

    assert.equal(connector.stopCalls, 1);
    assert.deepEqual(connector.sent, [
      {
        platform: "discord",
        accountId: "discord.main",
        chatId: "channel-1",
        mode: "create",
        text: "(completed with no text response)",
      },
    ]);
  } finally {
    await gateway.stop();
  }
});

test("Gateway swallows failures while sending an error reply", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "dobby-gateway-test-"));
  const config = createConfig(rootDir);
  const connector = new FakeConnector();
  const provider: ProviderInstance = {
    id: "pi.main",
    async createRuntime() {
      return {
        async prompt() {
          throw new Error("provider failed");
        },
        subscribe() {
          return () => {};
        },
        async abort() {},
        dispose() {},
      };
    },
  };
  const gateway = new Gateway({
    config,
    connectors: [connector],
    providers: new Map([["pi.main", provider]]),
    executors: new Map([[BUILTIN_HOST_SANDBOX_ID, createExecutor()]]),
    routeResolver: new RouteResolver(config.routes),
    bindingResolver: new BindingResolver(config.bindings),
    dedupStore: new DedupStore(join(rootDir, "dedup.json"), config.data.dedupTtlMs, createLogger()),
    runtimeRegistry: new RuntimeRegistry(createLogger()),
    logger: createLogger(),
  });

  try {
    await gateway.start();
    connector.failSends = true;

    await assert.doesNotReject(connector.emitInbound(createInbound()));
  } finally {
    await gateway.stop();
  }
});
