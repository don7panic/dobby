import type { ExtensionContributionManifest } from "../../core/types.js";
import type {
  ContributionInstanceTemplate,
  ContributionTemplatesByKind,
  NormalizedGatewayConfig,
  RawExtensionInstanceConfig,
  RawGatewayConfig,
  RawRouteProfile,
} from "./config-types.js";

const DEFAULT_DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Narrow type guard for plain object-like values.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalizes instance maps and drops malformed entries.
 */
function asInstanceMap(value: unknown): Record<string, RawExtensionInstanceConfig> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, RawExtensionInstanceConfig> = {};
  for (const [instanceId, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.contributionId !== "string" || raw.contributionId.trim().length === 0) {
      continue;
    }

    const rawConfig = isRecord(raw.config) ? raw.config : {};
    result[instanceId] = {
      contributionId: raw.contributionId,
      config: { ...rawConfig },
    };
  }

  return result;
}

/**
 * Normalizes extensions.allowList into package+enabled tuples.
 */
function asAllowList(value: unknown): Array<{ package: string; enabled: boolean }> {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: Array<{ package: string; enabled: boolean }> = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.package !== "string" || item.package.trim().length === 0) {
      continue;
    }

    normalized.push({
      package: item.package,
      enabled: item.enabled !== false,
    });
  }

  return normalized;
}

/**
 * Normalizes routing.routes and enforces safe defaults for optional fields.
 */
function asRoutes(value: unknown): Record<string, RawRouteProfile> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, RawRouteProfile> = {};
  for (const [routeId, route] of Object.entries(value)) {
    if (!isRecord(route) || typeof route.projectRoot !== "string" || route.projectRoot.trim().length === 0) {
      continue;
    }

    normalized[routeId] = {
      ...route,
      projectRoot: route.projectRoot,
      tools: route.tools === "readonly" ? "readonly" : "full",
      allowMentionsOnly: route.allowMentionsOnly !== false,
      maxConcurrentTurns:
        typeof route.maxConcurrentTurns === "number" && Number.isInteger(route.maxConcurrentTurns) && route.maxConcurrentTurns > 0
          ? route.maxConcurrentTurns
          : 1,
      ...(typeof route.providerId === "string" && route.providerId.trim().length > 0 ? { providerId: route.providerId } : {}),
      ...(typeof route.sandboxId === "string" && route.sandboxId.trim().length > 0 ? { sandboxId: route.sandboxId } : {}),
      ...(typeof route.systemPromptFile === "string" ? { systemPromptFile: route.systemPromptFile } : {}),
    };
  }

  return normalized;
}

/**
 * Normalizes partial/raw gateway config into a fully-shaped mutable object.
 */
export function ensureGatewayConfigShape(config: RawGatewayConfig): NormalizedGatewayConfig {
  const normalized: NormalizedGatewayConfig = {
    ...config,
    extensions: {
      ...((isRecord(config.extensions) ? config.extensions : {}) as Record<string, unknown>),
      allowList: asAllowList(config.extensions?.allowList),
    },
    providers: {
      ...((isRecord(config.providers) ? config.providers : {}) as Record<string, unknown>),
      defaultProviderId:
        typeof config.providers?.defaultProviderId === "string" && config.providers.defaultProviderId.trim().length > 0
          ? config.providers.defaultProviderId
          : "",
      instances: asInstanceMap(config.providers?.instances),
    },
    connectors: {
      ...((isRecord(config.connectors) ? config.connectors : {}) as Record<string, unknown>),
      instances: asInstanceMap(config.connectors?.instances),
    },
    sandboxes: {
      ...((isRecord(config.sandboxes) ? config.sandboxes : {}) as Record<string, unknown>),
      defaultSandboxId:
        typeof config.sandboxes?.defaultSandboxId === "string" && config.sandboxes.defaultSandboxId.trim().length > 0
          ? config.sandboxes.defaultSandboxId
          : "host.builtin",
      instances: asInstanceMap(config.sandboxes?.instances),
    },
    routing: {
      ...((isRecord(config.routing) ? config.routing : {}) as Record<string, unknown>),
      ...(typeof config.routing?.defaultRouteId === "string" && config.routing.defaultRouteId.trim().length > 0
        ? { defaultRouteId: config.routing.defaultRouteId }
        : {}),
      routes: asRoutes(config.routing?.routes),
    },
    data: {
      ...((isRecord(config.data) ? config.data : {}) as Record<string, unknown>),
      rootDir: typeof config.data?.rootDir === "string" && config.data.rootDir.trim().length > 0 ? config.data.rootDir : "./data",
      dedupTtlMs:
        typeof config.data?.dedupTtlMs === "number" && Number.isFinite(config.data.dedupTtlMs) && config.data.dedupTtlMs > 0
          ? config.data.dedupTtlMs
          : DEFAULT_DEDUP_TTL_MS,
    },
  };

  return normalized;
}

