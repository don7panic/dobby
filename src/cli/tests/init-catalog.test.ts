import assert from "node:assert/strict";
import test from "node:test";
import { createInitSelectionConfig } from "../shared/init-catalog.js";

test("createInitSelectionConfig wires explicit Discord bot config for provider.pi", () => {
  const selected = createInitSelectionConfig(["provider.pi"], "connector.discord", {
    routeId: "main",
    projectRoot: "/tmp/project",
    allowAllMessages: false,
    botName: "dobby-main",
    botToken: "token-abc",
    channelId: "123",
    routeProviderChoiceId: "provider.pi",
  });

  assert.deepEqual(selected.connectorConfig, {
    botName: "dobby-main",
    botToken: "token-abc",
    botChannelMap: {
      "123": "main",
    },
    reconnectStaleMs: 60_000,
    reconnectCheckIntervalMs: 10_000,
  });
  assert.deepEqual(selected.providerChoiceIds, ["provider.pi"]);
  assert.equal(selected.providerInstances.length, 1);
  assert.equal(selected.providerInstanceId, "pi.main");
  assert.equal(selected.providerContributionId, "provider.pi");
  assert.equal(selected.routeProfile.providerId, "pi.main");
});

test("createInitSelectionConfig wires explicit Discord bot config for provider.claude-cli", () => {
  const selected = createInitSelectionConfig(["provider.claude-cli"], "connector.discord", {
    routeId: "support",
    projectRoot: "/tmp/project",
    allowAllMessages: true,
    botName: "ops-bot",
    botToken: "token-xyz",
    channelId: "999",
    routeProviderChoiceId: "provider.claude-cli",
  });

  assert.deepEqual(selected.connectorConfig, {
    botName: "ops-bot",
    botToken: "token-xyz",
    botChannelMap: {
      "999": "support",
    },
    reconnectStaleMs: 60_000,
    reconnectCheckIntervalMs: 10_000,
  });
  assert.deepEqual(selected.providerChoiceIds, ["provider.claude-cli"]);
  assert.equal(selected.providerInstances.length, 1);
  assert.equal(selected.providerInstanceId, "claude-cli.main");
  assert.equal(selected.providerContributionId, "provider.claude-cli");
  assert.equal(selected.routeProfile.providerId, "claude-cli.main");
});

test("createInitSelectionConfig supports multiple providers and uses explicit route provider", () => {
  const selected = createInitSelectionConfig(["provider.pi", "provider.claude-cli"], "connector.discord", {
    routeId: "ops",
    projectRoot: "/tmp/project",
    allowAllMessages: false,
    botName: "dobby-multi",
    botToken: "token-multi",
    channelId: "777",
    routeProviderChoiceId: "provider.claude-cli",
  });

  assert.deepEqual(selected.providerChoiceIds, ["provider.pi", "provider.claude-cli"]);
  assert.deepEqual(
    selected.providerInstances.map((item) => item.instanceId),
    ["pi.main", "claude-cli.main"],
  );
  assert.deepEqual(selected.extensionPackages, [
    "@dobby.ai/provider-pi",
    "@dobby.ai/provider-claude-cli",
    "@dobby.ai/connector-discord",
  ]);
  assert.equal(selected.providerInstanceId, "claude-cli.main");
  assert.equal(selected.routeProfile.providerId, "claude-cli.main");
  assert.equal(selected.routeProviderChoiceId, "provider.claude-cli");
});
