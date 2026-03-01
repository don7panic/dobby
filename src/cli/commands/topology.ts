import { BUILTIN_HOST_SANDBOX_ID } from "../../core/types.js";
import {
  ensureGatewayConfigShape,
  setDefaultRoute,
  upsertRoute,
} from "../shared/config-mutators.js";
import {
  DISCORD_CONNECTOR_CONTRIBUTION_ID,
  normalizeDiscordBotChannelMap,
} from "../shared/discord-config.js";
import { requireRawConfig, resolveConfigPath, writeConfigWithValidation } from "../shared/config-io.js";
import type { RawGatewayConfig } from "../shared/config-types.js";

interface DiscordConnectorView {
  connectorId: string;
  contributionId: string;
  botName: string;
  hasToken: boolean;
  botChannelMap: Record<string, string>;
}

interface ChannelMappingView {
  connectorId: string;
  channelId: string;
  routeId: string;
  routeExists: boolean;
  projectRoot?: string;
}

interface RouteView {
  routeId: string;
  defaultRoute: boolean;
  projectRoot: string;
  tools: "full" | "readonly";
  allowMentionsOnly: boolean;
  providerId?: string;
  sandboxId?: string;
  mappedChannels: number;
}

/**
 * Lists configured connector instances and projects Discord-specific settings.
 */
function listDiscordConnectors(rawConfig: unknown): DiscordConnectorView[] {
  const normalized = ensureGatewayConfigShape(rawConfig as RawGatewayConfig);
  const items: DiscordConnectorView[] = [];

  for (const [connectorId, connector] of Object.entries(normalized.connectors.instances)) {
    if (connector.contributionId !== DISCORD_CONNECTOR_CONTRIBUTION_ID) {
      continue;
    }

    const botName = typeof connector.config?.botName === "string" ? connector.config.botName : "";
    const botToken = typeof connector.config?.botToken === "string" ? connector.config.botToken.trim() : "";
    items.push({
      connectorId,
      contributionId: connector.contributionId,
      botName,
      hasToken: botToken.length > 0,
      botChannelMap: normalizeDiscordBotChannelMap(connector.config?.botChannelMap),
    });
  }

  return items.sort((a, b) => a.connectorId.localeCompare(b.connectorId));
}

/**
 * Looks up one Discord connector instance and returns mutable normalized config.
 */
function getDiscordConnectorOrThrow(
  rawConfig: unknown,
  connectorId: string,
): {
  normalized: ReturnType<typeof ensureGatewayConfigShape>;
  connector: {
    contributionId: string;
    config: Record<string, unknown>;
  };
} {
  const normalized = ensureGatewayConfigShape(rawConfig as RawGatewayConfig);
  const connector = normalized.connectors.instances[connectorId];
  if (!connector) {
    throw new Error(`Connector instance '${connectorId}' not found`);
  }
  if (connector.contributionId !== DISCORD_CONNECTOR_CONTRIBUTION_ID) {
    throw new Error(
      `Connector '${connectorId}' uses contribution '${connector.contributionId}'. This command currently supports only '${DISCORD_CONNECTOR_CONTRIBUTION_ID}'.`,
    );
  }
  return {
    normalized,
    connector: {
      contributionId: connector.contributionId,
      config: connector.config ?? {},
    },
  };
}

/**
 * Aggregates channel->route mappings across Discord connectors.
 */
function listChannelMappings(rawConfig: unknown, connectorFilter?: string): ChannelMappingView[] {
  const normalized = ensureGatewayConfigShape(rawConfig as RawGatewayConfig);
  const routes = normalized.routing.routes;
  const connectors = listDiscordConnectors(normalized)
    .filter((item) => !connectorFilter || item.connectorId === connectorFilter);

  const items: ChannelMappingView[] = [];
  for (const connector of connectors) {
    for (const [channelId, routeId] of Object.entries(connector.botChannelMap)) {
      const route = routes[routeId];
      items.push({
        connectorId: connector.connectorId,
        channelId,
        routeId,
        routeExists: Boolean(route),
        ...(route ? { projectRoot: route.projectRoot } : {}),
      });
    }
  }

  return items.sort((a, b) => {
    const connectorCompare = a.connectorId.localeCompare(b.connectorId);
    if (connectorCompare !== 0) {
      return connectorCompare;
    }
    return a.channelId.localeCompare(b.channelId);
  });
}

