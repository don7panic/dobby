let moduleRef;
try {
  moduleRef = await import("./src/contribution.ts");
} catch {
  moduleRef = await import("../../dist/plugins/provider-claude/src/contribution.js");
}

export const contribution = moduleRef.providerClaudeContribution;
export default contribution;
