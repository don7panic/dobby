import type { RawRouteProfile } from "./config-types.js";
import {
  DEFAULT_DISCORD_CONNECTOR_INSTANCE_ID,
  DISCORD_CONNECTOR_CONTRIBUTION_ID,
} from "./discord-config.js";

export type InitProviderChoiceId = "provider.pi" | "provider.claude-cli";
export type InitConnectorChoiceId = "connector.discord";

interface ProviderCatalogEntry {
  id: InitProviderChoiceId;
  label: string;
  extensionPackage: string;
  instanceId: string;
  contributionId: string;
  config: Record<string, unknown>;
}

interface ConnectorCatalogEntry {
  id: InitConnectorChoiceId;
  label: string;
  extensionPackage: string;
  instanceId: string;
  contributionId: string;
}

export interface InitSelectionContext {
  routeId: string;
  projectRoot: string;
  allowAllMessages: boolean;
  botName: string;
  botToken: string;
  channelId: string;
  routeProviderChoiceId: InitProviderChoiceId;
}

export interface InitSelectionResult {
  providerChoiceIds: InitProviderChoiceId[];
  routeProviderChoiceId: InitProviderChoiceId;
  providerChoiceId: InitProviderChoiceId;
  connectorChoiceId: InitConnectorChoiceId;
  extensionPackages: string[];
  providerInstances: Array<{
    choiceId: InitProviderChoiceId;
    instanceId: string;
    contributionId: string;
    config: Record<string, unknown>;
  }>;
  providerInstanceId: string;
  providerContributionId: string;
  providerConfig: Record<string, unknown>;
  connectorInstanceId: string;
  connectorContributionId: string;
  connectorConfig: Record<string, unknown>;
  routeProfile: RawRouteProfile;
}

const PROVIDER_CATALOG: Record<InitProviderChoiceId, ProviderCatalogEntry> = {
  "provider.pi": {
    id: "provider.pi",
    label: "Pi provider",
    extensionPackage: "@dobby.ai/provider-pi",
    instanceId: "pi.main",
    contributionId: "provider.pi",
    config: {
      provider: "custom-openai",
      model: "example-model",
      thinkingLevel: "off",
      modelsFile: "./models.custom.json",
    },
  },
  "provider.claude-cli": {
    id: "provider.claude-cli",
    label: "Claude CLI provider",
    extensionPackage: "@dobby.ai/provider-claude-cli",
    instanceId: "claude-cli.main",
    contributionId: "provider.claude-cli",
    config: {
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
    extensionPackage: "@dobby.ai/connector-discord",
    instanceId: DEFAULT_DISCORD_CONNECTOR_INSTANCE_ID,
    contributionId: DISCORD_CONNECTOR_CONTRIBUTION_ID,
  },
};

/**
 * Returns static provider choices supported by `dobby init`.
 */
export function listInitProviderChoices(): ProviderCatalogEntry[] {
  return Object.values(PROVIDER_CATALOG);
}

/**
 * Returns static connector choices supported by `dobby init`.
 */
export function listInitConnectorChoices(): ConnectorCatalogEntry[] {
  return Object.values(CONNECTOR_CATALOG);
}

/**
 * Type guard for provider choice ids in init flow.
 */
export function isInitProviderChoiceId(value: string): value is InitProviderChoiceId {
  return Object.prototype.hasOwnProperty.call(PROVIDER_CATALOG, value);
}

/**
 * Type guard for connector choice ids in init flow.
 */
export function isInitConnectorChoiceId(value: string): value is InitConnectorChoiceId {
  return Object.prototype.hasOwnProperty.call(CONNECTOR_CATALOG, value);
}

/**
 * Builds init output config from selected provider/connector choices.
 */
export function createInitSelectionConfig(
  providerChoiceIds: InitProviderChoiceId[],
  connectorChoiceId: InitConnectorChoiceId,
  context: InitSelectionContext,
): InitSelectionResult {
  const dedupedProviderChoiceIds: InitProviderChoiceId[] = [];
  const seenProviderChoiceIds = new Set<InitProviderChoiceId>();
  for (const providerChoiceId of providerChoiceIds) {
    if (!seenProviderChoiceIds.has(providerChoiceId)) {
      seenProviderChoiceIds.add(providerChoiceId);
      dedupedProviderChoiceIds.push(providerChoiceId);
    }
  }

  if (dedupedProviderChoiceIds.length === 0) {
    throw new Error("At least one provider choice is required");
  }

  if (!dedupedProviderChoiceIds.includes(context.routeProviderChoiceId)) {
    throw new Error(
      `route provider choice '${context.routeProviderChoiceId}' must be one of selected providers: ${dedupedProviderChoiceIds.join(", ")}`,
    );
  }

  const providerChoices = dedupedProviderChoiceIds.map((providerChoiceId) => PROVIDER_CATALOG[providerChoiceId]);
  const primaryProviderChoice = PROVIDER_CATALOG[context.routeProviderChoiceId];
  const connectorChoice = CONNECTOR_CATALOG[connectorChoiceId];

  const baseRoute: RawRouteProfile = {
    projectRoot: context.projectRoot,
    tools: "full",
    systemPromptFile: "",
    allowMentionsOnly: !context.allowAllMessages,
    maxConcurrentTurns: 1,
    sandboxId: "host.builtin",
  };

  return {
    providerChoiceIds: dedupedProviderChoiceIds,
    routeProviderChoiceId: primaryProviderChoice.id,
    providerChoiceId: primaryProviderChoice.id,
    connectorChoiceId,
    extensionPackages: [
      ...new Set([...providerChoices.map((item) => item.extensionPackage), connectorChoice.extensionPackage]),
    ],
    providerInstances: providerChoices.map((providerChoice) => ({
      choiceId: providerChoice.id,
      instanceId: providerChoice.instanceId,
      contributionId: providerChoice.contributionId,
      config: structuredClone(providerChoice.config),
    })),
    providerInstanceId: primaryProviderChoice.instanceId,
    providerContributionId: primaryProviderChoice.contributionId,
    providerConfig: structuredClone(primaryProviderChoice.config),
    connectorInstanceId: connectorChoice.instanceId,
    connectorContributionId: connectorChoice.contributionId,
    connectorConfig: {
      botName: context.botName,
      botToken: context.botToken,
      botChannelMap: {
        [context.channelId]: context.routeId,
      },
      reconnectStaleMs: 60_000,
      reconnectCheckIntervalMs: 10_000,
    },
    routeProfile: {
      ...baseRoute,
      providerId: primaryProviderChoice.instanceId,
    },
  };
}
