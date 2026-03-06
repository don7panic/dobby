import { CronExpressionParser } from "cron-parser";
import type { JobSchedule } from "./types.js";

const BACKOFF_STEPS_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000] as const;

function parseAtTimestamp(at: string): number {
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid at schedule timestamp '${at}'`);
  }
  return timestamp;
}

function nextCronAtMs(expr: string, currentDateMs: number, tz?: string): number {
  const parsed = CronExpressionParser.parse(expr, {
    currentDate: new Date(currentDateMs),
    ...(tz ? { tz } : {}),
  });
  return parsed.next().toDate().getTime();
}

export function computeInitialNextRunAtMs(schedule: JobSchedule, nowMs: number): number | undefined {
  if (schedule.kind === "at") {
    return parseAtTimestamp(schedule.at);
  }

  if (schedule.kind === "every") {
    return nowMs + schedule.everyMs;
  }

  return nextCronAtMs(schedule.expr, nowMs, schedule.tz);
}

export function computeNextRunAfterSuccessMs(schedule: JobSchedule, nowMs: number): number | undefined {
  if (schedule.kind === "at") {
    return undefined;
  }

  if (schedule.kind === "every") {
    return nowMs + schedule.everyMs;
  }

  return nextCronAtMs(schedule.expr, nowMs, schedule.tz);
}

export function computeBackoffDelayMs(consecutiveErrors: number): number {
  const safeErrors = Number.isFinite(consecutiveErrors) && consecutiveErrors > 0 ? Math.floor(consecutiveErrors) : 1;
  const index = Math.min(safeErrors - 1, BACKOFF_STEPS_MS.length - 1);
  const fallback = BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1] as number;
  return BACKOFF_STEPS_MS[index] ?? fallback;
}

export function describeSchedule(schedule: JobSchedule): string {
  if (schedule.kind === "at") {
    return `at ${schedule.at}`;
  }
  if (schedule.kind === "every") {
    return `every ${schedule.everyMs}ms`;
  }
  return schedule.tz ? `cron '${schedule.expr}' (tz=${schedule.tz})` : `cron '${schedule.expr}'`;
}
