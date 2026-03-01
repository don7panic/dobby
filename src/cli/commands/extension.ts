import { join } from "node:path";
import { loadGatewayConfig } from "../../core/routing.js";
import type { GatewayConfig } from "../../core/types.js";
import { ExtensionStoreManager } from "../../extension/manager.js";
import {
  applyContributionTemplates,
  buildContributionTemplates,
  ensureGatewayConfigShape,
  listContributionIds,
  setDefaultProviderIfMissingOrInvalid,
  upsertAllowListPackage,
} from "../shared/config-mutators.js";
import { readRawConfig, requireRawConfig, resolveConfigPath, resolveDataRootDir, writeConfigWithValidation } from "../shared/config-io.js";
import type { RawGatewayConfig } from "../shared/config-types.js";
import { createLogger } from "../shared/runtime.js";

/**
 * Resolves extension store directory from normalized gateway config.
 */
function extensionStoreDir(config: GatewayConfig): string {
  return join(config.data.rootDir, "extensions");
}

/**
 * Resolves extension store directory directly from raw config plus config file location.
 */
function extensionStoreDirFromRaw(configPath: string, rawConfig: RawGatewayConfig): string {
  const rootDir = resolveDataRootDir(configPath, rawConfig);
  return join(rootDir, "extensions");
}

/**
 * Installs an extension package, optionally enabling it in config and creating instance templates.
 */
export async function runExtensionInstallCommand(options: {
  spec: string;
  enable?: boolean;
  json?: boolean;
}): Promise<void> {
  const configPath = resolveConfigPath();
  const logger = createLogger();

  const rawConfig = (await readRawConfig(configPath)) ?? {};
  const manager = new ExtensionStoreManager(logger, extensionStoreDirFromRaw(configPath, rawConfig));
  const installed = await manager.install(options.spec);

  if (!options.enable) {
    const templates = buildContributionTemplates(installed.manifest.contributions);
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            package: installed.packageName,
            version: installed.version,
            contributions: installed.manifest.contributions,
            templates,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(`Installed ${installed.packageName}@${installed.version}`);
    console.log("Contributions:");
    for (const contribution of installed.manifest.contributions) {
      console.log(`- ${contribution.kind}:${contribution.id} (${contribution.entry})`);
    }

    console.log("");
    console.log("allowList template:");
    console.log(JSON.stringify({ package: installed.packageName, enabled: true }, null, 2));

    console.log("");
    console.log("instances template:");
    console.log(JSON.stringify(templates, null, 2));
    return;
  }

  const next = ensureGatewayConfigShape(structuredClone(rawConfig));
  upsertAllowListPackage(next, installed.packageName, true);

  const templates = buildContributionTemplates(installed.manifest.contributions);
  const addedInstanceIds = applyContributionTemplates(next, templates);
  setDefaultProviderIfMissingOrInvalid(next);

  await writeConfigWithValidation(configPath, next, {
    validate: true,
    createBackup: true,
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          package: installed.packageName,
          version: installed.version,
          enabled: true,
          addedInstanceIds,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Installed and enabled ${installed.packageName}@${installed.version}`);
  console.log(`Updated ${configPath}`);
  if (addedInstanceIds.providers.length > 0 || addedInstanceIds.connectors.length > 0 || addedInstanceIds.sandboxes.length > 0) {
    console.log("Added instances:");
    for (const providerId of addedInstanceIds.providers) {
      console.log(`- provider: ${providerId}`);
    }
    for (const connectorId of addedInstanceIds.connectors) {
      console.log(`- connector: ${connectorId}`);
    }
    for (const sandboxId of addedInstanceIds.sandboxes) {
      console.log(`- sandbox: ${sandboxId}`);
    }
  }
}

/**
 * Uninstalls an extension package from store without mutating config references.
 */
export async function runExtensionUninstallCommand(options: {
  packageName: string;
}): Promise<void> {
  const configPath = resolveConfigPath();
  const logger = createLogger();
  const rawConfig = await requireRawConfig(configPath);
  const manager = new ExtensionStoreManager(logger, extensionStoreDirFromRaw(configPath, rawConfig));

  await manager.uninstall(options.packageName);
  console.log(`Uninstalled ${options.packageName}`);
  console.log("Remember to remove this package from extensions.allowList and related instance references.");
}

/**
 * Lists installed extension packages with enablement and contribution reference status.
 */
export async function runExtensionListCommand(options: {
  json?: boolean;
}): Promise<void> {
  const configPath = resolveConfigPath();
  const logger = createLogger();

  const rawConfig = await requireRawConfig(configPath);
  const manager = new ExtensionStoreManager(logger, extensionStoreDirFromRaw(configPath, rawConfig));
  const listed = await manager.listInstalled();

  const normalized = ensureGatewayConfigShape(rawConfig);
  const allowList = new Map((normalized.extensions?.allowList ?? []).map((item) => [item.package, item.enabled]));

  const configuredContributionIds = listContributionIds(normalized);
  const configuredContributionSet = new Set([
    ...configuredContributionIds.providers,
    ...configuredContributionIds.connectors,
    ...configuredContributionIds.sandboxes,
  ]);

  const items = listed.map((item) => {
    const contributions = item.manifest?.contributions ?? [];
    const referencedContributions = contributions
      .filter((contribution) => configuredContributionSet.has(contribution.id))
      .map((contribution) => `${contribution.kind}:${contribution.id}`);

    return {
      package: item.packageName,
      version: item.version,
      enabled: allowList.get(item.packageName) ?? false,
      contributions: contributions.map((contribution) => `${contribution.kind}:${contribution.id}`),
      referencedContributions,
      ...(item.error ? { error: item.error } : {}),
    };
  });

  if (options.json) {
    console.log(JSON.stringify({ configPath, items }, null, 2));
    return;
  }

  if (items.length === 0) {
    const config = await loadGatewayConfig(configPath);
    console.log(`No extensions installed in ${extensionStoreDir(config)}`);
    return;
  }

  console.log(`Extensions in ${extensionStoreDirFromRaw(configPath, normalized)}:`);
  for (const item of items) {
    const suffix = item.enabled ? "enabled" : "disabled";
    if (item.error) {
      console.log(`- ${item.package}@${item.version} (${suffix}, invalid: ${item.error})`);
      continue;
    }

    console.log(`- ${item.package}@${item.version} (${suffix})`);
    for (const contribution of item.contributions) {
      const isReferenced = item.referencedContributions.includes(contribution);
      console.log(`  * ${contribution}${isReferenced ? " [referenced]" : ""}`);
    }
  }
}
