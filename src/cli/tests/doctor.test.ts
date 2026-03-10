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

test("doctor reports invalid binding route references", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "dobby-doctor-home-"));

  try {
    const configPath = await writeTempHomeConfig(homeDir, {
      extensions: { allowList: [] },
      providers: {
        default: "pi.main",
        items: {
          "pi.main": {
            type: "provider.pi",
          },
        },
      },
      connectors: {
        items: {
          "discord.main": {
            type: "connector.discord",
            botName: "dobby-main",
            botToken: "token",
          },
        },
      },
      sandboxes: {
        default: "host.builtin",
        items: {},
      },
      routes: {
        defaults: {
          provider: "pi.main",
          sandbox: "host.builtin",
          tools: "full",
          mentions: "required",
        },
        items: {
          main: {
            projectRoot: process.cwd(),
          },
        },
      },
      bindings: {
        items: {
          "discord.main.123": {
            connector: "discord.main",
            source: {
              type: "channel",
              id: "123",
            },
            route: "missing-route",
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
      result.output.includes("bindings.items['discord.main.123'].route") && result.output.includes("missing-route"),
      true,
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("doctor reports init template placeholders as errors and warnings", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "dobby-doctor-placeholders-"));

  try {
    const configPath = await writeTempHomeConfig(homeDir, {
      extensions: { allowList: [] },
      providers: {
        default: "pi.main",
        items: {
          "pi.main": {
            type: "provider.pi",
            provider: "custom-openai",
            model: "example-model",
            thinkingLevel: "off",
            modelsFile: "./models.custom.json",
          },
        },
      },
      connectors: {
        items: {
          "discord.main": {
            type: "connector.discord",
            botName: "dobby-main",
            botToken: "REPLACE_WITH_DISCORD_BOT_TOKEN",
          },
          "feishu.main": {
            type: "connector.feishu",
            appId: "REPLACE_WITH_FEISHU_APP_ID",
            appSecret: "REPLACE_WITH_FEISHU_APP_SECRET",
          },
        },
      },
      sandboxes: {
        default: "host.builtin",
        items: {},
      },
      routes: {
        defaults: {
          provider: "pi.main",
          sandbox: "host.builtin",
          tools: "full",
          mentions: "required",
        },
        items: {
          main: {
            projectRoot: "./REPLACE_WITH_PROJECT_ROOT",
          },
        },
      },
      bindings: {
        items: {
          "discord.main.main": {
            connector: "discord.main",
            source: {
              type: "channel",
              id: "YOUR_DISCORD_CHANNEL_ID",
            },
            route: "main",
          },
          "feishu.main.main": {
            connector: "feishu.main",
            source: {
              type: "chat",
              id: "YOUR_FEISHU_CHAT_ID",
            },
            route: "main",
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
    assert.equal(result.output.includes("connectors.items['discord.main'].botToken still uses placeholder value"), true);
    assert.equal(result.output.includes("connectors.items['feishu.main'].appId still uses placeholder value"), true);
    assert.equal(result.output.includes("connectors.items['feishu.main'].appSecret still uses placeholder value"), true);
    assert.equal(result.output.includes("routes.items['main'].projectRoot still uses placeholder value"), true);
    assert.equal(result.output.includes("bindings.items['discord.main.main'].source.id still uses placeholder value"), true);
    assert.equal(result.output.includes("bindings.items['feishu.main.main'].source.id still uses placeholder value"), true);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
