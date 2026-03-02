import {
  cancel,
  confirm,
  isCancel,
  note,
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
} from "./config-mutators.js";
import {
  DEFAULT_DISCORD_BOT_NAME,
  DISCORD_CONNECTOR_CONTRIBUTION_ID,
  normalizeDiscordBotChannelMap,
} from "./discord-config.js";
import type { RawGatewayConfig } from "./config-types.js";
import { promptConfigFromSchema } from "./schema-prompts.js";

export type ConfigureSection = "provider" | "connector" | "routing" | "sandbox" | "data";

export const CONFIGURE_SECTION_VALUES: ConfigureSection[] = ["provider", "connector", "routing", "sandbox", "data"];

export interface ConfigureSectionContext {
  schemaByContributionId?: ReadonlyMap<string, Record<string, unknown>>;
  schemaStateByContributionId?: ReadonlyMap<string, "with_schema" | "without_schema">;
}

type SchemaFallbackState = "without_schema" | "not_loaded";

const SECTION_ORDER: Record<ConfigureSection, number> = {
  provider: 1,
  routing: 2,
  connector: 3,
  sandbox: 4,
  data: 5,
};

/**
 * Validates whether a string value is one of the supported configure sections.
 */
export function isConfigureSection(value: string): value is ConfigureSection {
  return CONFIGURE_SECTION_VALUES.includes(value as ConfigureSection);
}

/**
 * Deduplicates and reorders selected sections to honor dependency order.
 */
