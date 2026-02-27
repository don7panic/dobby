import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  BUILTIN_HOST_SANDBOX_ID,
} from "./types.js";
import type {
  ConnectorsConfig,
  ExtensionInstanceConfig,
  ExtensionsConfig,
  GatewayConfig,
  ProvidersConfig,
  RouteProfile,
  RouteResolution,
  RoutingConfig,
  SandboxesConfig,
} from "./types.js";

const extensionInstanceSchema = z.object({
  contributionId: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
});

const routeProfileSchema = z.object({
  projectRoot: z.string().min(1),
  tools: z.enum(["full", "readonly"]).default("full"),
  systemPromptFile: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  allowMentionsOnly: z.boolean().default(true),
  maxConcurrentTurns: z.number().int().positive().default(1),
  providerId: z.string().min(1).optional(),
  sandboxId: z.string().min(1).optional(),
});

const routingSchema = z.object({
  defaultRouteId: z.string().min(1).optional(),
  routes: z.record(z.string(), routeProfileSchema),
});

const gatewayConfigSchema = z.object({
  extensions: z.object({
    allowList: z
      .array(
        z.object({
          package: z.string().min(1),
          enabled: z.boolean().default(true),
        }),
      )
      .default([]),
  }),
  providers: z.object({
    defaultProviderId: z.string().min(1),
    instances: z.record(z.string(), extensionInstanceSchema),
  }),
  connectors: z.object({
    instances: z.record(z.string(), extensionInstanceSchema),
  }),
  sandboxes: z.object({
    defaultSandboxId: z.string().min(1).optional(),
    instances: z.record(z.string(), extensionInstanceSchema).default({}),
  }),
  routing: routingSchema,
  data: z.object({
    rootDir: z.string().default("./data"),
    dedupTtlMs: z.number().int().positive().default(7 * 24 * 60 * 60 * 1000),
  }),
});

type ParsedRouteProfile = z.infer<typeof routeProfileSchema>;
type ParsedGatewayConfig = z.infer<typeof gatewayConfigSchema>;

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

function dataBaseDir(configDir: string): string {
  return basename(configDir) === "config" ? resolve(configDir, "..") : configDir;
}

