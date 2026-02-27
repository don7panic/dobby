import assert from "node:assert/strict";
import test from "node:test";
import { createPresetConfig } from "../shared/presets.js";

test("createPresetConfig wires explicit Discord bot config for discord-pi", () => {
  const preset = createPresetConfig("discord-pi", {
    routeId: "main",
    projectRoot: "/tmp/project",
    allowAllMessages: false,
    botName: "dobby-main",
    botToken: "token-abc",
    channelId: "123",
  });

  assert.deepEqual(preset.connectorConfig, {
    botName: "dobby-main",
    botToken: "token-abc",
    botChannelMap: {
      "123": "main",
    },
    reconnectStaleMs: 60_000,
    reconnectCheckIntervalMs: 10_000,
  });
});

test("createPresetConfig wires explicit Discord bot config for discord-claude-cli", () => {
  const preset = createPresetConfig("discord-claude-cli", {
    routeId: "support",
    projectRoot: "/tmp/project",
    allowAllMessages: true,
    botName: "ops-bot",
    botToken: "token-xyz",
    channelId: "999",
  });

  assert.deepEqual(preset.connectorConfig, {
    botName: "ops-bot",
    botToken: "token-xyz",
    botChannelMap: {
      "999": "support",
    },
    reconnectStaleMs: 60_000,
    reconnectCheckIntervalMs: 10_000,
  });
});
