import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadGatewayConfig } from "../../core/routing.js";

async function writeTempConfig(payload: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dobby-routing-"));
  const configPath = join(dir, "gateway.json");
  await writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return configPath;
}

function validConfig(): Record<string, unknown> {
  return {
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
          projectRoot: "./workspace/project-a",
          systemPromptFile: "./prompts/main.md",
        },
      },
    },
    bindings: {
      items: {
        "discord.main.main": {
          connector: "discord.main",
          source: {
            type: "channel",
            id: "123",
          },
          route: "main",
        },
      },
    },
    data: {
      rootDir: "./data",
      dedupTtlMs: 604800000,
    },
  };
}

test("loadGatewayConfig applies route defaults and resolves relative paths", async () => {
  const payload = validConfig();
  const configPath = await writeTempConfig(payload);

  try {
    const loaded = await loadGatewayConfig(configPath);
    const configDir = dirname(configPath);

    assert.equal(loaded.providers.default, "pi.main");
    assert.deepEqual(loaded.routes.defaults, {
      provider: "pi.main",
      sandbox: "host.builtin",
      tools: "full",
      mentions: "required",
    });
    assert.deepEqual(loaded.routes.items.main, {
      projectRoot: join(configDir, "workspace/project-a"),
      systemPromptFile: join(configDir, "prompts/main.md"),
      provider: "pi.main",
      sandbox: "host.builtin",
      tools: "full",
      mentions: "required",
    });
    assert.equal(loaded.data.rootDir, join(configDir, "data"));
    assert.deepEqual(loaded.bindings.items["discord.main.main"], {
      connector: "discord.main",
      source: {
        type: "channel",
        id: "123",
      },
      route: "main",
    });
  } finally {
    await rm(dirname(configPath), { recursive: true, force: true });
  }
});

test("loadGatewayConfig fails fast on legacy top-level routing", async () => {
  const payload = validConfig();
  payload.routing = {
    routes: {
      main: {
        projectRoot: process.cwd(),
      },
    },
  };

  const configPath = await writeTempConfig(payload);
  try {
    await assert.rejects(loadGatewayConfig(configPath), /top-level field 'routing'/);
  } finally {
    await rm(dirname(configPath), { recursive: true, force: true });
  }
});

test("loadGatewayConfig fails fast on legacy botTokenEnv", async () => {
  const payload = validConfig();
  payload.connectors = {
    items: {
      "discord.main": {
        type: "connector.discord",
        botName: "dobby-main",
        botTokenEnv: "DISCORD_BOT_TOKEN",
      },
    },
  };

  const configPath = await writeTempConfig(payload);
  try {
    await assert.rejects(loadGatewayConfig(configPath), /botTokenEnv/);
  } finally {
    await rm(dirname(configPath), { recursive: true, force: true });
  }
});

test("loadGatewayConfig fails fast on legacy connector route maps", async () => {
  const payload = validConfig();
  payload.connectors = {
    items: {
      "discord.main": {
        type: "connector.discord",
        botName: "dobby-main",
        botToken: "token",
        botChannelMap: {
          "123": "main",
        },
      },
    },
  };

  const configPath = await writeTempConfig(payload);
  try {
    await assert.rejects(loadGatewayConfig(configPath), /botChannelMap/);
  } finally {
    await rm(dirname(configPath), { recursive: true, force: true });
  }
});

test("loadGatewayConfig fails fast on duplicate binding sources", async () => {
  const payload = validConfig();
  payload.bindings = {
    items: {
      "discord.main.main": {
        connector: "discord.main",
        source: {
          type: "channel",
          id: "123",
        },
        route: "main",
      },
      "discord.main.duplicate": {
        connector: "discord.main",
        source: {
          type: "channel",
          id: "123",
        },
        route: "main",
      },
    },
  };

  const configPath = await writeTempConfig(payload);
  try {
    await assert.rejects(loadGatewayConfig(configPath), /duplicates source 'discord\.main:channel:123'/);
  } finally {
    await rm(dirname(configPath), { recursive: true, force: true });
  }
});
