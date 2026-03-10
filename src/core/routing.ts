import { existsSync, readFileSync } from "node:fs";
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

const FORBIDDEN_CONNECTOR_CONFIG_KEYS: Record<string, string> = {
  botChannelMap: "Use bindings.items to map connector sources to routes.",
  chatRouteMap: "Use bindings.items to map connector sources to routes.",
  botTokenEnv: "Set botToken directly in connector config or inject it before the config is loaded.",
};

function isDobbyRepoRoot(candidateDir: string): boolean {
  const packageJsonPath = resolve(candidateDir, "package.json");
  const repoConfigPath = resolve(candidateDir, "config", "gateway.json");
  const localExtensionsScriptPath = resolve(candidateDir, "scripts", "local-extensions.mjs");

  if (!existsSync(packageJsonPath) || !existsSync(repoConfigPath) || !existsSync(localExtensionsScriptPath)) {
    return false;
  }

  try {
    const packageJsonRaw = readFileSync(packageJsonPath, "utf-8");
    const parsed = JSON.parse(packageJsonRaw) as { name?: unknown };
    return parsed.name === "dobby";
  } catch {
    return false;
  }
}

function resolveConfigBaseDir(configPath: string): string {
  const absoluteConfigPath = resolve(configPath);
  const configDir = dirname(absoluteConfigPath);
  const repoRoot = dirname(configDir);

  if (absoluteConfigPath === resolve(repoRoot, "config", "gateway.json") && isDobbyRepoRoot(repoRoot)) {
    return repoRoot;
  }

  return configDir;
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

function validateConnectorConfigKeys(parsed: ParsedGatewayConfig["connectors"]): void {
  for (const [instanceId, item] of Object.entries(parsed.items)) {
    for (const [key, message] of Object.entries(FORBIDDEN_CONNECTOR_CONFIG_KEYS)) {
      if (Object.prototype.hasOwnProperty.call(item, key)) {
        throw new Error(`connectors.items['${instanceId}'] must not include '${key}'. ${message}`);
      }
    }
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
  const configBaseDir = resolveConfigBaseDir(absoluteConfigPath);
  const raw = await readFile(absoluteConfigPath, "utf-8");
  const parsed = gatewayConfigSchema.parse(JSON.parse(raw) as unknown);
  validateConnectorConfigKeys(parsed.connectors);

  const routeDefaults: RouteDefaultsConfig = {
    provider: parsed.routes.defaults.provider ?? parsed.providers.default,
    sandbox: parsed.routes.defaults.sandbox ?? parsed.sandboxes.default ?? BUILTIN_HOST_SANDBOX_ID,
    tools: parsed.routes.defaults.tools ?? "full",
    mentions: parsed.routes.defaults.mentions ?? "required",
  };

  const normalizedRoutes = normalizeRoutes(parsed.routes, configBaseDir, routeDefaults);
  validateReferences(parsed, normalizedRoutes);

  const rootDir = resolveMaybeAbsolute(configBaseDir, parsed.data.rootDir);

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
