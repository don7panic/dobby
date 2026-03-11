export type JobSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number }
  | { kind: "cron"; expr: string; tz?: string | undefined };

export interface JobDelivery {
  connectorId: string;
  routeId: string;
  channelId: string;
  threadId?: string | undefined;
}

export interface ScheduledJobState {
  nextRunAtMs?: number | undefined;
  manualRunRequestedAtMs?: number | undefined;
  runningAtMs?: number | undefined;
  lastRunAtMs?: number | undefined;
  lastStatus?: "ok" | "error" | "skipped" | undefined;
  lastError?: string | undefined;
  consecutiveErrors?: number | undefined;
}

export interface ScheduledJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: JobSchedule;
  prompt: string;
  delivery: JobDelivery;
  createdAtMs: number;
  updatedAtMs: number;
  state: ScheduledJobState;
}

export interface CronConfig {
  enabled: boolean;
  storeFile: string;
  runLogFile: string;
  pollIntervalMs: number;
  maxConcurrentRuns: number;
  runMissedOnStartup: boolean;
  jobTimeoutMs: number;
}

export interface CronRunLogRecord {
  runId: string;
  jobId: string;
  jobName: string;
  startedAtMs: number;
  endedAtMs: number;
  status: "ok" | "error" | "timeout";
  error?: string;
}

export interface CronJobsSnapshot {
  version: 1;
  jobs: ScheduledJob[];
}
