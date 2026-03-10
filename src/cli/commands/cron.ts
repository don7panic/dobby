import { loadGatewayConfig } from "../../core/routing.js";
import type { GatewayConfig } from "../../core/types.js";
import { loadCronConfig } from "../../cron/config.js";
import { computeInitialNextRunAtMs, describeSchedule } from "../../cron/schedule.js";
import { CronStore } from "../../cron/store.js";
import type { CronSessionPolicy, JobSchedule, ScheduledJob } from "../../cron/types.js";
import { resolveConfigPath } from "../shared/config-io.js";
import { createLogger } from "../shared/runtime.js";

interface CronCommandSharedOptions {
  cronConfigPath?: string;
}

interface LoadedCronContext {
  configPath: string;
  gatewayConfig: GatewayConfig;
  cronConfigPath: string;
  store: CronStore;
}

interface ScheduleInput {
  at?: string;
  everyMs?: number;
  cronExpr?: string;
  tz?: string;
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "job";
}

function parseSchedule(input: ScheduleInput): JobSchedule {
  const variants = [input.at ? "at" : null, input.everyMs !== undefined ? "every" : null, input.cronExpr ? "cron" : null]
    .filter((item): item is "at" | "every" | "cron" => item !== null);
  if (variants.length !== 1) {
    throw new Error("Exactly one schedule option is required: --at | --every-ms | --cron");
  }

  if (input.at) {
    return { kind: "at", at: input.at };
  }

  if (input.everyMs !== undefined) {
    if (!Number.isFinite(input.everyMs) || input.everyMs <= 0) {
      throw new Error("--every-ms must be a positive integer");
    }
    return { kind: "every", everyMs: Math.floor(input.everyMs) };
  }

  if (!input.cronExpr) {
    throw new Error("Missing --cron expression");
  }

  return {
    kind: "cron",
    expr: input.cronExpr,
    ...(input.tz ? { tz: input.tz } : {}),
  };
}

function parseSessionPolicy(value: CronSessionPolicy | string | undefined): CronSessionPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "stateless" || value === "shared-session") {
    return value;
  }
  throw new Error(`Invalid session policy '${value}'. Expected 'stateless' or 'shared-session'.`);
}

function assertDeliveryReferences(
  config: GatewayConfig,
  input: {
    connectorId: string;
    routeId: string;
  },
): void {
  if (!config.connectors.items[input.connectorId]) {
    throw new Error(`Unknown connectorId '${input.connectorId}'`);
  }
  if (!config.routes.items[input.routeId]) {
    throw new Error(`Unknown routeId '${input.routeId}'`);
  }
}

async function loadCronContext(options?: CronCommandSharedOptions): Promise<LoadedCronContext> {
  const configPath = resolveConfigPath();
  const gatewayConfig = await loadGatewayConfig(configPath);
  const loadedCronConfig = await loadCronConfig({
    gatewayConfigPath: configPath,
    gatewayConfig,
    ...(options?.cronConfigPath ? { explicitCronConfigPath: options.cronConfigPath } : {}),
  });

  const logger = createLogger();
  const store = new CronStore(loadedCronConfig.config.storeFile, loadedCronConfig.config.runLogFile, logger);
  await store.load();

  return {
    configPath,
    gatewayConfig,
    cronConfigPath: loadedCronConfig.configPath,
    store,
  };
}

