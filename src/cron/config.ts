import { dirname, isAbsolute, resolve } from "node:path";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { z } from "zod";
import type { GatewayConfig } from "../core/types.js";
import type { CronConfig } from "./types.js";

interface LoadCronConfigOptions {
  gatewayConfigPath: string;
  gatewayConfig: GatewayConfig;
  explicitCronConfigPath?: string;
}

interface CronConfigResolution {
  configPath: string;
  source: "explicit" | "env" | "gateway" | "state";
}

export interface LoadedCronConfig {
  configPath: string;
  source: "explicit" | "env" | "gateway" | "state";
  config: CronConfig;
}

const rawCronConfigSchema = z.object({
  enabled: z.boolean().default(true),
  storeFile: z.string().min(1).optional(),
  runLogFile: z.string().min(1).optional(),
  pollIntervalMs: z.number().int().positive().default(10_000),
  maxConcurrentRuns: z.number().int().positive().default(1),
  runMissedOnStartup: z.boolean().default(true),
  jobTimeoutMs: z.number().int().positive().default(10 * 60 * 1000),
});

type RawCronConfig = z.infer<typeof rawCronConfigSchema>;

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return resolve(homedir(), value.slice(2));
  }

  return value;
}

function gatewayConfigBaseDir(gatewayConfigPath: string): string {
  const configDir = dirname(resolve(gatewayConfigPath));
  return configDir.endsWith("/config") || configDir.endsWith("\\config")
    ? resolve(configDir, "..")
    : configDir;
}

function resolvePathFromBase(baseDir: string, value: string): string {
  const expanded = expandHome(value);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function defaultCronConfigPayload(): RawCronConfig {
  return {
    enabled: true,
    storeFile: "./data/state/cron-jobs.json",
    runLogFile: "./data/state/cron-runs.jsonl",
    pollIntervalMs: 10_000,
    maxConcurrentRuns: 1,
    runMissedOnStartup: true,
    jobTimeoutMs: 10 * 60 * 1000,
  };
}

async function ensureCronConfigFile(configPath: string): Promise<void> {
  if (await fileExists(configPath)) {
    return;
  }

  await mkdir(dirname(configPath), { recursive: true });
  const payload = `${JSON.stringify(defaultCronConfigPayload(), null, 2)}\n`;
  await writeFile(configPath, payload, "utf-8");
}

function resolveCronConfigPath(options: LoadCronConfigOptions): CronConfigResolution {
  if (options.explicitCronConfigPath && options.explicitCronConfigPath.trim().length > 0) {
    const rawPath = options.explicitCronConfigPath.trim();
    const expanded = expandHome(rawPath);
    const configPath = isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
    return { configPath, source: "explicit" };
  }

  const envPath = process.env.DOBBY_CRON_CONFIG_PATH?.trim();
  if (envPath) {
    const expanded = expandHome(envPath);
    const configPath = isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
    return { configPath, source: "env" };
  }

  const candidate = resolve(dirname(resolve(options.gatewayConfigPath)), "cron.json");
  if (process.env.DOBBY_CRON_CONFIG_PATH === undefined && options.explicitCronConfigPath === undefined) {
    // no-op branch to make intent explicit for the resolution order
  }

  return {
    configPath: candidate,
    source: "gateway",
  };
}

function normalizeCronConfig(gatewayConfigPath: string, gatewayConfig: GatewayConfig, raw: RawCronConfig): CronConfig {
  const baseDir = gatewayConfigBaseDir(gatewayConfigPath);
  const defaultStoreFile = resolve(gatewayConfig.data.stateDir, "cron-jobs.json");
  const defaultRunLogFile = resolve(gatewayConfig.data.stateDir, "cron-runs.jsonl");
  return {
    enabled: raw.enabled,
    storeFile: raw.storeFile ? resolvePathFromBase(baseDir, raw.storeFile) : defaultStoreFile,
    runLogFile: raw.runLogFile ? resolvePathFromBase(baseDir, raw.runLogFile) : defaultRunLogFile,
    pollIntervalMs: raw.pollIntervalMs,
    maxConcurrentRuns: raw.maxConcurrentRuns,
    runMissedOnStartup: raw.runMissedOnStartup,
    jobTimeoutMs: raw.jobTimeoutMs,
  };
}

export async function loadCronConfig(options: LoadCronConfigOptions): Promise<LoadedCronConfig> {
  const resolved = resolveCronConfigPath(options);
  const gatewayFallbackPath = resolve(options.gatewayConfig.data.stateDir, "cron.config.json");

  let configPath = resolved.configPath;
  let source = resolved.source;

  if (source === "gateway" && !(await fileExists(configPath))) {
    configPath = gatewayFallbackPath;
    source = "state";
  }

  await ensureCronConfigFile(configPath);
  const raw = await readFile(configPath, "utf-8");
  const parsed = rawCronConfigSchema.parse(JSON.parse(raw));

  return {
    configPath,
    source,
    config: normalizeCronConfig(options.gatewayConfigPath, options.gatewayConfig, parsed),
  };
}
