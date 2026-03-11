import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCronRunCommand } from "../commands/cron.js";
import { CronService } from "../../cron/service.js";
import { CronStore } from "../../cron/store.js";
import type { GatewayLogger } from "../../core/types.js";
import type { Gateway, ScheduledExecutionRequest } from "../../core/gateway.js";
import type { ScheduledJob } from "../../cron/types.js";

function createLogger(): GatewayLogger {
  return {
    error() {},
    warn() {},
    info() {},
    debug() {},
  } as unknown as GatewayLogger;
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for expected condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function validGatewayConfig(dataRootDir: string): Record<string, unknown> {
  return {
    extensions: { allowList: [] },
    providers: {
      default: "pi.main",
      items: {
        "pi.main": {
          type: "provider.pi",
        },
      },
    },
    connectors: {
      items: {
        "discord.main": {
          type: "connector.discord",
          botName: "dobby-main",
          botToken: "token",
        },
      },
    },
    sandboxes: {
      default: "host.builtin",
      items: {},
    },
    routes: {
      default: {
        provider: "pi.main",
        sandbox: "host.builtin",
        tools: "full",
        mentions: "required",
      },
      items: {
        main: {
          projectRoot: "./workspace/project-a",
        },
      },
    },
    bindings: {
      items: {
        "discord.main.main": {
          connector: "discord.main",
          source: {
            type: "channel",
            id: "123",
          },
          route: "main",
        },
      },
    },
    data: {
      rootDir: dataRootDir,
      dedupTtlMs: 604800000,
    },
  };
}

function createJob(overrides: Partial<ScheduledJob> & Pick<ScheduledJob, "id" | "name">): ScheduledJob {
  const { id, name, state, ...rest } = overrides;
  const defaultState: ScheduledJob["state"] = {
    consecutiveErrors: 0,
  };
  return {
    id,
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    prompt: "Ping",
    delivery: {
      connectorId: "discord.main",
      routeId: "main",
      channelId: "123",
    },
    createdAtMs: 1,
    updatedAtMs: 1,
    ...rest,
    state: {
      ...defaultState,
      ...state,
    },
  };
}

test("cron run queues one manual execution without resuming a paused job", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dobby-cron-run-"));
  const gatewayConfigPath = join(dir, "gateway.json");
  const cronConfigPath = join(dir, "cron.json");
  const storeFile = join(dir, "cron-jobs.json");
  const runLogFile = join(dir, "cron-runs.jsonl");
  const logger = createLogger();
  const store = new CronStore(storeFile, runLogFile, logger);
  const previousConfigPath = process.env.DOBBY_CONFIG_PATH;
  const originalConsoleLog = console.log;

  try {
    await writeFile(gatewayConfigPath, `${JSON.stringify(validGatewayConfig(join(dir, "data")), null, 2)}\n`, "utf-8");
    await writeFile(
      cronConfigPath,
      `${JSON.stringify({
        enabled: true,
        storeFile,
        runLogFile,
        pollIntervalMs: 60_000,
        maxConcurrentRuns: 2,
        runMissedOnStartup: true,
        jobTimeoutMs: 60_000,
      }, null, 2)}\n`,
      "utf-8",
    );

    await store.upsertJob(createJob({
      id: "nightly-report",
      name: "nightly-report",
      enabled: false,
      state: {
        nextRunAtMs: 9_999_999,
        consecutiveErrors: 0,
      },
    }));

    process.env.DOBBY_CONFIG_PATH = gatewayConfigPath;
    console.log = () => {};

    await runCronRunCommand({
      jobId: "nightly-report",
      cronConfigPath,
    });

    await store.load();
    const updated = store.getJob("nightly-report");
    assert.ok(updated);
    assert.equal(updated.enabled, false);
    assert.equal(updated.state.nextRunAtMs, 9_999_999);
    assert.equal(typeof updated.state.manualRunRequestedAtMs, "number");
  } finally {
    console.log = originalConsoleLog;
    if (previousConfigPath === undefined) {
      delete process.env.DOBBY_CONFIG_PATH;
    } else {
      process.env.DOBBY_CONFIG_PATH = previousConfigPath;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("CronService immediately refills a freed concurrency slot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dobby-cron-service-"));
  const storeFile = join(dir, "cron-jobs.json");
  const runLogFile = join(dir, "cron-runs.jsonl");
  const logger = createLogger();
  const store = new CronStore(storeFile, runLogFile, logger);
  const now = Date.now() - 1_000;
  const started: string[] = [];
  const releaseFirst = deferred();
  const releaseSecond = deferred();
  const gateway = {
    async handleScheduled(request: ScheduledExecutionRequest): Promise<void> {
      started.push(request.jobId);
      if (request.jobId === "job-a") {
        await releaseFirst.promise;
        return;
      }

      await releaseSecond.promise;
    },
  };
  const service = new CronService({
    config: {
      enabled: true,
      pollIntervalMs: 60_000,
      maxConcurrentRuns: 1,
      runMissedOnStartup: true,
      jobTimeoutMs: 60_000,
      storeFile,
      runLogFile,
    },
    store,
    gateway: gateway as Gateway,
    logger,
  });

  try {
    await store.upsertJob(createJob({
      id: "job-a",
      name: "job-a",
      createdAtMs: 1,
      updatedAtMs: 1,
      state: {
        nextRunAtMs: now,
        consecutiveErrors: 0,
      },
    }));
    await store.upsertJob(createJob({
      id: "job-b",
      name: "job-b",
      createdAtMs: 2,
      updatedAtMs: 2,
      state: {
        nextRunAtMs: now,
        consecutiveErrors: 0,
      },
    }));

    await service.start();
    await waitFor(() => started.includes("job-a"));
    assert.deepEqual(started, ["job-a"]);

    releaseFirst.resolve(undefined);
    await waitFor(() => started.includes("job-b"));
    assert.deepEqual(started, ["job-a", "job-b"]);

    releaseSecond.resolve(undefined);
    await waitFor(() => store.getJob("job-b")?.state.runningAtMs === undefined);
  } finally {
    releaseFirst.resolve(undefined);
    releaseSecond.resolve(undefined);
    await service.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