export async function runCronAddCommand(options: {
  name: string;
  prompt: string;
  connectorId: string;
  routeId: string;
  channelId: string;
  threadId?: string;
  sessionPolicy?: CronSessionPolicy;
  at?: string;
  everyMs?: number;
  cronExpr?: string;
  tz?: string;
  cronConfigPath?: string;
}): Promise<void> {
  const context = await loadCronContext(
    options.cronConfigPath ? { cronConfigPath: options.cronConfigPath } : undefined,
  );
  assertDeliveryReferences(context.gatewayConfig, {
    connectorId: options.connectorId,
    routeId: options.routeId,
  });

  const schedule = parseSchedule({
    ...(options.at ? { at: options.at } : {}),
    ...(options.everyMs !== undefined ? { everyMs: options.everyMs } : {}),
    ...(options.cronExpr ? { cronExpr: options.cronExpr } : {}),
    ...(options.tz ? { tz: options.tz } : {}),
  });
  const now = Date.now();
  const nextRunAtMs = computeInitialNextRunAtMs(schedule, now);
  const id = `${slugify(options.name)}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionPolicy = parseSessionPolicy(options.sessionPolicy) ?? "stateless";

  const job: ScheduledJob = {
    id,
    name: options.name,
    enabled: true,
    schedule,
    sessionPolicy,
    prompt: options.prompt,
    delivery: {
      connectorId: options.connectorId,
      routeId: options.routeId,
      channelId: options.channelId,
      ...(options.threadId ? { threadId: options.threadId } : {}),
    },
    createdAtMs: now,
    updatedAtMs: now,
    state: {
      ...(nextRunAtMs !== undefined ? { nextRunAtMs } : {}),
      consecutiveErrors: 0,
    },
  };

  await context.store.upsertJob(job);
  console.log(`Added cron job ${job.id}`);
  console.log(`- schedule: ${describeSchedule(job.schedule)}`);
  console.log(`- delivery: ${job.delivery.connectorId}/${job.delivery.routeId}/${job.delivery.channelId}`);
  console.log(`- cron config: ${context.cronConfigPath}`);
}

export async function runCronListCommand(options: {
  cronConfigPath?: string;
  json?: boolean;
}): Promise<void> {
  const context = await loadCronContext(
    options.cronConfigPath ? { cronConfigPath: options.cronConfigPath } : undefined,
  );
  const jobs = context.store.listJobs();

  if (options.json) {
    console.log(JSON.stringify({ jobs, cronConfigPath: context.cronConfigPath }, null, 2));
    return;
  }

  if (jobs.length === 0) {
    console.log(`No cron jobs configured (${context.cronConfigPath})`);
    return;
  }

  console.log(`Cron jobs (${context.cronConfigPath}):`);
  for (const job of jobs) {
    const next = job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : "-";
    const last = job.state.lastRunAtMs ? new Date(job.state.lastRunAtMs).toISOString() : "-";
    const schedule = describeSchedule(job.schedule);
    console.log(`- ${job.id} [${job.enabled ? "enabled" : "paused"}] ${job.name}`);
    console.log(`  schedule=${schedule}`);
    console.log(`  next=${next} last=${last} status=${job.state.lastStatus ?? "-"}`);
    console.log(`  delivery=${job.delivery.connectorId}/${job.delivery.routeId}/${job.delivery.channelId}`);
  }
}

export async function runCronStatusCommand(options: {
  jobId?: string;
  cronConfigPath?: string;
  json?: boolean;
}): Promise<void> {
  const context = await loadCronContext(
    options.cronConfigPath ? { cronConfigPath: options.cronConfigPath } : undefined,
  );
  const target = options.jobId ? context.store.getJob(options.jobId) : null;

  if (options.jobId && !target) {
    throw new Error(`Cron job '${options.jobId}' does not exist`);
  }

  if (options.json) {
    if (target) {
      console.log(JSON.stringify(target, null, 2));
      return;
    }
    console.log(JSON.stringify(context.store.listJobs(), null, 2));
    return;
  }

  if (target) {
    console.log(`Cron status for ${target.id}`);
    console.log(`- name: ${target.name}`);
    console.log(`- enabled: ${target.enabled}`);
    console.log(`- schedule: ${describeSchedule(target.schedule)}`);
    console.log(`- sessionPolicy: ${target.sessionPolicy ?? "stateless"}`);
    console.log(`- nextRun: ${target.state.nextRunAtMs ? new Date(target.state.nextRunAtMs).toISOString() : "-"}`);
    console.log(`- lastRun: ${target.state.lastRunAtMs ? new Date(target.state.lastRunAtMs).toISOString() : "-"}`);
    console.log(`- lastStatus: ${target.state.lastStatus ?? "-"}`);
    if (target.state.lastError) {
      console.log(`- lastError: ${target.state.lastError}`);
    }
    return;
  }

  await runCronListCommand({
    ...(options.cronConfigPath ? { cronConfigPath: options.cronConfigPath } : {}),
    json: false,
  });
}

export async function runCronRunCommand(options: {
  jobId: string;
  cronConfigPath?: string;
}): Promise<void> {
  const context = await loadCronContext(
    options.cronConfigPath ? { cronConfigPath: options.cronConfigPath } : undefined,
  );
  const now = Date.now();
  await context.store.updateJob(options.jobId, (current) => ({
    ...current,
    enabled: true,
    updatedAtMs: now,
    state: {
      ...current.state,
      nextRunAtMs: now,
    },
  }));
  console.log(`Scheduled cron job ${options.jobId} to run on next scheduler tick.`);
  console.log("Ensure the gateway process is running for execution.");
}

export async function runCronUpdateCommand(options: {
  jobId: string;
  name?: string;
  prompt?: string;
  connectorId?: string;
  routeId?: string;
  channelId?: string;
  threadId?: string;
  clearThread?: boolean;
  sessionPolicy?: CronSessionPolicy;
  at?: string;
  everyMs?: number;
  cronExpr?: string;
  tz?: string;
  cronConfigPath?: string;
}): Promise<void> {
  const context = await loadCronContext(
    options.cronConfigPath ? { cronConfigPath: options.cronConfigPath } : undefined,
  );
  const now = Date.now();
  const hasScheduleUpdate = options.at !== undefined || options.everyMs !== undefined || options.cronExpr !== undefined;
  const nextSchedule = hasScheduleUpdate
    ? parseSchedule({
      ...(options.at ? { at: options.at } : {}),
      ...(options.everyMs !== undefined ? { everyMs: options.everyMs } : {}),
      ...(options.cronExpr ? { cronExpr: options.cronExpr } : {}),
      ...(options.tz ? { tz: options.tz } : {}),
    })
    : null;

  await context.store.updateJob(options.jobId, (current) => {
    const updatedDelivery: ScheduledJob["delivery"] = {
      connectorId: options.connectorId ?? current.delivery.connectorId,
      routeId: options.routeId ?? current.delivery.routeId,
      channelId: options.channelId ?? current.delivery.channelId,
    };
    const resolvedThreadId = options.clearThread ? undefined : (options.threadId ?? current.delivery.threadId);
    if (resolvedThreadId !== undefined) {
      updatedDelivery.threadId = resolvedThreadId;
    }

    assertDeliveryReferences(context.gatewayConfig, {
      connectorId: updatedDelivery.connectorId,
      routeId: updatedDelivery.routeId,
    });

    const schedule = nextSchedule ?? current.schedule;
    const nextRunAtMs = nextSchedule
      ? computeInitialNextRunAtMs(schedule, now)
      : current.state.nextRunAtMs;
    const nextState = {
      ...current.state,
    };
    if (nextSchedule) {
      if (nextRunAtMs === undefined) {
        delete nextState.nextRunAtMs;
      } else {
        nextState.nextRunAtMs = nextRunAtMs;
      }
    }

    const parsedSessionPolicy = parseSessionPolicy(options.sessionPolicy);
    const nextJob: ScheduledJob = {
      ...current,
      name: options.name ?? current.name,
      prompt: options.prompt ?? current.prompt,
      schedule,
      delivery: updatedDelivery,
      updatedAtMs: now,
      state: nextState,
    };
    const nextSessionPolicy = parsedSessionPolicy ?? current.sessionPolicy;
    if (nextSessionPolicy !== undefined) {
      nextJob.sessionPolicy = nextSessionPolicy;
    } else {
      delete nextJob.sessionPolicy;
    }

    return nextJob;
  });

  console.log(`Updated cron job ${options.jobId}`);
}

export async function runCronRemoveCommand(options: {
  jobId: string;
  cronConfigPath?: string;
}): Promise<void> {
  const context = await loadCronContext(
    options.cronConfigPath ? { cronConfigPath: options.cronConfigPath } : undefined,
  );
  const removed = await context.store.removeJob(options.jobId);
  if (!removed) {
    throw new Error(`Cron job '${options.jobId}' does not exist`);
  }
  console.log(`Removed cron job ${options.jobId}`);
}

export async function runCronPauseCommand(options: {
  jobId: string;
  cronConfigPath?: string;
}): Promise<void> {
  const context = await loadCronContext(
    options.cronConfigPath ? { cronConfigPath: options.cronConfigPath } : undefined,
  );
  const now = Date.now();
  await context.store.updateJob(options.jobId, (current) => ({
    ...current,
    enabled: false,
    updatedAtMs: now,
  }));
  console.log(`Paused cron job ${options.jobId}`);
}

export async function runCronResumeCommand(options: {
  jobId: string;
  cronConfigPath?: string;
}): Promise<void> {
  const context = await loadCronContext(
    options.cronConfigPath ? { cronConfigPath: options.cronConfigPath } : undefined,
  );
  const now = Date.now();
  await context.store.updateJob(options.jobId, (current) => {
    const nextState = {
      ...current.state,
    };
    const nextRunAtMs = computeInitialNextRunAtMs(current.schedule, now);
    if (nextRunAtMs === undefined) {
      delete nextState.nextRunAtMs;
    } else {
      nextState.nextRunAtMs = nextRunAtMs;
    }

    return {
      ...current,
      enabled: true,
      updatedAtMs: now,
      state: nextState,
    };
  });
  console.log(`Resumed cron job ${options.jobId}`);
}
