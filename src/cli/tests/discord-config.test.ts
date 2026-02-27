import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDiscordBotChannelMap } from "../shared/discord-config.js";

test("normalizeDiscordBotChannelMap keeps valid channel->route entries", () => {
  const normalized = normalizeDiscordBotChannelMap({
    "123": "projectA",
    "456": "projectB",
  });

  assert.deepEqual(normalized, {
    "123": "projectA",
    "456": "projectB",
  });
});

test("normalizeDiscordBotChannelMap drops invalid values", () => {
  const normalized = normalizeDiscordBotChannelMap({
    "123": "projectA",
    "456": "",
    "789": 1,
  });

  assert.deepEqual(normalized, {
    "123": "projectA",
  });
});
