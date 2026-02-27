import JSON5 from "json5";
import { getAtPath, parsePath, setAtPath, unsetAtPath } from "../shared/config-path.js";
import { requireRawConfig, resolveConfigPath, writeConfigWithValidation } from "../shared/config-io.js";
import type { RawGatewayConfig } from "../shared/config-types.js";

/**
 * Parses a required config path expression and rejects empty paths early.
 */
function parseRequiredPath(rawPath: string): string[] {
  const parsedPath = parsePath(rawPath);
  if (parsedPath.length === 0) {
    throw new Error("Path is empty.");
  }
  return parsedPath;
}

/**
 * Parses `config set` value as JSON5 by default, with raw string fallback when allowed.
 */
export function parseConfigSetValue(rawValue: string, strictJson = false): unknown {
  const trimmed = rawValue.trim();
  if (strictJson) {
    try {
      return JSON5.parse(trimmed);
    } catch (error) {
      throw new Error(`Failed to parse JSON5 value: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    return JSON5.parse(trimmed);
  } catch {
    return rawValue;
  }
}

/**
 * Reads a config value by path and prints either plain text or JSON.
 */
export async function runConfigGetCommand(options: {
  config?: string;
  path: string;
  json?: boolean;
}): Promise<void> {
  const configPath = resolveConfigPath(options.config);
  const rawConfig = await requireRawConfig(configPath);
  const parsedPath = parseRequiredPath(options.path);

  const value = getAtPath(rawConfig, parsedPath);
  if (!value.found) {
    throw new Error(`Config path not found: ${options.path}`);
  }

  if (options.json) {
    console.log(JSON.stringify(value.value ?? null, null, 2));
    return;
  }

  if (
    typeof value.value === "string"
    || typeof value.value === "number"
    || typeof value.value === "boolean"
  ) {
    console.log(String(value.value));
    return;
  }

  console.log(JSON.stringify(value.value ?? null, null, 2));
}

/**
 * Sets a config value at the given path, then validates and persists the file.
 */
export async function runConfigSetCommand(options: {
  config?: string;
  path: string;
  value: string;
  strictJson?: boolean;
  noValidate?: boolean;
}): Promise<void> {
  const configPath = resolveConfigPath(options.config);
  const rawConfig = await requireRawConfig(configPath);
  const parsedPath = parseRequiredPath(options.path);
  const parsedValue = parseConfigSetValue(options.value, options.strictJson === true);

  const next = structuredClone(rawConfig) as RawGatewayConfig;
  setAtPath(next as Record<string, unknown>, parsedPath, parsedValue);

  await writeConfigWithValidation(configPath, next, {
    validate: options.noValidate !== true,
    createBackup: true,
  });

  console.log(`Updated ${options.path}${options.noValidate ? " (validation skipped)" : ""}`);
}

/**
 * Removes a config value by path, then validates and persists the file.
 */
export async function runConfigUnsetCommand(options: {
  config?: string;
  path: string;
  noValidate?: boolean;
}): Promise<void> {
  const configPath = resolveConfigPath(options.config);
  const rawConfig = await requireRawConfig(configPath);
  const parsedPath = parseRequiredPath(options.path);

  const next = structuredClone(rawConfig) as RawGatewayConfig;
  const removed = unsetAtPath(next as Record<string, unknown>, parsedPath);
  if (!removed) {
    throw new Error(`Config path not found: ${options.path}`);
  }

  await writeConfigWithValidation(configPath, next, {
    validate: options.noValidate !== true,
    createBackup: true,
  });

  console.log(`Removed ${options.path}${options.noValidate ? " (validation skipped)" : ""}`);
}
