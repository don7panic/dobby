import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { BUILTIN_HOST_SANDBOX_ID } from "./types.js";
import type {
  BindingConfig,
  BindingResolution,
  BindingSource,
  ConnectorsConfig,
  ExtensionInstanceConfig,
  ExtensionsConfig,
  GatewayConfig,
  ProvidersConfig,
  RouteDefaultsConfig,
  RouteProfile,
  RouteResolution,
  RoutesConfig,
  SandboxesConfig,
} from "./types.js";

const extensionItemSchema = z.object({
  type: z.string().trim().min(1),
}).catchall(z.unknown());

const routeDefaultsSchema = z.object({
  provider: z.string().trim().min(1).optional(),
  sandbox: z.string().trim().min(1).optional(),
  tools: z.enum(["full", "readonly"]).optional(),
  mentions: z.enum(["required", "optional"]).optional(),
}).strict();

const routeItemSchema = z.object({
  projectRoot: z.string().trim().min(1),
  tools: z.enum(["full", "readonly"]).optional(),
  mentions: z.enum(["required", "optional"]).optional(),
  provider: z.string().trim().min(1).optional(),
  sandbox: z.string().trim().min(1).optional(),
  systemPromptFile: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
}).strict();

const bindingSourceSchema = z.object({
  type: z.enum(["channel", "chat"]),
  id: z.string().trim().min(1),
}).strict();

const bindingItemSchema = z.object({
  connector: z.string().trim().min(1),
  source: bindingSourceSchema,
  route: z.string().trim().min(1),
}).strict();

const gatewayConfigSchema = z.object({
  extensions: z.object({
    allowList: z
      .array(
        z.object({
          package: z.string().trim().min(1),
          enabled: z.boolean().default(true),
        }).strict(),
      )
      .default([]),
  }).strict(),
  providers: z.object({
    default: z.string().trim().min(1),
    items: z.record(z.string(), extensionItemSchema),
  }).strict(),
  connectors: z.object({
    items: z.record(z.string(), extensionItemSchema),
  }).strict(),
  sandboxes: z.object({
    default: z.string().trim().min(1).optional(),
    items: z.record(z.string(), extensionItemSchema).default({}),
  }).strict(),
  routes: z.object({
    defaults: routeDefaultsSchema.default({}),
    items: z.record(z.string(), routeItemSchema),
  }).strict(),
  bindings: z.object({
    items: z.record(z.string(), bindingItemSchema).default({}),
  }).strict(),
  data: z.object({
    rootDir: z.string().default("./data"),
    dedupTtlMs: z.number().int().positive().default(7 * 24 * 60 * 60 * 1000),
  }).strict(),
}).strict();

type ParsedGatewayConfig = z.infer<typeof gatewayConfigSchema>;
type ParsedRouteItem = z.infer<typeof routeItemSchema>;
type ParsedExtensionItem = z.infer<typeof extensionItemSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveMaybeAbsolute(baseDir: string, value: string): string {
  const expanded = expandHome(value);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return resolve(homedir(), value.slice(2));
  }

  return value;
}

function normalizeInstanceItem(item: ParsedExtensionItem): ExtensionInstanceConfig {
  const { type, ...config } = item;
  return {
    type,
    config,
  };
}

function normalizeInstances(parsedItems: Record<string, ParsedExtensionItem>): Record<string, ExtensionInstanceConfig> {
  const normalized: Record<string, ExtensionInstanceConfig> = {};
  for (const [id, item] of Object.entries(parsedItems)) {
    normalized[id] = normalizeInstanceItem(item);
  }
  return normalized;
}

function normalizeExtensions(parsed: ParsedGatewayConfig["extensions"]): ExtensionsConfig {
  return {
    allowList: parsed.allowList.map((item) => ({
      package: item.package,
      enabled: item.enabled,
    })),
  };
}

function normalizeProviders(parsed: ParsedGatewayConfig["providers"]): ProvidersConfig {
  return {
    default: parsed.default,
    items: normalizeInstances(parsed.items),
  };
}

function normalizeConnectors(parsed: ParsedGatewayConfig["connectors"]): ConnectorsConfig {
  return {
    items: normalizeInstances(parsed.items),
  };
}

function normalizeSandboxes(parsed: ParsedGatewayConfig["sandboxes"]): SandboxesConfig {
  return {
    ...(parsed.default ? { default: parsed.default } : {}),
    items: normalizeInstances(parsed.items),
  };
}

function normalizeRouteProfile(
  baseDir: string,
  profile: ParsedRouteItem,
  defaults: RouteDefaultsConfig,
): RouteProfile {
  const normalized: RouteProfile = {
    projectRoot: resolveMaybeAbsolute(baseDir, profile.projectRoot),
    tools: profile.tools ?? defaults.tools,
    mentions: profile.mentions ?? defaults.mentions,
    provider: profile.provider ?? defaults.provider,
    sandbox: profile.sandbox ?? defaults.sandbox,
  };

  if (profile.systemPromptFile) {
    normalized.systemPromptFile = resolveMaybeAbsolute(baseDir, profile.systemPromptFile);
  }

  return normalized;
}

