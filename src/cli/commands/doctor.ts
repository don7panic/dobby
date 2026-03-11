import { access, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { loadGatewayConfig } from "../../core/routing.js";
import { ExtensionStoreManager } from "../../extension/manager.js";
import {
  ensureGatewayConfigShape,
  setDefaultProviderIfMissingOrInvalid,
} from "../shared/config-mutators.js";
import { DISCORD_CONNECTOR_CONTRIBUTION_ID } from "../shared/discord-config.js";
import { readRawConfig, resolveConfigPath, resolveDataRootDir, writeConfigWithValidation } from "../shared/config-io.js";
import { createLogger } from "../shared/runtime.js";

interface DoctorIssue {
  level: "error" | "warning";
  message: string;
}

interface PlaceholderHit {
  path: string;
  value: string;
}

function isPlaceholderValue(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toUpperCase();
  return normalized.includes("REPLACE_WITH_") || normalized.includes("YOUR_");
}

function isCredentialLikeKey(key: string): boolean {
  return /(?:token|secret|api[-_]?key|appid|appsecret)/i.test(key);
}

function walkPlaceholders(value: unknown, path: string): PlaceholderHit[] {
  if (isPlaceholderValue(value)) {
    return [{ path, value }];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => walkPlaceholders(item, `${path}[${index}]`));
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  return Object.entries(value).flatMap(([key, nested]) => walkPlaceholders(nested, `${path}.${key}`));
}

function lastPathSegment(path: string): string {
  const withoutIndexes = path.replaceAll(/\[\d+\]/g, "");
  const segments = withoutIndexes.split(".");
  return segments[segments.length - 1] ?? withoutIndexes;
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return resolve(homedir(), value.slice(2));
  }

  return value;
}

function resolveRouteProjectRoot(configPath: string, projectRoot: string): string {
  const expanded = expandHome(projectRoot);
  if (isAbsolute(expanded)) {
    return resolve(expanded);
  }

  return resolve(dirname(resolve(configPath)), expanded);
}