/**
 * Counts mapped Discord channels for each route id.
 */
function buildRouteChannelCounts(rawConfig: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  for (const mapping of listChannelMappings(rawConfig)) {
    counts.set(mapping.routeId, (counts.get(mapping.routeId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Lists routes with selected runtime-affecting properties.
 */
function listRoutes(rawConfig: unknown): RouteView[] {
  const normalized = ensureGatewayConfigShape(rawConfig as RawGatewayConfig);
  const counts = buildRouteChannelCounts(normalized);

  return Object.entries(normalized.routing.routes)
    .map(([routeId, route]): RouteView => ({
      routeId,
      defaultRoute: normalized.routing.defaultRouteId === routeId,
      projectRoot: route.projectRoot,
      tools: route.tools === "readonly" ? "readonly" : "full",
      allowMentionsOnly: route.allowMentionsOnly !== false,
      ...(route.providerId ? { providerId: route.providerId } : {}),
      ...(route.sandboxId ? { sandboxId: route.sandboxId } : {}),
      mappedChannels: counts.get(routeId) ?? 0,
    }))
    .sort((a, b) => a.routeId.localeCompare(b.routeId));
}

/**
 * Writes updated normalized config with validation+backup.
 */
async function saveConfig(configPath: string, normalized: ReturnType<typeof ensureGatewayConfigShape>): Promise<void> {
  await writeConfigWithValidation(configPath, normalized, {
    validate: true,
    createBackup: true,
  });
}

/**
 * Lists configured bot connectors in a human-friendly view.
 */
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
      `- ${bot.connectorId}: botName='${bot.botName || "(empty)"}', token=${bot.hasToken ? "set" : "missing"}, mappedChannels=${Object.keys(bot.botChannelMap).length}`,
    );
  }
}

/**
 * Updates botName and/or botToken for one Discord connector instance.
 */
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

  const currentMap = normalizeDiscordBotChannelMap(connector.config.botChannelMap);
  const currentName = typeof connector.config.botName === "string" ? connector.config.botName : "";
  const currentToken = typeof connector.config.botToken === "string" ? connector.config.botToken : "";

  normalized.connectors.instances[options.connectorId] = {
    contributionId: connector.contributionId,
    config: {
      ...connector.config,
      botName: nextName ?? currentName,
      botToken: nextToken ?? currentToken,
      botChannelMap: currentMap,
    },
  };

  await saveConfig(configPath, normalized);
  console.log(`Updated bot settings for connector '${options.connectorId}'`);
}

/**
 * Lists channel->route mappings for one connector or all Discord connectors.
 */
export async function runChannelListCommand(options: {
  connectorId?: string;
  json?: boolean;
}): Promise<void> {
  const configPath = resolveConfigPath();
  const rawConfig = await requireRawConfig(configPath);
  const mappings = listChannelMappings(rawConfig, options.connectorId);

  if (options.connectorId) {
    const connectors = listDiscordConnectors(rawConfig);
    const found = connectors.some((item) => item.connectorId === options.connectorId);
    if (!found) {
      throw new Error(`Discord connector '${options.connectorId}' not found`);
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ configPath, mappings }, null, 2));
    return;
  }

  if (mappings.length === 0) {
    console.log("No channel mappings configured.");
    return;
  }

  console.log(`Channel mappings (${configPath}):`);
  for (const item of mappings) {
    const routeSuffix = item.routeExists ? "" : " [missing route]";
    const projectSuffix = item.projectRoot ? ` (${item.projectRoot})` : "";
    console.log(`- ${item.connectorId}: ${item.channelId} -> ${item.routeId}${routeSuffix}${projectSuffix}`);
  }
}

