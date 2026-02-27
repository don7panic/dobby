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
  text,
} from "@clack/prompts";
import JSON5 from "json5";
import {
  ensureGatewayConfigShape,
  setDefaultProviderIfMissingOrInvalid,
  setDefaultRoute,
  upsertConnectorInstance,
  upsertProviderInstance,
  upsertRoute,
} from "../shared/config-mutators.js";
import {
  DEFAULT_DISCORD_BOT_NAME,
  DISCORD_CONNECTOR_CONTRIBUTION_ID,
  normalizeDiscordBotChannelMap,
} from "../shared/discord-config.js";
import { requireRawConfig, resolveConfigPath, writeConfigWithValidation } from "../shared/config-io.js";
import type { RawGatewayConfig } from "../shared/config-types.js";

export type ConfigureSection = "provider" | "connector" | "routing" | "sandbox" | "data";

const SECTION_VALUES: ConfigureSection[] = ["provider", "connector", "routing", "sandbox", "data"];

/**
 * Validates whether a string value is one of the supported configure sections.
 */
function isConfigureSection(value: string): value is ConfigureSection {
  return SECTION_VALUES.includes(value as ConfigureSection);
}

/**
 * Collects required text input with retry semantics and cancellation handling.
 */
async function requiredText(message: string, initialValue?: string, placeholder?: string): Promise<string> {
  while (true) {
    const promptOptions = {
      message,
      ...(initialValue !== undefined ? { initialValue } : {}),
      ...(placeholder !== undefined ? { placeholder } : {}),
    };
    const result = await text(promptOptions);
    if (isCancel(result)) {
      cancel("Configure cancelled.");
      throw new Error("Configure cancelled.");
    }

    const trimmed = String(result ?? "").trim();
    if (trimmed.length > 0) {
      return trimmed;
    }

    await note("This field is required.", "Validation");
  }
}

/**
 * Parses and validates botChannelMap JSON input from configure prompts.
 */
function parseBotChannelMapText(raw: string): Record<string, string> {
  const parsed = JSON5.parse(raw);
  const normalized = normalizeDiscordBotChannelMap(parsed);
  if (Object.keys(normalized).length === 0) {
    throw new Error("Discord botChannelMap must include at least one channel mapping");
  }

  return normalized;
}

/**
 * Runs provider-related prompts and applies changes into config.providers.
 */
async function configureProviderSection(config: RawGatewayConfig): Promise<void> {
  const next = ensureGatewayConfigShape(config);
  const providerInstances = next.providers?.instances ?? {};

  const providerChoices = Object.keys(providerInstances).sort((a, b) => a.localeCompare(b));
  let targetProvider: string;
  if (providerChoices.length === 0) {
    targetProvider = await requiredText("Provider instance ID", "pi.main");
  } else {
    const targetProviderResult = await select({
      message: "Select provider instance",
      options: [
        ...providerChoices.map((id) => ({ value: id, label: id })),
        { value: "__new", label: "Create new provider instance" },
      ],
      initialValue: providerChoices[0],
    });
    if (isCancel(targetProviderResult)) {
      cancel("Configure cancelled.");
      throw new Error("Configure cancelled.");
    }
    targetProvider = String(targetProviderResult);
  }

  const instanceId = targetProvider === "__new"
    ? await requiredText("New provider instance ID", "provider.main")
    : targetProvider;

  const existing = providerInstances[instanceId];
  const contributionId = await requiredText(
    "Provider contribution ID",
    existing?.contributionId ?? "provider.pi",
    "provider.pi",
  );

  let instanceConfig: Record<string, unknown> = {};
  if (contributionId === "provider.pi") {
    const provider = await requiredText("Pi provider key", String(existing?.config?.provider ?? "custom-openai"));
    const model = await requiredText("Pi model", String(existing?.config?.model ?? "example-model"));
    const thinkingLevel = await requiredText(
      "Pi thinking level",
      String(existing?.config?.thinkingLevel ?? "off"),
      "off|minimal|low|medium|high|xhigh",
    );
    const modelsFileResult = await text({
      message: "modelsFile (optional)",
      initialValue: String(existing?.config?.modelsFile ?? "./models.custom.json"),
    });
    if (isCancel(modelsFileResult)) {
      cancel("Configure cancelled.");
      throw new Error("Configure cancelled.");
    }

    instanceConfig = {
      provider,
      model,
      thinkingLevel,
      ...(String(modelsFileResult ?? "").trim().length > 0 ? { modelsFile: String(modelsFileResult).trim() } : {}),
    };
  } else if (contributionId === "provider.claude-cli") {
    const model = await requiredText("Claude model", String(existing?.config?.model ?? "claude-sonnet-4-5"));
    const maxTurns = await requiredText("maxTurns", String(existing?.config?.maxTurns ?? 20));
    const command = await requiredText("command", String(existing?.config?.command ?? "claude"));

    instanceConfig = {
      model,
      maxTurns: Number.parseInt(maxTurns, 10),
      command,
      commandArgs: Array.isArray(existing?.config?.commandArgs) ? existing.config.commandArgs : [],
      authMode: String(existing?.config?.authMode ?? "auto"),
      permissionMode: String(existing?.config?.permissionMode ?? "bypassPermissions"),
      streamVerbose: existing?.config?.streamVerbose !== false,
    };
  } else {
    const rawConfig = await text({
      message: "Provider config JSON (optional)",
      initialValue: existing?.config ? JSON.stringify(existing.config) : "{}",
    });
    if (isCancel(rawConfig)) {
      cancel("Configure cancelled.");
      throw new Error("Configure cancelled.");
    }

    const rawText = String(rawConfig ?? "{}").trim();
    if (rawText.length > 0) {
      const parsed = JSON5.parse(rawText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Provider config must be a JSON object");
      }
      instanceConfig = parsed as Record<string, unknown>;
    }
  }

  upsertProviderInstance(next, instanceId, contributionId, instanceConfig);
  setDefaultProviderIfMissingOrInvalid(next);

  const defaultChoices = Object.keys(next.providers?.instances ?? {}).sort((a, b) => a.localeCompare(b));
  if (defaultChoices.length > 0) {
    const defaultChoiceResult = await select({
      message: "Default provider",
      options: defaultChoices.map((id) => ({ value: id, label: id })),
      initialValue: next.providers?.defaultProviderId && defaultChoices.includes(next.providers.defaultProviderId)
        ? next.providers.defaultProviderId
        : defaultChoices[0],
    });
    if (isCancel(defaultChoiceResult)) {
      cancel("Configure cancelled.");
      throw new Error("Configure cancelled.");
    }
    const defaultChoice = String(defaultChoiceResult);

    next.providers = {
      ...(next.providers ?? {}),
      ...(defaultChoice.length > 0 ? { defaultProviderId: defaultChoice } : {}),
      instances: next.providers?.instances ?? {},
    };
  }

  Object.assign(config, next);
}

