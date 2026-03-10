import type { ExtensionContributionManifest } from "../../core/types.js";
import type {
  ContributionInstanceTemplate,
  ContributionTemplatesByKind,
  NormalizedGatewayConfig,
  RawBindingConfig,
  RawDefaultBindingConfig,
  RawExtensionItemConfig,
  RawGatewayConfig,
  RawRouteDefaults,
  RawRouteProfile,
} from "./config-types.js";

const DEFAULT_DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asItemMap(value: unknown): Record<string, RawExtensionItemConfig> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, RawExtensionItemConfig> = {};
  for (const [instanceId, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.type !== "string" || raw.type.trim().length === 0) {
      continue;
    }

    result[instanceId] = {
      ...raw,
      type: raw.type,
    };
  }

  return result;
}

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

function asRouteDefaults(value: unknown): RawRouteDefaults {
  if (!isRecord(value)) {
    return {
      tools: "full",
      mentions: "required",
    };
  }

  return {
    ...(typeof value.projectRoot === "string" && value.projectRoot.trim().length > 0 ? { projectRoot: value.projectRoot } : {}),
    ...(typeof value.provider === "string" && value.provider.trim().length > 0 ? { provider: value.provider } : {}),
    ...(typeof value.sandbox === "string" && value.sandbox.trim().length > 0 ? { sandbox: value.sandbox } : {}),
    tools: value.tools === "readonly" ? "readonly" : "full",
    mentions: value.mentions === "optional" ? "optional" : "required",
  };
}

function asRoutes(value: unknown): Record<string, RawRouteProfile> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, RawRouteProfile> = {};
  for (const [routeId, route] of Object.entries(value)) {
    if (!isRecord(route)) {
      continue;
    }

    normalized[routeId] = {
      ...route,
      ...(typeof route.projectRoot === "string" && route.projectRoot.trim().length > 0 ? { projectRoot: route.projectRoot } : {}),
      ...(route.tools === "readonly" ? { tools: "readonly" as const } : {}),
      ...(route.mentions === "optional" ? { mentions: "optional" as const } : {}),
      ...(typeof route.provider === "string" && route.provider.trim().length > 0 ? { provider: route.provider } : {}),
      ...(typeof route.sandbox === "string" && route.sandbox.trim().length > 0 ? { sandbox: route.sandbox } : {}),
      ...(typeof route.systemPromptFile === "string" ? { systemPromptFile: route.systemPromptFile } : {}),
    };
  }

  return normalized;
}

function asDefaultBinding(value: unknown): RawDefaultBindingConfig | undefined {
  if (!isRecord(value) || typeof value.route !== "string" || value.route.trim().length === 0) {
    return undefined;
  }

  return {
    ...value,
    route: value.route,
  };
}

function asBindings(value: unknown): Record<string, RawBindingConfig> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, RawBindingConfig> = {};
  for (const [bindingId, binding] of Object.entries(value)) {
    if (!isRecord(binding)) {
      continue;
    }

    const rawSource = binding.source;
    if (
      typeof binding.connector !== "string"
      || binding.connector.trim().length === 0
      || typeof binding.route !== "string"
      || binding.route.trim().length === 0
      || !isRecord(rawSource)
      || (rawSource.type !== "channel" && rawSource.type !== "chat")
      || typeof rawSource.id !== "string"
      || rawSource.id.trim().length === 0
    ) {
      continue;
    }

    normalized[bindingId] = {
      ...binding,
      connector: binding.connector,
      route: binding.route,
      source: {
        ...rawSource,
        type: rawSource.type,
        id: rawSource.id,
      },
    };
  }

  return normalized;
}

