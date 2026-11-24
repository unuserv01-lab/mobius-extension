// TempStore — in-memory, TTL-bound temporary data for ONE subagent (P6).
// Wiped immediately when the task ends. Never persisted, never synced.
export class TempStore {
  private data = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly ttlMs: number;

  constructor(ttlSeconds: number) {
    this.ttlMs = ttlSeconds * 1000;
  }

  set<T>(key: string, value: T): void {
    this.data.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  get<T>(key: string): T | undefined {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  /** Immediate wipe (called on task end — P6). */
  wipe(): void {
    this.data.clear();
  }

  size(): number {
    return this.data.size;
  }
}
