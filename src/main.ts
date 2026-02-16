import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import pino from "pino";
import { SessionFactory } from "./agent/session-factory.js";
import { DiscordConnector } from "./connectors/discord/connector.js";
import { DedupStore } from "./core/dedup-store.js";
import { Gateway } from "./core/gateway.js";
import { loadGatewayConfig, RouteResolver } from "./core/routing.js";
import { RuntimeRegistry } from "./core/runtime-registry.js";
import type { ConnectorPlugin } from "./core/types.js";
import { createExecutor } from "./sandbox/executor.js";

function parseConfigPath(argv: string[]): string {
  const configFlagIndex = argv.findIndex((arg) => arg === "--config");
  const flagValue = configFlagIndex >= 0 ? argv[configFlagIndex + 1] : undefined;

  if (flagValue) {
    return resolve(flagValue);
  }

  return resolve(process.cwd(), "config", "gateway.json");
}

async function ensureDataDirs(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await mkdir(join(rootDir, "sessions"), { recursive: true });
  await mkdir(join(rootDir, "attachments"), { recursive: true });
  await mkdir(join(rootDir, "logs"), { recursive: true });
  await mkdir(join(rootDir, "state"), { recursive: true });
}

async function main(): Promise<void> {
  const configPath = parseConfigPath(process.argv.slice(2));
  const config = await loadGatewayConfig(configPath);

  await ensureDataDirs(config.data.rootDir);

  const logger = pino({
    name: "im-agent-gateway",
    level: process.env.LOG_LEVEL ?? "info",
  });

  const executor = await createExecutor(config.sandbox, logger);
  const dedupStore = new DedupStore(join(config.data.stateDir, "dedup.json"), config.data.dedupTtlMs, logger);
  const routeResolver = new RouteResolver(config.routing);
  const runtimeRegistry = new RuntimeRegistry(logger);
  const sessionFactory = new SessionFactory({ config, executor, logger });

  const connectors: ConnectorPlugin[] = [];
  if (config.discord.enabled) {
    connectors.push(new DiscordConnector(config.discord, join(config.data.attachmentsDir, "discord"), logger));
  }

  if (connectors.length === 0) {
    throw new Error("No connectors are enabled. Set discord.enabled=true in config/gateway.json");
  }

  const gateway = new Gateway({
    config,
    connectors,
    routeResolver,
    dedupStore,
    runtimeRegistry,
    sessionFactory,
    logger,
  });

  await gateway.start();
  logger.info({ configPath }, "Gateway started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down gateway");
    await gateway.stop();
    await executor.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void main().catch((error) => {
  const logger = pino({ name: "im-agent-gateway" });
  logger.error({ err: error }, "Fatal startup error");
  process.exit(1);
});