/**
 * Runs connector-related prompts and applies changes into config.connectors.
 */
async function configureConnectorSection(config: RawGatewayConfig): Promise<void> {
  const next = ensureGatewayConfigShape(config);
  const connectorInstances = next.connectors?.instances ?? {};

  const connectorChoices = Object.keys(connectorInstances).sort((a, b) => a.localeCompare(b));
  let targetConnector: string;
  if (connectorChoices.length === 0) {
    targetConnector = await requiredText("Connector instance ID", "discord.main");
  } else {
    const targetConnectorResult = await select({
      message: "Select connector instance",
      options: [
        ...connectorChoices.map((id) => ({ value: id, label: id })),
        { value: "__new", label: "Create new connector instance" },
      ],
      initialValue: connectorChoices[0],
    });
    if (isCancel(targetConnectorResult)) {
      cancel("Configure cancelled.");
      throw new Error("Configure cancelled.");
    }
    targetConnector = String(targetConnectorResult);
  }

  const instanceId = targetConnector === "__new"
    ? await requiredText("New connector instance ID", "discord.main")
    : targetConnector;

  const existing = connectorInstances[instanceId];
  const contributionId = await requiredText(
    "Connector contribution ID",
    existing?.contributionId ?? DISCORD_CONNECTOR_CONTRIBUTION_ID,
    DISCORD_CONNECTOR_CONTRIBUTION_ID,
  );

  let connectorConfig: Record<string, unknown> = {};
  if (contributionId === DISCORD_CONNECTOR_CONTRIBUTION_ID) {
    const botName = await requiredText(
      "Discord botName",
      typeof existing?.config?.botName === "string" ? existing.config.botName : DEFAULT_DISCORD_BOT_NAME,
    );

    const botTokenResult = await password({
      message: "Discord botToken (leave blank to keep current value)",
      mask: "*",
    });
    if (isCancel(botTokenResult)) {
      cancel("Configure cancelled.");
      throw new Error("Configure cancelled.");
    }
    const providedBotToken = String(botTokenResult ?? "").trim();
    const existingBotToken = typeof existing?.config?.botToken === "string" ? existing.config.botToken : "";
    const botToken = providedBotToken.length > 0 ? providedBotToken : existingBotToken;
    if (botToken.length === 0) {
      throw new Error("Discord botToken is required");
    }

    const existingChannelMap = normalizeDiscordBotChannelMap(existing?.config?.botChannelMap);
    const channelMapInput = await text({
      message: "Discord botChannelMap JSON (channelId -> routeId)",
      initialValue: JSON.stringify(existingChannelMap, null, 2),
    });
    if (isCancel(channelMapInput)) {
      cancel("Configure cancelled.");
      throw new Error("Configure cancelled.");
    }

    const botChannelMap = parseBotChannelMapText(String(channelMapInput ?? "{}"));
    const knownRoutes = new Set(Object.keys(next.routing?.routes ?? {}));
    for (const routeId of Object.values(botChannelMap)) {
      if (!knownRoutes.has(routeId)) {
        throw new Error(`Discord botChannelMap references unknown route '${routeId}'`);
      }
    }

    const reconnectStaleMs =
      typeof existing?.config?.reconnectStaleMs === "number" && existing.config.reconnectStaleMs > 0
        ? existing.config.reconnectStaleMs
        : 60_000;
    const reconnectCheckIntervalMs =
      typeof existing?.config?.reconnectCheckIntervalMs === "number" && existing.config.reconnectCheckIntervalMs > 0
        ? existing.config.reconnectCheckIntervalMs
        : 10_000;

    connectorConfig = {
      botName,
      botToken,
      botChannelMap,
      reconnectStaleMs,
      reconnectCheckIntervalMs,
    };
  } else {
    const rawConfig = await text({
      message: "Connector config JSON (optional)",
      initialValue: existing?.config ? JSON.stringify(existing.config) : "{}",
    });
    if (isCancel(rawConfig)) {
      cancel("Configure cancelled.");
      throw new Error("Configure cancelled.");
    }

    const rawText = String(rawConfig ?? "{}").trim();
    if (rawText.length > 0) {
      const parsed = JSON5.parse(rawText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Connector config must be a JSON object");
      }
      connectorConfig = parsed as Record<string, unknown>;
    }
  }

  upsertConnectorInstance(next, instanceId, contributionId, connectorConfig);
  Object.assign(config, next);
}

