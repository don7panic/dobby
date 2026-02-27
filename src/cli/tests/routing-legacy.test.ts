import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadGatewayConfig } from "../../core/routing.js";

/**
 * Writes a temporary config file and returns its absolute path.
 */
async function writeTempConfig(payload: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dobby-routing-"));
  const path = join(dir, "gateway.json");
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return path;
}

/**
 * Creates a minimal valid config payload for routing loader tests.
 */
function validConfig(): Record<string, unknown> {
  return {
    extensions: { allowList: [] },
    providers: {
      defaultProviderId: "pi.main",
      instances: {
        "pi.main": {
          contributionId: "provider.pi",
          config: {},
        },
      },
    },
    connectors: {
      instances: {
        "discord.main": {
          contributionId: "connector.discord",
          config: {
            botName: "dobby-main",
            botToken: "token",
            botChannelMap: {
              "123": "main",
            },
          },
        },
      },
    },
    sandboxes: {
      defaultSandboxId: "host.builtin",
      instances: {},
    },
    routing: {
      defaultRouteId: "main",
      routes: {
        main: {
          projectRoot: process.cwd(),
          tools: "full",
          allowMentionsOnly: true,
          maxConcurrentTurns: 1,
          providerId: "pi.main",
          sandboxId: "host.builtin",
        },
      },
    },
    data: {
      rootDir: "./data",
      dedupTtlMs: 604800000,
    },
  };
}

test("loadGatewayConfig fails fast on legacy routing.channelMap", async () => {
  const payload = validConfig();
  (payload.routing as Record<string, unknown>).channelMap = { "discord.main": { "123": "main" } };

  const configPath = await writeTempConfig(payload);
  await assert.rejects(loadGatewayConfig(configPath), /routing\.channelMap/);
  await rm(join(configPath, ".."), { recursive: true, force: true });
});

test("loadGatewayConfig fails fast on legacy botTokenEnv", async () => {
  const payload = validConfig();
  (payload.connectors as Record<string, unknown>).instances = {
    "discord.main": {
      contributionId: "connector.discord",
      config: {
        botTokenEnv: "DISCORD_BOT_TOKEN",
      },
    },
  };

  const configPath = await writeTempConfig(payload);
  await assert.rejects(loadGatewayConfig(configPath), /botTokenEnv/);
  await rm(join(configPath, ".."), { recursive: true, force: true });
});
