import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import type { GatewayLogger } from "@im-agent-gateway/plugin-sdk";
import { BOXLITE_CONTEXT_CONVERSATION_KEY_ENV, BOXLITE_CONTEXT_PROJECT_ROOT_ENV } from "./boxlite-context.js";
import type { ExecOptions, ExecResult, Executor } from "@im-agent-gateway/plugin-sdk";

export interface BoxliteConfig {
  workspaceRoot: string;
  image: string;
  cpus?: number;
  memoryMib?: number;
  containerWorkspaceRoot: string;
  reuseMode: "conversation" | "workspace";
  autoRemove: boolean;
  securityProfile: "development" | "standard" | "maximum";
}

interface BoxEntry {
  key: string;
  name: string;
  projectRoot: string;
  box: {
    exec: (
      command: string,
      args?: string[],
      env?: Array<[string, string]>,
      tty?: boolean,
    ) => Promise<{
      stdout: () => Promise<{ next: () => Promise<string | null> }>;
      stderr: () => Promise<{ next: () => Promise<string | null> }>;
      wait: () => Promise<{ exitCode: number; errorMessage?: string | null }>;
    }>;
    stop: () => Promise<void>;
  };
}

interface NativeRuntime {
  create?: (options: unknown, name?: string) => Promise<unknown>;
  getOrCreate?: (options: unknown, name?: string) => Promise<unknown>;
  remove?: (idOrName: string, force?: boolean) => Promise<void>;
  shutdown?: (timeoutSeconds?: number) => Promise<void>;
  close?: () => void;
}

interface CancellationHandle {
  cancelled: Promise<void>;
  wasCancelled: () => boolean;
  dispose: () => void;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizePrefix(path: string): string {
  return path.endsWith(sep) ? path : `${path}${sep}`;
}

function boxNameFromKey(key: string): string {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 20);
  return `im-agent-${digest}`;
}

function summarizeCommand(command: string, maxLength = 160): string {
  if (command.length <= maxLength) return command;
  return `${command.slice(0, maxLength - 12)}...(trimmed)`;
}

function toEnvTuples(env: NodeJS.ProcessEnv | undefined): Array<[string, string]> | undefined {
  if (!env) return undefined;

  const tuples: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      tuples.push([key, value]);
    }
  }

  return tuples.length > 0 ? tuples : undefined;
}

function formatBoxliteInitError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return [
    "Failed to initialize BoxLite runtime.",
    `Root cause: ${message}`,
    "Install dependency: npm install @boxlite-ai/boxlite",
    "If native binding is missing, reinstall dependencies and add the platform package if needed (example: @boxlite-ai/boxlite-darwin-arm64).",
  ].join("\n");
}

function mapSecurityProfile(profile: BoxliteConfig["securityProfile"]): {
  jailerEnabled: boolean;
  seccompEnabled: boolean;
  maxOpenFiles?: number;
  maxFileSize?: number;
  maxProcesses?: number;
} {
  if (profile === "development") {
    return {
      jailerEnabled: false,
      seccompEnabled: false,
    };
  }

  if (profile === "standard") {
    return {
      jailerEnabled: true,
      seccompEnabled: true,
    };
  }

  return {
    jailerEnabled: true,
    seccompEnabled: true,
    maxOpenFiles: 1024,
    maxFileSize: 1024 * 1024 * 1024,
    maxProcesses: 100,
  };
}

export class BoxliteExecutor implements Executor {
  private readonly normalizedWorkspaceRoot: string;
  private readonly boxes = new Map<string, BoxEntry>();
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly probedBoxKeys = new Set<string>();
  private readonly normalizedContainerWorkspaceRoot: string;
  private warnedMissingConversationContext = false;
  private closed = false;

  private constructor(
    private readonly config: BoxliteConfig,
    private readonly runtime: NativeRuntime,
    private readonly logger: GatewayLogger,
  ) {
    this.normalizedWorkspaceRoot = resolve(config.workspaceRoot);
    this.normalizedContainerWorkspaceRoot = config.containerWorkspaceRoot.endsWith("/")
      ? config.containerWorkspaceRoot.slice(0, -1)
      : config.containerWorkspaceRoot;
  }

  static async create(config: BoxliteConfig, logger: GatewayLogger): Promise<BoxliteExecutor> {
    const runtime = await BoxliteExecutor.loadRuntime();
    return new BoxliteExecutor(config, runtime, logger);
  }