/**
 * Upserts allowList entry for one package and controls enabled flag explicitly.
 */
export function upsertAllowListPackage(config: RawGatewayConfig, packageName: string, enabled = true): void {
  const next = ensureGatewayConfigShape(config);
  const allowList = next.extensions.allowList;
  const existing = allowList.find((item) => item.package === packageName);
  if (existing) {
    existing.enabled = enabled;
    config.extensions = next.extensions;
    return;
  }

  allowList.push({ package: packageName, enabled });
  config.extensions = {
    ...next.extensions,
    allowList,
  };
}

/**
 * Derives a default instance id from contribution id.
 */
function buildTemplateInstanceId(contributionId: string): string {
  const segments = contributionId.split(".");
  const suffix = segments.length > 1 ? segments.slice(1).join("-") : contributionId;
  return `${suffix}.main`;
}

/**
 * Converts contribution manifests into provider/connector/sandbox instance templates.
 */
export function buildContributionTemplates(contributions: ExtensionContributionManifest[]): ContributionTemplatesByKind {
  const templates: ContributionTemplatesByKind = {
    providers: [],
    connectors: [],
    sandboxes: [],
  };

  for (const contribution of contributions) {
    const template: ContributionInstanceTemplate = {
      id: buildTemplateInstanceId(contribution.id),
      contributionId: contribution.id,
      config: {},
    };

    if (contribution.kind === "provider") {
      templates.providers.push(template);
      continue;
    }

    if (contribution.kind === "connector") {
      templates.connectors.push(template);
      continue;
    }

    templates.sandboxes.push(template);
  }

  return templates;
}

/**
 * Adds template instances when contribution ids are not yet represented in current instances.
 */
function upsertTemplateInstances(
  instances: Record<string, RawExtensionInstanceConfig>,
  templates: ContributionInstanceTemplate[],
): string[] {
  const byContributionId = new Set(Object.values(instances).map((instance) => instance.contributionId));
  const addedIds: string[] = [];

  for (const template of templates) {
    if (byContributionId.has(template.contributionId)) {
      continue;
    }

    let candidateId = template.id;
    let suffix = 2;
    while (instances[candidateId]) {
      candidateId = `${template.id}-${suffix}`;
      suffix += 1;
    }

    instances[candidateId] = {
      contributionId: template.contributionId,
      config: structuredClone(template.config),
    };
    byContributionId.add(template.contributionId);
    addedIds.push(candidateId);
  }

  return addedIds;
}

/**
 * Applies generated instance templates into config and returns newly created ids.
 */
export function applyContributionTemplates(config: RawGatewayConfig, templates: ContributionTemplatesByKind): {
  providers: string[];
  connectors: string[];
  sandboxes: string[];
} {
  const next = ensureGatewayConfigShape(config);
  const providerInstances = next.providers.instances;
  const connectorInstances = next.connectors.instances;
  const sandboxInstances = next.sandboxes.instances;

  const added = {
    providers: upsertTemplateInstances(providerInstances, templates.providers),
    connectors: upsertTemplateInstances(connectorInstances, templates.connectors),
    sandboxes: upsertTemplateInstances(sandboxInstances, templates.sandboxes),
  };

  config.providers = {
    ...next.providers,
    instances: providerInstances,
  };
  config.connectors = {
    ...next.connectors,
    instances: connectorInstances,
  };
  config.sandboxes = {
    ...next.sandboxes,
    instances: sandboxInstances,
  };

  return added;
}

