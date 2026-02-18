import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";
import type { GatewayLogger } from "@im-agent-gateway/plugin-sdk";
import type { ExecOptions, ExecResult, Executor } from "@im-agent-gateway/plugin-sdk";

export interface DockerConfig {
  container: string;
  hostWorkspaceRoot: string;
  containerWorkspaceRoot: string;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizePrefix(path: string): string {
  return path.endsWith(sep) ? path : `${path}${sep}`;
}

export class DockerExecutor implements Executor {
  private readonly normalizedHostRoot: string;

  private constructor(
    private readonly config: DockerConfig,
    private readonly logger: GatewayLogger,
  ) {
    this.normalizedHostRoot = normalizePrefix(resolve(config.hostWorkspaceRoot));
  }

  static async create(config: DockerConfig, logger: GatewayLogger): Promise<DockerExecutor> {
    const instance = new DockerExecutor(config, logger);
    await instance.validate();
    return instance;
  }

  async exec(command: string, cwd: string, options: ExecOptions = {}): Promise<ExecResult> {
    const containerCwd = this.toContainerPath(cwd);
    const wrapped = `cd ${shellEscape(containerCwd)} && ${command}`;

    const args = ["exec", "-i"];
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        if (value !== undefined) {
          args.push("-e", `${key}=${value}`);
        }
      }
    }
    args.push(this.config.container, "sh", "-lc", wrapped);

    return new Promise<ExecResult>((resolveResult, reject) => {
      const child = spawn("docker", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let killed = false;

      const onAbort = () => {
        killed = true;
        child.kill("SIGKILL");
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
        resolveResult({ stdout, stderr, code: code ?? 0, killed });
      });
    });
  }

  async close(): Promise<void> {
    this.logger.debug({ container: this.config.container }, "DockerExecutor closed");
  }

  private async validate(): Promise<void> {
    await this.execSimple("docker", ["--version"]);

    const inspect = await this.execSimple("docker", ["inspect", "-f", "{{.State.Running}}", this.config.container]);
    if (inspect.trim() !== "true") {
      throw new Error(`Docker container '${this.config.container}' is not running`);
    }
  }

  private toContainerPath(hostPath: string): string {
    const resolved = resolve(hostPath);
    if (!resolved.startsWith(this.normalizedHostRoot) && resolved !== this.normalizedHostRoot.slice(0, -1)) {
      throw new Error(`Path '${resolved}' is outside docker hostWorkspaceRoot '${this.config.hostWorkspaceRoot}'`);
    }

    const relative = resolved.slice(this.normalizedHostRoot.length).replaceAll("\\", "/");
    const base = this.config.containerWorkspaceRoot.endsWith("/")
      ? this.config.containerWorkspaceRoot.slice(0, -1)
      : this.config.containerWorkspaceRoot;

    return relative.length > 0 ? `${base}/${relative}` : base;
  }

  private execSimple(command: string, args: string[]): Promise<string> {
    return new Promise((resolveOutput, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolveOutput(stdout);
        } else {
          reject(new Error(stderr || `Command failed: ${command} ${args.join(" ")}`));
        }
      });
    });
  }
}
