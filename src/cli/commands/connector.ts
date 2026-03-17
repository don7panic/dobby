import { join } from "node:path";
import {
  connectorStatusSnapshotExists,
  connectorStatusSnapshotPath,
  isConnectorStatusSnapshotStale,
  readConnectorStatusSnapshot,
  type ConnectorStatusItem,
} from "../../core/connector-status.js";
import { requireRawConfig, resolveConfigPath, resolveDataRootDir } from "../shared/config-io.js";

function formatTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function renderTable(items: ConnectorStatusItem[]): string[] {
  const rows = items.map((item) => ({
    connectorId: item.connectorId,
    platform: item.platform,
    availability: item.availability,
    health: item.health.status,
    restarts: String(item.health.restartCount ?? 0),
    updated: formatTimestamp(item.health.updatedAtMs),
  }));

  const widths = {
    connectorId: Math.max("CONNECTOR".length, ...rows.map((row) => row.connectorId.length)),
    platform: Math.max("PLATFORM".length, ...rows.map((row) => row.platform.length)),
    availability: Math.max("AVAILABILITY".length, ...rows.map((row) => row.availability.length)),
    health: Math.max("HEALTH".length, ...rows.map((row) => row.health.length)),
    restarts: Math.max("RESTARTS".length, ...rows.map((row) => row.restarts.length)),
    updated: Math.max("UPDATED".length, ...rows.map((row) => row.updated.length)),
  };

  const lines = [
    [
      pad("CONNECTOR", widths.connectorId),
      pad("PLATFORM", widths.platform),
      pad("AVAILABILITY", widths.availability),
      pad("HEALTH", widths.health),
      pad("RESTARTS", widths.restarts),
      pad("UPDATED", widths.updated),
    ].join("  "),
  ];

  for (const row of rows) {
    lines.push([
      pad(row.connectorId, widths.connectorId),
      pad(row.platform, widths.platform),
      pad(row.availability, widths.availability),
      pad(row.health, widths.health),
      pad(row.restarts, widths.restarts),
      pad(row.updated, widths.updated),
    ].join("  "));
  }

  return lines;
}

export async function runConnectorStatusCommand(options: {
  connectorId?: string;
  json?: boolean;
}): Promise<void> {
  const configPath = resolveConfigPath();
  const rawConfig = await requireRawConfig(configPath);
  const statusPath = connectorStatusSnapshotPath(join(resolveDataRootDir(configPath, rawConfig), "state"));

  if (!(await connectorStatusSnapshotExists(statusPath))) {
    throw new Error(`Connector status snapshot '${statusPath}' does not exist. Start 'dobby start' first.`);
  }

  const snapshot = await readConnectorStatusSnapshot(statusPath);
  const items = options.connectorId
    ? snapshot.items.filter((item) => item.connectorId === options.connectorId)
    : snapshot.items;

  if (options.connectorId && items.length === 0) {
    throw new Error(`Connector '${options.connectorId}' was not found in '${statusPath}'.`);
  }

  if (options.json) {
    console.log(JSON.stringify({ ...snapshot, items }));
    return;
  }

  if (isConnectorStatusSnapshotStale(snapshot)) {
    console.log("Warning: connector status snapshot is stale; the gateway may not be running.");
  }

  if (items.length === 0) {
    console.log("(empty)");
    return;
  }

  for (const line of renderTable(items)) {
    console.log(line);
  }
}
