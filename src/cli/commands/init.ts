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
  setDefaultProviderIfMissingOrInvalid,
  setDefaultRoute,
  upsertAllowListPackage,
  upsertConnectorInstance,
  upsertProviderInstance,
  upsertRoute,
} from "../shared/config-mutators.js";
import { DEFAULT_DISCORD_BOT_NAME } from "../shared/discord-config.js";
import {
  readRawConfig,
  resolveConfigPath,
  resolveDataRootDir,
  writeConfigWithValidation,
} from "../shared/config-io.js";
import type { RawGatewayConfig } from "../shared/config-types.js";
import {
  createInitSelectionConfig,
  isInitConnectorChoiceId,
  isInitProviderChoiceId,
  listInitConnectorChoices,
  listInitProviderChoices,
  type InitConnectorChoiceId,
  type InitProviderChoiceId,
} from "../shared/init-catalog.js";
import { createLogger } from "../shared/runtime.js";

interface InitInput {
  providerChoiceIds: InitProviderChoiceId[];
  connectorChoiceId: InitConnectorChoiceId;
  projectRoot: string;
  channelId: string;
  routeId: string;
  botName: string;
  botToken: string;
  allowAllMessages: boolean;
}

type MergeStrategy = "preserve" | "overwrite" | "prompt";

/**
 * Type guard for supported init merge strategy values.
 */
function isMergeStrategy(value: string): value is MergeStrategy {
  return value === "preserve" || value === "overwrite" || value === "prompt";
}

/**
 * Returns a trimmed string value when present, otherwise undefined.
 */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Resolves merge strategy and prompts only when explicitly requested.
 */
async function resolveMergeStrategy(options: {
  merge?: boolean;
  mergeStrategy?: string;
  overwrite?: boolean;
}, hasExistingConfig: boolean): Promise<"preserve" | "overwrite"> {
  if (!hasExistingConfig || options.overwrite === true || options.merge !== true) {
    return "overwrite";
  }

  const requested = (asString(options.mergeStrategy) ?? "preserve").toLowerCase();
  if (!isMergeStrategy(requested)) {
    throw new Error(`Unsupported --merge-strategy '${requested}'. Allowed: preserve, overwrite, prompt`);
  }

  if (requested !== "prompt") {
    return requested;
  }

  const picked = await select({
    message: "Existing values conflict with init selection. Choose merge strategy",
    options: [
      { value: "preserve", label: "preserve (keep existing values, only fill missing)" },
      { value: "overwrite", label: "overwrite (replace conflicting values with init selection)" },
    ],
    initialValue: "preserve",
  });
  if (isCancel(picked)) {
    cancel("Initialization cancelled.");
    throw new Error("Initialization cancelled.");
  }

  return String(picked) as "preserve" | "overwrite";
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
export async function runInitCommand(options: {
  merge?: boolean;
  mergeStrategy?: string;
  overwrite?: boolean;
}): Promise<void> {
  if (options.merge && options.overwrite) {
    throw new Error("--merge and --overwrite cannot be used together");
  }

  const configPath = resolveConfigPath();
  const existingConfig = await readRawConfig(configPath);

  if (existingConfig && !options.merge && !options.overwrite) {
    throw new Error(
      `Config '${configPath}' already exists. Use --merge to keep existing values or --overwrite to replace it.`,
    );
  }
  const mergeStrategy = await resolveMergeStrategy(options, Boolean(existingConfig));

  const input = await collectInitInput();
  const selected = createInitSelectionConfig(input.providerChoiceIds, input.connectorChoiceId, {
    routeId: input.routeId,
    projectRoot: input.projectRoot,
    allowAllMessages: input.allowAllMessages,
    botName: input.botName,
    botToken: input.botToken,
    channelId: input.channelId,
  });

  const baseConfig: RawGatewayConfig =
    options.overwrite || !existingConfig ? {} : structuredClone(existingConfig);
  const next = ensureGatewayConfigShape(baseConfig);

  const rootDir = resolveDataRootDir(configPath, next);
  const manager = new ExtensionStoreManager(createLogger(), `${rootDir}/extensions`);

  const installSpinner = spinner();
  installSpinner.start("Installing required extensions");
  try {
    for (const packageName of selected.extensionPackages) {
      const installed = await manager.install(packageName);
      const hasAllowListEntry = next.extensions.allowList.some((item) => item.package === installed.packageName);
      if (mergeStrategy === "overwrite" || !hasAllowListEntry) {
        upsertAllowListPackage(next, installed.packageName, true);
      }
    }
    installSpinner.stop("Extensions installed");
  } catch (error) {
    installSpinner.stop("Extension installation failed");
    throw error;
  }

  for (const provider of selected.providerInstances) {
    const hasProviderInstance = Boolean(next.providers.instances[provider.instanceId]);
    if (mergeStrategy === "overwrite" || !hasProviderInstance) {
      upsertProviderInstance(next, provider.instanceId, provider.contributionId, provider.config);
    }
  }

  const hasConnectorInstance = Boolean(next.connectors.instances[selected.connectorInstanceId]);
  if (mergeStrategy === "overwrite" || !hasConnectorInstance) {
    upsertConnectorInstance(next, selected.connectorInstanceId, selected.connectorContributionId, selected.connectorConfig);
  }

  if (mergeStrategy === "overwrite") {
    next.providers = {
      ...next.providers,
      defaultProviderId: selected.providerInstanceId,
      instances: next.providers.instances,
    };
  } else {
    setDefaultProviderIfMissingOrInvalid(next);
  }

  const hasRoute = Boolean(next.routing.routes[input.routeId]);
  if (mergeStrategy === "overwrite" || !hasRoute) {
    upsertRoute(next, input.routeId, {
      ...selected.routeProfile,
      projectRoot: input.projectRoot,
    });
  }

  if (mergeStrategy === "overwrite" || !next.routing.defaultRouteId) {
    setDefaultRoute(next, input.routeId);
  }

  await writeConfigWithValidation(configPath, next, {
    validate: true,
    createBackup: Boolean(existingConfig),
  });

  outro("Initialization completed.");

  console.log(`Config written: ${configPath}`);
  if (existingConfig && options.merge) {
    console.log(`Merge strategy: ${mergeStrategy}`);
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
