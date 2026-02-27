import { access, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { loadGatewayConfig } from "../../core/routing.js";
import { ExtensionStoreManager } from "../../extension/manager.js";
import {
  clearInvalidDefaultRoute,
  ensureGatewayConfigShape,
  setDefaultProviderIfMissingOrInvalid,
} from "../shared/config-mutators.js";
import {
  DISCORD_CONNECTOR_CONTRIBUTION_ID,
  normalizeDiscordBotChannelMap,
} from "../shared/discord-config.js";
import { readRawConfig, resolveConfigPath, resolveDataRootDir, writeConfigWithValidation } from "../shared/config-io.js";
import { createLogger } from "../shared/runtime.js";

interface DoctorIssue {
  level: "error" | "warning";
  message: string;
}

/**
 * Expands "~" prefixed paths for route projectRoot checks.
 */
function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return resolve(homedir(), value.slice(2));
  }

  return value;
}

/**
 * Resolves route projectRoot against config location when given as relative path.
 */
function resolveRouteProjectRoot(configPath: string, projectRoot: string): string {
  const expanded = expandHome(projectRoot);
  if (isAbsolute(expanded)) {
    return resolve(expanded);
  }

  return resolve(dirname(resolve(configPath)), expanded);
}

/**
 * Runs preflight diagnostics and optional conservative fixes for config/runtime consistency.
 */
