import { z } from "zod";
import type { ConnectorContributionModule } from "@im-agent-gateway/plugin-sdk";
import { DiscordConnector, type DiscordConnectorConfig } from "./connector.js";

const discordConnectorConfigSchema = z.object({
  botTokenEnv: z.string().min(1).default("DISCORD_BOT_TOKEN"),
  allowDirectMessages: z.boolean().default(true),
  allowedGuildIds: z.array(z.string()).default([]),
});

export const connectorDiscordContribution: ConnectorContributionModule = {
  kind: "connector",
  createInstance(options) {
    const config = discordConnectorConfigSchema.parse(options.config) as DiscordConnectorConfig;
    return new DiscordConnector(options.instanceId, config, options.attachmentsRoot, options.host.logger);
  },
};

export default connectorDiscordContribution;
