let moduleRef;
try {
  moduleRef = await import("./src/contribution.ts");
} catch {
  moduleRef = await import("../../dist/plugins/provider-pi/src/contribution.js");
}

export const contribution = moduleRef.providerPiContribution;
export default contribution;
