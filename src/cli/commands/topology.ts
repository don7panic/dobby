import { BUILTIN_HOST_SANDBOX_ID } from "../../core/types.js";
import {
  ensureGatewayConfigShape,
  upsertBinding,
  upsertRoute,
} from "../shared/config-mutators.js";
import { DISCORD_CONNECTOR_CONTRIBUTION_ID } from "../shared/discord-config.js";
import { requireRawConfig, resolveConfigPath, writeConfigWithValidation } from "../shared/config-io.js";
import type { RawBindingConfig, RawGatewayConfig } from "../shared/config-types.js";

interface DiscordConnectorView {
  connectorId: string;
  type: string;
  botName: string;
  hasToken: boolean;
}

interface BindingView {
  bindingId: string;
  connectorId: string;
  sourceType: string;
  sourceId: string;
  routeId: string;
  routeExists: boolean;
  projectRoot?: string;
}

interface RouteView {
  routeId: string;
  projectRoot: string;
  tools: "full" | "readonly";
  mentions: "required" | "optional";
  provider?: string;
  sandbox?: string;
  bindings: number;
}

function effectiveRouteProjectRoot(
  normalized: ReturnType<typeof ensureGatewayConfigShape>,
  routeId: string,
): string | undefined {
  const route = normalized.routes.items[routeId];
  if (!route) {
    return undefined;
  }

  return route.projectRoot ?? normalized.routes.defaults.projectRoot;
}

function listDiscordConnectors(rawConfig: unknown): DiscordConnectorView[] {
  const normalized = ensureGatewayConfigShape(rawConfig as RawGatewayConfig);
  const items: DiscordConnectorView[] = [];

  for (const [connectorId, connector] of Object.entries(normalized.connectors.items)) {
    if (connector.type !== DISCORD_CONNECTOR_CONTRIBUTION_ID) {
      continue;
    }

    const botName = typeof connector.botName === "string" ? connector.botName : "";
    const botToken = typeof connector.botToken === "string" ? connector.botToken.trim() : "";
    items.push({
      connectorId,
      type: connector.type,
      botName,
      hasToken: botToken.length > 0,
    });
  }

  return items.sort((a, b) => a.connectorId.localeCompare(b.connectorId));
}

function getDiscordConnectorOrThrow(
  rawConfig: unknown,
  connectorId: string,
): {
  normalized: ReturnType<typeof ensureGatewayConfigShape>;
  connector: Record<string, unknown> & { type: string };
} {
  const normalized = ensureGatewayConfigShape(rawConfig as RawGatewayConfig);
  const connector = normalized.connectors.items[connectorId];
  if (!connector) {
    throw new Error(`Connector instance '${connectorId}' not found`);
  }
  if (connector.type !== DISCORD_CONNECTOR_CONTRIBUTION_ID) {
    throw new Error(
      `Connector '${connectorId}' uses contribution '${connector.type}'. This command currently supports only '${DISCORD_CONNECTOR_CONTRIBUTION_ID}'.`,
    );
  }
  return {
    normalized,
    connector,
  };
}

function listBindings(rawConfig: unknown, connectorFilter?: string): BindingView[] {
  const normalized = ensureGatewayConfigShape(rawConfig as RawGatewayConfig);
  const bindings: BindingView[] = Object.entries(normalized.bindings.items)
    .filter(([, binding]) => !connectorFilter || binding.connector === connectorFilter)
    .map(([bindingId, binding]) => {
      const route = normalized.routes.items[binding.route];
      const projectRoot = route ? effectiveRouteProjectRoot(normalized, binding.route) : undefined;
      return {
        bindingId,
        connectorId: binding.connector,
        sourceType: binding.source.type,
        sourceId: binding.source.id,
        routeId: binding.route,
        routeExists: Boolean(route),
        ...(projectRoot ? { projectRoot } : {}),
      };
    });

  if (!connectorFilter && normalized.bindings.default) {
    const projectRoot = effectiveRouteProjectRoot(normalized, normalized.bindings.default.route);
    bindings.push({
      bindingId: "bindings.default",
      connectorId: "*",
      sourceType: "direct_message",
      sourceId: "*",
      routeId: normalized.bindings.default.route,
      routeExists: Boolean(normalized.routes.items[normalized.bindings.default.route]),
      ...(projectRoot ? { projectRoot } : {}),
    });
  }

  return bindings.sort((a, b) => a.bindingId.localeCompare(b.bindingId));
}

function buildRouteBindingCounts(rawConfig: unknown): Map<string, number> {
  const normalized = ensureGatewayConfigShape(rawConfig as RawGatewayConfig);
  const counts = new Map<string, number>();
  for (const binding of listBindings(normalized)) {
    counts.set(binding.routeId, (counts.get(binding.routeId) ?? 0) + 1);
  }
  return counts;
}

