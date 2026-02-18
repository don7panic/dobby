import type { GatewayLogger } from "../core/types.js";

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
