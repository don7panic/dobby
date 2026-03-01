import { existsSync, readFileSync } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { loadGatewayConfig } from "../../core/routing.js";
import type { RawGatewayConfig } from "./config-types.js";

/**
 * Default config file path used by all CLI commands.
 */
export const DEFAULT_CONFIG_PATH = resolve(homedir(), ".dobby", "gateway.json");

/**
 * Expands "~" prefixed paths to the current user's home directory.
 */
function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return resolve(homedir(), value.slice(2));
  }

  return value;
}

/**
 * Preserves legacy behavior where config files under "./config" still resolve data relative to project root.
 */
function dataBaseDir(configDir: string): string {
  return basename(configDir) === "config" ? resolve(configDir, "..") : configDir;
}

type ConfigPathSource = "env" | "repo" | "default";

interface ConfigPathResolutionInput {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface ResolvedConfigPathInfo {
  path: string;
  source: ConfigPathSource;
}

/**
 * Returns true when a directory looks like the dobby repository root.
 */
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

/**
 * Scans current directory and ancestors to find a local dobby repo config path.
 */
function findDobbyRepoConfigPath(startDir: string): string | null {
  let currentDir = resolve(startDir);

  while (true) {
    if (isDobbyRepoRoot(currentDir)) {
      return resolve(currentDir, "config", "gateway.json");
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

/**
 * Resolves config path source by priority: env override -> local repo -> default home path.
 */
function resolveConfigPathInfo(input?: ConfigPathResolutionInput): ResolvedConfigPathInfo {
  const env = input?.env ?? process.env;
  const cwd = input?.cwd ?? process.cwd();
  const rawOverride = env.DOBBY_CONFIG_PATH;
  const override = typeof rawOverride === "string" ? rawOverride.trim() : "";

  if (override.length > 0) {
    const expanded = expandHome(override);
    return {
      path: isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded),
      source: "env",
    };
  }

  const localRepoConfigPath = findDobbyRepoConfigPath(cwd);
  if (localRepoConfigPath) {
    return {
      path: localRepoConfigPath,
      source: "repo",
    };
  }

  return {
    path: DEFAULT_CONFIG_PATH,
    source: "default",
  };
}

/**
 * Resolves config path with dev-friendly detection and env override support.
 */
export function resolveConfigPath(input?: ConfigPathResolutionInput): string {
  return resolveConfigPathInfo(input).path;
}

/**
 * Formats a user-facing init command hint for missing-config errors.
 */
function initCommandHint(): string {
  return "dobby init";
}

/**
 * Resolves data.rootDir into an absolute path using config-file-relative semantics.
 */
export function resolveDataRootDir(configPath: string, rawConfig: RawGatewayConfig): string {
  const absoluteConfigPath = resolve(configPath);
  const configDir = dirname(absoluteConfigPath);
  const rawRootDir = typeof rawConfig.data?.rootDir === "string" && rawConfig.data.rootDir.trim().length > 0
    ? rawConfig.data.rootDir
    : "./data";

  const expanded = expandHome(rawRootDir);
  if (isAbsolute(expanded)) {
    return resolve(expanded);
  }

  return resolve(dataBaseDir(configDir), expanded);
}

/**
 * Checks whether a file exists without throwing for missing paths.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads and parses the raw JSON config file.
 */
export async function readRawConfig(configPath: string): Promise<RawGatewayConfig | null> {
  const absolutePath = resolve(configPath);
  if (!(await fileExists(absolutePath))) {
    return null;
  }

  const raw = await readFile(absolutePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config at '${absolutePath}' must be a JSON object`);
  }

  return parsed as RawGatewayConfig;
}

/**
 * Writes config content atomically via temp file + rename.
 */
async function writeAtomic(configPath: string, content: string): Promise<void> {
  const absolutePath = resolve(configPath);
  const configDir = dirname(absolutePath);
  await mkdir(configDir, { recursive: true });

  const tempPath = `${absolutePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tempPath, content, "utf-8");
  await rename(tempPath, absolutePath);
}

/**
 * Serializes and writes the config file with normalized JSON formatting.
 */
export async function writeRawConfig(configPath: string, rawConfig: RawGatewayConfig): Promise<void> {
  const payload = `${JSON.stringify(rawConfig, null, 2)}\n`;
  await writeAtomic(configPath, payload);
}

/**
 * Creates a timestamped backup beside the target config file.
 */
export async function backupConfig(configPath: string): Promise<string | null> {
  const absolutePath = resolve(configPath);
  if (!(await fileExists(absolutePath))) {
    return null;
  }

  const content = await readFile(absolutePath, "utf-8");
  const backupPath = `${absolutePath}.bak-${Date.now()}`;
  await writeFile(backupPath, content, "utf-8");
  return backupPath;
}

/**
 * Writes config, validates with loadGatewayConfig, and rolls back on any failure.
 */
export async function writeConfigWithValidation(
  configPath: string,
  rawConfig: RawGatewayConfig,
  options?: {
    validate?: boolean;
    createBackup?: boolean;
  },
): Promise<{ backupPath: string | null }> {
  const absolutePath = resolve(configPath);
  const validate = options?.validate !== false;

  const previousExists = await fileExists(absolutePath);
  const previousContent = previousExists ? await readFile(absolutePath, "utf-8") : null;
  const backupPath = options?.createBackup ? await backupConfig(absolutePath) : null;

  try {
    await writeRawConfig(absolutePath, rawConfig);
    if (!validate) {
      return { backupPath };
    }

    await loadGatewayConfig(absolutePath);
    return { backupPath };
  } catch (error) {
    if (previousContent === null) {
      await rm(absolutePath, { force: true });
    } else {
      await writeAtomic(absolutePath, previousContent);
    }
    throw error;
  }
}

/**
 * Reads config and throws a user-oriented error when the file is missing.
 */
export async function requireRawConfig(configPath: string): Promise<RawGatewayConfig> {
  const raw = await readRawConfig(configPath);
  if (!raw) {
    const resolvedConfigPath = resolve(configPath);
    const currentResolution = resolveConfigPathInfo();
    let sourceHint = "";
    if (resolvedConfigPath === currentResolution.path && currentResolution.source === "env") {
      sourceHint = ` Source: DOBBY_CONFIG_PATH='${process.env.DOBBY_CONFIG_PATH ?? ""}'.`;
    } else if (resolvedConfigPath === currentResolution.path && currentResolution.source === "repo") {
      sourceHint = " Source: detected dobby repo, using ./config/gateway.json.";
    }

    throw new Error(
      `Config '${resolvedConfigPath}' does not exist.${sourceHint} Run '${initCommandHint()}' first.`,
    );
  }
  return raw;
}
