import { z } from "zod";
import type { ConnectorContributionModule } from "@dobby.ai/plugin-sdk";
import { DiscordConnector, type DiscordConnectorConfig } from "./connector.js";

const discordConnectorConfigSchema = z.object({
  botName: z.string().min(1),
  botToken: z.string().min(1),
  botChannelMap: z.record(z.string(), z.string().min(1)),
  reconnectStaleMs: z.number().int().positive().default(60_000),
  reconnectCheckIntervalMs: z.number().int().positive().default(10_000),
});

export const connectorDiscordContribution: ConnectorContributionModule = {
  kind: "connector",
  createInstance(options) {
    const config = discordConnectorConfigSchema.parse(options.config) as DiscordConnectorConfig;
    return new DiscordConnector(options.instanceId, config, options.attachmentsRoot, options.host.logger);
  },
};

export default connectorDiscordContribution;
