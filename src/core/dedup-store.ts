import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GatewayLogger } from "./types.js";

interface DedupSnapshot {
  version: 1;
  entries: Record<string, number>;
}

export class DedupStore {
  private readonly entries = new Map<string, number>();
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly filePath: string,
    private readonly ttlMs: number,
    private readonly logger: GatewayLogger,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const snapshot = JSON.parse(raw) as DedupSnapshot;
      const now = Date.now();
      for (const [key, expiresAt] of Object.entries(snapshot.entries ?? {})) {
        if (expiresAt > now) {
          this.entries.set(key, expiresAt);
        }
      }
    } catch {
      // First start or malformed file; start clean.
    }
  }

  startAutoFlush(intervalMs = 15000): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, intervalMs);
  }

  stopAutoFlush(): void {
    if (!this.flushTimer) return;
    clearInterval(this.flushTimer);
    this.flushTimer = null;
  }

  has(key: string): boolean {
    const now = Date.now();
    const expiresAt = this.entries.get(key);
    if (!expiresAt) return false;
    if (expiresAt <= now) {
      this.entries.delete(key);
      this.dirty = true;
      return false;
    }
    return true;
  }

  add(key: string): void {
    const expiresAt = Date.now() + this.ttlMs;
    this.entries.set(key, expiresAt);
    this.dirty = true;

    if (this.entries.size % 100 === 0) {
      this.sweepExpired();
    }
  }

  sweepExpired(): void {
    const now = Date.now();
    let removed = 0;

    for (const [key, expiresAt] of this.entries.entries()) {
      if (expiresAt <= now) {
        this.entries.delete(key);
        removed += 1;
      }
    }

    if (removed > 0) {
      this.dirty = true;
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;

    const snapshot: DedupSnapshot = {
      version: 1,
      entries: Object.fromEntries(this.entries.entries()),
    };

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(snapshot, null, 2), "utf-8");
      this.dirty = false;
    } catch (error) {
      this.logger.error({ err: error, filePath: this.filePath }, "Failed to flush dedup store");
    }
  }
}
