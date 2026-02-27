import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import type { GatewayConfig } from "../../core/types.js";

/**
 * Creates the shared gateway logger instance used across CLI commands.
 */
export function createLogger() {
  return pino({
    name: "dobby",
    level: process.env.LOG_LEVEL ?? "info",
  });
}

/**
 * Returns the extension store directory from normalized gateway config.
 */
export function extensionStoreDir(config: GatewayConfig): string {
  return join(config.data.rootDir, "extensions");
}

/**
 * Ensures required runtime data directories exist before start/doctor operations.
 */
export async function ensureDataDirs(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await mkdir(join(rootDir, "sessions"), { recursive: true });
  await mkdir(join(rootDir, "attachments"), { recursive: true });
  await mkdir(join(rootDir, "logs"), { recursive: true });
  await mkdir(join(rootDir, "state"), { recursive: true });
  await mkdir(join(rootDir, "extensions"), { recursive: true });
}