export function normalizeConfigureSectionOrder(sections: ConfigureSection[]): ConfigureSection[] {
  const unique: ConfigureSection[] = [];
  for (const section of sections) {
    if (!unique.includes(section)) {
      unique.push(section);
    }
  }

  return unique.sort((a, b) => SECTION_ORDER[a] - SECTION_ORDER[b]);
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
 * Explains why schema-driven prompting is unavailable before falling back to raw JSON input.
 */
async function noteSchemaFallback(
  contributionId: string,
  context?: ConfigureSectionContext,
): Promise<SchemaFallbackState> {
  const state = context?.schemaStateByContributionId?.get(contributionId);
  if (state === "without_schema") {
    await note(
      `Contribution '${contributionId}' is loaded but does not expose configSchema. Falling back to JSON input.`,
      "Schema",
    );
    return "without_schema";
  }

  await note(
    `No loaded schema for contribution '${contributionId}'. The extension may be disabled or not installed. Falling back to JSON input.`,
    "Schema",
  );
  return "not_loaded";
}

/**
 * Guards raw JSON fallback when schema is unavailable because contribution is not loaded.
 */
async function confirmUnloadedSchemaFallback(contributionId: string, state: SchemaFallbackState): Promise<void> {
  if (state !== "not_loaded") {
    return;
  }

  const proceed = await confirm({
    message: `Continue with raw JSON for '${contributionId}'? Defaults will not be auto-applied.`,
    initialValue: false,
  });
  if (isCancel(proceed)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }
  if (!proceed) {
    throw new Error(
      `Cannot continue without schema for contribution '${contributionId}'. ` +
      `Enable/install the extension first (check 'extensions.allowList'), then retry.`,
    );
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
 * Renders current channel mappings for guided editing notes.
 */
function formatBotChannelMap(botChannelMap: Record<string, string>): string {
  const entries = Object.entries(botChannelMap).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) {
    return "(empty)";
  }

  return entries.map(([channelId, routeId]) => `${channelId} -> ${routeId}`).join("\n");
}

/**
 * Provides guided add/remove flow for editing Discord channel mappings.
 */
async function editBotChannelMapGuided(
  existingMap: Record<string, string>,
  knownRouteIds: string[],
): Promise<Record<string, string>> {
  const workingMap: Record<string, string> = { ...existingMap };
  if (knownRouteIds.length === 0 && Object.keys(workingMap).length === 0) {
    throw new Error("No routes found. Configure routing first.");
  }

  while (true) {
    await note(formatBotChannelMap(workingMap), "Current botChannelMap");

    const actionResult = await select({
      message: "Edit botChannelMap",
      options: [
        { value: "upsert", label: "Add or update mapping" },
        { value: "remove", label: "Remove mapping" },
        { value: "done", label: "Done" },
      ],
      initialValue: "upsert",
    });
    if (isCancel(actionResult)) {
      cancel("Configure cancelled.");
      throw new Error("Configure cancelled.");
    }
    const action = String(actionResult);

    if (action === "done") {
      if (Object.keys(workingMap).length === 0) {
        await note("Discord botChannelMap must include at least one channel mapping", "Validation");
        continue;
      }
      return workingMap;
    }

    if (action === "remove") {
      const channelChoices = Object.keys(workingMap).sort((a, b) => a.localeCompare(b));
      if (channelChoices.length === 0) {
        await note("No mapping to remove.", "Info");
        continue;
      }

      const removeResult = await select({
        message: "Select channel mapping to remove",
        options: channelChoices.map((channelId) => ({
          value: channelId,
          label: `${channelId} -> ${workingMap[channelId]}`,
        })),
        initialValue: channelChoices[0],
      });
      if (isCancel(removeResult)) {
        cancel("Configure cancelled.");
        throw new Error("Configure cancelled.");
      }

      delete workingMap[String(removeResult)];
      continue;
    }

    const channelId = await requiredText("Discord channel ID");
    let routeId: string;
    if (knownRouteIds.length > 0) {
      const routeResult = await select({
        message: "Route ID",
        options: knownRouteIds.map((id) => ({ value: id, label: id })),
        initialValue: knownRouteIds[0],
      });
      if (isCancel(routeResult)) {
        cancel("Configure cancelled.");
        throw new Error("Configure cancelled.");
      }
      routeId = String(routeResult);
    } else {
      routeId = await requiredText("Route ID");
    }

    workingMap[channelId] = routeId;
  }
}

/**
 * Runs provider-related prompts and applies changes into config.providers.
 */
async function configureProviderSection(config: RawGatewayConfig, context?: ConfigureSectionContext): Promise<void> {
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
  const schema = context?.schemaByContributionId?.get(contributionId);
  if (schema) {
    const existingConfig = existing?.config && typeof existing.config === "object" && !Array.isArray(existing.config)
      ? existing.config as Record<string, unknown>
      : {};
    instanceConfig = await promptConfigFromSchema(schema, existingConfig, {
      title: `Provider '${instanceId}' (${contributionId})`,
    });
  } else {
    const fallbackState = await noteSchemaFallback(contributionId, context);
    await confirmUnloadedSchemaFallback(contributionId, fallbackState);
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
async function configureConnectorSection(config: RawGatewayConfig, context?: ConfigureSectionContext): Promise<void> {
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
    const knownRouteIds = Object.keys(next.routing?.routes ?? {}).sort((a, b) => a.localeCompare(b));
    const channelMapModeResult = await select({
      message: "Edit botChannelMap",
      options: [
        { value: "guided", label: "Guided editor (recommended)" },
        { value: "json", label: "Raw JSON input" },
      ],
      initialValue: "guided",
    });
    if (isCancel(channelMapModeResult)) {
      cancel("Configure cancelled.");
      throw new Error("Configure cancelled.");
    }

    let botChannelMap: Record<string, string>;
    if (channelMapModeResult === "guided") {
      botChannelMap = await editBotChannelMapGuided(existingChannelMap, knownRouteIds);
    } else {
      const channelMapInput = await text({
        message: "Discord botChannelMap JSON (channelId -> routeId)",
        initialValue: JSON.stringify(existingChannelMap, null, 2),
      });
      if (isCancel(channelMapInput)) {
        cancel("Configure cancelled.");
        throw new Error("Configure cancelled.");
      }

      botChannelMap = parseBotChannelMapText(String(channelMapInput ?? "{}"));
    }

    const knownRoutes = new Set(knownRouteIds);
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
  } else if (context?.schemaByContributionId?.has(contributionId)) {
    const schema = context.schemaByContributionId.get(contributionId)!;
    const existingConfig = existing?.config && typeof existing.config === "object" && !Array.isArray(existing.config)
      ? existing.config as Record<string, unknown>
      : {};
    connectorConfig = await promptConfigFromSchema(schema, existingConfig, {
      title: `Connector '${instanceId}' (${contributionId})`,
    });
  } else {
    const fallbackState = await noteSchemaFallback(contributionId, context);
    await confirmUnloadedSchemaFallback(contributionId, fallbackState);
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
 * Runs one interactive config section mutator.
 */
export async function applyConfigureSection(
  config: RawGatewayConfig,
  section: ConfigureSection,
  context?: ConfigureSectionContext,
): Promise<void> {
  if (section === "provider") {
    await configureProviderSection(config, context);
    return;
  }

  if (section === "connector") {
    await configureConnectorSection(config, context);
    return;
  }

  if (section === "routing") {
    await configureRoutingSection(config);
    return;
  }

  if (section === "sandbox") {
    await configureSandboxSection(config);
    return;
  }

  await configureDataSection(config);
}
