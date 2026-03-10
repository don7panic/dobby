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
  upsertBinding,
  upsertConnectorInstance,
  upsertProviderInstance,
  upsertRoute,
} from "./config-mutators.js";
import {
  DEFAULT_DISCORD_BOT_NAME,
  DISCORD_CONNECTOR_CONTRIBUTION_ID,
} from "./discord-config.js";
import type { RawBindingConfig, RawGatewayConfig } from "./config-types.js";
import { promptConfigFromSchema } from "./schema-prompts.js";

export type ConfigureSection = "provider" | "connector" | "route" | "binding" | "sandbox" | "data";

export const CONFIGURE_SECTION_VALUES: ConfigureSection[] = ["provider", "connector", "route", "binding", "sandbox", "data"];

export interface ConfigureSectionContext {
  schemaByContributionId?: ReadonlyMap<string, Record<string, unknown>>;
  schemaStateByContributionId?: ReadonlyMap<string, "with_schema" | "without_schema">;
}

type SchemaFallbackState = "without_schema" | "not_loaded";

const SECTION_ORDER: Record<ConfigureSection, number> = {
  provider: 1,
  connector: 2,
  sandbox: 3,
  route: 4,
  binding: 5,
  data: 6,
};

export function isConfigureSection(value: string): value is ConfigureSection {
  return CONFIGURE_SECTION_VALUES.includes(value as ConfigureSection);
}

export function normalizeConfigureSectionOrder(sections: ConfigureSection[]): ConfigureSection[] {
  const unique: ConfigureSection[] = [];
  for (const section of sections) {
    if (!unique.includes(section)) {
      unique.push(section);
    }
  }

  return unique.sort((a, b) => SECTION_ORDER[a] - SECTION_ORDER[b]);
}