/**
 * Creates or updates one channel mapping on a Discord connector.
 */
export async function runChannelSetCommand(options: {
  connectorId: string;
  channelId: string;
  routeId: string;
}): Promise<void> {
  const configPath = resolveConfigPath();
  const rawConfig = await requireRawConfig(configPath);
  const { normalized, connector } = getDiscordConnectorOrThrow(rawConfig, options.connectorId);

  if (!normalized.routing.routes[options.routeId]) {
    throw new Error(`Route '${options.routeId}' does not exist`);
  }

  const currentMap = normalizeDiscordBotChannelMap(connector.config.botChannelMap);
  currentMap[options.channelId] = options.routeId;

  normalized.connectors.instances[options.connectorId] = {
    contributionId: connector.contributionId,
    config: {
      ...connector.config,
      botChannelMap: currentMap,
    },
  };

  await saveConfig(configPath, normalized);
  console.log(`Mapped channel '${options.channelId}' -> route '${options.routeId}' on connector '${options.connectorId}'`);
}

/**
 * Removes one channel mapping from a Discord connector.
 */
export async function runChannelUnsetCommand(options: {
  connectorId: string;
  channelId: string;
}): Promise<void> {
  const configPath = resolveConfigPath();
  const rawConfig = await requireRawConfig(configPath);
  const { normalized, connector } = getDiscordConnectorOrThrow(rawConfig, options.connectorId);

  const currentMap = normalizeDiscordBotChannelMap(connector.config.botChannelMap);
  if (!Object.prototype.hasOwnProperty.call(currentMap, options.channelId)) {
    throw new Error(`Channel '${options.channelId}' is not mapped on connector '${options.connectorId}'`);
  }

  delete currentMap[options.channelId];

  normalized.connectors.instances[options.connectorId] = {
    contributionId: connector.contributionId,
    config: {
      ...connector.config,
      botChannelMap: currentMap,
    },
  };

  await saveConfig(configPath, normalized);
  console.log(`Removed mapping for channel '${options.channelId}' on connector '${options.connectorId}'`);
}

/**
 * Lists route profiles with project/provider/sandbox and channel usage counts.
 */
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
    const defaultMarker = route.defaultRoute ? " [default]" : "";
    const providerInfo = route.providerId ? route.providerId : "(default provider)";
    const sandboxInfo = route.sandboxId ? route.sandboxId : BUILTIN_HOST_SANDBOX_ID;
    const mentionsInfo = route.allowMentionsOnly ? "mentions-only" : "all-messages";
    console.log(
      `- ${route.routeId}${defaultMarker}: ${route.projectRoot}, tools=${route.tools}, provider=${providerInfo}, sandbox=${sandboxInfo}, mode=${mentionsInfo}, channels=${route.mappedChannels}`,
    );
  }
}

/**
 * Creates or updates one route profile with explicit fields.
 */
