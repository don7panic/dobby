import type { ConversationRuntime, GatewayLogger } from "./types.js";

interface RuntimeEntry {
  runtime: ConversationRuntime | undefined;
  tail: Promise<void>;
  epoch: number;
  scheduledTasks: number;
}

export class RuntimeRegistry {
  private readonly entries = new Map<string, RuntimeEntry>();

  constructor(private readonly logger: GatewayLogger) {}

  async run(
    key: string,
    createFn: () => Promise<ConversationRuntime>,
    task: (runtime: ConversationRuntime) => Promise<void>,
  ): Promise<void> {
    const entry = this.getOrCreateEntry(key);
    const scheduledEpoch = entry.epoch;
    entry.scheduledTasks += 1;
    const run = entry.tail.then(async () => {
      if (scheduledEpoch !== entry.epoch) return;

      let runtime = entry.runtime;
      if (!runtime) {
        const created = await createFn();
        if (scheduledEpoch !== entry.epoch) {
          await this.closeRuntime(key, created, "Discarding runtime created for stale queued task");
          return;
        }

        entry.runtime = created;
        runtime = created;
      }

      await task(runtime);
    });

    const managedRun = run.finally(() => {
      entry.scheduledTasks = Math.max(0, entry.scheduledTasks - 1);
    });

    this.attachTail(key, entry, managedRun, "Queued task failed");
    await managedRun;
  }

  async abort(key: string): Promise<boolean> {
    const entry = this.entries.get(key);
    if (!entry?.runtime) return false;
    return this.abortRuntime(key, entry.runtime, "Failed to abort runtime");
  }

  async cancel(key: string): Promise<boolean> {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.scheduledTasks === 0) return false;

    entry.epoch += 1;
    if (!entry.runtime) return true;
    return this.abortRuntime(key, entry.runtime, "Failed to cancel runtime");
  }

  async reset(key: string): Promise<boolean> {
    const entry = this.entries.get(key);
    if (!entry) return false;

    entry.epoch += 1;
    if (entry.runtime) {
      await this.abortRuntime(key, entry.runtime, "Failed to abort runtime during reset");
    }

    const close = entry.tail.then(async () => {
      const runtime = entry.runtime;
      entry.runtime = undefined;
      if (!runtime) return;
      await this.closeRuntime(key, runtime, "Failed to close runtime during reset");
    });

    this.attachTail(key, entry, close);
    await close;
    return true;
  }

  async closeAll(): Promise<void> {
    const keys = [...this.entries.keys()];
    await Promise.all(keys.map((key) => this.reset(key)));
    this.entries.clear();
  }

  private getOrCreateEntry(key: string): RuntimeEntry {
    const existing = this.entries.get(key);
    if (existing) return existing;

    const entry: RuntimeEntry = {
      runtime: undefined,
      tail: Promise.resolve(),
      epoch: 0,
      scheduledTasks: 0,
    };
    this.entries.set(key, entry);
    return entry;
  }

  private attachTail(
    key: string,
    entry: RuntimeEntry,
    run: Promise<void>,
    errorMessage = "Queued task failed",
  ): void {
    const nextTail = run.catch((error) => {
      this.logger.error({ err: error, conversationKey: key }, errorMessage);
    });
    entry.tail = nextTail;
    void nextTail.finally(() => {
      if (this.entries.get(key) !== entry) return;
      if (entry.runtime !== undefined) return;
      if (entry.tail !== nextTail) return;
      this.entries.delete(key);
    });
  }

  private async abortRuntime(key: string, runtime: ConversationRuntime, errorMessage: string): Promise<boolean> {
    try {
      await runtime.runtime.abort();
      return true;
    } catch (error) {
      this.logger.error({ err: error, conversationKey: key }, errorMessage);
      return false;
    }
  }

  private async closeRuntime(key: string, runtime: ConversationRuntime, errorMessage: string): Promise<void> {
    try {
      await runtime.close();
    } catch (error) {
      this.logger.error({ err: error, conversationKey: key }, errorMessage);
    }
  }
}