function normalizeRouteProfile(baseDir: string, profile: ParsedRouteProfile): RouteProfile {
  const normalized: RouteProfile = {
    projectRoot: resolveMaybeAbsolute(baseDir, profile.projectRoot),
    tools: profile.tools,
    allowMentionsOnly: profile.allowMentionsOnly,
    maxConcurrentTurns: profile.maxConcurrentTurns,
    ...(profile.providerId ? { providerId: profile.providerId } : {}),
    ...(profile.sandboxId ? { sandboxId: profile.sandboxId } : {}),
  };

  if (profile.systemPromptFile) {
    normalized.systemPromptFile = resolveMaybeAbsolute(baseDir, profile.systemPromptFile);
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

function normalizeInstances(
  parsedInstances: Record<string, z.infer<typeof extensionInstanceSchema>>,
): Record<string, ExtensionInstanceConfig> {
  const normalized: Record<string, ExtensionInstanceConfig> = {};
  for (const [id, instance] of Object.entries(parsedInstances)) {
    normalized[id] = {
      contributionId: instance.contributionId,
      config: instance.config,
    };
  }
  return normalized;
}

function normalizeProviders(parsed: ParsedGatewayConfig["providers"]): ProvidersConfig {
  return {
    defaultProviderId: parsed.defaultProviderId,
    instances: normalizeInstances(parsed.instances),
  };
}

function normalizeConnectors(parsed: ParsedGatewayConfig["connectors"]): ConnectorsConfig {
  return {
    instances: normalizeInstances(parsed.instances),
  };
}

function normalizeSandboxes(parsed: ParsedGatewayConfig["sandboxes"]): SandboxesConfig {
  return {
    ...(parsed.defaultSandboxId ? { defaultSandboxId: parsed.defaultSandboxId } : {}),
    instances: normalizeInstances(parsed.instances),
  };
}

function normalizeRouting(
  parsedRouting: ParsedGatewayConfig["routing"],
  normalizedRoutes: Record<string, RouteProfile>,
): RoutingConfig {
  return {
    routes: normalizedRoutes,
    ...(parsedRouting.defaultRouteId ? { defaultRouteId: parsedRouting.defaultRouteId } : {}),
  };
}

function assertNoLegacyFields(rawConfig: unknown): void {
  if (!isRecord(rawConfig)) {
    return;
  }

  const rawRouting = rawConfig.routing;
  if (isRecord(rawRouting) && Object.prototype.hasOwnProperty.call(rawRouting, "channelMap")) {
    throw new Error(
      "Legacy field 'routing.channelMap' is no longer supported. " +
      "Move channel mappings into connectors.instances.<id>.config.botChannelMap.",
    );
  }

  const rawConnectors = rawConfig.connectors;
  const rawInstances = isRecord(rawConnectors) ? rawConnectors.instances : undefined;
  if (!isRecord(rawInstances)) {
    return;
  }

  for (const [instanceId, rawInstance] of Object.entries(rawInstances)) {
    const rawConfigValue = isRecord(rawInstance) ? rawInstance.config : undefined;
    if (isRecord(rawConfigValue) && Object.prototype.hasOwnProperty.call(rawConfigValue, "botTokenEnv")) {
      throw new Error(
        `Legacy field connectors.instances['${instanceId}'].config.botTokenEnv is no longer supported. ` +
        "Use connectors.instances.<id>.config.botToken instead.",
      );
    }
  }
}

function validateReferences(
  parsed: ParsedGatewayConfig,
  normalizedRoutes: Record<string, RouteProfile>,
): void {
  if (!parsed.providers.instances[parsed.providers.defaultProviderId]) {
    throw new Error(`providers.defaultProviderId '${parsed.providers.defaultProviderId}' does not exist in providers.instances`);
  }

  const defaultSandboxId = parsed.sandboxes.defaultSandboxId ?? BUILTIN_HOST_SANDBOX_ID;
  if (defaultSandboxId !== BUILTIN_HOST_SANDBOX_ID && !parsed.sandboxes.instances[defaultSandboxId]) {
    throw new Error(`sandboxes.defaultSandboxId '${defaultSandboxId}' does not exist in sandboxes.instances`);
  }

  if (parsed.routing.defaultRouteId && !normalizedRoutes[parsed.routing.defaultRouteId]) {
    throw new Error(`routing.defaultRouteId '${parsed.routing.defaultRouteId}' does not exist in routing.routes`);
  }

  for (const [routeId, profile] of Object.entries(normalizedRoutes)) {
    const providerId = profile.providerId ?? parsed.providers.defaultProviderId;
    const sandboxId = profile.sandboxId ?? parsed.sandboxes.defaultSandboxId ?? BUILTIN_HOST_SANDBOX_ID;
    if (!parsed.providers.instances[providerId]) {
      throw new Error(`routing.routes['${routeId}'].providerId references unknown provider instance '${providerId}'`);
    }
    if (sandboxId !== BUILTIN_HOST_SANDBOX_ID && !parsed.sandboxes.instances[sandboxId]) {
      throw new Error(`routing.routes['${routeId}'].sandboxId references unknown sandbox instance '${sandboxId}'`);
    }
  }
}

export async function loadGatewayConfig(configPath: string): Promise<GatewayConfig> {
  const absoluteConfigPath = resolve(configPath);
  const configDir = dirname(absoluteConfigPath);
  const raw = await readFile(absoluteConfigPath, "utf-8");
  const parsedRaw = JSON.parse(raw) as unknown;
  assertNoLegacyFields(parsedRaw);
  const parsed = gatewayConfigSchema.parse(parsedRaw);

  const normalizedRoutes: Record<string, RouteProfile> = {};
  for (const [routeId, profile] of Object.entries(parsed.routing.routes)) {
    normalizedRoutes[routeId] = normalizeRouteProfile(configDir, profile);
  }

  validateReferences(parsed, normalizedRoutes);

  const rootDir = resolveMaybeAbsolute(dataBaseDir(configDir), parsed.data.rootDir);

  return {
    extensions: normalizeExtensions(parsed.extensions),
    providers: normalizeProviders(parsed.providers),
    connectors: normalizeConnectors(parsed.connectors),
    sandboxes: normalizeSandboxes(parsed.sandboxes),
    routing: normalizeRouting(parsed.routing, normalizedRoutes),
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
  constructor(private readonly routing: RoutingConfig) {}

  resolve(routeId: string): RouteResolution | null {
    const normalizedRouteId = routeId.trim();
    if (!normalizedRouteId) return null;

    const profile = this.routing.routes[normalizedRouteId];
    if (!profile) return null;

    return { routeId: normalizedRouteId, profile };
  }
}
