/**
 * Contribution id used by the built-in Discord connector plugin.
 */
export const DISCORD_CONNECTOR_CONTRIBUTION_ID = "connector.discord";

/**
 * Default connector instance id used by starter presets.
 */
export const DEFAULT_DISCORD_CONNECTOR_INSTANCE_ID = "discord.main";

/**
 * Default human-readable bot name for starter setups.
 */
export const DEFAULT_DISCORD_BOT_NAME = "dobby-main";

/**
 * Narrow type guard for object-like values.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalizes Discord bot channel map into channelId -> routeId entries.
 */
export function normalizeDiscordBotChannelMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [channelId, routeId] of Object.entries(value)) {
    if (typeof routeId === "string" && routeId.trim().length > 0) {
      normalized[channelId] = routeId;
    }
  }

  return normalized;
}
