import type {
  ConnectorContext,
  ConnectorHealth,
  ConnectorHealthStatus,
  ConnectorPlugin,
  ConnectorSendResult,
  ConnectorTypingEnvelope,
  GatewayLogger,
  OutboundEnvelope,
  Platform,
} from "./types.js";

const DEFAULT_MONITOR_INTERVAL_MS = 5_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_DEGRADED_RESTART_THRESHOLD_MS = 90_000;
const DEFAULT_RECONNECTING_RESTART_THRESHOLD_MS = 180_000;
const DEFAULT_RESTART_BACKOFF_MS = 5_000;
const DEFAULT_MAX_RESTART_BACKOFF_MS = 60_000;

export interface SupervisedConnectorOptions {
  initialConnector: ConnectorPlugin;
  createInstance: () => Promise<ConnectorPlugin> | ConnectorPlugin;
  logger: GatewayLogger;
  monitorIntervalMs?: number;
  startTimeoutMs?: number;
  degradedRestartThresholdMs?: number;
  reconnectingRestartThresholdMs?: number;
  restartBackoffMs?: number;
  maxRestartBackoffMs?: number;
}

interface ConnectorDescriptor {
  id: string;
  platform: Platform;
  name: string;
  capabilities: ConnectorPlugin["capabilities"];
}

