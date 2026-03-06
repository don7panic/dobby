import type { Gateway } from "../core/gateway.js";
import type { GatewayLogger } from "../core/types.js";
import { computeBackoffDelayMs, computeInitialNextRunAtMs, computeNextRunAfterSuccessMs } from "./schedule.js";
import { CronStore } from "./store.js";
import type { CronConfig, CronRunLogRecord, ScheduledJob } from "./types.js";

interface CronServiceOptions {
  config: CronConfig;
  store: CronStore;
  gateway: Gateway;
  logger: GatewayLogger;
}

interface ScheduledRunContext {
  runId: string;
  jobId: string;
  scheduledAtMs: number;
}

export class CronService {
  private timer: NodeJS.Timeout | null = null;
  private readonly activeRuns = new Map<string, Promise<void>>();
  private tickInFlight = false;
  private started = false;
  private stopping = false;

  constructor(private readonly options: CronServiceOptions) {}

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.options.store.load();
    await this.recoverOnStartup();

    if (!this.options.config.enabled) {
      this.options.logger.info("Cron scheduler is disabled by config");
      this.started = true;
      return;
    }

    const intervalMs = Math.min(this.options.config.pollIntervalMs, 60_000);
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);

    this.started = true;
    this.options.logger.info(
      {
        pollIntervalMs: intervalMs,
        maxConcurrentRuns: this.options.config.maxConcurrentRuns,
      },
      "Cron scheduler started",
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    await Promise.allSettled(this.activeRuns.values());
    this.activeRuns.clear();
    this.started = false;
  }

  async triggerNow(jobId: string): Promise<void> {
    await this.options.store.load();
    const job = this.options.store.getJob(jobId);
    if (!job) {
      throw new Error(`Cron job '${jobId}' does not exist`);
    }

    await this.enqueueJob(job, Date.now());
    const latestRun = [...this.activeRuns.values()].at(-1);
    if (latestRun) {
      await latestRun;
    }
  }

  private async recoverOnStartup(): Promise<void> {
    const now = Date.now();
    for (const job of this.options.store.listJobs()) {
      let changed = false;
      const next = structuredClone(job);

      if (next.state.runningAtMs !== undefined) {
        next.state.runningAtMs = undefined;
        next.state.lastStatus = "error";
        next.state.lastError = "Recovered stale running state after restart";
        changed = true;
      }

      if (next.state.nextRunAtMs === undefined) {
        next.state.nextRunAtMs = computeInitialNextRunAtMs(next.schedule, now);
        changed = true;
      }

      if (
        this.options.config.runMissedOnStartup
        && next.enabled
        && next.state.nextRunAtMs !== undefined
        && next.state.nextRunAtMs <= now
      ) {
        next.state.nextRunAtMs = now;
        changed = true;
      }

      if (changed) {
        next.updatedAtMs = now;
        await this.options.store.upsertJob(next);
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.stopping || !this.options.config.enabled) {
      return;
    }
    if (this.tickInFlight) {
      return;
    }

    this.tickInFlight = true;
    try {
      // Reload from disk on every tick so CLI mutations (cron run/update/pause/resume)
      // made by a separate process become visible to the long-running scheduler.
      await this.options.store.load();

      const now = Date.now();
      const dueJobs = this.options.store.listJobs().filter((job) =>
        job.enabled
        && job.state.runningAtMs === undefined
        && job.state.nextRunAtMs !== undefined
        && job.state.nextRunAtMs <= now
      );

      for (const job of dueJobs) {
        if (this.activeRuns.size >= this.options.config.maxConcurrentRuns) {
          break;
        }
        await this.enqueueJob(job, now);
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  private async enqueueJob(job: ScheduledJob, now: number): Promise<void> {
    const scheduledAtMs = job.state.nextRunAtMs ?? now;
    const runContext: ScheduledRunContext = {
      runId: `${job.id}:${scheduledAtMs}`,
      jobId: job.id,
      scheduledAtMs,
    };

    await this.options.store.updateJob(job.id, (current) => ({
      ...current,
      updatedAtMs: now,
      state: {
        ...current.state,
        runningAtMs: now,
      },
    }));

    const runPromise = this.executeJobRun(runContext)
      .catch((error) => {
        this.options.logger.warn(
          { err: error, jobId: runContext.jobId, runId: runContext.runId },
          "Cron run failed",
        );
      })
      .finally(() => {
        this.activeRuns.delete(runContext.runId);
      });

    this.activeRuns.set(runContext.runId, runPromise);
  }

  private async executeJobRun(run: ScheduledRunContext): Promise<void> {
    const startedAtMs = Date.now();
    const job = this.options.store.getJob(run.jobId);
    if (!job) {
      return;
    }

    let status: CronRunLogRecord["status"] = "ok";
    let errorMessage: string | undefined;

    try {
      await this.options.gateway.handleScheduled({
        jobId: job.id,
        runId: run.runId,
        prompt: job.prompt,
        connectorId: job.delivery.connectorId,
        routeId: job.delivery.routeId,
        channelId: job.delivery.channelId,
        ...(job.delivery.threadId ? { threadId: job.delivery.threadId } : {}),
        timeoutMs: this.options.config.jobTimeoutMs,
      });
    } catch (error) {
      status = "error";
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    const endedAtMs = Date.now();
    await this.options.store.updateJob(job.id, (current) => {
      const isSuccess = status === "ok";
      const previousErrors = current.state.consecutiveErrors ?? 0;
      const nextErrorCount = isSuccess ? 0 : previousErrors + 1;

      const nextRunAtMs = isSuccess
        ? computeNextRunAfterSuccessMs(current.schedule, endedAtMs)
        : current.schedule.kind === "at"
          ? undefined
          : endedAtMs + computeBackoffDelayMs(nextErrorCount);

      return {
        ...current,
        enabled: current.schedule.kind === "at" ? false : current.enabled,
        updatedAtMs: endedAtMs,
        state: {
          ...current.state,
          runningAtMs: undefined,
          lastRunAtMs: endedAtMs,
          lastStatus: isSuccess ? "ok" : "error",
          lastError: isSuccess ? undefined : errorMessage,
          consecutiveErrors: nextErrorCount,
          nextRunAtMs,
        },
      };
    });

    const runRecord: CronRunLogRecord = {
      runId: run.runId,
      jobId: job.id,
      jobName: job.name,
      startedAtMs,
      endedAtMs,
      status,
      ...(errorMessage ? { error: errorMessage } : {}),
    };
    await this.options.store.appendRunLog(runRecord);
  }
}
