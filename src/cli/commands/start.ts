import { dirname, join } from "node:path";
import { loadCronConfig } from "../../cron/config.js";
import { CronService } from "../../cron/service.js";
import { CronStore } from "../../cron/store.js";
import { DedupStore } from "../../core/dedup-store.js";
import { Gateway } from "../../core/gateway.js";
import { BindingResolver, loadGatewayConfig, RouteResolver } from "../../core/routing.js";
import { RuntimeRegistry } from "../../core/runtime-registry.js";
import { BUILTIN_HOST_SANDBOX_ID } from "../../core/types.js";
import type {
  GatewayLogger,
  ProviderInstance,
  ProvidersConfig,
  SandboxInstance,
  SandboxesConfig,
} from "../../core/types.js";
import { ExtensionLoader } from "../../extension/loader.js";
import { ExtensionRegistry } from "../../extension/registry.js";
import type { Executor } from "../../sandbox/executor.js";
import { HostExecutor } from "../../sandbox/host-executor.js";
import { resolveConfigPath } from "../shared/config-io.js";
import { createLogger, ensureDataDirs, extensionStoreDir } from "../shared/runtime.js";

/**
 * Closes provider instances best-effort so shutdown does not stop on one failed provider.
 */
async function closeProviderInstances(providers: Map<string, ProviderInstance>, logger: GatewayLogger): Promise<void> {
  for (const [providerId, provider] of providers.entries()) {
    if (!provider.close) {
      continue;
    }

    try {
      await provider.close();
    } catch (error) {
      logger.warn({ err: error, providerId }, "Failed to close provider instance");
    }
  }
}

/**
 * Closes sandbox executors and optional sandbox lifecycle hooks during shutdown.
 */
async function closeSandboxInstances(sandboxes: Map<string, SandboxInstance>, logger: GatewayLogger): Promise<void> {
  for (const [sandboxId, sandbox] of sandboxes.entries()) {
    try {
      await sandbox.executor.close();
    } catch (error) {
      logger.warn({ err: error, sandboxId }, "Failed to close sandbox executor");
    }

    if (!sandbox.close) {
      continue;
    }

    try {
      await sandbox.close();
    } catch (error) {
      logger.warn({ err: error, sandboxId }, "Failed to close sandbox instance");
    }
  }
}

/**
 * Narrows provider instances to only those referenced by default provider or any route override.
 */
function selectProviderInstances(config: Awaited<ReturnType<typeof loadGatewayConfig>>): ProvidersConfig {
  const requiredProviderIds = new Set<string>([config.providers.default]);
  for (const route of Object.values(config.routes.items)) {
    requiredProviderIds.add(route.provider);
  }

  const instances = Object.fromEntries(
    Object.entries(config.providers.items).filter(([instanceId]) => requiredProviderIds.has(instanceId)),
  );

  return {
    default: config.providers.default,
    items: instances,
  };
}

/**
 * Narrows sandbox instances to only those referenced by default/route sandbox settings.
 */
function selectSandboxInstances(config: Awaited<ReturnType<typeof loadGatewayConfig>>): SandboxesConfig {
  const defaultSandboxId = config.sandboxes.default ?? BUILTIN_HOST_SANDBOX_ID;
  const requiredSandboxIds = new Set<string>();

  if (defaultSandboxId !== BUILTIN_HOST_SANDBOX_ID) {
    requiredSandboxIds.add(defaultSandboxId);
  }

  for (const route of Object.values(config.routes.items)) {
    if (route.sandbox !== BUILTIN_HOST_SANDBOX_ID) {
      requiredSandboxIds.add(route.sandbox);
    }
  }

  const instances = Object.fromEntries(
    Object.entries(config.sandboxes.items).filter(([instanceId]) => requiredSandboxIds.has(instanceId)),
  );

  return {
    ...(config.sandboxes.default ? { default: config.sandboxes.default } : {}),
    items: instances,
  };
}

/**
 * Starts the gateway runtime from config and wires graceful shutdown handlers.
 */
export async function runStartCommand(): Promise<void> {
  const configPath = resolveConfigPath();
  const config = await loadGatewayConfig(configPath);

  await ensureDataDirs(config.data.rootDir);

  const logger = createLogger();
  const loader = new ExtensionLoader(logger, {
    extensionsDir: extensionStoreDir(config),
  });

  const loadedPackages = await loader.loadAllowList(config.extensions.allowList);
  const registry = new ExtensionRegistry();
  registry.registerPackages(loadedPackages);

  logger.info(
    {
      extensionStoreDir: extensionStoreDir(config),
      packages: loadedPackages.map((item) => ({
        package: item.packageName,
        manifestName: item.manifest.name,
        version: item.manifest.version,
        contributions: item.manifest.contributions.map((contribution) => `${contribution.kind}:${contribution.id}`),
      })),
    },
    "Extension packages loaded",
  );

  const extensionHostContext = {
    logger,
    configBaseDir: dirname(configPath),
  };

  const activeProvidersConfig = selectProviderInstances(config);
  const activeSandboxesConfig = selectSandboxInstances(config);

  const providers = await registry.createProviderInstances(activeProvidersConfig, extensionHostContext, config.data);
  const connectors = await registry.createConnectorInstances(config.connectors, extensionHostContext, config.data.attachmentsDir);
  const sandboxes = await registry.createSandboxInstances(activeSandboxesConfig, extensionHostContext);

  const hostExecutor = new HostExecutor(logger);
  const executors = new Map<string, Executor>();
  executors.set(BUILTIN_HOST_SANDBOX_ID, hostExecutor);

  for (const [sandboxId, sandbox] of sandboxes.entries()) {
    executors.set(sandboxId, sandbox.executor);
  }

  if (connectors.length === 0) {
    throw new Error("No connectors are configured. Add connector instances in your dobby config.");
  }

  const dedupStore = new DedupStore(join(config.data.stateDir, "dedup.json"), config.data.dedupTtlMs, logger);
  const routeResolver = new RouteResolver(config.routes);
  const bindingResolver = new BindingResolver(config.bindings);
  const runtimeRegistry = new RuntimeRegistry(logger);

  const gateway = new Gateway({
    config,
    connectors,
    providers,
    executors,
    routeResolver,
    bindingResolver,
    dedupStore,
    runtimeRegistry,
    logger,
  });

  const loadedCronConfig = await loadCronConfig({
    gatewayConfigPath: configPath,
    gatewayConfig: config,
  });
  const cronStore = new CronStore(loadedCronConfig.config.storeFile, loadedCronConfig.config.runLogFile, logger);
  const cronService = new CronService({
    config: loadedCronConfig.config,
    store: cronStore,
    gateway,
    logger,
  });

  await gateway.start();
  await cronService.start();
  logger.info(
    {
      configPath,
      cronConfigPath: loadedCronConfig.configPath,
      cronConfigSource: loadedCronConfig.source,
      cronEnabled: loadedCronConfig.config.enabled,
    },
    "Gateway started",
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down gateway");
    await cronService.stop();
    await gateway.stop();
    await hostExecutor.close();
    await closeProviderInstances(providers, logger);
    await closeSandboxInstances(sandboxes, logger);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}