function normalizeRoutes(parsed: ParsedGatewayConfig["routes"], baseDir: string, defaults: RouteDefaultsConfig): RoutesConfig {
  const items: Record<string, RouteProfile> = {};
  for (const [routeId, profile] of Object.entries(parsed.items)) {
    items[routeId] = normalizeRouteProfile(baseDir, profile, defaults);
  }

  return {
    defaults,
    items,
  };
}

function normalizeBindings(parsed: ParsedGatewayConfig["bindings"]): GatewayConfig["bindings"] {
  const items: Record<string, BindingConfig> = {};
  for (const [bindingId, binding] of Object.entries(parsed.items)) {
    items[bindingId] = {
      connector: binding.connector,
      source: {
        type: binding.source.type,
        id: binding.source.id,
      },
      route: binding.route,
    };
  }

  return { items };
}

function assertNoLegacyFields(rawConfig: unknown): void {
  if (!isRecord(rawConfig)) {
    return;
  }

  if (Object.prototype.hasOwnProperty.call(rawConfig, "routing")) {
    throw new Error("Legacy top-level field 'routing' is no longer supported. Use top-level 'routes' and 'bindings'.");
  }

  const rawProviders = rawConfig.providers;
  if (isRecord(rawProviders) && Object.prototype.hasOwnProperty.call(rawProviders, "instances")) {
    throw new Error("Legacy field 'providers.instances' is no longer supported. Use providers.items with inline config.");
  }
  if (isRecord(rawProviders) && Object.prototype.hasOwnProperty.call(rawProviders, "defaultProviderId")) {
    throw new Error("Legacy field 'providers.defaultProviderId' is no longer supported. Use providers.default.");
  }

  const rawConnectors = rawConfig.connectors;
  if (isRecord(rawConnectors) && Object.prototype.hasOwnProperty.call(rawConnectors, "instances")) {
    throw new Error("Legacy field 'connectors.instances' is no longer supported. Use connectors.items with inline config.");
  }

  const rawSandboxes = rawConfig.sandboxes;
  if (isRecord(rawSandboxes) && Object.prototype.hasOwnProperty.call(rawSandboxes, "instances")) {
    throw new Error("Legacy field 'sandboxes.instances' is no longer supported. Use sandboxes.items with inline config.");
  }
  if (isRecord(rawSandboxes) && Object.prototype.hasOwnProperty.call(rawSandboxes, "defaultSandboxId")) {
    throw new Error("Legacy field 'sandboxes.defaultSandboxId' is no longer supported. Use sandboxes.default.");
  }

  const rawConnectorItems = isRecord(rawConnectors) ? rawConnectors.items : undefined;
  if (!isRecord(rawConnectorItems)) {
    const rawRoutes = rawConfig.routes;
    if (isRecord(rawRoutes) && isRecord(rawRoutes.defaults) && Object.prototype.hasOwnProperty.call(rawRoutes.defaults, "projectRoot")) {
      throw new Error("routes.defaults.projectRoot is not supported. Set projectRoot on each routes.items entry.");
    }
    return;
  }

  for (const [instanceId, rawItem] of Object.entries(rawConnectorItems)) {
    if (!isRecord(rawItem)) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(rawItem, "botChannelMap")) {
      throw new Error(
        `Legacy field connectors.items['${instanceId}'].botChannelMap is no longer supported. Use bindings.items instead.`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(rawItem, "chatRouteMap")) {
      throw new Error(
        `Legacy field connectors.items['${instanceId}'].chatRouteMap is no longer supported. Use bindings.items instead.`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(rawItem, "botTokenEnv")) {
      throw new Error(
        `Legacy field connectors.items['${instanceId}'].botTokenEnv is no longer supported. Use botToken directly in config or your own secret injection flow.`,
      );
    }
  }

  const rawRoutes = rawConfig.routes;
  if (isRecord(rawRoutes) && isRecord(rawRoutes.defaults) && Object.prototype.hasOwnProperty.call(rawRoutes.defaults, "projectRoot")) {
    throw new Error("routes.defaults.projectRoot is not supported. Set projectRoot on each routes.items entry.");
  }
}

function validateReferences(parsed: ParsedGatewayConfig, normalizedRoutes: RoutesConfig): void {
  if (!parsed.providers.items[parsed.providers.default]) {
    throw new Error(`providers.default '${parsed.providers.default}' does not exist in providers.items`);
  }

  const defaultSandbox = parsed.sandboxes.default ?? BUILTIN_HOST_SANDBOX_ID;
  if (defaultSandbox !== BUILTIN_HOST_SANDBOX_ID && !parsed.sandboxes.items[defaultSandbox]) {
    throw new Error(`sandboxes.default '${defaultSandbox}' does not exist in sandboxes.items`);
  }

  const resolvedDefaults: RouteDefaultsConfig = {
    provider: parsed.routes.defaults.provider ?? parsed.providers.default,
    sandbox: parsed.routes.defaults.sandbox ?? parsed.sandboxes.default ?? BUILTIN_HOST_SANDBOX_ID,
    tools: parsed.routes.defaults.tools ?? "full",
    mentions: parsed.routes.defaults.mentions ?? "required",
  };

  if (!parsed.providers.items[resolvedDefaults.provider]) {
    throw new Error(`routes.defaults.provider references unknown provider '${resolvedDefaults.provider}'`);
  }
  if (resolvedDefaults.sandbox !== BUILTIN_HOST_SANDBOX_ID && !parsed.sandboxes.items[resolvedDefaults.sandbox]) {
    throw new Error(`routes.defaults.sandbox references unknown sandbox '${resolvedDefaults.sandbox}'`);
  }

  for (const [routeId, profile] of Object.entries(normalizedRoutes.items)) {
    if (!parsed.providers.items[profile.provider]) {
      throw new Error(`routes.items['${routeId}'].provider references unknown provider '${profile.provider}'`);
    }
    if (profile.sandbox !== BUILTIN_HOST_SANDBOX_ID && !parsed.sandboxes.items[profile.sandbox]) {
      throw new Error(`routes.items['${routeId}'].sandbox references unknown sandbox '${profile.sandbox}'`);
    }
  }

  const seenSources = new Map<string, string>();
  for (const [bindingId, binding] of Object.entries(parsed.bindings.items)) {
    if (!parsed.connectors.items[binding.connector]) {
      throw new Error(`bindings.items['${bindingId}'].connector references unknown connector '${binding.connector}'`);
    }
    if (!normalizedRoutes.items[binding.route]) {
      throw new Error(`bindings.items['${bindingId}'].route references unknown route '${binding.route}'`);
    }

    const bindingKey = `${binding.connector}:${binding.source.type}:${binding.source.id}`;
    const existingBindingId = seenSources.get(bindingKey);
    if (existingBindingId) {
      throw new Error(
        `bindings.items['${bindingId}'] duplicates source '${bindingKey}' already used by bindings.items['${existingBindingId}']`,
      );
    }
    seenSources.set(bindingKey, bindingId);
  }
}

export async function loadGatewayConfig(configPath: string): Promise<GatewayConfig> {
  const absoluteConfigPath = resolve(configPath);
  const configDir = dirname(absoluteConfigPath);
  const raw = await readFile(absoluteConfigPath, "utf-8");
  const parsedRaw = JSON.parse(raw) as unknown;
  assertNoLegacyFields(parsedRaw);
  const parsed = gatewayConfigSchema.parse(parsedRaw);

  const routeDefaults: RouteDefaultsConfig = {
    provider: parsed.routes.defaults.provider ?? parsed.providers.default,
    sandbox: parsed.routes.defaults.sandbox ?? parsed.sandboxes.default ?? BUILTIN_HOST_SANDBOX_ID,
    tools: parsed.routes.defaults.tools ?? "full",
    mentions: parsed.routes.defaults.mentions ?? "required",
  };

  const normalizedRoutes = normalizeRoutes(parsed.routes, configDir, routeDefaults);
  validateReferences(parsed, normalizedRoutes);

  const rootDir = resolveMaybeAbsolute(configDir, parsed.data.rootDir);

  return {
    extensions: normalizeExtensions(parsed.extensions),
    providers: normalizeProviders(parsed.providers),
    connectors: normalizeConnectors(parsed.connectors),
    sandboxes: normalizeSandboxes(parsed.sandboxes),
    routes: normalizedRoutes,
    bindings: normalizeBindings(parsed.bindings),
    data: {
      rootDir,
      sessionsDir: resolve(rootDir, "sessions"),
      attachmentsDir: resolve(rootDir, "attachments"),
      logsDir: resolve(rootDir, "logs"),
      stateDir: resolve(rootDir, "state"),
      dedupTtlMs: parsed.data.dedupTtlMs,
    },
  };
}

export class RouteResolver {
  constructor(private readonly routes: RoutesConfig) {}

  resolve(routeId: string): RouteResolution | null {
    const normalizedRouteId = routeId.trim();
    if (!normalizedRouteId) return null;

    const profile = this.routes.items[normalizedRouteId];
    if (!profile) return null;

    return { routeId: normalizedRouteId, profile };
  }
}

export class BindingResolver {
  private readonly bindingsBySource = new Map<string, BindingResolution>();

  constructor(bindings: GatewayConfig["bindings"]) {
    for (const [bindingId, binding] of Object.entries(bindings.items)) {
      this.bindingsBySource.set(this.buildKey(binding.connector, binding.source), {
        bindingId,
        config: binding,
      });
    }
  }

  resolve(connectorId: string, source: BindingSource): BindingResolution | null {
    if (!connectorId.trim() || !source.id.trim()) {
      return null;
    }

    return this.bindingsBySource.get(this.buildKey(connectorId, source)) ?? null;
  }

  private buildKey(connectorId: string, source: BindingSource): string {
    return `${connectorId.trim()}:${source.type}:${source.id.trim()}`;
  }
}