export async function runDoctorCommand(options: {
  fix?: boolean;
}): Promise<void> {
  const configPath = resolveConfigPath();
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
  const enabledPackages = new Set(
    normalized.extensions.allowList.filter((item) => item.enabled).map((item) => item.package),
  );

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

  for (const [instanceId, instance] of Object.entries(normalized.providers.items)) {
    if (!availableContributionIds.has(instance.type)) {
      issues.push({
        level: "error",
        message: `providers.items['${instanceId}'] references missing contribution '${instance.type}'`,
      });
    }

    for (const hit of walkPlaceholders(instance, `providers.items['${instanceId}']`)) {
      if (hit.path.endsWith(".type")) {
        continue;
      }

      issues.push({
        level: isCredentialLikeKey(lastPathSegment(hit.path)) ? "error" : "warning",
        message: `${hit.path} still uses placeholder value '${hit.value}'`,
      });
    }
  }

  for (const [instanceId, instance] of Object.entries(normalized.connectors.items)) {
    if (!availableContributionIds.has(instance.type)) {
      issues.push({
        level: "error",
        message: `connectors.items['${instanceId}'] references missing contribution '${instance.type}'`,
      });
    }

    for (const hit of walkPlaceholders(instance, `connectors.items['${instanceId}']`)) {
      if (hit.path.endsWith(".type")) {
        continue;
      }

      issues.push({
        level: isCredentialLikeKey(lastPathSegment(hit.path)) ? "error" : "warning",
        message: `${hit.path} still uses placeholder value '${hit.value}'`,
      });
    }

    if (instance.type === DISCORD_CONNECTOR_CONTRIBUTION_ID) {
      const botName = typeof instance.botName === "string" ? instance.botName.trim() : "";
      const botToken = typeof instance.botToken === "string" ? instance.botToken.trim() : "";
      if (botName.length === 0) {
        issues.push({
          level: "error",
          message: `connectors.items['${instanceId}'].botName is required`,
        });
      }
      if (botToken.length === 0) {
        issues.push({
          level: "error",
          message: `connectors.items['${instanceId}'].botToken is required`,
        });
      }
    }
  }

  for (const [instanceId, instance] of Object.entries(normalized.sandboxes.items)) {
    if (!availableContributionIds.has(instance.type)) {
      issues.push({
        level: "error",
        message: `sandboxes.items['${instanceId}'] references missing contribution '${instance.type}'`,
      });
    }
  }

  if (normalized.routes.default.projectRoot && isPlaceholderValue(normalized.routes.default.projectRoot)) {
    issues.push({
      level: "warning",
      message: `routes.default.projectRoot still uses placeholder value '${normalized.routes.default.projectRoot}'`,
    });
  }

  for (const [routeId, route] of Object.entries(normalized.routes.items)) {
    const effectiveProjectRoot = route.projectRoot ?? normalized.routes.default.projectRoot;
    const projectRootSource = route.projectRoot ? `routes.items['${routeId}'].projectRoot` : "routes.default.projectRoot";

    if (!effectiveProjectRoot) {
      issues.push({
        level: "error",
        message: `routes.items['${routeId}'].projectRoot is required when routes.default.projectRoot is not set`,
      });
      continue;
    }

    if (isPlaceholderValue(effectiveProjectRoot)) {
      issues.push({
        level: "warning",
        message: `${projectRootSource} still uses placeholder value '${effectiveProjectRoot}'`,
      });
      continue;
    }

    try {
      const projectRootPath = resolveRouteProjectRoot(configPath, effectiveProjectRoot);
      await access(projectRootPath);
    } catch {
      issues.push({
        level: "warning",
        message: `${projectRootSource} does not exist: ${effectiveProjectRoot}`,
      });
    }
  }

  if (normalized.bindings.default && !normalized.routes.items[normalized.bindings.default.route]) {
    issues.push({
      level: "error",
      message: `bindings.default.route references unknown route '${normalized.bindings.default.route}'`,
    });
  }

  const seenBindingSources = new Map<string, string>();
  for (const [bindingId, binding] of Object.entries(normalized.bindings.items)) {
    if (!normalized.connectors.items[binding.connector]) {
      issues.push({
        level: "error",
        message: `bindings.items['${bindingId}'].connector references unknown connector '${binding.connector}'`,
      });
    }
    if (!normalized.routes.items[binding.route]) {
      issues.push({
        level: "error",
        message: `bindings.items['${bindingId}'].route references unknown route '${binding.route}'`,
      });
    }

    if (isPlaceholderValue(binding.source.id)) {
      issues.push({
        level: "warning",
        message: `bindings.items['${bindingId}'].source.id still uses placeholder value '${binding.source.id}'`,
      });
    }

    const bindingKey = `${binding.connector}:${binding.source.type}:${binding.source.id}`;
    const existingBindingId = seenBindingSources.get(bindingKey);
    if (existingBindingId) {
      issues.push({
        level: "error",
        message:
          `bindings.items['${bindingId}'] duplicates source '${bindingKey}' already used by bindings.items['${existingBindingId}']`,
      });
    } else {
      seenBindingSources.set(bindingKey, bindingId);
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
    for (const item of fixTarget.extensions.allowList) {
      if (item.enabled && !installedSet.has(item.package)) {
        item.enabled = false;
      }
    }

    setDefaultProviderIfMissingOrInvalid(fixTarget);

    await writeConfigWithValidation(configPath, fixTarget, {
      validate: true,
      createBackup: true,
    });

    console.log("Applied doctor --fix actions:");
    console.log("- ensured data directories exist");
    console.log("- disabled allowList entries for packages not installed");
    console.log("- repaired default provider when missing or invalid");
  }

  const errorCount = issues.filter((issue) => issue.level === "error").length;
  const warningCount = issues.filter((issue) => issue.level === "warning").length;

  if (issues.length === 0) {
    console.log(`Doctor found no issues (${configPath})`);
    return;
  }

  console.log(`Doctor results (${configPath}):`);
  for (const issue of issues) {
    console.log(`- [${issue.level}] ${issue.message}`);
  }
  console.log(`Summary: ${errorCount} error(s), ${warningCount} warning(s)`);

  if (errorCount > 0) {
    throw new Error(`Doctor found ${errorCount} error(s)`);
  }
}
