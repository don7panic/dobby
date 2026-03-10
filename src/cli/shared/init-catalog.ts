import type { RawBindingConfig, RawRouteProfile } from "./config-types.js";
import {
  DEFAULT_DISCORD_BOT_NAME,
  DEFAULT_DISCORD_CONNECTOR_INSTANCE_ID,
  DISCORD_CONNECTOR_CONTRIBUTION_ID,
} from "./discord-config.js";

export type InitProviderChoiceId = "provider.pi" | "provider.claude-cli";
export type InitConnectorChoiceId = "connector.discord" | "connector.feishu";

export const DEFAULT_INIT_ROUTE_ID = "main";
export const DEFAULT_INIT_PROJECT_ROOT = "./REPLACE_WITH_PROJECT_ROOT";

interface ProviderCatalogEntry {
  id: InitProviderChoiceId;
  label: string;
  package: string;
  instanceId: string;
  contributionId: string;
  defaultConfig: Record<string, unknown>;
}

interface ConnectorBindingTemplate {
  sourceType: RawBindingConfig["source"]["type"];
  sourceId: string;
}

interface ConnectorCatalogEntry {
  id: InitConnectorChoiceId;
  label: string;
  package: string;
  instanceId: string;
  contributionId: string;
  defaultConfig: Record<string, unknown>;
  bindingTemplate: ConnectorBindingTemplate;
}

export interface InitSelectionContext {
  routeProviderChoiceId: InitProviderChoiceId;
}

export interface InitSelectionResult {
  providerChoiceIds: InitProviderChoiceId[];
  routeProviderChoiceId: InitProviderChoiceId;
  providerChoiceId: InitProviderChoiceId;
  connectorChoiceIds: InitConnectorChoiceId[];
  extensionPackages: string[];
  providerInstances: Array<{
    choiceId: InitProviderChoiceId;
    instanceId: string;
    contributionId: string;
    config: Record<string, unknown>;
  }>;
  connectorInstances: Array<{
    choiceId: InitConnectorChoiceId;
    instanceId: string;
    contributionId: string;
    config: Record<string, unknown>;
  }>;
  providerInstanceId: string;
  providerContributionId: string;
  providerConfig: Record<string, unknown>;
  routeId: string;
  routeProfile: RawRouteProfile;
  bindings: Array<{
    id: string;
    config: RawBindingConfig;
  }>;
}

const PROVIDER_CATALOG: Record<InitProviderChoiceId, ProviderCatalogEntry> = {
  "provider.pi": {
    id: "provider.pi",
    label: "Pi provider",
    package: "@dobby.ai/provider-pi",
    instanceId: "pi.main",
    contributionId: "provider.pi",
    defaultConfig: {
      provider: "custom-openai",
      model: "example-model",
      thinkingLevel: "off",
      modelsFile: "./models.custom.json",
    },
  },
  "provider.claude-cli": {
    id: "provider.claude-cli",
    label: "Claude CLI provider",
    package: "@dobby.ai/provider-claude-cli",
    instanceId: "claude-cli.main",
    contributionId: "provider.claude-cli",
    defaultConfig: {
      model: "claude-sonnet-4-5",
      maxTurns: 20,
      command: "claude",
      commandArgs: [],
      authMode: "auto",
      permissionMode: "bypassPermissions",
      streamVerbose: true,
    },
  },
};

const CONNECTOR_CATALOG: Record<InitConnectorChoiceId, ConnectorCatalogEntry> = {
  "connector.discord": {
    id: "connector.discord",
    label: "Discord connector",
    package: "@dobby.ai/connector-discord",
    instanceId: DEFAULT_DISCORD_CONNECTOR_INSTANCE_ID,
    contributionId: DISCORD_CONNECTOR_CONTRIBUTION_ID,
    defaultConfig: {
      botName: DEFAULT_DISCORD_BOT_NAME,
      botToken: "REPLACE_WITH_DISCORD_BOT_TOKEN",
      reconnectStaleMs: 60_000,
      reconnectCheckIntervalMs: 10_000,
    },
    bindingTemplate: {
      sourceType: "channel",
      sourceId: "YOUR_DISCORD_CHANNEL_ID",
    },
  },
  "connector.feishu": {
    id: "connector.feishu",
    label: "Feishu connector",
    package: "@dobby.ai/connector-feishu",
    instanceId: "feishu.main",
    contributionId: "connector.feishu",
    defaultConfig: {
      appId: "REPLACE_WITH_FEISHU_APP_ID",
      appSecret: "REPLACE_WITH_FEISHU_APP_SECRET",
      domain: "feishu",
      messageFormat: "card_markdown",
      replyMode: "direct",
      downloadAttachments: true,
    },
    bindingTemplate: {
      sourceType: "chat",
      sourceId: "YOUR_FEISHU_CHAT_ID",
    },
  },
};