function listRoutes(rawConfig: unknown): RouteView[] {
  const normalized = ensureGatewayConfigShape(rawConfig as RawGatewayConfig);
  const counts = buildRouteBindingCounts(normalized);

  return Object.entries(normalized.routes.items)
    .map(([routeId, route]): RouteView => ({
      routeId,
      projectRoot: effectiveRouteProjectRoot(normalized, routeId) ?? "(unset)",
      tools: route.tools === "readonly" ? "readonly" : "full",
      mentions: route.mentions === "optional" ? "optional" : "required",
      ...(route.provider ? { provider: route.provider } : {}),
      ...(route.sandbox ? { sandbox: route.sandbox } : {}),
      bindings: counts.get(routeId) ?? 0,
    }))
    .sort((a, b) => a.routeId.localeCompare(b.routeId));
}

async function saveConfig(configPath: string, normalized: ReturnType<typeof ensureGatewayConfigShape>): Promise<void> {
  await writeConfigWithValidation(configPath, normalized, {
    validate: true,
    createBackup: true,
  });
}

export async function runBotListCommand(options: {
  json?: boolean;
}): Promise<void> {
  const configPath = resolveConfigPath();
  const rawConfig = await requireRawConfig(configPath);
  const bots = listDiscordConnectors(rawConfig);

  if (options.json) {
    console.log(JSON.stringify({ configPath, bots }, null, 2));
    return;
  }

  if (bots.length === 0) {
    console.log("No Discord connector instances configured.");
    return;
  }

  console.log(`Bots (${configPath}):`);
  for (const bot of bots) {
    console.log(
      `- ${bot.connectorId}: botName='${bot.botName || "(empty)"}', token=${bot.hasToken ? "set" : "missing"}`,
    );
  }
}

export async function runBotSetCommand(options: {
  connectorId: string;
  name?: string;
  token?: string;
}): Promise<void> {
  const configPath = resolveConfigPath();
  const rawConfig = await requireRawConfig(configPath);
  const { normalized, connector } = getDiscordConnectorOrThrow(rawConfig, options.connectorId);

  const nextName = typeof options.name === "string" ? options.name.trim() : undefined;
  const nextToken = typeof options.token === "string" ? options.token.trim() : undefined;
  if (!nextName && !nextToken) {
    throw new Error("At least one of --name or --token must be provided");
  }

  normalized.connectors.items[options.connectorId] = {
    ...connector,
    ...(nextName !== undefined ? { botName: nextName } : {}),
    ...(nextToken !== undefined ? { botToken: nextToken } : {}),
  };

  await saveConfig(configPath, normalized);
  console.log(`Updated bot settings for connector '${options.connectorId}'`);
}

export async function runBindingListCommand(options: {
  connectorId?: string;
  json?: boolean;
}): Promise<void> {
  const configPath = resolveConfigPath();
  const rawConfig = await requireRawConfig(configPath);
  const bindings = listBindings(rawConfig, options.connectorId);

  if (options.connectorId) {
    const normalized = ensureGatewayConfigShape(rawConfig);
    if (!normalized.connectors.items[options.connectorId]) {
      throw new Error(`Connector '${options.connectorId}' not found`);
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ configPath, bindings }, null, 2));
    return;
  }

  if (bindings.length === 0) {
    console.log("No bindings configured.");
    return;
  }

  console.log(`Bindings (${configPath}):`);
  for (const binding of bindings) {
    const routeSuffix = binding.routeExists ? "" : " [missing route]";
    const projectSuffix = binding.projectRoot ? ` (${binding.projectRoot})` : "";
    console.log(
      `- ${binding.bindingId}: ${binding.connectorId}/${binding.sourceType}:${binding.sourceId} -> ${binding.routeId}${routeSuffix}${projectSuffix}`,
    );
  }
}

export async function runBindingSetCommand(options: {
  bindingId: string;
  connectorId: string;
  routeId: string;
  sourceType: "channel" | "chat";
  sourceId: string;
}): Promise<void> {
  const configPath = resolveConfigPath();
  const rawConfig = await requireRawConfig(configPath);
  const normalized = ensureGatewayConfigShape(structuredClone(rawConfig));

  if (!normalized.connectors.items[options.connectorId]) {
    throw new Error(`Connector '${options.connectorId}' does not exist`);
  }
  if (!normalized.routes.items[options.routeId]) {
    throw new Error(`Route '${options.routeId}' does not exist`);
  }

  const duplicate = Object.entries(normalized.bindings.items).find(([bindingId, binding]) =>
    bindingId !== options.bindingId
    && binding.connector === options.connectorId
    && binding.source.type === options.sourceType
    && binding.source.id === options.sourceId
  );
  if (duplicate) {
    throw new Error(
      `Binding source '${options.connectorId}/${options.sourceType}:${options.sourceId}' is already used by '${duplicate[0]}'`,
    );
  }

  const binding: RawBindingConfig = {
    connector: options.connectorId,
    source: {
      type: options.sourceType,
      id: options.sourceId,
    },
    route: options.routeId,
  };
  upsertBinding(normalized, options.bindingId, binding);

  await saveConfig(configPath, normalized);
  console.log(`Upserted binding '${options.bindingId}'`);
}