/**
 * Runs route editing prompts and default route selection.
 */
async function configureRoutingSection(config: RawGatewayConfig): Promise<void> {
  const next = ensureGatewayConfigShape(config);
  const routes = next.routing?.routes ?? {};
  const routeChoices = Object.keys(routes).sort((a, b) => a.localeCompare(b));

  let targetRoute: string;
  if (routeChoices.length === 0) {
    targetRoute = await requiredText("Route ID", "main");
  } else {
    const targetRouteResult = await select({
      message: "Select route",
      options: [
        ...routeChoices.map((id) => ({ value: id, label: id })),
        { value: "__new", label: "Create new route" },
      ],
      initialValue: routeChoices[0],
    });

    if (isCancel(targetRouteResult)) {
      cancel("Configure cancelled.");
      throw new Error("Configure cancelled.");
    }
    targetRoute = String(targetRouteResult);
  }

  const routeId = targetRoute === "__new" ? await requiredText("New route ID", "main") : targetRoute;
  const existingRoute = routes[routeId];

  const projectRoot = await requiredText("projectRoot", existingRoute?.projectRoot ?? process.cwd());
  const toolsChoice = await select({
    message: "tools profile",
    options: [
      { value: "full", label: "full" },
      { value: "readonly", label: "readonly" },
    ],
    initialValue: existingRoute?.tools === "readonly" ? "readonly" : "full",
  });
  if (isCancel(toolsChoice)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }
  const resolvedToolsChoice = String(toolsChoice);

  const mentionsOnly = await confirm({
    message: "Only respond when mentioned in group chats",
    initialValue: existingRoute?.allowMentionsOnly !== false,
  });
  if (isCancel(mentionsOnly)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }

  const providers = Object.keys(next.providers?.instances ?? {}).sort((a, b) => a.localeCompare(b));
  let providerId: string | null = null;
  if (providers.length > 0) {
    const providerIdResult = await select({
      message: "providerId",
      options: providers.map((id) => ({ value: id, label: id })),
      initialValue: existingRoute?.providerId && providers.includes(existingRoute.providerId)
        ? existingRoute.providerId
        : providers[0],
    });
    if (isCancel(providerIdResult)) {
      cancel("Configure cancelled.");
      throw new Error("Configure cancelled.");
    }
    providerId = String(providerIdResult);
  }

  const sandboxIds = ["host.builtin", ...Object.keys(next.sandboxes?.instances ?? {}).sort((a, b) => a.localeCompare(b))];
  const sandboxId = await select({
    message: "sandboxId",
    options: sandboxIds.map((id) => ({ value: id, label: id })),
    initialValue: existingRoute?.sandboxId && sandboxIds.includes(existingRoute.sandboxId)
      ? existingRoute.sandboxId
      : "host.builtin",
  });
  if (isCancel(sandboxId)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }
  const resolvedSandboxId = String(sandboxId);

  upsertRoute(next, routeId, {
    projectRoot,
    tools: resolvedToolsChoice === "readonly" ? "readonly" : "full",
    allowMentionsOnly: mentionsOnly === true,
    maxConcurrentTurns:
      typeof existingRoute?.maxConcurrentTurns === "number" && existingRoute.maxConcurrentTurns > 0
        ? existingRoute.maxConcurrentTurns
        : 1,
    ...(providerId ? { providerId } : {}),
    sandboxId: resolvedSandboxId,
    ...(typeof existingRoute?.systemPromptFile === "string" ? { systemPromptFile: existingRoute.systemPromptFile } : {}),
  });

  const setAsDefault = await confirm({
    message: "Set this route as defaultRouteId",
    initialValue: next.routing?.defaultRouteId === routeId || !next.routing?.defaultRouteId,
  });

  if (isCancel(setAsDefault)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }

  if (setAsDefault) {
    setDefaultRoute(next, routeId);
  }

  Object.assign(config, next);
}

