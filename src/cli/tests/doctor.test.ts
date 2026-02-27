import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runDoctorCommand } from "../commands/doctor.js";

/**
 * Writes a temporary config file and returns its absolute path.
 */
async function writeTempConfig(payload: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dobby-doctor-"));
  const path = join(dir, "gateway.json");
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return path;
}

test("doctor reports invalid botChannelMap route references", async () => {
  const configPath = await writeTempConfig({
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
              "123": "missing-route",
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
  });

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((item) => String(item)).join(" "));
  };

  try {
    await assert.rejects(runDoctorCommand({ config: configPath }), /Doctor found blocking errors/);
  } finally {
    console.log = originalLog;
    await rm(dirname(configPath), { recursive: true, force: true });
  }

  assert.equal(
    logs.some((line) => line.includes("botChannelMap['123']") && line.includes("missing-route")),
    true,
  );
});
