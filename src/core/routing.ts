import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { AgentConfig, GatewayConfig, RouteProfile, RouteResolution, RoutingConfig } from "./types.js";

const routeProfileSchema = z.object({
  projectRoot: z.string().min(1),
  tools: z.enum(["full", "readonly"]).default("full"),
  systemPromptFile: z.string().optional(),
  allowMentionsOnly: z.boolean().default(true),
  maxConcurrentTurns: z.number().int().positive().default(1),
});

const routingSchema = z.object({
  defaultRouteId: z.string().min(1).optional(),
  channelMap: z.record(z.string().min(1)),
  routes: z.record(routeProfileSchema),
});

const gatewayConfigSchema = z.object({
  discord: z.object({
    enabled: z.boolean().default(true),
    botTokenEnv: z.string().min(1).default("DISCORD_BOT_TOKEN"),
    allowDirectMessages: z.boolean().default(true),
    allowedGuildIds: z.array(z.string()).default([]),
  }),
  routing: routingSchema,
  agent: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).default("off"),
    agentDir: z.string().optional(),
    authFile: z.string().optional(),
    modelsFile: z.string().optional(),
  }),
  sandbox: z.union([
    z.object({ backend: z.literal("host") }),
    z.object({
      backend: z.literal("docker"),
      docker: z.object({
        container: z.string().min(1),
        hostWorkspaceRoot: z.string().min(1),
        containerWorkspaceRoot: z.string().min(1).default("/workspace"),
      }),
    }),
    z.object({
      backend: z.literal("boxlite"),
      boxlite: z.object({
        workspaceRoot: z.string().min(1),
        image: z.string().min(1).default("alpine:latest"),
        cpus: z.number().int().positive().optional(),
        memoryMib: z.number().int().positive().optional(),
        containerWorkspaceRoot: z.string().min(1).default("/workspace"),
        reuseMode: z.enum(["conversation", "workspace"]).default("conversation"),
        autoRemove: z.boolean().default(true),
        securityProfile: z.enum(["development", "standard", "maximum"]).default("maximum"),
      }),
    }),
  ]),
  data: z.object({
    rootDir: z.string().default("./data"),
    dedupTtlMs: z.number().int().positive().default(7 * 24 * 60 * 60 * 1000),
  }),
});

type ParsedRouteProfile = z.infer<typeof routeProfileSchema>;

type ParsedAgentConfig = z.infer<typeof gatewayConfigSchema>["agent"];

type ParsedGatewayConfig = z.infer<typeof gatewayConfigSchema>;

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
  // Keep "./data" beside the repository root for the default config path "./config/gateway.json".
  return basename(configDir) === "config" ? resolve(configDir, "..") : configDir;
}

function normalizeRouteProfile(baseDir: string, profile: ParsedRouteProfile): RouteProfile {
  const normalized: RouteProfile = {
    projectRoot: resolveMaybeAbsolute(baseDir, profile.projectRoot),
    tools: profile.tools,
    allowMentionsOnly: profile.allowMentionsOnly,
    maxConcurrentTurns: profile.maxConcurrentTurns,
  };

  if (profile.systemPromptFile) {
    normalized.systemPromptFile = resolveMaybeAbsolute(baseDir, profile.systemPromptFile);
  }

  return normalized;
}

function normalizeAgentConfig(baseDir: string, raw: ParsedAgentConfig): AgentConfig {
  const normalized: AgentConfig = {
    provider: raw.provider,
    model: raw.model,
    thinkingLevel: raw.thinkingLevel,
  };

  if (raw.agentDir) {
    normalized.agentDir = resolveMaybeAbsolute(baseDir, raw.agentDir);
  }
  if (raw.authFile) {
    normalized.authFile = resolveMaybeAbsolute(baseDir, raw.authFile);
  }
  if (raw.modelsFile) {
    normalized.modelsFile = resolveMaybeAbsolute(baseDir, raw.modelsFile);
  }

  return normalized;
}

function normalizeRouting(parsedRouting: ParsedGatewayConfig["routing"], normalizedRoutes: Record<string, RouteProfile>): RoutingConfig {
  return {
    channelMap: parsedRouting.channelMap,
    routes: normalizedRoutes,
    ...(parsedRouting.defaultRouteId ? { defaultRouteId: parsedRouting.defaultRouteId } : {}),
  };
}

export async function loadGatewayConfig(configPath: string): Promise<GatewayConfig> {
  const absoluteConfigPath = resolve(configPath);
  const configDir = dirname(absoluteConfigPath);
  const raw = await readFile(absoluteConfigPath, "utf-8");
  const parsed = gatewayConfigSchema.parse(JSON.parse(raw));

  const normalizedRoutes: Record<string, RouteProfile> = {};
  for (const [routeId, profile] of Object.entries(parsed.routing.routes)) {
    normalizedRoutes[routeId] = normalizeRouteProfile(configDir, profile);
  }

  if (parsed.routing.defaultRouteId && !normalizedRoutes[parsed.routing.defaultRouteId]) {
    throw new Error(`defaultRouteId '${parsed.routing.defaultRouteId}' does not exist in routing.routes`);
  }

  for (const [channelId, routeId] of Object.entries(parsed.routing.channelMap)) {
    if (!normalizedRoutes[routeId]) {
      throw new Error(`channelMap entry '${channelId}' references unknown route '${routeId}'`);
    }
  }

  const rootDir = resolveMaybeAbsolute(dataBaseDir(configDir), parsed.data.rootDir);

  return {
    discord: parsed.discord,
    routing: normalizeRouting(parsed.routing, normalizedRoutes),
    agent: normalizeAgentConfig(configDir, parsed.agent),
    sandbox:
      parsed.sandbox.backend === "docker"
        ? {
            backend: "docker",
            docker: {
              container: parsed.sandbox.docker.container,
              hostWorkspaceRoot: resolveMaybeAbsolute(configDir, parsed.sandbox.docker.hostWorkspaceRoot),
              containerWorkspaceRoot: parsed.sandbox.docker.containerWorkspaceRoot,
            },
          }
        : parsed.sandbox.backend === "boxlite"
          ? {
              backend: "boxlite",
              boxlite: {
                workspaceRoot: resolveMaybeAbsolute(configDir, parsed.sandbox.boxlite.workspaceRoot),
                image: parsed.sandbox.boxlite.image,
                ...(parsed.sandbox.boxlite.cpus !== undefined ? { cpus: parsed.sandbox.boxlite.cpus } : {}),
                ...(parsed.sandbox.boxlite.memoryMib !== undefined ? { memoryMib: parsed.sandbox.boxlite.memoryMib } : {}),
                containerWorkspaceRoot: parsed.sandbox.boxlite.containerWorkspaceRoot,
                reuseMode: parsed.sandbox.boxlite.reuseMode,
                autoRemove: parsed.sandbox.boxlite.autoRemove,
                securityProfile: parsed.sandbox.boxlite.securityProfile,
              },
            }
          : { backend: "host" },
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

  resolve(channelId: string): RouteResolution | null {
    const routeId = this.routing.channelMap[channelId] ?? this.routing.defaultRouteId;
    if (!routeId) return null;

    const profile = this.routing.routes[routeId];
    if (!profile) return null;

    return { routeId, profile };
  }
}
