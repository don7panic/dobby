import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  password,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { ExtensionStoreManager } from "../../extension/manager.js";
import {
  ensureGatewayConfigShape,
  setDefaultRoute,
  upsertAllowListPackage,
  upsertConnectorInstance,
  upsertProviderInstance,
  upsertRoute,
} from "../shared/config-mutators.js";
import { DEFAULT_DISCORD_BOT_NAME } from "../shared/discord-config.js";
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
  connectorChoiceId: InitConnectorChoiceId;
  projectRoot: string;
  channelId: string;
  routeId: string;
  botName: string;
  botToken: string;
  allowAllMessages: boolean;
}

/**
 * Repeatedly prompts for non-empty text input and aborts cleanly on cancel.
 */
async function promptRequiredText(params: {
  message: string;
  placeholder?: string;
  initialValue?: string;
}): Promise<string> {
  while (true) {
    const promptOptions = {
      message: params.message,
      ...(params.placeholder !== undefined ? { placeholder: params.placeholder } : {}),
      ...(params.initialValue !== undefined ? { initialValue: params.initialValue } : {}),
    };
    const result = await text(promptOptions);
    if (isCancel(result)) {
      cancel("Initialization cancelled.");
      throw new Error("Initialization cancelled.");
    }

    const value = String(result ?? "").trim();
    if (value.length > 0) {
      return value;
    }

    await note("This field is required.", "Validation");
  }
}

/**
 * Collects init inputs from interactive prompts.
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
      message: "Choose provider for the default route",
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
  const connectorChoiceResult = await select({
    message: "Choose connector",
    options: connectorChoices.map((item) => ({
      value: item.id,
      label: item.label,
    })),
    initialValue: "connector.discord",
  });
  if (isCancel(connectorChoiceResult)) {
    cancel("Initialization cancelled.");
    throw new Error("Initialization cancelled.");
  }
  const connectorChoiceId = String(connectorChoiceResult);
  if (!isInitConnectorChoiceId(connectorChoiceId)) {
    throw new Error(`Unsupported connector choice '${connectorChoiceId}'`);
  }

  const projectRoot = await promptRequiredText({
    message: "Project root",
    initialValue: process.cwd(),
  });

  const channelId = await promptRequiredText({
    message: "Discord channel ID",
    placeholder: "1234567890",
  });

  const routeIdResult = await text({
    message: "Route ID",
    initialValue: "main",
  });
  if (isCancel(routeIdResult)) {
    cancel("Initialization cancelled.");
    throw new Error("Initialization cancelled.");
  }

  const botNameResult = await text({
    message: "Discord bot name",
    initialValue: DEFAULT_DISCORD_BOT_NAME,
  });
  if (isCancel(botNameResult)) {
    cancel("Initialization cancelled.");
    throw new Error("Initialization cancelled.");
  }

  const botTokenResult = await password({
    message: "Discord bot token",
    mask: "*",
    validate: (value) => (value.trim().length > 0 ? undefined : "Token is required"),
  });
  if (isCancel(botTokenResult)) {
    cancel("Initialization cancelled.");
    throw new Error("Initialization cancelled.");
  }

  const allowAllMessagesResult = await confirm({
    message: "Allow all group messages (not mention-only)?",
    initialValue: false,
  });
  if (isCancel(allowAllMessagesResult)) {
    cancel("Initialization cancelled.");
    throw new Error("Initialization cancelled.");
  }

  return {
    providerChoiceIds: providerChoiceIds as InitProviderChoiceId[],
    routeProviderChoiceId,
    connectorChoiceId,
    projectRoot,
    channelId,
    routeId: String(routeIdResult ?? "").trim() || "main",
    botName: String(botNameResult ?? "").trim() || DEFAULT_DISCORD_BOT_NAME,
    botToken: String(botTokenResult ?? "").trim(),
    allowAllMessages: allowAllMessagesResult === true,
  };
}

/**
 * Executes first-time initialization: install required extensions, write config, then validate.
 */
export async function runInitCommand(): Promise<void> {
  const configPath = resolveConfigPath();
  const existingConfig = await readRawConfig(configPath);
  if (existingConfig) {
    throw new Error(
      `Config '${configPath}' already exists. Use 'dobby config edit' or 'dobby configure' to update existing values.`,
    );
  }

  const input = await collectInitInput();
  const selected = createInitSelectionConfig(input.providerChoiceIds, input.connectorChoiceId, {
    routeId: input.routeId,
    projectRoot: input.projectRoot,
    allowAllMessages: input.allowAllMessages,
    botName: input.botName,
    botToken: input.botToken,
    channelId: input.channelId,
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

  upsertConnectorInstance(next, selected.connectorInstanceId, selected.connectorContributionId, selected.connectorConfig);

  next.providers = {
    ...next.providers,
    defaultProviderId: selected.providerInstanceId,
    instances: next.providers.instances,
  };

  upsertRoute(next, input.routeId, {
    ...selected.routeProfile,
    projectRoot: input.projectRoot,
  });
  setDefaultRoute(next, input.routeId);

  const validatedConfig = await applyAndValidateContributionSchemas(configPath, next);

  const createdModelsFiles: string[] = [];
  for (const provider of selected.providerInstances) {
    if (provider.contributionId !== "provider.pi") {
      continue;
    }

    const resolvedProvider = validatedConfig.providers?.instances?.[provider.instanceId];
    const ensured = await ensureProviderPiModelsFile(configPath, resolvedProvider?.config ?? provider.config);
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
  console.log("1. dobby start");

  const showHint = await confirm({
    message: "Show quick validation commands?",
    initialValue: true,
  });

  if (!isCancel(showHint) && showHint) {
    await note(
      [
        "dobby extension list",
        "dobby doctor",
      ].join("\n"),
      "Validation",
    );
  }
}