/**
 * Upserts one provider instance by id.
 */
export function upsertProviderInstance(
  config: RawGatewayConfig,
  instanceId: string,
  contributionId: string,
  instanceConfig: Record<string, unknown>,
): void {
  const next = ensureGatewayConfigShape(config);
  const instances = next.providers.instances;
  instances[instanceId] = {
    contributionId,
    config: structuredClone(instanceConfig),
  };
  config.providers = {
    ...next.providers,
    instances,
  };
}

/**
 * Upserts one connector instance by id.
 */
export function upsertConnectorInstance(
  config: RawGatewayConfig,
  instanceId: string,
  contributionId: string,
  instanceConfig: Record<string, unknown>,
): void {
  const next = ensureGatewayConfigShape(config);
  const instances = next.connectors.instances;
  instances[instanceId] = {
    contributionId,
    config: structuredClone(instanceConfig),
  };
  config.connectors = {
    ...next.connectors,
    instances,
  };
}

/**
 * Repairs missing/invalid default provider by choosing first lexicographic candidate.
 */
export function setDefaultProviderIfMissingOrInvalid(config: RawGatewayConfig): void {
  const next = ensureGatewayConfigShape(config);
  const instances = next.providers.instances;
  const defaultProviderId = next.providers.defaultProviderId;

  if (defaultProviderId && instances[defaultProviderId]) {
    config.providers = next.providers;
    return;
  }

  const candidates = Object.keys(instances).sort((a, b) => a.localeCompare(b));
  if (candidates.length === 0) {
    config.providers = next.providers;
    return;
  }

  config.providers = {
    ...next.providers,
    defaultProviderId: candidates[0]!,
    instances,
  };
}

/**
 * Upserts one route profile with conservative defaults for omitted fields.
 */
export function upsertRoute(config: RawGatewayConfig, routeId: string, profile: RawRouteProfile): void {
  const next = ensureGatewayConfigShape(config);
  const routes = next.routing.routes;

  routes[routeId] = {
    tools: "full",
    allowMentionsOnly: true,
    maxConcurrentTurns: 1,
    ...profile,
    projectRoot: profile.projectRoot,
  };

  config.routing = {
    ...next.routing,
    routes,
    ...(next.routing.defaultRouteId ? { defaultRouteId: next.routing.defaultRouteId } : {}),
  };
}

/**
 * Sets routing.defaultRouteId to a specific route id.
 */
export function setDefaultRoute(config: RawGatewayConfig, routeId: string): void {
  const next = ensureGatewayConfigShape(config);
  config.routing = {
    ...next.routing,
    defaultRouteId: routeId,
    routes: next.routing.routes,
  };
}

/**
 * Clears routing.defaultRouteId when the referenced route does not exist.
 */
export function clearInvalidDefaultRoute(config: RawGatewayConfig): boolean {
  const next = ensureGatewayConfigShape(config);
  const defaultRouteId = next.routing.defaultRouteId;
  const routes = next.routing.routes;

  if (!defaultRouteId || routes[defaultRouteId]) {
    config.routing = next.routing;
    return false;
  }

  const { defaultRouteId: _dropped, ...rest } = next.routing;
  config.routing = {
    ...rest,
    routes,
  };
  return true;
}

/**
 * Lists contribution ids referenced by configured provider/connector/sandbox instances.
 */
export function listContributionIds(config: RawGatewayConfig): {
  providers: string[];
  connectors: string[];
  sandboxes: string[];
} {
  const next = ensureGatewayConfigShape(config);

  return {
    providers: Object.values(next.providers?.instances ?? {}).map((instance) => instance.contributionId),
    connectors: Object.values(next.connectors?.instances ?? {}).map((instance) => instance.contributionId),
    sandboxes: Object.values(next.sandboxes?.instances ?? {}).map((instance) => instance.contributionId),
  };
}
