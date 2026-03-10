import { z } from "zod";
import type { ConnectorContributionModule } from "@dobby.ai/plugin-sdk";
import { FeishuConnector, type FeishuConnectorConfig } from "./connector.js";

const feishuConnectorConfigSchema = z.object({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  domain: z.enum(["feishu", "lark"]).default("feishu"),
  botName: z.string().min(1).optional(),
  botOpenId: z.string().min(1).optional(),
  messageFormat: z.enum(["text", "card_markdown"]).default("card_markdown"),
  replyMode: z.enum(["direct", "reply"]).default("direct"),
  cardTitle: z.string().min(1).optional(),
  chatRouteMap: z.record(z.string(), z.string().min(1)),
  downloadAttachments: z.boolean().default(true),
});

export const connectorFeishuContribution: ConnectorContributionModule = {
  kind: "connector",
  configSchema: z.toJSONSchema(feishuConnectorConfigSchema),
  createInstance(options) {
    const config = feishuConnectorConfigSchema.parse(options.config) as FeishuConnectorConfig;
    return new FeishuConnector(options.instanceId, config, options.attachmentsRoot, options.host.logger);
  },
};

export default connectorFeishuContribution;
