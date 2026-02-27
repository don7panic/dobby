import type { RawRouteProfile } from "./config-types.js";
import {
  DEFAULT_DISCORD_CONNECTOR_INSTANCE_ID,
  DISCORD_CONNECTOR_CONTRIBUTION_ID,
} from "./discord-config.js";

export type InitPresetId = "discord-pi" | "discord-claude-cli";

export interface InitPresetContext {
  routeId: string;
  projectRoot: string;
  allowAllMessages: boolean;
  botName: string;
  botToken: string;
  channelId: string;
}

export interface InitPresetResult {
  id: InitPresetId;
  extensionPackages: string[];
  providerInstanceId: string;
  providerContributionId: string;
  providerConfig: Record<string, unknown>;
  connectorInstanceId: string;
  connectorContributionId: string;
  connectorConfig: Record<string, unknown>;
  routeProfile: RawRouteProfile;
}

const PRESET_IDS: InitPresetId[] = ["discord-pi", "discord-claude-cli"];

/**
 * Returns all preset identifiers supported by `dobby init`.
 */
export function listPresetIds(): InitPresetId[] {
  return [...PRESET_IDS];
}

/**
 * Type guard for validating preset ids provided by users.
 */
export function isPresetId(value: string): value is InitPresetId {
  return PRESET_IDS.includes(value as InitPresetId);
}

/**
 * Builds preset-specific extension, instance, and route defaults for init flow.
 */
export function createPresetConfig(presetId: InitPresetId, context: InitPresetContext): InitPresetResult {
  const baseRoute: RawRouteProfile = {
    projectRoot: context.projectRoot,
    tools: "full",
    systemPromptFile: "",
    allowMentionsOnly: !context.allowAllMessages,
    maxConcurrentTurns: 1,
    sandboxId: "host.builtin",
  };

  if (presetId === "discord-claude-cli") {
    return {
      id: presetId,
      extensionPackages: ["@dobby/provider-claude-cli", "@dobby/connector-discord"],
      providerInstanceId: "claude-cli.main",
      providerContributionId: "provider.claude-cli",
      providerConfig: {
        model: "claude-sonnet-4-5",
        maxTurns: 20,
        command: "claude",
        commandArgs: [],
        authMode: "auto",
        permissionMode: "bypassPermissions",
        streamVerbose: true,
      },
      connectorInstanceId: DEFAULT_DISCORD_CONNECTOR_INSTANCE_ID,
      connectorContributionId: DISCORD_CONNECTOR_CONTRIBUTION_ID,
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
        providerId: "claude-cli.main",
      },
    };
  }

  return {
    id: "discord-pi",
    extensionPackages: ["@dobby/provider-pi", "@dobby/connector-discord"],
    providerInstanceId: "pi.main",
    providerContributionId: "provider.pi",
    providerConfig: {
      provider: "custom-openai",
      model: "example-model",
      thinkingLevel: "off",
      modelsFile: "./models.custom.json",
    },
    connectorInstanceId: DEFAULT_DISCORD_CONNECTOR_INSTANCE_ID,
    connectorContributionId: DISCORD_CONNECTOR_CONTRIBUTION_ID,
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
      providerId: "pi.main",
    },
  };
}
