import type { GatewayLogger, SandboxConfig } from "../core/types.js";
import { BoxliteExecutor } from "./boxlite-executor.js";
import { DockerExecutor } from "./docker-executor.js";
import { HostExecutor } from "./host-executor.js";

export interface ExecOptions {
  timeoutSeconds?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface Executor {
  exec(command: string, cwd: string, options?: ExecOptions): Promise<ExecResult>;
  close(): Promise<void>;
}

export async function createExecutor(config: SandboxConfig, logger: GatewayLogger): Promise<Executor> {
  if (config.backend === "host") {
    return new HostExecutor(logger);
  }

  if (config.backend === "docker") {
    return DockerExecutor.create(config.docker, logger);
  }

  if (config.backend === "boxlite") {
    return BoxliteExecutor.create(config.boxlite, logger);
  }

  throw new Error("Unsupported sandbox backend");
}
