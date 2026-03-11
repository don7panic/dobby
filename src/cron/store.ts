import { access, appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { GatewayLogger } from "../core/types.js";
import type { CronJobsSnapshot, CronRunLogRecord, JobSchedule, ScheduledJob } from "./types.js";

const jobScheduleSchema: z.ZodType<JobSchedule> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("at"),
    at: z.string().min(1),
  }),
  z.object({
    kind: z.literal("every"),
    everyMs: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("cron"),
    expr: z.string().min(1),
    tz: z.string().min(1).optional(),
  }),
]);

const scheduledJobSchema: z.ZodType<ScheduledJob> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  schedule: jobScheduleSchema,
  prompt: z.string(),
  delivery: z.object({
    connectorId: z.string().min(1),
    routeId: z.string().min(1),
    channelId: z.string().min(1),
    threadId: z.string().min(1).optional(),
  }),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  state: z.object({
    nextRunAtMs: z.number().int().nonnegative().optional(),
    manualRunRequestedAtMs: z.number().int().nonnegative().optional(),
    runningAtMs: z.number().int().nonnegative().optional(),
    lastRunAtMs: z.number().int().nonnegative().optional(),
    lastStatus: z.enum(["ok", "error", "skipped"]).optional(),
    lastError: z.string().optional(),
    consecutiveErrors: z.number().int().nonnegative().optional(),
  }),
});

const snapshotSchema = z.object({
  version: z.literal(1),
  jobs: z.array(scheduledJobSchema),
});

function cloneJob(job: ScheduledJob): ScheduledJob {
  return structuredClone(job);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(filePath: string, payload: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tempPath, payload, "utf-8");
  await rename(tempPath, filePath);
}

export class CronStore {
  private readonly jobs = new Map<string, ScheduledJob>();

  constructor(
    private readonly jobsFilePath: string,
    private readonly runLogFilePath: string,
    private readonly logger: GatewayLogger,
  ) {}

  async load(): Promise<void> {
    this.jobs.clear();
    const absolutePath = resolve(this.jobsFilePath);
    if (await fileExists(absolutePath)) {
      try {
        const raw = await readFile(absolutePath, "utf-8");
        const parsed = snapshotSchema.parse(JSON.parse(raw));
        for (const job of parsed.jobs) {
          this.jobs.set(job.id, job);
        }
      } catch (error) {
        this.logger.warn({ err: error, filePath: absolutePath }, "Failed to load cron jobs store; starting empty");
      }
    }
  }

  listJobs(): ScheduledJob[] {
    return [...this.jobs.values()]
      .map((job) => cloneJob(job))
      .sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
  }

  getJob(jobId: string): ScheduledJob | null {
    const found = this.jobs.get(jobId);
    return found ? cloneJob(found) : null;
  }

  async upsertJob(job: ScheduledJob): Promise<void> {
    const normalized = scheduledJobSchema.parse(job);
    this.jobs.set(normalized.id, cloneJob(normalized));
    await this.flush();
  }

  async updateJob(jobId: string, updater: (current: ScheduledJob) => ScheduledJob): Promise<ScheduledJob> {
    const current = this.jobs.get(jobId);
    if (!current) {
      throw new Error(`Cron job '${jobId}' does not exist`);
    }

    const next = scheduledJobSchema.parse(updater(cloneJob(current)));
    this.jobs.set(jobId, cloneJob(next));
    await this.flush();
    return cloneJob(next);
  }

  async removeJob(jobId: string): Promise<boolean> {
    const deleted = this.jobs.delete(jobId);
    if (!deleted) {
      return false;
    }
    await this.flush();
    return true;
  }

  async appendRunLog(record: CronRunLogRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    try {
      await mkdir(dirname(this.runLogFilePath), { recursive: true });
      await appendFile(this.runLogFilePath, line, "utf-8");
    } catch (error) {
      this.logger.warn({ err: error, runLogFilePath: this.runLogFilePath }, "Failed to append cron run log");
    }
  }

  private async flush(): Promise<void> {
    const snapshot: CronJobsSnapshot = {
      version: 1,
      jobs: [...this.jobs.values()]
        .map((job) => cloneJob(job))
        .sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id)),
    };
    await writeAtomic(this.jobsFilePath, `${JSON.stringify(snapshot, null, 2)}\n`);
  }
}
