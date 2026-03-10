import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { BindingResolver, loadGatewayConfig } from "../../core/routing.js";

async function writeTempConfig(payload: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dobby-routing-"));
  const configPath = join(dir, "gateway.json");
  await writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return configPath;
}

async function writeRepoTempConfig(payload: unknown): Promise<{ repoRoot: string; configPath: string }> {
  const repoRoot = await mkdtemp(join(tmpdir(), "dobby-routing-repo-"));
  const configDir = join(repoRoot, "config");
  await mkdir(configDir, { recursive: true });
  await mkdir(join(repoRoot, "scripts"), { recursive: true });
  await writeFile(join(repoRoot, "package.json"), JSON.stringify({ name: "@dobby.ai/dobby" }), "utf-8");
  await writeFile(join(repoRoot, "scripts", "local-extensions.mjs"), "#!/usr/bin/env node\n", "utf-8");

  const configPath = join(configDir, "gateway.json");
  await writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return { repoRoot, configPath };
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

test("loadGatewayConfig resolves data.rootDir from repo root for repo-local config/gateway.json", async () => {
  const payload = validConfig();
  const { repoRoot, configPath } = await writeRepoTempConfig(payload);

  try {
    const loaded = await loadGatewayConfig(configPath);
    const mainRoute = loaded.routes.items.main;
    assert.ok(mainRoute);
    assert.equal(loaded.data.rootDir, join(repoRoot, "data"));
    assert.equal(mainRoute.projectRoot, join(repoRoot, "workspace/project-a"));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("loadGatewayConfig applies routes.defaults.projectRoot and bindings.default for direct messages", async () => {
  const payload = validConfig();
  payload.routes = {
    defaults: {
      projectRoot: "./workspace/default-root",
      provider: "pi.main",
      sandbox: "host.builtin",
      tools: "full",
      mentions: "required",
    },
    items: {
      main: {},
    },
  };
  payload.bindings = {
    default: {
      route: "main",
    },
    items: {},
  };

  const configPath = await writeTempConfig(payload);

  try {
    const loaded = await loadGatewayConfig(configPath);
    const configDir = dirname(configPath);
    const resolver = new BindingResolver(loaded.bindings);

    assert.deepEqual(loaded.routes.defaults, {
      projectRoot: join(configDir, "workspace/default-root"),
      provider: "pi.main",
      sandbox: "host.builtin",
      tools: "full",
      mentions: "required",
    });
    assert.deepEqual(loaded.routes.items.main, {
      projectRoot: join(configDir, "workspace/default-root"),
      provider: "pi.main",
      sandbox: "host.builtin",
      tools: "full",
      mentions: "required",
    });
    assert.deepEqual(loaded.bindings.default, {
      route: "main",
    });
    assert.equal(
      resolver.resolve(
        "discord.main",
        {
          type: "channel",
          id: "dm-123",
        },
        { isDirectMessage: true },
      )?.config.route,
      "main",
    );
    assert.equal(
      resolver.resolve(
        "discord.main",
        {
          type: "channel",
          id: "dm-123",
        },
        { isDirectMessage: false },
      ),
      null,
    );
  } finally {
    await rm(dirname(configPath), { recursive: true, force: true });
  }
});

test("loadGatewayConfig rejects connector fields reserved by the host", async () => {
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
    await assert.rejects(loadGatewayConfig(configPath), /must not include 'botChannelMap'/);
  } finally {
    await rm(dirname(configPath), { recursive: true, force: true });
  }
});

test("loadGatewayConfig rejects connector env indirection fields reserved by the host", async () => {
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
    await assert.rejects(loadGatewayConfig(configPath), /must not include 'botTokenEnv'/);
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
