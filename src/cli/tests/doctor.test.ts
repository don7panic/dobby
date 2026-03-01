import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Writes a temporary default config under HOME/.dobby/gateway.json.
 */
async function writeTempHomeConfig(homeDir: string, payload: unknown): Promise<string> {
  const dobbyDir = join(homeDir, ".dobby");
  await mkdir(dobbyDir, { recursive: true });
  const configPath = join(dobbyDir, "gateway.json");
  await writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return configPath;
}

/**
 * Runs `dobby doctor` in a child process with an isolated HOME directory.
 */
async function runDoctorWithHome(homeDir: string, configPath: string): Promise<{ code: number | null; output: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/main.ts", "doctor"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: homeDir,
          DOBBY_CONFIG_PATH: configPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });

    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      resolve({ code, output });
    });
  });
}

test("doctor reports invalid botChannelMap route references", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "dobby-doctor-home-"));

  try {
    const configPath = await writeTempHomeConfig(homeDir, {
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

    const result = await runDoctorWithHome(homeDir, configPath);
    assert.equal(result.code, 1);
    assert.equal(
      result.output.includes("botChannelMap['123']") && result.output.includes("missing-route"),
      true,
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