export async function runDoctorCommand(options: {
  config?: string;
  fix?: boolean;
}): Promise<void> {
  const configPath = resolveConfigPath(options.config);
  const issues: DoctorIssue[] = [];

  const rawConfig = await readRawConfig(configPath);
  if (!rawConfig) {
    throw new Error(`Config '${configPath}' does not exist`);
  }

  try {
    await loadGatewayConfig(configPath);
  } catch (error) {
    issues.push({
      level: "error",
      message: `Config schema/reference validation failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const normalized = ensureGatewayConfigShape(structuredClone(rawConfig));
  const logger = createLogger();
  const manager = new ExtensionStoreManager(logger, join(resolveDataRootDir(configPath, normalized), "extensions"));
  const installedExtensions = await manager.listInstalled();

  const installedPackages = new Set(installedExtensions.map((item) => item.packageName));
  const enabledPackages = new Set((normalized.extensions?.allowList ?? []).filter((item) => item.enabled).map((item) => item.package));

  for (const packageName of enabledPackages) {
    if (!installedPackages.has(packageName)) {
      issues.push({
        level: "error",
        message: `extensions.allowList enables '${packageName}' but it is not installed`,
      });
    }
  }

  const availableContributionIds = new Set<string>();
  for (const item of installedExtensions) {
    if (item.error) {
      issues.push({
        level: "warning",
        message: `Installed extension '${item.packageName}' has invalid manifest: ${item.error}`,
      });
      continue;
    }

    if (!enabledPackages.has(item.packageName)) {
      continue;
    }

    for (const contribution of item.manifest?.contributions ?? []) {
      availableContributionIds.add(contribution.id);
    }
  }

  const providers = normalized.providers?.instances ?? {};
  const connectors = normalized.connectors?.instances ?? {};
  const sandboxes = normalized.sandboxes?.instances ?? {};

  for (const [instanceId, instance] of Object.entries(providers)) {
    if (!availableContributionIds.has(instance.contributionId)) {
      issues.push({
        level: "error",
        message: `providers.instances['${instanceId}'] references missing contribution '${instance.contributionId}'`,
      });
    }
  }

  for (const [instanceId, instance] of Object.entries(connectors)) {
    if (!availableContributionIds.has(instance.contributionId)) {
      issues.push({
        level: "error",
        message: `connectors.instances['${instanceId}'] references missing contribution '${instance.contributionId}'`,
      });
    }
  }

  for (const [instanceId, instance] of Object.entries(sandboxes)) {
    if (!availableContributionIds.has(instance.contributionId)) {
      issues.push({
        level: "error",
        message: `sandboxes.instances['${instanceId}'] references missing contribution '${instance.contributionId}'`,
      });
    }
  }

  const routes = normalized.routing?.routes ?? {};

  if (normalized.routing?.defaultRouteId && !routes[normalized.routing.defaultRouteId]) {
    issues.push({
      level: "error",
      message: `routing.defaultRouteId '${normalized.routing.defaultRouteId}' does not exist`,
    });
  }

  for (const [routeId, route] of Object.entries(routes)) {
    try {
      const projectRootPath = resolveRouteProjectRoot(configPath, route.projectRoot);
      await access(projectRootPath);
    } catch {
      issues.push({
        level: "warning",
        message: `routing.routes['${routeId}'].projectRoot does not exist: ${route.projectRoot}`,
      });
    }
  }

  for (const [instanceId, connector] of Object.entries(connectors)) {
    if (connector.contributionId !== DISCORD_CONNECTOR_CONTRIBUTION_ID) {
      continue;
    }

    const botName = typeof connector.config?.botName === "string" ? connector.config.botName.trim() : "";
    if (botName.length === 0) {
      issues.push({
        level: "error",
        message: `connectors.instances['${instanceId}'].config.botName is required`,
      });
    }

    const botToken = typeof connector.config?.botToken === "string" ? connector.config.botToken.trim() : "";
    if (botToken.length === 0) {
      issues.push({
        level: "error",
        message: `connectors.instances['${instanceId}'].config.botToken is required`,
      });
    }

    const botChannelMap = normalizeDiscordBotChannelMap(connector.config?.botChannelMap);
    if (Object.keys(botChannelMap).length === 0) {
      issues.push({
        level: "warning",
        message: `connectors.instances['${instanceId}'].config.botChannelMap is empty`,
      });
    }

    for (const [channelId, routeId] of Object.entries(botChannelMap)) {
      if (!routes[routeId]) {
        issues.push({
          level: "error",
          message:
            `connectors.instances['${instanceId}'].config.botChannelMap['${channelId}'] ` +
            `references unknown route '${routeId}'`,
        });
      }
    }
  }

  if (options.fix) {
    const fixTarget = ensureGatewayConfigShape(structuredClone(rawConfig));
    const rootDir = resolveDataRootDir(configPath, fixTarget);

    await mkdir(rootDir, { recursive: true });
    await mkdir(join(rootDir, "sessions"), { recursive: true });
    await mkdir(join(rootDir, "attachments"), { recursive: true });
    await mkdir(join(rootDir, "logs"), { recursive: true });
    await mkdir(join(rootDir, "state"), { recursive: true });
    await mkdir(join(rootDir, "extensions"), { recursive: true });

    const installedSet = new Set(installedExtensions.map((item) => item.packageName));
    const allowList = fixTarget.extensions?.allowList ?? [];
    for (const item of allowList) {
      if (item.enabled && !installedSet.has(item.package)) {
        item.enabled = false;
      }
    }

    const droppedDefaultRoute = clearInvalidDefaultRoute(fixTarget);
    setDefaultProviderIfMissingOrInvalid(fixTarget);

    await writeConfigWithValidation(configPath, fixTarget, {
      validate: true,
      createBackup: true,
    });

    console.log("Applied doctor --fix actions:");
    console.log("- ensured data directories exist");
    if (droppedDefaultRoute) {
      console.log("- cleared invalid routing.defaultRouteId");
    }

    if (!droppedDefaultRoute) {
      console.log("- no default route cleanup needed");
    }
  }

  const errorCount = issues.filter((issue) => issue.level === "error").length;
  const warningCount = issues.filter((issue) => issue.level === "warning").length;

  if (issues.length === 0) {
    console.log(`Doctor OK: no issues found (${configPath})`);
    return;
  }

  console.log(`Doctor report for ${configPath}:`);
  for (const issue of issues) {
    const prefix = issue.level === "error" ? "ERROR" : "WARN";
    console.log(`[${prefix}] ${issue.message}`);
  }

  console.log(`Summary: ${errorCount} error(s), ${warningCount} warning(s)`);

  if (errorCount > 0) {
    throw new Error("Doctor found blocking errors");
  }
}
