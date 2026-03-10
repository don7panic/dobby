import {
  cancel,
  intro,
  isCancel,
  multiselect,
  outro,
  select,
  spinner,
} from "@clack/prompts";
import { ExtensionStoreManager } from "../../extension/manager.js";
import {
  ensureGatewayConfigShape,
  upsertAllowListPackage,
  upsertBinding,
  upsertConnectorInstance,
  upsertProviderInstance,
  upsertRoute,
} from "../shared/config-mutators.js";
import { applyAndValidateContributionSchemas } from "../shared/config-schema.js";
import {
  readRawConfig,
  resolveConfigPath,
  resolveDataRootDir,
  writeConfigWithValidation,
} from "../shared/config-io.js";
import {
  createInitSelectionConfig,
  isInitConnectorChoiceId,
  isInitProviderChoiceId,
  listInitConnectorChoices,
  listInitProviderChoices,
  type InitConnectorChoiceId,
  type InitProviderChoiceId,
} from "../shared/init-catalog.js";
import { ensureProviderPiModelsFile } from "../shared/init-models-file.js";
import { createLogger } from "../shared/runtime.js";

interface InitInput {
  providerChoiceIds: InitProviderChoiceId[];
  routeProviderChoiceId: InitProviderChoiceId;
  connectorChoiceIds: InitConnectorChoiceId[];
}

/**
 * Collects high-level starter choices only; config values are written as templates.
 */
async function collectInitInput(): Promise<InitInput> {
  intro("dobby init");

  const providerChoices = listInitProviderChoices();
  const providerChoiceResult = await multiselect({
    message: "Choose provider(s) (space to select multiple)",
    options: providerChoices.map((item) => ({
      value: item.id,
      label: item.label,
    })),
    initialValues: ["provider.pi"],
    required: true,
  });
  if (isCancel(providerChoiceResult)) {
    cancel("Initialization cancelled.");
    throw new Error("Initialization cancelled.");
  }

  const providerChoiceIds = (providerChoiceResult as unknown[]).map((value) => String(value));
  if (providerChoiceIds.length === 0) {
    throw new Error("At least one provider must be selected");
  }
  if (!providerChoiceIds.every((providerChoiceId) => isInitProviderChoiceId(providerChoiceId))) {
    const invalidChoice = providerChoiceIds.find((providerChoiceId) => !isInitProviderChoiceId(providerChoiceId));
    throw new Error(`Unsupported provider choice '${invalidChoice}'`);
  }

  const providerChoicesById = new Map(providerChoices.map((choice) => [choice.id, choice]));
  let routeProviderChoiceId = providerChoiceIds[0] as InitProviderChoiceId;
  if (providerChoiceIds.length > 1) {
    const routeProviderChoiceResult = await select({
      message: "Choose default provider",
      options: providerChoiceIds.map((providerChoiceId) => ({
        value: providerChoiceId,
        label: providerChoicesById.get(providerChoiceId as InitProviderChoiceId)?.label ?? providerChoiceId,
      })),
      initialValue: providerChoiceIds[0],
    });
    if (isCancel(routeProviderChoiceResult)) {
      cancel("Initialization cancelled.");
      throw new Error("Initialization cancelled.");
    }

    const routeProviderCandidate = String(routeProviderChoiceResult);
    if (!isInitProviderChoiceId(routeProviderCandidate) || !providerChoiceIds.includes(routeProviderCandidate)) {
      throw new Error(`Unsupported route provider choice '${routeProviderCandidate}'`);
    }
    routeProviderChoiceId = routeProviderCandidate;
  }

  const connectorChoices = listInitConnectorChoices();
  const connectorChoiceResult = await multiselect({
    message: "Choose connector(s) (space to select multiple)",
    options: connectorChoices.map((item) => ({
      value: item.id,
      label: item.label,
    })),
    initialValues: ["connector.discord"],
    required: true,
  });
  if (isCancel(connectorChoiceResult)) {
    cancel("Initialization cancelled.");
    throw new Error("Initialization cancelled.");
  }

  const connectorChoiceIds = (connectorChoiceResult as unknown[]).map((value) => String(value));
  if (connectorChoiceIds.length === 0) {
    throw new Error("At least one connector must be selected");
  }
  if (!connectorChoiceIds.every((connectorChoiceId) => isInitConnectorChoiceId(connectorChoiceId))) {
    const invalidChoice = connectorChoiceIds.find((connectorChoiceId) => !isInitConnectorChoiceId(connectorChoiceId));
    throw new Error(`Unsupported connector choice '${invalidChoice}'`);
  }

  return {
    providerChoiceIds: providerChoiceIds as InitProviderChoiceId[],
    routeProviderChoiceId,
    connectorChoiceIds: connectorChoiceIds as InitConnectorChoiceId[],
  };
}