async function requiredText(message: string, initialValue?: string, placeholder?: string): Promise<string> {
  while (true) {
    const result = await text({
      message,
      ...(initialValue !== undefined ? { initialValue } : {}),
      ...(placeholder !== undefined ? { placeholder } : {}),
    });
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

async function optionalText(message: string, initialValue?: string, placeholder?: string): Promise<string | undefined> {
  const result = await text({
    message,
    ...(initialValue !== undefined ? { initialValue } : {}),
    ...(placeholder !== undefined ? { placeholder } : {}),
  });
  if (isCancel(result)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }

  const trimmed = String(result ?? "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

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

async function promptJsonObject(
  message: string,
  initialValue: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await text({
    message,
    initialValue: JSON.stringify(initialValue, null, 2),
  });
  if (isCancel(result)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }

  const rawText = String(result ?? "{}").trim();
  if (rawText.length === 0) {
    return {};
  }

  const parsed = JSON5.parse(rawText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Config must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

async function configureProviderSection(config: RawGatewayConfig, context?: ConfigureSectionContext): Promise<void> {
  const next = ensureGatewayConfigShape(config);
  const providerItems = next.providers.items;

  const providerChoices = Object.keys(providerItems).sort((a, b) => a.localeCompare(b));
  const targetProvider = providerChoices.length === 0
    ? "__new"
    : await select({
      message: "Select provider instance",
      options: [
        ...providerChoices.map((id) => ({ value: id, label: id })),
        { value: "__new", label: "Create new provider instance" },
      ],
      initialValue: providerChoices[0],
    });
  if (isCancel(targetProvider)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }

  const instanceId = String(targetProvider) === "__new"
    ? await requiredText("New provider instance ID", "pi.main")
    : String(targetProvider);
  const existing = providerItems[instanceId];
  const contributionId = await requiredText(
    "Provider contribution ID",
    existing?.type ?? "provider.pi",
    "provider.pi",
  );

  let providerConfig: Record<string, unknown> = {};
  const existingConfig = existing ? Object.fromEntries(Object.entries(existing).filter(([key]) => key !== "type")) : {};
  if (context?.schemaByContributionId?.has(contributionId)) {
    providerConfig = await promptConfigFromSchema(
      context.schemaByContributionId.get(contributionId)!,
      existingConfig,
      { title: `Provider '${instanceId}' (${contributionId})` },
    );
  } else {
    const fallbackState = await noteSchemaFallback(contributionId, context);
    await confirmUnloadedSchemaFallback(contributionId, fallbackState);
    providerConfig = await promptJsonObject("Provider config JSON", existingConfig);
  }

  upsertProviderInstance(next, instanceId, contributionId, providerConfig);
  setDefaultProviderIfMissingOrInvalid(next);

  const providerIds = Object.keys(next.providers.items).sort((a, b) => a.localeCompare(b));
  if (providerIds.length > 0) {
    const defaultProvider = await select({
      message: "Default provider",
      options: providerIds.map((id) => ({ value: id, label: id })),
      initialValue: next.providers.default && providerIds.includes(next.providers.default) ? next.providers.default : providerIds[0],
    });
    if (isCancel(defaultProvider)) {
      cancel("Configure cancelled.");
      throw new Error("Configure cancelled.");
    }
    next.providers.default = String(defaultProvider);
    next.routes.defaults.provider = String(defaultProvider);
  }

  Object.assign(config, next);
}

async function configureConnectorSection(config: RawGatewayConfig, context?: ConfigureSectionContext): Promise<void> {
  const next = ensureGatewayConfigShape(config);
  const connectorItems = next.connectors.items;

  const connectorChoices = Object.keys(connectorItems).sort((a, b) => a.localeCompare(b));
  const targetConnector = connectorChoices.length === 0
    ? "__new"
    : await select({
      message: "Select connector instance",
      options: [
        ...connectorChoices.map((id) => ({ value: id, label: id })),
        { value: "__new", label: "Create new connector instance" },
      ],
      initialValue: connectorChoices[0],
    });
  if (isCancel(targetConnector)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }

  const instanceId = String(targetConnector) === "__new"
    ? await requiredText("New connector instance ID", "discord.main")
    : String(targetConnector);
  const existing = connectorItems[instanceId];
  const contributionId = await requiredText(
    "Connector contribution ID",
    existing?.type ?? DISCORD_CONNECTOR_CONTRIBUTION_ID,
    DISCORD_CONNECTOR_CONTRIBUTION_ID,
  );

  let connectorConfig: Record<string, unknown> = {};
  const existingConfig = existing ? Object.fromEntries(Object.entries(existing).filter(([key]) => key !== "type")) : {};
  if (contributionId === DISCORD_CONNECTOR_CONTRIBUTION_ID) {
    const botName = await requiredText(
      "Discord botName",
      typeof existing?.botName === "string" ? existing.botName : DEFAULT_DISCORD_BOT_NAME,
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
    const existingBotToken = typeof existing?.botToken === "string" ? existing.botToken : "";
    const botToken = providedBotToken.length > 0 ? providedBotToken : existingBotToken;
    if (botToken.length === 0) {
      throw new Error("Discord botToken is required");
    }
    connectorConfig = {
      ...existingConfig,
      botName,
      botToken,
    };
  } else if (context?.schemaByContributionId?.has(contributionId)) {
    connectorConfig = await promptConfigFromSchema(
      context.schemaByContributionId.get(contributionId)!,
      existingConfig,
      { title: `Connector '${instanceId}' (${contributionId})` },
    );
  } else {
    const fallbackState = await noteSchemaFallback(contributionId, context);
    await confirmUnloadedSchemaFallback(contributionId, fallbackState);
    connectorConfig = await promptJsonObject("Connector config JSON", existingConfig);
  }

  upsertConnectorInstance(next, instanceId, contributionId, connectorConfig);
  Object.assign(config, next);
}

async function configureRouteSection(config: RawGatewayConfig): Promise<void> {
  const next = ensureGatewayConfigShape(config);
  const routeItems = next.routes.items;
  const routeChoices = Object.keys(routeItems).sort((a, b) => a.localeCompare(b));

  const targetRoute = routeChoices.length === 0
    ? "__new"
    : await select({
      message: "Select route",
      options: [
        ...routeChoices.map((id) => ({ value: id, label: id })),
        { value: "__new", label: "Create new route" },
      ],
      initialValue: routeChoices[0],
    });
  if (isCancel(targetRoute)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }

  const routeId = String(targetRoute) === "__new" ? await requiredText("New route ID", "main") : String(targetRoute);
  const existing = routeItems[routeId];

  const projectRoot = await requiredText("projectRoot", existing?.projectRoot ?? process.cwd());
  const tools = await select({
    message: "tools",
    options: [
      { value: "__default", label: `Use route default (${next.routes.defaults.tools ?? "full"})` },
      { value: "full", label: "full" },
      { value: "readonly", label: "readonly" },
    ],
    initialValue: existing?.tools ?? "__default",
  });
  if (isCancel(tools)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }

  const mentions = await select({
    message: "mentions",
    options: [
      { value: "__default", label: `Use route default (${next.routes.defaults.mentions ?? "required"})` },
      { value: "required", label: "required" },
      { value: "optional", label: "optional" },
    ],
    initialValue: existing?.mentions ?? "__default",
  });
  if (isCancel(mentions)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }

  const providerIds = Object.keys(next.providers.items).sort((a, b) => a.localeCompare(b));
  const providerValue = providerIds.length > 0
    ? await select({
      message: "provider",
      options: [
        { value: "__default", label: `Use route default (${(next.routes.defaults.provider ?? next.providers.default) || "(unset)"})` },
        ...providerIds.map((id) => ({ value: id, label: id })),
      ],
      initialValue: existing?.provider ?? "__default",
    })
    : "__default";
  if (isCancel(providerValue)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }

  const sandboxIds = ["host.builtin", ...Object.keys(next.sandboxes.items).sort((a, b) => a.localeCompare(b))];
  const sandboxValue = await select({
    message: "sandbox",
    options: [
      { value: "__default", label: `Use route default (${next.routes.defaults.sandbox ?? next.sandboxes.default})` },
      ...sandboxIds.map((id) => ({ value: id, label: id })),
    ],
    initialValue: existing?.sandbox ?? "__default",
  });
  if (isCancel(sandboxValue)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }

  const systemPromptFile = await optionalText("systemPromptFile (optional)", existing?.systemPromptFile ?? "");

  upsertRoute(next, routeId, {
    projectRoot,
    ...(tools !== "__default" ? { tools: String(tools) as "full" | "readonly" } : {}),
    ...(mentions !== "__default" ? { mentions: String(mentions) as "required" | "optional" } : {}),
    ...(providerValue !== "__default" ? { provider: String(providerValue) } : {}),
    ...(sandboxValue !== "__default" ? { sandbox: String(sandboxValue) } : {}),
    ...(systemPromptFile ? { systemPromptFile } : {}),
  });

  Object.assign(config, next);
}

async function configureBindingSection(config: RawGatewayConfig): Promise<void> {
  const next = ensureGatewayConfigShape(config);
  const bindingItems = next.bindings.items;
  const bindingChoices = Object.keys(bindingItems).sort((a, b) => a.localeCompare(b));

  if (Object.keys(next.connectors.items).length === 0) {
    throw new Error("No connectors found. Configure connectors first.");
  }
  if (Object.keys(next.routes.items).length === 0) {
    throw new Error("No routes found. Configure routes first.");
  }

  const targetBinding = bindingChoices.length === 0
    ? "__new"
    : await select({
      message: "Select binding",
      options: [
        ...bindingChoices.map((id) => ({ value: id, label: id })),
        { value: "__new", label: "Create new binding" },
      ],
      initialValue: bindingChoices[0],
    });
  if (isCancel(targetBinding)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }

  const bindingId = String(targetBinding) === "__new"
    ? await requiredText("New binding ID", "discord.main.main")
    : String(targetBinding);
  const existing = bindingItems[bindingId];

  const connectorIds = Object.keys(next.connectors.items).sort((a, b) => a.localeCompare(b));
  const connectorId = await select({
    message: "connector",
    options: connectorIds.map((id) => ({ value: id, label: id })),
    initialValue: existing?.connector && connectorIds.includes(existing.connector) ? existing.connector : connectorIds[0],
  });
  if (isCancel(connectorId)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }

  const sourceType = await select({
    message: "source.type",
    options: [
      { value: "channel", label: "channel" },
      { value: "chat", label: "chat" },
    ],
    initialValue: existing?.source.type ?? "channel",
  });
  if (isCancel(sourceType)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }

  const sourceId = await requiredText("source.id", existing?.source.id);
  const routeIds = Object.keys(next.routes.items).sort((a, b) => a.localeCompare(b));
  const routeId = await select({
    message: "route",
    options: routeIds.map((id) => ({ value: id, label: id })),
    initialValue: existing?.route && routeIds.includes(existing.route) ? existing.route : routeIds[0],
  });
  if (isCancel(routeId)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }

  const duplicate = Object.entries(next.bindings.items).find(([existingBindingId, binding]) =>
    existingBindingId !== bindingId
    && binding.connector === connectorId
    && binding.source.type === sourceType
    && binding.source.id === sourceId
  );
  if (duplicate) {
    throw new Error(
      `Binding source '${String(connectorId)}/${String(sourceType)}:${sourceId}' is already used by '${duplicate[0]}'`,
    );
  }

  upsertBinding(next, bindingId, {
    connector: String(connectorId),
    source: {
      type: String(sourceType) as "channel" | "chat",
      id: sourceId,
    },
    route: String(routeId),
  });

  Object.assign(config, next);
}

async function configureSandboxSection(config: RawGatewayConfig): Promise<void> {
  const next = ensureGatewayConfigShape(config);
  const sandboxIds = ["host.builtin", ...Object.keys(next.sandboxes.items).sort((a, b) => a.localeCompare(b))];

  const defaultSandbox = await select({
    message: "Default sandbox",
    options: sandboxIds.map((id) => ({ value: id, label: id })),
    initialValue: next.sandboxes.default && sandboxIds.includes(next.sandboxes.default) ? next.sandboxes.default : "host.builtin",
  });
  if (isCancel(defaultSandbox)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }

  next.sandboxes.default = String(defaultSandbox);
  next.routes.defaults.sandbox = String(defaultSandbox);
  Object.assign(config, next);
}

async function configureDataSection(config: RawGatewayConfig): Promise<void> {
  const next = ensureGatewayConfigShape(config);
  const rootDir = await requiredText("data.rootDir", next.data.rootDir);
  const dedupTtlMsRaw = await requiredText("data.dedupTtlMs", String(next.data.dedupTtlMs));
  const dedupTtlMs = Number.parseInt(dedupTtlMsRaw, 10);
  if (!Number.isFinite(dedupTtlMs) || dedupTtlMs <= 0) {
    throw new Error("data.dedupTtlMs must be a positive integer");
  }

  next.data = {
    ...next.data,
    rootDir,
    dedupTtlMs,
  };
  Object.assign(config, next);
}

export async function applyConfigureSection(
  section: ConfigureSection,
  config: RawGatewayConfig,
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
  if (section === "route") {
    await configureRouteSection(config);
    return;
  }
  if (section === "binding") {
    await configureBindingSection(config);
    return;
  }
  if (section === "sandbox") {
    await configureSandboxSection(config);
    return;
  }
  await configureDataSection(config);
}
