import { loadGatewayConfig } from "../../core/routing.js";
import type { GatewayConfig } from "../../core/types.js";
import { loadCronConfig } from "../../cron/config.js";
import { computeInitialNextRunAtMs, describeSchedule } from "../../cron/schedule.js";
import { CronStore } from "../../cron/store.js";
import type { JobSchedule, ScheduledJob } from "../../cron/types.js";
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

function printMarkdown(lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}

function formatCode(value: string): string {
  return `\`${value}\``;
}

function formatTimestamp(timestampMs?: number): string {
  return timestampMs !== undefined ? formatCode(new Date(timestampMs).toISOString()) : "-";
}

function formatDelivery(job: ScheduledJob): string {
  const segments = [
    job.delivery.connectorId,
    job.delivery.routeId,
    job.delivery.channelId,
    ...(job.delivery.threadId ? [job.delivery.threadId] : []),
  ];
  return formatCode(segments.join("/"));
}

function buildJobMarkdown(job: ScheduledJob, headingLevel = 3): string[] {
  const heading = `${"#".repeat(headingLevel)} ${formatCode(job.id)}`;
  const lines = [
    heading,
    `- name: ${job.name}`,
    `- state: ${job.enabled ? "enabled" : "paused"}`,
    `- schedule: ${formatCode(describeSchedule(job.schedule))}`,
    `- next run: ${formatTimestamp(job.state.nextRunAtMs)}`,
    `- last run: ${formatTimestamp(job.state.lastRunAtMs)}`,
    `- last status: ${job.state.lastStatus ?? "-"}`,
    `- delivery: ${formatDelivery(job)}`,
  ];

  if (job.state.manualRunRequestedAtMs !== undefined) {
    lines.push(`- manual run queued at: ${formatTimestamp(job.state.manualRunRequestedAtMs)}`);
  }
  if (job.state.lastError) {
    lines.push(`- last error: ${job.state.lastError}`);
  }

  return lines;
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

  const job: ScheduledJob = {
    id,
    name: options.name,
    enabled: true,
    schedule,
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
  printMarkdown([
    "## Cron Job Added",
    `- id: ${formatCode(job.id)}`,
    `- name: ${job.name}`,
    `- schedule: ${formatCode(describeSchedule(job.schedule))}`,
    `- delivery: ${formatDelivery(job)}`,
    `- cron config: ${formatCode(context.cronConfigPath)}`,
  ]);
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
    printMarkdown([
      "## Cron Jobs",
      "",
      "_No cron jobs configured._",
      "",
      `- cron config: ${formatCode(context.cronConfigPath)}`,
    ]);
    return;
  }

  const lines = [
    "## Cron Jobs",
    "",
    `- cron config: ${formatCode(context.cronConfigPath)}`,
    `- total jobs: ${jobs.length}`,
  ];
  for (const job of jobs) {
    lines.push("", ...buildJobMarkdown(job));
  }
  printMarkdown(lines);
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
    printMarkdown([
      "## Cron Job Status",
      ...buildJobMarkdown(target, 3),
      "",
      `- cron config: ${formatCode(context.cronConfigPath)}`,
    ]);
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
    updatedAtMs: now,
    state: {
      ...current.state,
      manualRunRequestedAtMs: current.state.manualRunRequestedAtMs ?? now,
    },
  }));
  printMarkdown([
    "## Cron Job Run Queued",
    `- id: ${formatCode(options.jobId)}`,
    "- action: queued one immediate execution",
    "- enabled state: unchanged",
    "- schedule: unchanged",
    `- note: Ensure ${formatCode("dobby start")} is running so the queued execution can be consumed.`,
  ]);
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
  const hasScheduleUpdate = options.at !== undefined
    || options.everyMs !== undefined
    || options.cronExpr !== undefined
    || options.tz !== undefined;

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

    let schedule = current.schedule;
    if (hasScheduleUpdate) {
      const hasExplicitScheduleVariant = options.at !== undefined
        || options.everyMs !== undefined
        || options.cronExpr !== undefined;
      if (hasExplicitScheduleVariant) {
        schedule = parseSchedule({
          ...(options.at ? { at: options.at } : {}),
          ...(options.everyMs !== undefined ? { everyMs: options.everyMs } : {}),
          ...(options.cronExpr ? { cronExpr: options.cronExpr } : {}),
          ...(options.tz ? { tz: options.tz } : {}),
        });
      } else if (options.tz !== undefined) {
        if (current.schedule.kind !== "cron") {
          throw new Error("--tz can only be updated for cron schedules or together with --cron");
        }
        schedule = {
          kind: "cron",
          expr: current.schedule.expr,
          ...(options.tz ? { tz: options.tz } : {}),
        };
      }
    }

    const nextRunAtMs = hasScheduleUpdate
      ? computeInitialNextRunAtMs(schedule, now)
      : current.state.nextRunAtMs;
    const nextState = {
      ...current.state,
    };
    if (hasScheduleUpdate) {
      if (nextRunAtMs === undefined) {
        delete nextState.nextRunAtMs;
      } else {
        nextState.nextRunAtMs = nextRunAtMs;
      }
    }

    const nextJob: ScheduledJob = {
      ...current,
      name: options.name ?? current.name,
      prompt: options.prompt ?? current.prompt,
      schedule,
      delivery: updatedDelivery,
      updatedAtMs: now,
      state: nextState,
    };
    return nextJob;
  });

  printMarkdown([
    "## Cron Job Updated",
    `- id: ${formatCode(options.jobId)}`,
  ]);
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
  printMarkdown([
    "## Cron Job Removed",
    `- id: ${formatCode(options.jobId)}`,
  ]);
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
  printMarkdown([
    "## Cron Job Paused",
    `- id: ${formatCode(options.jobId)}`,
    "- state: paused",
  ]);
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
  printMarkdown([
    "## Cron Job Resumed",
    `- id: ${formatCode(options.jobId)}`,
    "- state: enabled",
  ]);
}
