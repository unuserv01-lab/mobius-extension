// AgentScope — lifecycle of one temporary subagent (P2, P6).
// start() arms an AbortController + a hard timeout; abort() cancels the
// in-flight work; cleanup() wipes the TempStore and releases everything.
import { TempStore } from './TempStore';

export class AgentScope {
  readonly tempStore: TempStore;
  private controller: AbortController | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(tempTtlSeconds: number) {
    this.tempStore = new TempStore(tempTtlSeconds);
  }

  start(timeoutMs = 120_000): AbortSignal {
    this.controller = new AbortController();
    this.timeoutId = setTimeout(() => this.abort('timeout'), timeoutMs);
    return this.controller.signal;
  }

  abort(reason = 'aborted'): void {
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.timeoutId = null;
    if (this.controller && !this.controller.signal.aborted) {
      this.controller.abort(new Error(`SubAgent ${reason}`));
    }
  }

  cleanup(): void {
    this.abort('cleanup');
    this.tempStore.wipe();
  }

  get signal(): AbortSignal | null {
    return this.controller?.signal ?? null;
  }
}
