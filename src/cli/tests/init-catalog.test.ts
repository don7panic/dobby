import assert from "node:assert/strict";
import test from "node:test";
import { createInitSelectionConfig } from "../shared/init-catalog.js";

test("createInitSelectionConfig writes Discord starter template for provider.pi", () => {
  const selected = createInitSelectionConfig(["provider.pi"], ["connector.discord"], {
    routeProviderChoiceId: "provider.pi",
    defaultProjectRoot: "./my-project",
  });

  assert.deepEqual(selected.providerChoiceIds, ["provider.pi"]);
  assert.deepEqual(selected.connectorChoiceIds, ["connector.discord"]);
  assert.equal(selected.routeId, "main");
  assert.equal(selected.providerInstanceId, "pi.main");
  assert.deepEqual(selected.providerInstances, [{
    choiceId: "provider.pi",
    instanceId: "pi.main",
    contributionId: "provider.pi",
    config: {
      model: "REPLACE_WITH_PROVIDER_MODEL_ID",
      baseUrl: "REPLACE_WITH_PROVIDER_BASE_URL",
      apiKey: "REPLACE_WITH_PROVIDER_API_KEY_OR_ENV",
    },
  }]);
  assert.deepEqual(selected.connectorInstances, [{
    choiceId: "connector.discord",
    instanceId: "discord.main",
    contributionId: "connector.discord",
    config: {
      botName: "dobby-main",
      botToken: "REPLACE_WITH_DISCORD_BOT_TOKEN",
      reconnectStaleMs: 60_000,
      reconnectCheckIntervalMs: 10_000,
    },
  }]);
  assert.deepEqual(selected.routeDefaults, {
    projectRoot: "./my-project",
    tools: "full",
    mentions: "required",
    provider: "pi.main",
    sandbox: "host.builtin",
  });
  assert.deepEqual(selected.routeProfile, {});
  assert.deepEqual(selected.defaultBinding, {
    route: "main",
  });
  assert.deepEqual(selected.bindings, [{
    id: "discord.main.main",
    config: {
      connector: "discord.main",
      source: {
        type: "channel",
        id: "YOUR_DISCORD_CHANNEL_ID",
      },
      route: "main",
    },
  }]);
});

test("createInitSelectionConfig writes Feishu starter template for provider.claude-cli", () => {
  const selected = createInitSelectionConfig(["provider.claude-cli"], ["connector.feishu"], {
    routeProviderChoiceId: "provider.claude-cli",
    defaultProjectRoot: "./my-project",
  });

  assert.deepEqual(selected.providerChoiceIds, ["provider.claude-cli"]);
  assert.deepEqual(selected.connectorChoiceIds, ["connector.feishu"]);
  assert.equal(selected.routeId, "main");
  assert.equal(selected.providerInstanceId, "claude-cli.main");
  assert.deepEqual(selected.connectorInstances, [{
    choiceId: "connector.feishu",
    instanceId: "feishu.main",
    contributionId: "connector.feishu",
    config: {
      appId: "REPLACE_WITH_FEISHU_APP_ID",
      appSecret: "REPLACE_WITH_FEISHU_APP_SECRET",
      domain: "feishu",
      messageFormat: "card_markdown",
      replyMode: "direct",
      downloadAttachments: true,
    },
  }]);
  assert.deepEqual(selected.bindings, [{
    id: "feishu.main.main",
    config: {
      connector: "feishu.main",
      source: {
        type: "chat",
        id: "YOUR_FEISHU_CHAT_ID",
      },
      route: "main",
    },
  }]);
});

test("createInitSelectionConfig supports multiple providers and connectors with one default provider", () => {
  const selected = createInitSelectionConfig(
    ["provider.pi", "provider.claude-cli"],
    ["connector.discord", "connector.feishu"],
    {
      routeProviderChoiceId: "provider.claude-cli",
      defaultProjectRoot: "./my-project",
    },
  );

  assert.deepEqual(selected.providerChoiceIds, ["provider.pi", "provider.claude-cli"]);
  assert.deepEqual(selected.connectorChoiceIds, ["connector.discord", "connector.feishu"]);
  assert.deepEqual(selected.extensionPackages, [
    "@dobby.ai/provider-pi",
    "@dobby.ai/provider-claude-cli",
    "@dobby.ai/connector-discord",
    "@dobby.ai/connector-feishu",
  ]);
  assert.equal(selected.providerInstanceId, "claude-cli.main");
  assert.equal(selected.routeDefaults.provider, "claude-cli.main");
  assert.equal(selected.routeProviderChoiceId, "provider.claude-cli");
  assert.deepEqual(selected.defaultBinding, {
    route: "main",
  });
  assert.deepEqual(selected.bindings, [
    {
      id: "discord.main.main",
      config: {
        connector: "discord.main",
        source: {
          type: "channel",
          id: "YOUR_DISCORD_CHANNEL_ID",
        },
        route: "main",
      },
    },
    {
      id: "feishu.main.main",
      config: {
        connector: "feishu.main",
        source: {
          type: "chat",
          id: "YOUR_FEISHU_CHAT_ID",
        },
        route: "main",
      },
    },
  ]);
});
