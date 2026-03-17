import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runConnectorStatusCommand } from "../commands/connector.js";

test("connector status reads the runtime snapshot and filters one connector", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dobby-connector-status-"));
  const configPath = join(dir, "gateway.json");
  const dataRoot = join(dir, "data");
  const stateDir = join(dataRoot, "state");
  const statusPath = join(stateDir, "connectors-status.json");
  const previousConfigPath = process.env.DOBBY_CONFIG_PATH;
  const originalConsoleLog = console.log;
  const lines: string[] = [];

  try {
    await writeFile(configPath, `${JSON.stringify({ data: { rootDir: "./data" } }, null, 2)}\n`, "utf-8");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      statusPath,
      `${JSON.stringify({
        schemaVersion: 1,
        generatedAtMs: Date.now(),
        staleAfterMs: 15_000,
        gateway: {
          pid: 123,
          startedAtMs: Date.now() - 1_000,
        },
        items: [
          {
            connectorId: "discord.main",
            platform: "discord",
            connectorName: "discord",
            availability: "online",
            online: true,
            health: {
              status: "ready",
              statusSinceMs: Date.now() - 2_000,
              updatedAtMs: Date.now() - 500,
              restartCount: 1,
            },
          },
          {
            connectorId: "feishu.main",
            platform: "feishu",
            connectorName: "feishu",
            availability: "reconnecting",
            online: false,
            health: {
              status: "reconnecting",
              statusSinceMs: Date.now() - 4_000,
              updatedAtMs: Date.now() - 1_000,
              restartCount: 0,
            },
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    process.env.DOBBY_CONFIG_PATH = configPath;
    console.log = (value?: unknown) => {
      lines.push(String(value ?? ""));
    };

    await runConnectorStatusCommand({ connectorId: "discord.main" });

    assert.equal(lines.length, 2);
    const [header, row] = lines;
    assert.ok(header);
    assert.ok(row);
    assert.match(header, /CONNECTOR\s+PLATFORM\s+AVAILABILITY\s+HEALTH\s+RESTARTS\s+UPDATED/);
    assert.match(row, /discord\.main\s+discord\s+online\s+ready\s+1\s+/);
  } finally {
    console.log = originalConsoleLog;
    if (previousConfigPath === undefined) {
      delete process.env.DOBBY_CONFIG_PATH;
    } else {
      process.env.DOBBY_CONFIG_PATH = previousConfigPath;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