  async exec(command: string, cwd: string, options: ExecOptions = {}): Promise<ExecResult> {
    if (this.closed) {
      throw new Error("BoxliteExecutor is closed");
    }

    const startedAt = Date.now();
    const context = this.parseExecutionContext(cwd, options.env);
    const key = this.resolveBoxKey(context.conversationKey, context.projectRoot);
    const boxEntry = await this.getOrCreateBox(key, context.projectRoot);
    const guestCwd = this.toContainerPath(cwd, context.projectRoot);
    const wrapped = `cd ${shellEscape(guestCwd)} && ${command}`;

    this.logger.info(
      {
        boxKey: key,
        boxName: boxEntry.name,
        projectRoot: context.projectRoot,
        hostCwd: resolve(cwd),
        guestCwd,
        commandPreview: summarizeCommand(command),
        reuseMode: this.config.reuseMode,
      },
      "BoxLite execution starting",
    );

    const execution = await boxEntry.box.exec("sh", ["-lc", wrapped], toEnvTuples(context.commandEnv), false);

    const stdoutTask = this.readExecutionStream(async () => execution.stdout());
    const stderrTask = this.readExecutionStream(async () => execution.stderr());

    const cancellation = this.createCancellation(options, async () => {
      await this.stopAndInvalidate(key, boxEntry, "execution aborted");
    });

    const waitOutcome = execution
      .wait()
      .then((result) => ({ kind: "result" as const, result }))
      .catch((error) => ({ kind: "error" as const, error }));

    let outcome: Awaited<typeof waitOutcome> | null = null;
    const first = await Promise.race([waitOutcome, cancellation.cancelled.then(() => null)]);
    if (first !== null) {
      outcome = first;
    } else {
      const settled = await Promise.race([
        waitOutcome,
        new Promise<null>((resolveWaitTimeout) => {
          setTimeout(() => resolveWaitTimeout(null), 3000);
        }),
      ]);
      outcome = settled;
    }

    cancellation.dispose();

    const [stdout, stderr] = await Promise.all([stdoutTask, stderrTask]);
    if (cancellation.wasCancelled()) {
      const fallbackCode = outcome?.kind === "result" ? outcome.result.exitCode : -1;
      this.logger.info(
        {
          boxKey: key,
          boxName: boxEntry.name,
          code: fallbackCode,
          killed: true,
          durationMs: Date.now() - startedAt,
          stdoutBytes: Buffer.byteLength(stdout, "utf-8"),
          stderrBytes: Buffer.byteLength(stderr, "utf-8"),
        },
        "BoxLite execution finished",
      );
      return { stdout, stderr, code: fallbackCode, killed: true };
    }

    if (!outcome) {
      throw new Error("BoxLite execution did not finish after cancellation timeout");
    }

    if (outcome.kind === "error") {
      throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
    }

    this.logger.info(
      {
        boxKey: key,
        boxName: boxEntry.name,
        code: outcome.result.exitCode,
        killed: false,
        durationMs: Date.now() - startedAt,
        stdoutBytes: Buffer.byteLength(stdout, "utf-8"),
        stderrBytes: Buffer.byteLength(stderr, "utf-8"),
      },
      "BoxLite execution finished",
    );

    return {
      stdout,
      stderr,
      code: outcome.result.exitCode,
      killed: false,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    const keys = [...this.boxes.keys()];
    await Promise.all(keys.map((key) => this.stopAndInvalidate(key, undefined, "executor shutdown")));

    if (typeof this.runtime.shutdown === "function") {
      try {
        await this.runtime.shutdown(10);
      } catch (error) {
        this.logger.warn({ err: error }, "Failed to shutdown BoxLite runtime cleanly");
      }
    }

    if (typeof this.runtime.close === "function") {
      try {
        this.runtime.close();
      } catch (error) {
        this.logger.warn({ err: error }, "Failed to close BoxLite runtime handle");
      }
    }
  }

  private parseExecutionContext(
    cwd: string,
    env: NodeJS.ProcessEnv | undefined,
  ): {
    conversationKey?: string;
    projectRoot: string;
    commandEnv: NodeJS.ProcessEnv | undefined;
  } {
    const copiedEnv: NodeJS.ProcessEnv | undefined = env ? { ...env } : undefined;
    const conversationKey = copiedEnv?.[BOXLITE_CONTEXT_CONVERSATION_KEY_ENV];
    const projectRootRaw = copiedEnv?.[BOXLITE_CONTEXT_PROJECT_ROOT_ENV] ?? this.normalizedWorkspaceRoot;

    if (copiedEnv) {
      delete copiedEnv[BOXLITE_CONTEXT_CONVERSATION_KEY_ENV];
      delete copiedEnv[BOXLITE_CONTEXT_PROJECT_ROOT_ENV];
    }

    const projectRoot = resolve(projectRootRaw);
    this.assertWithinRoot(projectRoot, this.normalizedWorkspaceRoot, "project root");
    this.assertWithinRoot(cwd, projectRoot, "cwd");

    return {
      ...(conversationKey ? { conversationKey } : {}),
      projectRoot,
      commandEnv: copiedEnv,
    };
  }

  private resolveBoxKey(conversationKey: string | undefined, projectRoot: string): string {
    if (this.config.reuseMode === "conversation") {
      if (conversationKey && conversationKey.length > 0) {
        return `conversation:${conversationKey}`;
      }

      if (!this.warnedMissingConversationContext) {
        this.warnedMissingConversationContext = true;
        this.logger.warn(
          {
            envKey: BOXLITE_CONTEXT_CONVERSATION_KEY_ENV,
          },
          "Missing BoxLite conversation context; falling back to workspace-level box reuse",
        );
      }
    }

    return `workspace:${projectRoot}`;
  }

  private async getOrCreateBox(key: string, projectRoot: string): Promise<BoxEntry> {
    const existing = this.boxes.get(key);
    if (existing) {
      if (existing.projectRoot === projectRoot) {
        await this.probeBox(existing);
        return existing;
      }
      await this.stopAndInvalidate(key, existing, "project root changed");
    }

    const name = boxNameFromKey(key);
    const boxOptions: Record<string, unknown> = {
      image: this.config.image,
      autoRemove: this.config.autoRemove,
      workingDir: this.normalizedContainerWorkspaceRoot,
      volumes: [
        {
          hostPath: projectRoot,
          guestPath: this.normalizedContainerWorkspaceRoot,
          readOnly: false,
        },
      ],
      security: mapSecurityProfile(this.config.securityProfile),
    };

    if (this.config.cpus !== undefined) {
      boxOptions.cpus = this.config.cpus;
    }
    if (this.config.memoryMib !== undefined) {
      boxOptions.memoryMib = this.config.memoryMib;
    }

    let boxHandle: unknown;
    if (typeof this.runtime.getOrCreate === "function") {
      const result = await this.runtime.getOrCreate(boxOptions, name);
      boxHandle = this.extractBoxFromGetOrCreateResult(result);
    } else if (typeof this.runtime.create === "function") {
      boxHandle = await this.runtime.create(boxOptions, name);
    } else {
      throw new Error("BoxLite runtime does not expose create/getOrCreate");
    }

    const box = this.assertBoxHandle(boxHandle);
    const created: BoxEntry = { key, name, projectRoot, box };
    this.boxes.set(key, created);
    this.logger.info(
      {
        boxKey: key,
        boxName: name,
        image: this.config.image,
        projectRoot,
        containerWorkspaceRoot: this.normalizedContainerWorkspaceRoot,
        autoRemove: this.config.autoRemove,
        securityProfile: this.config.securityProfile,
      },
      "BoxLite box ready",
    );
    await this.probeBox(created);
    return created;
  }

  private async probeBox(entry: BoxEntry): Promise<void> {
    if (this.probedBoxKeys.has(entry.key)) return;
    this.probedBoxKeys.add(entry.key);

    try {
      const execution = await entry.box.exec("sh", ["-lc", "uname -s && pwd"], undefined, false);
      const [stdout, stderr, result] = await Promise.all([
        this.readExecutionStream(async () => execution.stdout()),
        this.readExecutionStream(async () => execution.stderr()),
        execution.wait(),
      ]);

      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const kernel = lines[0] ?? "";
      const cwd = lines[1] ?? "";
      const expected = this.normalizedContainerWorkspaceRoot;
      const looksGuestCwd = cwd === expected || cwd.startsWith(`${expected}/`);
      const looksIsolated = result.exitCode === 0 && kernel === "Linux" && looksGuestCwd;

      if (looksIsolated) {
        this.logger.info(
          {
            boxKey: entry.key,
            boxName: entry.name,
            kernel,
            cwd,
          },
          "BoxLite isolation probe passed",
        );
        return;
      }

      this.logger.warn(
        {
          boxKey: entry.key,
          boxName: entry.name,
          exitCode: result.exitCode,
          kernel,
          cwd,
          expectedWorkspaceRoot: expected,
          stderr: stderr.trim(),
        },
        "BoxLite isolation probe indicates non-guest execution",
      );
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          boxKey: entry.key,
          boxName: entry.name,
        },
        "BoxLite isolation probe failed",
      );
    }
  }

  private extractBoxFromGetOrCreateResult(result: unknown): unknown {
    if (result && typeof result === "object") {
      const asRecord = result as Record<string, unknown>;
      if (asRecord.box) {
        return asRecord.box;
      }
    }

    return result;
  }

  private assertBoxHandle(value: unknown): BoxEntry["box"] {
    if (!value || typeof value !== "object") {
      throw new Error("BoxLite runtime returned an invalid box handle");
    }

    const maybeBox = value as Record<string, unknown>;
    if (typeof maybeBox.exec !== "function" || typeof maybeBox.stop !== "function") {
      throw new Error("BoxLite runtime returned a box without exec/stop methods");
    }

    return maybeBox as unknown as BoxEntry["box"];
  }

  private async stopAndInvalidate(key: string, expected: BoxEntry | undefined, reason: string): Promise<void> {
    const current = this.boxes.get(key);
    if (!current) return;
    if (expected && current !== expected) return;

    const existingStop = this.stopping.get(key);
    if (existingStop) {
      await existingStop;
      return;
    }

    this.boxes.delete(key);
    this.probedBoxKeys.delete(key);
    const stopPromise = (async () => {
      try {
        await current.box.stop();
      } catch (error) {
        this.logger.warn({ err: error, key, reason }, "Failed to stop BoxLite box");
      }

      if (typeof this.runtime.remove === "function") {
        try {
          await this.runtime.remove(current.name, true);
        } catch (error) {
          this.logger.debug({ err: error, key, boxName: current.name }, "Failed to remove BoxLite box (ignored)");
        }
      }
    })().finally(() => {
      this.stopping.delete(key);
    });

    this.stopping.set(key, stopPromise);
    await stopPromise;
  }

  private createCancellation(options: ExecOptions, onCancel: () => Promise<void>): CancellationHandle {
    let cancelled = false;
    let resolved = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    let resolveCancelled!: () => void;

    const cancelledPromise = new Promise<void>((resolvePromise) => {
      resolveCancelled = resolvePromise;
    });

    const triggerCancel = async () => {
      if (resolved) return;
      resolved = true;
      cancelled = true;

      try {
        await onCancel();
      } catch (error) {
        this.logger.warn({ err: error }, "Failed during BoxLite cancellation handling");
      } finally {
        resolveCancelled();
      }
    };

    if (options.timeoutSeconds && options.timeoutSeconds > 0) {
      timeoutHandle = setTimeout(() => {
        void triggerCancel();
      }, options.timeoutSeconds * 1000);
    }

    if (options.signal) {
      abortHandler = () => {
        void triggerCancel();
      };

      if (options.signal.aborted) {
        void triggerCancel();
      } else {
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    return {
      cancelled: cancelledPromise,
      wasCancelled: () => cancelled,
      dispose: () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (options.signal && abortHandler) {
          options.signal.removeEventListener("abort", abortHandler);
        }
      },
    };
  }

  private async readExecutionStream(
    streamFactory: () => Promise<{ next: () => Promise<string | null> }>,
  ): Promise<string> {
    let stream: { next: () => Promise<string | null> } | null = null;
    try {
      stream = await streamFactory();
    } catch {
      return "";
    }

    const chunks: string[] = [];
    try {
      while (true) {
        const chunk = await stream.next();
        if (chunk === null) break;
        chunks.push(chunk);
      }
    } catch {
      // Ignore stream read errors; wait result is the source of truth for execution status.
    }

    return chunks.join("");
  }

  private toContainerPath(hostPath: string, projectRoot: string): string {
    const resolved = resolve(hostPath);
    this.assertWithinRoot(resolved, projectRoot, "cwd");

    const relativePrefix = normalizePrefix(projectRoot);
    const relative = resolved === projectRoot ? "" : resolved.slice(relativePrefix.length).replaceAll("\\", "/");

    return relative.length > 0 ? `${this.normalizedContainerWorkspaceRoot}/${relative}` : this.normalizedContainerWorkspaceRoot;
  }

  private assertWithinRoot(pathToCheck: string, rootDir: string, label: string): void {
    const normalizedRoot = resolve(rootDir);
    const normalizedPath = resolve(pathToCheck);
    const rootPrefix = normalizePrefix(normalizedRoot);

    if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(rootPrefix)) {
      throw new Error(`Resolved ${label} '${normalizedPath}' is outside allowed root '${normalizedRoot}'`);
    }
  }

  private static async loadRuntime(): Promise<NativeRuntime> {
    try {
      const boxliteModule = await import("@boxlite-ai/boxlite");
      const getNativeModule = (boxliteModule as { getNativeModule?: () => unknown }).getNativeModule;
      if (typeof getNativeModule !== "function") {
        throw new Error("getNativeModule export not found");
      }

      const native = getNativeModule() as { JsBoxlite?: { withDefaultConfig?: () => NativeRuntime } };
      if (!native?.JsBoxlite?.withDefaultConfig) {
        throw new Error("JsBoxlite.withDefaultConfig is not available");
      }

      return native.JsBoxlite.withDefaultConfig();
    } catch (error) {
      throw new Error(formatBoxliteInitError(error));
    }
  }
}
