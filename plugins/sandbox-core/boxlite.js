let moduleRef;
try {
  moduleRef = await import("./src/boxlite-contribution.ts");
} catch {
  moduleRef = await import("../../dist/plugins/sandbox-core/src/boxlite-contribution.js");
}

export const contribution = moduleRef.sandboxBoxliteContribution;
export default contribution;