export function ensureGatewayConfigShape(config: RawGatewayConfig): NormalizedGatewayConfig {
  const normalizedProvidersDefault =
    typeof config.providers?.default === "string" && config.providers.default.trim().length > 0
      ? config.providers.default
      : "";
  const normalizedSandboxesDefault =
    typeof config.sandboxes?.default === "string" && config.sandboxes.default.trim().length > 0
      ? config.sandboxes.default
      : "host.builtin";

  const routeDefaults = asRouteDefaults(config.routes?.defaults);
  if (!routeDefaults.provider && normalizedProvidersDefault) {
    routeDefaults.provider = normalizedProvidersDefault;
  }
  if (!routeDefaults.sandbox && normalizedSandboxesDefault) {
    routeDefaults.sandbox = normalizedSandboxesDefault;
  }

  const defaultBinding = asDefaultBinding(config.bindings?.default);

  return {
    ...config,
    extensions: {
      ...((isRecord(config.extensions) ? config.extensions : {}) as Record<string, unknown>),
      allowList: asAllowList(config.extensions?.allowList),
    },
    providers: {
      ...((isRecord(config.providers) ? config.providers : {}) as Record<string, unknown>),
      default: normalizedProvidersDefault,
      items: asItemMap(config.providers?.items),
    },
    connectors: {
      ...((isRecord(config.connectors) ? config.connectors : {}) as Record<string, unknown>),
      items: asItemMap(config.connectors?.items),
    },
    sandboxes: {
      ...((isRecord(config.sandboxes) ? config.sandboxes : {}) as Record<string, unknown>),
      default: normalizedSandboxesDefault,
      items: asItemMap(config.sandboxes?.items),
    },
    routes: {
      ...((isRecord(config.routes) ? config.routes : {}) as Record<string, unknown>),
      defaults: routeDefaults,
      items: asRoutes(config.routes?.items),
    },
    bindings: {
      ...((isRecord(config.bindings) ? config.bindings : {}) as Record<string, unknown>),
      ...(defaultBinding ? { default: defaultBinding } : {}),
      items: asBindings(config.bindings?.items),
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
}

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

function buildTemplateInstanceId(contributionId: string): string {
  const segments = contributionId.split(".");
  const suffix = segments.length > 1 ? segments.slice(1).join("-") : contributionId;
  return `${suffix}.main`;
}

export function buildContributionTemplates(contributions: ExtensionContributionManifest[]): ContributionTemplatesByKind {
  const templates: ContributionTemplatesByKind = {
    providers: [],
    connectors: [],
    sandboxes: [],
  };

  for (const contribution of contributions) {
    const template: ContributionInstanceTemplate = {
      id: buildTemplateInstanceId(contribution.id),
      type: contribution.id,
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

function upsertTemplateInstances(
  items: Record<string, RawExtensionItemConfig>,
  templates: ContributionInstanceTemplate[],
): string[] {
  const byType = new Set(Object.values(items).map((instance) => instance.type));
  const addedIds: string[] = [];

  for (const template of templates) {
    if (byType.has(template.type)) {
      continue;
    }

    let candidateId = template.id;
    let suffix = 2;
    while (items[candidateId]) {
      candidateId = `${template.id}-${suffix}`;
      suffix += 1;
    }

    items[candidateId] = {
      type: template.type,
      ...structuredClone(template.config),
    };
    byType.add(template.type);
    addedIds.push(candidateId);
  }

  return addedIds;
}

export function applyContributionTemplates(config: RawGatewayConfig, templates: ContributionTemplatesByKind): {
  providers: string[];
  connectors: string[];
  sandboxes: string[];
} {
  const next = ensureGatewayConfigShape(config);
  const providerItems = next.providers.items;
  const connectorItems = next.connectors.items;
  const sandboxItems = next.sandboxes.items;

  const added = {
    providers: upsertTemplateInstances(providerItems, templates.providers),
    connectors: upsertTemplateInstances(connectorItems, templates.connectors),
    sandboxes: upsertTemplateInstances(sandboxItems, templates.sandboxes),
  };

  config.providers = {
    ...next.providers,
    items: providerItems,
  };
  config.connectors = {
    ...next.connectors,
    items: connectorItems,
  };
  config.sandboxes = {
    ...next.sandboxes,
    items: sandboxItems,
  };

  return added;
}

export function upsertProviderInstance(
  config: RawGatewayConfig,
  instanceId: string,
  type: string,
  instanceConfig: Record<string, unknown>,
): void {
  const next = ensureGatewayConfigShape(config);
  next.providers.items[instanceId] = {
    type,
    ...structuredClone(instanceConfig),
  };
  config.providers = {
    ...next.providers,
    items: next.providers.items,
  };
}

export function upsertConnectorInstance(
  config: RawGatewayConfig,
  instanceId: string,
  type: string,
  instanceConfig: Record<string, unknown>,
): void {
  const next = ensureGatewayConfigShape(config);
  next.connectors.items[instanceId] = {
    type,
    ...structuredClone(instanceConfig),
  };
  config.connectors = {
    ...next.connectors,
    items: next.connectors.items,
  };
}

export function upsertSandboxInstance(
  config: RawGatewayConfig,
  instanceId: string,
  type: string,
  instanceConfig: Record<string, unknown>,
): void {
  const next = ensureGatewayConfigShape(config);
  next.sandboxes.items[instanceId] = {
    type,
    ...structuredClone(instanceConfig),
  };
  config.sandboxes = {
    ...next.sandboxes,
    items: next.sandboxes.items,
  };
}

export function setDefaultProviderIfMissingOrInvalid(config: RawGatewayConfig): void {
  const next = ensureGatewayConfigShape(config);
  const items = next.providers.items;
  const defaultProvider = next.providers.default;

  if (defaultProvider && items[defaultProvider]) {
    config.providers = next.providers;
    if (!next.routes.defaults.provider) {
      config.routes = {
        ...next.routes,
        defaults: {
          ...next.routes.defaults,
          provider: defaultProvider,
        },
      };
    }
    return;
  }

  const candidates = Object.keys(items).sort((a, b) => a.localeCompare(b));
  if (candidates.length === 0) {
    config.providers = next.providers;
    return;
  }

  config.providers = {
    ...next.providers,
    default: candidates[0]!,
    items,
  };
  config.routes = {
    ...next.routes,
    defaults: {
      ...next.routes.defaults,
      provider: candidates[0]!,
    },
  };
}

export function upsertRoute(config: RawGatewayConfig, routeId: string, profile: RawRouteProfile): void {
  const next = ensureGatewayConfigShape(config);
  next.routes.items[routeId] = {
    ...(typeof profile.projectRoot === "string" && profile.projectRoot.trim().length > 0 ? { projectRoot: profile.projectRoot } : {}),
    ...(profile.tools ? { tools: profile.tools } : {}),
    ...(profile.mentions ? { mentions: profile.mentions } : {}),
    ...(profile.provider ? { provider: profile.provider } : {}),
    ...(profile.sandbox ? { sandbox: profile.sandbox } : {}),
    ...(typeof profile.systemPromptFile === "string" ? { systemPromptFile: profile.systemPromptFile } : {}),
  };
  config.routes = {
    ...next.routes,
    items: next.routes.items,
  };
}

export function upsertBinding(config: RawGatewayConfig, bindingId: string, binding: RawBindingConfig): void {
  const next = ensureGatewayConfigShape(config);
  next.bindings.items[bindingId] = structuredClone(binding);
  config.bindings = {
    ...next.bindings,
    items: next.bindings.items,
  };
}

export function setDefaultBinding(config: RawGatewayConfig, binding: RawDefaultBindingConfig | undefined): void {
  const next = ensureGatewayConfigShape(config);
  const normalizedBinding = binding ? structuredClone(binding) : undefined;
  config.bindings = {
    ...next.bindings,
    ...(normalizedBinding ? { default: normalizedBinding } : {}),
    items: next.bindings.items,
  };

  if (!normalizedBinding) {
    delete config.bindings.default;
  }
}

export function listContributionIds(config: RawGatewayConfig): {
  providers: string[];
  connectors: string[];
  sandboxes: string[];
} {
  const next = ensureGatewayConfigShape(config);

  return {
    providers: Object.values(next.providers.items).map((instance) => instance.type),
    connectors: Object.values(next.connectors.items).map((instance) => instance.type),
    sandboxes: Object.values(next.sandboxes.items).map((instance) => instance.type),
  };
}
