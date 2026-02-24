import { resolve } from "node:path";
import { z } from "zod";
import type { SandboxContributionModule } from "@dobby/plugin-sdk";
import { BoxliteExecutor } from "./boxlite-executor.js";

const boxliteSandboxConfigSchema = z.object({
  workspaceRoot: z.string().min(1),
  image: z.string().min(1).default("alpine:latest"),
  cpus: z.number().int().positive().optional(),
  memoryMib: z.number().int().positive().optional(),
  containerWorkspaceRoot: z.string().min(1).default("/workspace"),
  reuseMode: z.enum(["conversation", "workspace"]).default("conversation"),
  autoRemove: z.boolean().default(true),
  securityProfile: z.enum(["development", "standard", "maximum"]).default("maximum"),
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

export const sandboxBoxliteContribution: SandboxContributionModule = {
  kind: "sandbox",
  async createInstance(options) {
    const parsed = boxliteSandboxConfigSchema.parse(options.config);
    const executor = await BoxliteExecutor.create(
      {
        workspaceRoot: resolveMaybeAbsolute(options.host.configBaseDir, parsed.workspaceRoot),
        image: parsed.image,
        ...(parsed.cpus !== undefined ? { cpus: parsed.cpus } : {}),
        ...(parsed.memoryMib !== undefined ? { memoryMib: parsed.memoryMib } : {}),
        containerWorkspaceRoot: parsed.containerWorkspaceRoot,
        reuseMode: parsed.reuseMode,
        autoRemove: parsed.autoRemove,
        securityProfile: parsed.securityProfile,
      },
      options.host.logger,
    );

    return {
      id: options.instanceId,
      executor,
    };
  },
};

export default sandboxBoxliteContribution;
