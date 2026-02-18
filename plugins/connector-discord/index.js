let moduleRef;
try {
  moduleRef = await import("./src/contribution.ts");
} catch {
  moduleRef = await import("../../dist/plugins/connector-discord/src/contribution.js");
}

export const contribution = moduleRef.connectorDiscordContribution;
export default contribution;
