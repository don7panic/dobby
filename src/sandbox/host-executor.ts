import { spawn } from "node:child_process";
import type { GatewayLogger } from "../core/types.js";
import type { ExecOptions, ExecResult, Executor } from "./executor.js";

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export class HostExecutor implements Executor {
  constructor(private readonly logger: GatewayLogger) {}

  async exec(command: string, cwd: string, options: ExecOptions = {}): Promise<ExecResult> {
    const wrapped = `cd ${shellEscape(cwd)} && ${command}`;

    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn("sh", ["-lc", wrapped], {
        stdio: ["ignore", "pipe", "pipe"],
        env: options.env ?? process.env,
        detached: true,
      });

      let stdout = "";
      let stderr = "";
      let killed = false;

      const onAbort = () => {
        killed = true;
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            try {
              process.kill(child.pid, "SIGKILL");
            } catch {
              // Process already exited.
            }
          }
        }
      };

      let timeoutHandle: NodeJS.Timeout | undefined;
      if (options.timeoutSeconds && options.timeoutSeconds > 0) {
        timeoutHandle = setTimeout(onAbort, options.timeoutSeconds * 1000);
      }

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });

      child.on("error", (error) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (options.signal) options.signal.removeEventListener("abort", onAbort);
        reject(error);
      });

      child.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (options.signal) options.signal.removeEventListener("abort", onAbort);
        resolve({ stdout, stderr, code: code ?? 0, killed });
      });
    });
  }

  async close(): Promise<void> {
    this.logger.debug("HostExecutor closed");
  }
}
