import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ConnectorHealth, ConnectorHealthStatus, ConnectorPlugin, Platform } from "./types.js";

export const CONNECTOR_STATUS_SNAPSHOT_FILENAME = "connectors-status.json";
export const DEFAULT_CONNECTOR_STATUS_PUBLISH_INTERVAL_MS = 5_000;
export const DEFAULT_CONNECTOR_STATUS_STALE_AFTER_MS = 15_000;

export type ConnectorAvailability = "online" | "degraded" | "reconnecting" | "offline";

export interface ConnectorStatusItem {
  connectorId: string;
  platform: Platform;
  connectorName: string;
  availability: ConnectorAvailability;
  online: boolean;
  health: ConnectorHealth;
}

export interface ConnectorStatusSnapshotFile {
  schemaVersion: 1;
  generatedAtMs: number;
  staleAfterMs: number;
  gateway: {
    pid: number;
    startedAtMs: number;
  };
  items: ConnectorStatusItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function createFallbackHealth(detail: string): ConnectorHealth {
  const now = Date.now();
  return {
    status: "stopped",
    detail,
    statusSinceMs: now,
    updatedAtMs: now,
  };
}

export function availabilityFromHealthStatus(status: ConnectorHealthStatus): ConnectorAvailability {
  switch (status) {
    case "ready":
      return "online";
    case "degraded":
      return "degraded";
    case "reconnecting":
      return "reconnecting";
    case "starting":
    case "failed":
    case "stopped":
    default:
      return "offline";
  }
}

export function connectorStatusSnapshotPath(stateDir: string): string {
  return join(resolve(stateDir), CONNECTOR_STATUS_SNAPSHOT_FILENAME);
}

export function statusItemFromConnector(connector: ConnectorPlugin): ConnectorStatusItem {
  const health = connector.getHealth?.() ?? createFallbackHealth("Connector health is not available");
  const availability = availabilityFromHealthStatus(health.status);

  return {
    connectorId: connector.id,
    platform: connector.platform,
    connectorName: connector.name,
    availability,
    online: availability === "online",
    health,
  };
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const absolutePath = resolve(filePath);
  await mkdir(dirname(absolutePath), { recursive: true });

  const tempPath = `${absolutePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tempPath, content, "utf-8");
  await rename(tempPath, absolutePath);
}

export async function writeConnectorStatusSnapshot(
  filePath: string,
  snapshot: ConnectorStatusSnapshotFile,
): Promise<void> {
  await writeAtomic(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export async function connectorStatusSnapshotExists(filePath: string): Promise<boolean> {
  try {
    await access(resolve(filePath));
    return true;
  } catch {
    return false;
  }
}

function parseHealth(value: unknown): ConnectorHealth | null {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.status !== "string" || typeof value.statusSinceMs !== "number" || typeof value.updatedAtMs !== "number") {
    return null;
  }

  return value as unknown as ConnectorHealth;
}

function parseStatusItem(value: unknown): ConnectorStatusItem | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.connectorId !== "string"
    || typeof value.platform !== "string"
    || typeof value.connectorName !== "string"
    || typeof value.availability !== "string"
    || typeof value.online !== "boolean"
  ) {
    return null;
  }

  const health = parseHealth(value.health);
  if (!health) {
    return null;
  }

  return {
    connectorId: value.connectorId,
    platform: value.platform,
    connectorName: value.connectorName,
    availability: value.availability as ConnectorAvailability,
    online: value.online,
    health,
  };
}

export async function readConnectorStatusSnapshot(filePath: string): Promise<ConnectorStatusSnapshotFile> {
  const raw = await readFile(resolve(filePath), "utf-8");
  const parsed = JSON.parse(raw) as unknown;

  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.generatedAtMs !== "number" || typeof parsed.staleAfterMs !== "number") {
    throw new Error(`Connector status snapshot '${resolve(filePath)}' has invalid metadata`);
  }

  if (!isRecord(parsed.gateway) || typeof parsed.gateway.pid !== "number" || typeof parsed.gateway.startedAtMs !== "number") {
    throw new Error(`Connector status snapshot '${resolve(filePath)}' has invalid gateway metadata`);
  }

  if (!Array.isArray(parsed.items)) {
    throw new Error(`Connector status snapshot '${resolve(filePath)}' must contain an items array`);
  }

  const items = parsed.items.map((item) => {
    const normalized = parseStatusItem(item);
    if (!normalized) {
      throw new Error(`Connector status snapshot '${resolve(filePath)}' contains an invalid connector entry`);
    }
    return normalized;
  });

  return {
    schemaVersion: 1,
    generatedAtMs: parsed.generatedAtMs,
    staleAfterMs: parsed.staleAfterMs,
    gateway: {
      pid: parsed.gateway.pid,
      startedAtMs: parsed.gateway.startedAtMs,
    },
    items,
  };
}

export function isConnectorStatusSnapshotStale(snapshot: ConnectorStatusSnapshotFile, now = Date.now()): boolean {
  return now - snapshot.generatedAtMs > snapshot.staleAfterMs;
}