function createHealth(status: ConnectorHealthStatus, detail?: string): ConnectorHealth {
  const now = Date.now();
  return {
    status,
    statusSinceMs: now,
    updatedAtMs: now,
    ...(detail ? { detail } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SupervisedConnector implements ConnectorPlugin {
  private readonly descriptor: ConnectorDescriptor;
  private readonly createInstance: () => Promise<ConnectorPlugin> | ConnectorPlugin;
  private readonly logger: GatewayLogger;
  private readonly monitorIntervalMs: number;
  private readonly startTimeoutMs: number;
  private readonly degradedRestartThresholdMs: number;
  private readonly reconnectingRestartThresholdMs: number;
  private readonly restartBackoffMs: number;
  private readonly maxRestartBackoffMs: number;

  private current: ConnectorPlugin;
  private ctx: ConnectorContext | null = null;
  private health = createHealth("stopped");
  private started = false;
  private stopping = false;
  private restarting = false;
  private generation = 0;
  private monitorTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartFailures = 0;
  private restartCount = 0;

  constructor(options: SupervisedConnectorOptions) {
    this.current = options.initialConnector;
    this.createInstance = options.createInstance;
    this.logger = options.logger;
    this.monitorIntervalMs = options.monitorIntervalMs ?? DEFAULT_MONITOR_INTERVAL_MS;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.degradedRestartThresholdMs = options.degradedRestartThresholdMs ?? DEFAULT_DEGRADED_RESTART_THRESHOLD_MS;
    this.reconnectingRestartThresholdMs =
      options.reconnectingRestartThresholdMs ?? DEFAULT_RECONNECTING_RESTART_THRESHOLD_MS;
    this.restartBackoffMs = options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
    this.maxRestartBackoffMs = options.maxRestartBackoffMs ?? DEFAULT_MAX_RESTART_BACKOFF_MS;
    this.descriptor = {
      id: options.initialConnector.id,
      platform: options.initialConnector.platform,
      name: options.initialConnector.name,
      capabilities: options.initialConnector.capabilities,
    };
  }

  get id(): string {
    return this.descriptor.id;
  }

  get platform(): Platform {
    return this.descriptor.platform;
  }

  get name(): string {
    return this.descriptor.name;
  }

  get capabilities(): ConnectorPlugin["capabilities"] {
    return this.descriptor.capabilities;
  }

  async start(ctx: ConnectorContext): Promise<void> {
    if (this.started) {
      this.logger.warn({ connectorId: this.id }, "Supervised connector start called while already started");
      return;
    }

    this.ctx = ctx;
    this.started = true;
    this.stopping = false;
    this.restartFailures = 0;
    this.clearRestartTimer();
    this.updateHealth({ status: "starting", detail: "Starting connector" });

    this.generation += 1;
    const generation = this.generation;
    try {
      await this.current.start(this.createManagedContext(generation));
      this.syncCurrentHealth("Connector started");
      this.startMonitor();
    } catch (error) {
      const message = errorMessage(error);
      this.updateHealth({
        status: "failed",
        detail: "Initial connector start failed",
        lastError: message,
        lastErrorAtMs: Date.now(),
      });
      this.started = false;
      this.ctx = null;
      throw error;
    }
  }

  async send(message: OutboundEnvelope): Promise<ConnectorSendResult> {
    try {
      const result = await this.current.send(message);
      this.noteOutbound();
      return result;
    } catch (error) {
      this.noteRuntimeError("Failed to send outbound message", error);
      throw error;
    }
  }

  async sendTyping(message: ConnectorTypingEnvelope): Promise<void> {
    const sendTyping = this.current.sendTyping;
    if (!sendTyping) {
      return;
    }

    try {
      await sendTyping.call(this.current, message);
      this.noteOutbound();
    } catch (error) {
      this.noteRuntimeError("Failed to send typing indicator", error);
      throw error;
    }
  }

  getHealth(): ConnectorHealth {
    this.syncCurrentHealth();
    return { ...this.health, restartCount: this.restartCount };
  }

  async stop(): Promise<void> {
    if (!this.started && this.health.status === "stopped") {
      return;
    }

    this.stopping = true;
    this.started = false;
    this.ctx = null;
    this.generation += 1;
    this.stopMonitor();
    this.clearRestartTimer();

    try {
      await this.current.stop();
    } finally {
      this.updateHealth({ status: "stopped", detail: "Connector stopped by host" });
      this.stopping = false;
    }
  }

  private startMonitor(): void {
    if (this.monitorTimer) {
      return;
    }

    this.monitorTimer = setInterval(() => {
      void this.monitor();
    }, this.monitorIntervalMs);
  }

  private stopMonitor(): void {
    if (!this.monitorTimer) {
      return;
    }

    clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  private async monitor(): Promise<void> {
    if (!this.started || this.stopping || this.restarting) {
      return;
    }

    this.syncCurrentHealth();

    const now = Date.now();
    const unhealthyForMs = now - this.health.statusSinceMs;
    switch (this.health.status) {
      case "starting":
        if (unhealthyForMs >= this.startTimeoutMs) {
          this.scheduleRestart("start_timeout", true);
        }
        return;
      case "degraded":
        if (unhealthyForMs >= this.degradedRestartThresholdMs) {
          this.scheduleRestart("degraded_timeout", true);
        }
        return;
      case "reconnecting":
        if (unhealthyForMs >= this.reconnectingRestartThresholdMs) {
          this.scheduleRestart("reconnecting_timeout", true);
        }
        return;
      case "failed":
        this.scheduleRestart("connector_failed", false);
        return;
      default:
        return;
    }
  }

  private syncCurrentHealth(fallbackDetail?: string): void {
    try {
      const observed = this.current.getHealth?.();
      if (!observed) {
        if (this.started && !this.stopping && !this.restarting && this.health.status === "starting") {
          this.updateHealth({ status: "ready", detail: fallbackDetail ?? "Connector ready" });
        }
        return;
      }

      this.updateHealth(observed);
    } catch (error) {
      this.noteRuntimeError("Failed to read connector health", error);
    }
  }

  private createManagedContext(generation: number): ConnectorContext {
    return {
      emitInbound: async (message) => {
        if (generation !== this.generation || !this.ctx) {
          return;
        }

        this.noteInbound();
        await this.ctx.emitInbound(message);
      },
      emitControl: async (event) => {
        if (generation !== this.generation || !this.ctx) {
          return;
        }

        await this.ctx.emitControl(event);
      },
    };
  }

  private noteInbound(): void {
    const now = Date.now();
    this.updateHealth({
      status: "ready",
      detail: "Observed inbound connector activity",
      lastInboundAtMs: now,
      lastReadyAtMs: this.health.lastReadyAtMs ?? now,
    });
  }

  private noteOutbound(): void {
    const now = Date.now();
    this.updateHealth({
      status: "ready",
      detail: "Observed outbound connector activity",
      lastOutboundAtMs: now,
      lastReadyAtMs: this.health.lastReadyAtMs ?? now,
    });
  }

  private noteRuntimeError(detail: string, error: unknown): void {
    const message = errorMessage(error);
    this.updateHealth({
      status: this.health.status === "reconnecting" ? "reconnecting" : "degraded",
      detail,
      lastError: message,
      lastErrorAtMs: Date.now(),
    });
  }

  private updateHealth(next: ConnectorHealth): void;
  private updateHealth(
    next: Pick<ConnectorHealth, "status"> &
      Partial<Omit<ConnectorHealth, "status" | "statusSinceMs" | "updatedAtMs" | "restartCount">> &
      Partial<Pick<ConnectorHealth, "statusSinceMs" | "updatedAtMs">>,
  ): void;
  private updateHealth(
    next: Pick<ConnectorHealth, "status"> &
      Partial<Omit<ConnectorHealth, "status" | "statusSinceMs" | "updatedAtMs" | "restartCount">> &
      Partial<Pick<ConnectorHealth, "statusSinceMs" | "updatedAtMs">>,
  ): void {
    const previous = this.health;
    const now = next.updatedAtMs ?? Date.now();
    const statusChanged = next.status !== previous.status;
    const merged: ConnectorHealth = {
      ...previous,
      ...next,
      status: next.status,
      statusSinceMs: next.statusSinceMs ?? (statusChanged ? now : previous.statusSinceMs),
      updatedAtMs: now,
      restartCount: this.restartCount,
    };

    this.health = merged;
    if (statusChanged || merged.detail !== previous.detail) {
      this.logHealthTransition(previous, merged);
    }
  }

  private logHealthTransition(previous: ConnectorHealth, next: ConnectorHealth): void {
    const payload = {
      connectorId: this.id,
      previousStatus: previous.status,
      status: next.status,
      detail: next.detail ?? null,
      restartCount: this.restartCount,
      lastError: next.lastError ?? null,
    };

    if (next.status === "failed") {
      this.logger.error(payload, "Connector health changed");
      return;
    }

    if (next.status === "degraded" || next.status === "reconnecting") {
      this.logger.warn(payload, "Connector health changed");
      return;
    }

    this.logger.info(payload, "Connector health changed");
  }

  private scheduleRestart(reason: string, immediate: boolean): void {
    if (!this.started || this.stopping || this.restarting || this.restartTimer) {
      return;
    }

    const delayMs = immediate ? 0 : this.computeRestartDelay();
    this.updateHealth({
      status: "reconnecting",
      detail:
        delayMs > 0
          ? `Supervisor scheduled connector restart in ${delayMs}ms (${reason})`
          : `Supervisor restarting connector (${reason})`,
    });

    if (delayMs === 0) {
      void this.restart(reason);
      return;
    }

    this.logger.warn({ connectorId: this.id, reason, delayMs }, "Scheduling supervised connector restart");
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.restart(reason);
    }, delayMs);
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) {
      return;
    }

    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private computeRestartDelay(): number {
    return Math.min(this.restartBackoffMs * 2 ** this.restartFailures, this.maxRestartBackoffMs);
  }

  private async restart(reason: string): Promise<void> {
    if (!this.started || this.stopping || this.restarting || !this.ctx) {
      return;
    }

    this.restarting = true;
    this.clearRestartTimer();

    const previous = this.current;
    const nextGeneration = this.generation + 1;
    this.generation = nextGeneration;
    this.updateHealth({ status: "reconnecting", detail: `Supervisor restarting connector (${reason})` });
    this.logger.warn({ connectorId: this.id, reason }, "Restarting connector through supervisor");

    let shouldRetry = false;

    try {
      await previous.stop().catch((error) => {
        this.logger.warn({ err: error, connectorId: this.id, reason }, "Failed to stop connector before restart");
      });

      const candidate = await this.createInstance();
      this.assertCompatible(candidate);
      this.updateHealth({ status: "starting", detail: `Starting replacement connector (${reason})` });
      await candidate.start(this.createManagedContext(nextGeneration));
      this.current = candidate;
      this.restartFailures = 0;
      this.restartCount += 1;
      this.syncCurrentHealth("Replacement connector started");
      this.logger.info({ connectorId: this.id, reason, restartCount: this.restartCount }, "Connector restarted");
    } catch (error) {
      shouldRetry = true;
      this.restartFailures += 1;
      this.updateHealth({
        status: "failed",
        detail: `Connector restart failed (${reason})`,
        lastError: errorMessage(error),
        lastErrorAtMs: Date.now(),
      });
      this.logger.error(
        { err: error, connectorId: this.id, reason, restartFailures: this.restartFailures },
        "Failed to restart connector",
      );
    } finally {
      this.restarting = false;
    }

    if (shouldRetry) {
      this.scheduleRestart(`retry_after_${reason}`, false);
    }
  }

  private assertCompatible(candidate: ConnectorPlugin): void {
    if (candidate.id !== this.id || candidate.platform !== this.platform || candidate.name !== this.name) {
      throw new Error(
        `Replacement connector metadata mismatch for '${this.id}' (${candidate.id}/${candidate.platform}/${candidate.name})`,
      );
    }
  }
}
