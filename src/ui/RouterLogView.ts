// RouterLogView — live on-device vs cloud audit log (P4: every cloud call logged).
import { AIRouter } from '../ai/AIRouter';
import { PermissionManager } from '../core/PermissionManager';

export class RouterLogView {
  private el: HTMLElement;
  private router: AIRouter;

  constructor(el: HTMLElement) {
    this.el = el;
    this.router = new AIRouter(new PermissionManager());
  }

  async render(): Promise<void> {
    const logs = await this.router.getLog();
    const rows = logs
      .map(
        (l) => `
        <div class="card log-entry">
          <span class="badge ${l.engine}">${l.engine === 'on-device' ? 'ON-DEVICE' : l.engine === 'cloud' ? 'CLOUD' : l.engine === 'local-server' ? 'LOCAL SERVER' : 'LOCAL FALLBACK'}</span>
          <time>${new Date(l.timestamp).toLocaleTimeString()}</time>
          <div>${this.escape(l.taskSummary)}</div>
          <div class="muted">${this.escape(l.reason)}</div>
          <div class="muted mono">${this.escape(l.payloadSummary)} · ${l.latencyMs} ms · cloud allowed: ${l.cloudAllowed ? 'yes' : 'no'}</div>
        </div>`,
      )
      .join('');
    this.el.innerHTML = `
      <section>
        <h2>AI Router Log</h2>
        <p class="muted">Every routing decision MOBIUS makes — on-device first, cloud only when allowed and needed. Refreshes every 3 seconds.</p>
        ${logs.length === 0 ? '<div class="card muted">No decisions yet. Ask MOBIUS something from the bubble.</div>' : rows}
        ${logs.length > 0 ? '<button class="btn danger" id="clear-log">Clear log</button>' : ''}
      </section>`;
    const clearBtn = this.el.querySelector('#clear-log');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        void this.router.clearLog().then(() => this.render());
      });
    }
  }

  private escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
