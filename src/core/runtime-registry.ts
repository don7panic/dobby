import type { ConversationRuntime, GatewayLogger } from "./types.js";

interface RuntimeEntry {
  runtime: ConversationRuntime;
  tail: Promise<void>;
}

export class RuntimeRegistry {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly creating = new Map<string, Promise<ConversationRuntime>>();

  constructor(private readonly logger: GatewayLogger) {}

  async getOrCreate(key: string, createFn: () => Promise<ConversationRuntime>): Promise<ConversationRuntime> {
    const existing = this.entries.get(key);
    if (existing) return existing.runtime;

    const pending = this.creating.get(key);
    if (pending) return pending;

    const creation = (async () => {
      const runtime = await createFn();
      this.entries.set(key, { runtime, tail: Promise.resolve() });
      return runtime;
    })().finally(() => {
      this.creating.delete(key);
    });

    this.creating.set(key, creation);
    return creation;
  }

  async enqueue(key: string, task: (runtime: ConversationRuntime) => Promise<void>): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) {
      throw new Error(`Runtime missing for key '${key}'`);
    }

    const run = entry.tail.then(() => task(entry.runtime));
    entry.tail = run.catch((error) => {
      this.logger.error({ err: error, conversationKey: key }, "Queued task failed");
    });

    await run;
  }

  async abort(key: string): Promise<boolean> {
    const entry = this.entries.get(key);
    if (!entry) return false;

    try {
      await entry.runtime.session.abort();
      return true;
    } catch (error) {
      this.logger.error({ err: error, conversationKey: key }, "Failed to abort runtime");
      return false;
    }
  }

  async closeAll(): Promise<void> {
    for (const [key, entry] of this.entries.entries()) {
      try {
        await entry.runtime.close();
      } catch (error) {
        this.logger.error({ err: error, conversationKey: key }, "Failed to close runtime");
      }
    }

    this.entries.clear();
    this.creating.clear();
  }
}
