import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { loadGatewayConfig } from "../../core/routing.js";
import type { RawGatewayConfig } from "./config-types.js";

/**
 * Default config file path used by CLI commands when --config is omitted.
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

/**
 * Resolves the config path from CLI input, falling back to the default home config.
 */
export function resolveConfigPath(configPath?: string): string {
  if (configPath && configPath.trim().length > 0) {
    return resolve(configPath);
  }

  return DEFAULT_CONFIG_PATH;
}

/**
 * Formats a user-facing init command hint for missing-config errors.
 */
function initCommandHint(configPath: string): string {
  return resolve(configPath) === DEFAULT_CONFIG_PATH ? "dobby init" : `dobby init --config ${configPath}`;
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
    throw new Error(
      `Config '${resolve(configPath)}' does not exist. Run '${initCommandHint(configPath)}' first.`,
    );
  }
  return raw;
}