/**
 * Executes first-time initialization by installing starter extensions and writing template config.
 */
export async function runInitCommand(): Promise<void> {
  const configPath = resolveConfigPath();
  const existingConfig = await readRawConfig(configPath);
  if (existingConfig) {
    throw new Error(
      `Config '${configPath}' already exists. Edit the file directly to update existing values.`,
    );
  }

  const input = await collectInitInput();
  const selected = createInitSelectionConfig(input.providerChoiceIds, input.connectorChoiceIds, {
    routeProviderChoiceId: input.routeProviderChoiceId,
  });

  const next = ensureGatewayConfigShape({});
  const rootDir = resolveDataRootDir(configPath, next);
  const manager = new ExtensionStoreManager(createLogger(), `${rootDir}/extensions`);

  const installSpinner = spinner();
  installSpinner.start(`Installing required extensions (${selected.extensionPackages.length} packages)`);
  try {
    const installedPackages = await manager.installMany(selected.extensionPackages);
    for (const installed of installedPackages) {
      upsertAllowListPackage(next, installed.packageName, true);
    }
    installSpinner.stop("Extensions installed");
  } catch (error) {
    installSpinner.stop("Extension installation failed");
    throw error;
  }

  for (const provider of selected.providerInstances) {
    upsertProviderInstance(next, provider.instanceId, provider.contributionId, provider.config);
  }

  for (const connector of selected.connectorInstances) {
    upsertConnectorInstance(next, connector.instanceId, connector.contributionId, connector.config);
  }

  next.providers = {
    ...next.providers,
    default: selected.providerInstanceId,
    items: next.providers.items,
  };
  next.routes = {
    ...next.routes,
    defaults: {
      ...next.routes.defaults,
      provider: selected.providerInstanceId,
      sandbox: "host.builtin",
      tools: "full",
      mentions: "required",
    },
  };

  upsertRoute(next, selected.routeId, selected.routeProfile);
  for (const binding of selected.bindings) {
    upsertBinding(next, binding.id, binding.config);
  }

  const validatedConfig = await applyAndValidateContributionSchemas(configPath, next);

  const createdModelsFiles: string[] = [];
  for (const provider of selected.providerInstances) {
    if (provider.contributionId !== "provider.pi") {
      continue;
    }

    const resolvedProvider = validatedConfig.providers?.items?.[provider.instanceId];
    const { type: _type, ...providerConfig } = resolvedProvider ?? {};
    const ensured = await ensureProviderPiModelsFile(
      configPath,
      Object.keys(providerConfig).length > 0 ? providerConfig : provider.config,
    );
    if (ensured.created) {
      createdModelsFiles.push(ensured.path);
    }
  }

  await writeConfigWithValidation(configPath, validatedConfig, {
    validate: true,
    createBackup: false,
  });

  outro("Initialization completed.");

  console.log(`Config written: ${configPath}`);
  if (createdModelsFiles.length > 0) {
    console.log("Generated model files:");
    for (const path of createdModelsFiles) {
      console.log(`- ${path}`);
    }
  }
  console.log("Next steps:");
  console.log("1. Edit gateway.json and replace all REPLACE_WITH_* / YOUR_* placeholders");
  console.log("2. Run 'dobby doctor' to validate the edited config");
  console.log("3. Run 'dobby start' when the placeholders are replaced");
}