/**
 * Updates the default sandbox setting while preserving configured sandbox instances.
 */
async function configureSandboxSection(config: RawGatewayConfig): Promise<void> {
  const next = ensureGatewayConfigShape(config);
  const sandboxIds = ["host.builtin", ...Object.keys(next.sandboxes?.instances ?? {}).sort((a, b) => a.localeCompare(b))];

  const defaultSandboxId = await select({
    message: "Default sandbox ID",
    options: sandboxIds.map((id) => ({ value: id, label: id })),
    initialValue:
      typeof next.sandboxes?.defaultSandboxId === "string" && sandboxIds.includes(next.sandboxes.defaultSandboxId)
        ? next.sandboxes.defaultSandboxId
        : "host.builtin",
  });

  if (isCancel(defaultSandboxId)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }
  const resolvedDefaultSandboxId = String(defaultSandboxId);

  next.sandboxes = {
    ...(next.sandboxes ?? {}),
    defaultSandboxId: resolvedDefaultSandboxId,
    instances: next.sandboxes?.instances ?? {},
  };

  Object.assign(config, next);
}

/**
 * Updates data section fields that affect runtime storage and dedup behavior.
 */
async function configureDataSection(config: RawGatewayConfig): Promise<void> {
  const next = ensureGatewayConfigShape(config);
  const rootDir = await requiredText("data.rootDir", next.data?.rootDir ?? "./data");
  const dedupInput = await requiredText("data.dedupTtlMs", String(next.data?.dedupTtlMs ?? 604800000));

  const dedupTtlMs = Number.parseInt(dedupInput, 10);
  if (!Number.isFinite(dedupTtlMs) || dedupTtlMs <= 0) {
    throw new Error("data.dedupTtlMs must be a positive integer");
  }

  next.data = {
    ...(next.data ?? {}),
    rootDir,
    dedupTtlMs,
  };

  Object.assign(config, next);
}

/**
 * Resolves target sections from CLI flags or interactive section picker.
 */
async function resolveSections(sections: string[]): Promise<ConfigureSection[]> {
  if (sections.length > 0) {
    const normalized: ConfigureSection[] = [];
    for (const section of sections) {
      if (!isConfigureSection(section)) {
        throw new Error(`Unknown --section '${section}'. Allowed: ${SECTION_VALUES.join(", ")}`);
      }
      normalized.push(section);
    }
    return normalized;
  }

  const picked = await multiselect({
    message: "Select sections to configure",
    options: [
      { value: "provider", label: "provider" },
      { value: "connector", label: "connector" },
      { value: "routing", label: "routing" },
      { value: "sandbox", label: "sandbox" },
      { value: "data", label: "data" },
    ],
    initialValues: ["provider", "connector", "routing"],
    required: true,
  });

  if (isCancel(picked)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }

  return picked as ConfigureSection[];
}

/**
 * Executes interactive config updates and validates each saved section.
 */
export async function runConfigureCommand(options: {
  config?: string;
  sections: string[];
}): Promise<void> {
  const configPath = resolveConfigPath(options.config);
  const rawConfig = await requireRawConfig(configPath);
  const next = ensureGatewayConfigShape(structuredClone(rawConfig));

  intro("dobby configure");
  const sections = await resolveSections(options.sections);

  for (const section of sections) {
    if (section === "provider") {
      await configureProviderSection(next);
    } else if (section === "connector") {
      await configureConnectorSection(next);
    } else if (section === "routing") {
      await configureRoutingSection(next);
    } else if (section === "sandbox") {
      await configureSandboxSection(next);
    } else if (section === "data") {
      await configureDataSection(next);
    }

    await writeConfigWithValidation(configPath, next, {
      validate: true,
      createBackup: true,
    });

    await note(`Section '${section}' saved to ${configPath}`, "Saved");
  }

  outro("Configuration updated.");
}
