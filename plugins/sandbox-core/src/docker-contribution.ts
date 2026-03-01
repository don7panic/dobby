import { resolve } from "node:path";
import { z } from "zod";
import type { SandboxContributionModule } from "@dobby.ai/plugin-sdk";
import { DockerExecutor } from "./docker-executor.js";

const dockerSandboxConfigSchema = z.object({
  container: z.string().min(1),
  hostWorkspaceRoot: z.string().min(1),
  containerWorkspaceRoot: z.string().min(1).default("/workspace"),
});

function resolveMaybeAbsolute(baseDir: string, value: string): string {
  if (value === "~") {
    return resolve(process.env.HOME ?? "", ".");
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return resolve(process.env.HOME ?? "", value.slice(2));
  }
  return resolve(baseDir, value);
}

export const sandboxDockerContribution: SandboxContributionModule = {
  kind: "sandbox",
  configSchema: z.toJSONSchema(dockerSandboxConfigSchema),
  async createInstance(options) {
    const parsed = dockerSandboxConfigSchema.parse(options.config);
    const executor = await DockerExecutor.create(
      {
        container: parsed.container,
        hostWorkspaceRoot: resolveMaybeAbsolute(options.host.configBaseDir, parsed.hostWorkspaceRoot),
        containerWorkspaceRoot: parsed.containerWorkspaceRoot,
      },
      options.host.logger,
    );

    return {
      id: options.instanceId,
      executor,
    };
  },
};

export default sandboxDockerContribution;