export async function runRouteSetCommand(options: {
  routeId: string;
  projectRoot?: string;
  tools?: string;
  providerId?: string;
  sandboxId?: string;
  allowMentionsOnly?: boolean;
  setAsDefault?: boolean;
}): Promise<void> {
  const configPath = resolveConfigPath();
  const rawConfig = await requireRawConfig(configPath);
  const normalized = ensureGatewayConfigShape(structuredClone(rawConfig));
  const existing = normalized.routing.routes[options.routeId];

  const projectRoot = options.projectRoot?.trim() || existing?.projectRoot;
  if (!projectRoot) {
    throw new Error("--project-root is required when creating a new route");
  }

  const toolsRaw = options.tools ?? existing?.tools ?? "full";
  if (toolsRaw !== "full" && toolsRaw !== "readonly") {
    throw new Error(`Invalid --tools '${toolsRaw}'. Allowed: full, readonly`);
  }

  const providerId = options.providerId ?? existing?.providerId;
  if (providerId && !normalized.providers.instances[providerId]) {
    throw new Error(`Provider '${providerId}' does not exist`);
  }

  const sandboxId = options.sandboxId ?? existing?.sandboxId ?? BUILTIN_HOST_SANDBOX_ID;
  if (sandboxId !== BUILTIN_HOST_SANDBOX_ID && !normalized.sandboxes.instances[sandboxId]) {
    throw new Error(`Sandbox '${sandboxId}' does not exist`);
  }

  const allowMentionsOnly = options.allowMentionsOnly ?? (existing?.allowMentionsOnly !== false);

  upsertRoute(normalized, options.routeId, {
    projectRoot,
    tools: toolsRaw,
    allowMentionsOnly,
    maxConcurrentTurns:
      typeof existing?.maxConcurrentTurns === "number" && existing.maxConcurrentTurns > 0
        ? existing.maxConcurrentTurns
        : 1,
    ...(providerId ? { providerId } : {}),
    ...(sandboxId ? { sandboxId } : {}),
    ...(typeof existing?.systemPromptFile === "string" ? { systemPromptFile: existing.systemPromptFile } : {}),
  });

  if (options.setAsDefault) {
    setDefaultRoute(normalized, options.routeId);
  }

  await saveConfig(configPath, normalized);
  console.log(`Upserted route '${options.routeId}'`);
}

/**
 * Removes one route, optionally cascading Discord channel mappings.
 */
export async function runRouteRemoveCommand(options: {
  routeId: string;
  cascadeChannelMaps?: boolean;
}): Promise<void> {
  const configPath = resolveConfigPath();
  const rawConfig = await requireRawConfig(configPath);
  const normalized = ensureGatewayConfigShape(structuredClone(rawConfig));

  if (!normalized.routing.routes[options.routeId]) {
    throw new Error(`Route '${options.routeId}' not found`);
  }

  const mappingRefs = listChannelMappings(normalized).filter((item) => item.routeId === options.routeId);
  if (mappingRefs.length > 0 && !options.cascadeChannelMaps) {
    const refList = mappingRefs.map((item) => `${item.connectorId}:${item.channelId}`).join(", ");
    throw new Error(
      `Route '${options.routeId}' is referenced by channel mappings (${refList}). Re-run with --cascade-channel-maps to remove these mappings automatically.`,
    );
  }

  if (mappingRefs.length > 0 && options.cascadeChannelMaps) {
    const refsByConnector = new Map<string, string[]>();
    for (const item of mappingRefs) {
      refsByConnector.set(item.connectorId, [...(refsByConnector.get(item.connectorId) ?? []), item.channelId]);
    }

    for (const [connectorId, channels] of refsByConnector.entries()) {
      const connector = normalized.connectors.instances[connectorId];
      if (!connector || connector.contributionId !== DISCORD_CONNECTOR_CONTRIBUTION_ID) {
        continue;
      }

      const nextMap = normalizeDiscordBotChannelMap(connector.config?.botChannelMap);
      for (const channelId of channels) {
        delete nextMap[channelId];
      }

      normalized.connectors.instances[connectorId] = {
        contributionId: connector.contributionId,
        config: {
          ...connector.config,
          botChannelMap: nextMap,
        },
      };
    }
  }

  delete normalized.routing.routes[options.routeId];
  if (normalized.routing.defaultRouteId === options.routeId) {
    const { defaultRouteId: _removedDefaultRoute, ...rest } = normalized.routing;
    normalized.routing = {
      ...rest,
      routes: normalized.routing.routes,
    };
  }

  await saveConfig(configPath, normalized);
  console.log(`Removed route '${options.routeId}'`);
}