export async function runBindingRemoveCommand(options: {
  bindingId: string;
}): Promise<void> {
  const configPath = resolveConfigPath();
  const rawConfig = await requireRawConfig(configPath);
  const normalized = ensureGatewayConfigShape(structuredClone(rawConfig));

  if (!normalized.bindings.items[options.bindingId]) {
    throw new Error(`Binding '${options.bindingId}' not found`);
  }

  delete normalized.bindings.items[options.bindingId];
  await saveConfig(configPath, normalized);
  console.log(`Removed binding '${options.bindingId}'`);
}

export async function runRouteListCommand(options: {
  json?: boolean;
}): Promise<void> {
  const configPath = resolveConfigPath();
  const rawConfig = await requireRawConfig(configPath);
  const routes = listRoutes(rawConfig);

  if (options.json) {
    console.log(JSON.stringify({ configPath, routes }, null, 2));
    return;
  }

  if (routes.length === 0) {
    console.log("No routes configured.");
    return;
  }

  console.log(`Routes (${configPath}):`);
  for (const route of routes) {
    const providerInfo = route.provider ? route.provider : "(route default)";
    const sandboxInfo = route.sandbox ? route.sandbox : BUILTIN_HOST_SANDBOX_ID;
    console.log(
      `- ${route.routeId}: ${route.projectRoot}, tools=${route.tools}, mentions=${route.mentions}, provider=${providerInfo}, sandbox=${sandboxInfo}, bindings=${route.bindings}`,
    );
  }
}

export async function runRouteSetCommand(options: {
  routeId: string;
  projectRoot?: string;
  tools?: string;
  providerId?: string;
  sandboxId?: string;
  mentions?: "required" | "optional";
}): Promise<void> {
  const configPath = resolveConfigPath();
  const rawConfig = await requireRawConfig(configPath);
  const normalized = ensureGatewayConfigShape(structuredClone(rawConfig));
  const existing = normalized.routes.items[options.routeId];

  const projectRoot = options.projectRoot?.trim() || existing?.projectRoot;
  if (!projectRoot && !normalized.routes.defaults.projectRoot) {
    throw new Error("--project-root is required when creating a new route");
  }

  const toolsRaw = options.tools ?? existing?.tools;
  if (toolsRaw !== undefined && toolsRaw !== "full" && toolsRaw !== "readonly") {
    throw new Error(`Invalid --tools '${toolsRaw}'. Allowed: full, readonly`);
  }

  const provider = options.providerId ?? existing?.provider;
  if (provider && !normalized.providers.items[provider]) {
    throw new Error(`Provider '${provider}' does not exist`);
  }

  const sandbox = options.sandboxId ?? existing?.sandbox;
  if (sandbox && sandbox !== BUILTIN_HOST_SANDBOX_ID && !normalized.sandboxes.items[sandbox]) {
    throw new Error(`Sandbox '${sandbox}' does not exist`);
  }

  upsertRoute(normalized, options.routeId, {
    ...(projectRoot ? { projectRoot } : {}),
    ...(toolsRaw ? { tools: toolsRaw } : {}),
    ...((options.mentions ?? existing?.mentions) ? { mentions: (options.mentions ?? existing?.mentions)! } : {}),
    ...(provider ? { provider } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(typeof existing?.systemPromptFile === "string" ? { systemPromptFile: existing.systemPromptFile } : {}),
  });

  await saveConfig(configPath, normalized);
  console.log(`Upserted route '${options.routeId}'`);
}

export async function runRouteRemoveCommand(options: {
  routeId: string;
  cascadeBindings?: boolean;
}): Promise<void> {
  const configPath = resolveConfigPath();
  const rawConfig = await requireRawConfig(configPath);
  const normalized = ensureGatewayConfigShape(structuredClone(rawConfig));

  if (!normalized.routes.items[options.routeId]) {
    throw new Error(`Route '${options.routeId}' not found`);
  }

  const bindingRefs = listBindings(normalized).filter(
    (binding) => binding.routeId === options.routeId && binding.bindingId !== "bindings.default",
  );
  const hasDefaultBindingRef = normalized.bindings.default?.route === options.routeId;
  if ((bindingRefs.length > 0 || hasDefaultBindingRef) && !options.cascadeBindings) {
    const refList = bindingRefs.map((binding) => binding.bindingId).join(", ");
    throw new Error(
      `Route '${options.routeId}' is referenced by bindings (${[refList, hasDefaultBindingRef ? "bindings.default" : ""].filter(Boolean).join(", ")}). Re-run with --cascade-bindings to remove these bindings automatically.`,
    );
  }

  if (options.cascadeBindings) {
    for (const binding of bindingRefs) {
      delete normalized.bindings.items[binding.bindingId];
    }
    if (hasDefaultBindingRef) {
      delete normalized.bindings.default;
    }
  }

  delete normalized.routes.items[options.routeId];
  await saveConfig(configPath, normalized);
  console.log(`Removed route '${options.routeId}'`);
}
