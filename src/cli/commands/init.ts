import {
  cancel,
  confirm,
  intro,
  isCancel,
  note,
  outro,
  password,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { ExtensionStoreManager } from "../../extension/manager.js";
import {
  ensureDefaultProvider,
  ensureGatewayConfigShape,
  setDefaultRoute,
  upsertAllowListPackage,
  upsertConnectorInstance,
  upsertProviderInstance,
  upsertRoute,
} from "../shared/config-mutators.js";
import {
  DEFAULT_DISCORD_BOT_NAME,
} from "../shared/discord-config.js";
import {
  DEFAULT_CONFIG_PATH,
  readRawConfig,
  resolveConfigPath,
  resolveDataRootDir,
  writeConfigWithValidation,
} from "../shared/config-io.js";
import type { RawGatewayConfig } from "../shared/config-types.js";
import { createPresetConfig, isPresetId, listPresetIds, type InitPresetId } from "../shared/presets.js";
import { createLogger } from "../shared/runtime.js";

interface InitInput {
  preset: InitPresetId;
  projectRoot: string;
  channelId: string;
  routeId: string;
  botName: string;
  botToken: string;
  allowAllMessages: boolean;
}

/**
 * Returns a trimmed string value when present, otherwise undefined.
 */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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
 * Collects init inputs from flags (non-interactive) or prompt flow (interactive).
 */
async function collectInitInput(
  options: {
    preset?: string;
    projectRoot?: string;
    channelId?: string;
    routeId?: string;
    botName?: string;
    botToken?: string;
    allowAllMessages?: boolean;
    nonInteractive?: boolean;
  },
): Promise<InitInput> {
  const nonInteractive = options.nonInteractive === true;

  if (nonInteractive) {
    const presetValue = options.preset ?? "discord-pi";
    if (!isPresetId(presetValue)) {
      throw new Error(`Unsupported preset '${presetValue}'. Available: ${listPresetIds().join(", ")}`);
    }

    const channelId = asString(options.channelId);
    if (!channelId) {
      throw new Error("--channel-id is required in --non-interactive mode");
    }

    const botToken = asString(options.botToken);
    if (!botToken) {
      throw new Error("--bot-token is required in --non-interactive mode");
    }

    return {
      preset: presetValue,
      projectRoot: asString(options.projectRoot) ?? process.cwd(),
      channelId,
      routeId: asString(options.routeId) ?? "main",
      botName: asString(options.botName) ?? DEFAULT_DISCORD_BOT_NAME,
      botToken,
      allowAllMessages: options.allowAllMessages === true,
    };
  }

  intro("dobby init");

  const presetResult = await select({
    message: "Choose a starter preset",
    options: [
      { value: "discord-pi", label: "Discord + Pi provider" },
      { value: "discord-claude-cli", label: "Discord + Claude CLI provider" },
    ],
    initialValue: isPresetId(options.preset ?? "") ? options.preset : "discord-pi",
  });
  if (isCancel(presetResult)) {
    cancel("Initialization cancelled.");
    throw new Error("Initialization cancelled.");
  }

  const projectRoot = await promptRequiredText({
    message: "Project root",
    initialValue: asString(options.projectRoot) ?? process.cwd(),
  });

  const channelIdInitial = asString(options.channelId);
  const channelId = await promptRequiredText({
    message: "Discord channel ID",
    placeholder: "1234567890",
    ...(channelIdInitial ? { initialValue: channelIdInitial } : {}),
  });

  const routeIdResult = await text({
    message: "Route ID",
    initialValue: asString(options.routeId) ?? "main",
  });
  if (isCancel(routeIdResult)) {
    cancel("Initialization cancelled.");
    throw new Error("Initialization cancelled.");
  }

  const botNameResult = await text({
    message: "Discord bot name",
    initialValue: asString(options.botName) ?? DEFAULT_DISCORD_BOT_NAME,
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
    initialValue: options.allowAllMessages === true,
  });
  if (isCancel(allowAllMessagesResult)) {
    cancel("Initialization cancelled.");
    throw new Error("Initialization cancelled.");
  }

  return {
    preset: String(presetResult) as InitPresetId,
    projectRoot,
    channelId,
    routeId: String(routeIdResult ?? "").trim() || "main",
    botName: String(botNameResult ?? "").trim() || DEFAULT_DISCORD_BOT_NAME,
    botToken: String(botTokenResult ?? "").trim(),
    allowAllMessages: allowAllMessagesResult === true,
  };
}

/**
 * Formats start command hints so default config path users can run bare "dobby start".
 */
function startCommandHint(configPath: string): string {
  return withConfigFlag("dobby start", configPath);
}

/**
 * Appends --config only when caller is not using the global default config path.
 */
function withConfigFlag(command: string, configPath: string): string {
  return configPath === DEFAULT_CONFIG_PATH ? command : `${command} --config ${configPath}`;
}

/**
 * Executes first-time initialization: install preset extensions, write config, then validate.
 */
export async function runInitCommand(options: {
  config?: string;
  preset?: string;
  projectRoot?: string;
  channelId?: string;
  routeId?: string;
  botName?: string;
  botToken?: string;
  allowAllMessages?: boolean;
  merge?: boolean;
  overwrite?: boolean;
  nonInteractive?: boolean;
  yes?: boolean;
}): Promise<void> {
  if (options.merge && options.overwrite) {
    throw new Error("--merge and --overwrite cannot be used together");
  }

  const configPath = resolveConfigPath(options.config);
  const existingConfig = await readRawConfig(configPath);

  if (existingConfig && !options.merge && !options.overwrite) {
    throw new Error(
      `Config '${configPath}' already exists. Use --merge to keep existing values or --overwrite to replace it.`,
    );
  }

  const input = await collectInitInput(options);
  const preset = createPresetConfig(input.preset, {
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
    for (const packageName of preset.extensionPackages) {
      const installed = await manager.install(packageName);
      upsertAllowListPackage(next, installed.packageName, true);
    }
    installSpinner.stop("Extensions installed");
  } catch (error) {
    installSpinner.stop("Extension installation failed");
    throw error;
  }

  upsertProviderInstance(next, preset.providerInstanceId, preset.providerContributionId, preset.providerConfig);
  upsertConnectorInstance(next, preset.connectorInstanceId, preset.connectorContributionId, preset.connectorConfig);
  ensureDefaultProvider(next, preset.providerInstanceId);

  upsertRoute(next, input.routeId, {
    ...preset.routeProfile,
    projectRoot: input.projectRoot,
  });
  setDefaultRoute(next, input.routeId);

  await writeConfigWithValidation(configPath, next, {
    validate: true,
    createBackup: Boolean(existingConfig),
  });

  if (!options.nonInteractive) {
    outro("Initialization completed.");
  }

  console.log(`Config written: ${configPath}`);
  console.log("Next steps:");
  console.log(`1. ${startCommandHint(configPath)}`);

  if (!options.nonInteractive && options.yes !== true) {
    const showHint = await confirm({
      message: "Show quick validation commands?",
      initialValue: true,
    });

    if (!isCancel(showHint) && showHint) {
      await note(
        [
          withConfigFlag("dobby extension list", configPath),
          withConfigFlag("dobby doctor", configPath),
        ].join("\n"),
        "Validation",
      );
    }
  }
}
