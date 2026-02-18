let moduleRef;
try {
  moduleRef = await import("./src/docker-contribution.ts");
} catch {
  moduleRef = await import("../../dist/plugins/sandbox-core/src/docker-contribution.js");
}

export const contribution = moduleRef.sandboxDockerContribution;
export default contribution;