function dedupeChoiceIds<T extends string>(choiceIds: T[]): T[] {
  const dedupedChoiceIds: T[] = [];
  const seenChoiceIds = new Set<T>();

  for (const choiceId of choiceIds) {
    if (seenChoiceIds.has(choiceId)) {
      continue;
    }
    seenChoiceIds.add(choiceId);
    dedupedChoiceIds.push(choiceId);
  }

  return dedupedChoiceIds;
}

export function listInitProviderChoices(): ProviderCatalogEntry[] {
  return Object.values(PROVIDER_CATALOG);
}

export function listInitConnectorChoices(): ConnectorCatalogEntry[] {
  return Object.values(CONNECTOR_CATALOG);
}

export function isInitProviderChoiceId(value: string): value is InitProviderChoiceId {
  return Object.prototype.hasOwnProperty.call(PROVIDER_CATALOG, value);
}

export function isInitConnectorChoiceId(value: string): value is InitConnectorChoiceId {
  return Object.prototype.hasOwnProperty.call(CONNECTOR_CATALOG, value);
}

export function createInitSelectionConfig(
  providerChoiceIds: InitProviderChoiceId[],
  connectorChoiceIds: InitConnectorChoiceId[],
  context: InitSelectionContext,
): InitSelectionResult {
  const dedupedProviderChoiceIds = dedupeChoiceIds(providerChoiceIds);
  if (dedupedProviderChoiceIds.length === 0) {
    throw new Error("At least one provider choice is required");
  }

  const dedupedConnectorChoiceIds = dedupeChoiceIds(connectorChoiceIds);
  if (dedupedConnectorChoiceIds.length === 0) {
    throw new Error("At least one connector choice is required");
  }

  if (!dedupedProviderChoiceIds.includes(context.routeProviderChoiceId)) {
    throw new Error(
      `route provider choice '${context.routeProviderChoiceId}' must be one of selected providers: ${dedupedProviderChoiceIds.join(", ")}`,
    );
  }

  const providerChoices = dedupedProviderChoiceIds.map((providerChoiceId) => PROVIDER_CATALOG[providerChoiceId]);
  const connectorChoices = dedupedConnectorChoiceIds.map((connectorChoiceId) => CONNECTOR_CATALOG[connectorChoiceId]);
  const primaryProviderChoice = PROVIDER_CATALOG[context.routeProviderChoiceId];

  return {
    providerChoiceIds: dedupedProviderChoiceIds,
    routeProviderChoiceId: primaryProviderChoice.id,
    providerChoiceId: primaryProviderChoice.id,
    connectorChoiceIds: dedupedConnectorChoiceIds,
    extensionPackages: [
      ...new Set([
        ...providerChoices.map((item) => item.package),
        ...connectorChoices.map((item) => item.package),
      ]),
    ],
    providerInstances: providerChoices.map((providerChoice) => ({
      choiceId: providerChoice.id,
      instanceId: providerChoice.instanceId,
      contributionId: providerChoice.contributionId,
      config: structuredClone(providerChoice.defaultConfig),
    })),
    connectorInstances: connectorChoices.map((connectorChoice) => ({
      choiceId: connectorChoice.id,
      instanceId: connectorChoice.instanceId,
      contributionId: connectorChoice.contributionId,
      config: structuredClone(connectorChoice.defaultConfig),
    })),
    providerInstanceId: primaryProviderChoice.instanceId,
    providerContributionId: primaryProviderChoice.contributionId,
    providerConfig: structuredClone(primaryProviderChoice.defaultConfig),
    routeId: DEFAULT_INIT_ROUTE_ID,
    routeProfile: {
      projectRoot: DEFAULT_INIT_PROJECT_ROOT,
      tools: "full",
      systemPromptFile: "",
      mentions: "required",
      provider: primaryProviderChoice.instanceId,
      sandbox: "host.builtin",
    },
    bindings: connectorChoices.map((connectorChoice) => ({
      id: `${connectorChoice.instanceId}.${DEFAULT_INIT_ROUTE_ID}`,
      config: {
        connector: connectorChoice.instanceId,
        source: {
          type: connectorChoice.bindingTemplate.sourceType,
          id: connectorChoice.bindingTemplate.sourceId,
        },
        route: DEFAULT_INIT_ROUTE_ID,
      },
    })),
  };
}
