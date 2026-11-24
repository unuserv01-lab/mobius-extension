// RouterLogView — live on-device vs cloud audit log (P4: every cloud call logged).
// (v7: i18n + SKILL badge for deterministic skill runs.)
import { AIRouter } from '../ai/AIRouter';
import { loadLanguage, t } from '../core/i18n';
import { PermissionManager } from '../core/PermissionManager';

const BADGE_LABEL: Record<string, string> = {
  'on-device': 'ON-DEVICE',
  cloud: 'CLOUD',
  'local-server': 'LOCAL SERVER',
  'local-fallback': 'LOCAL FALLBACK',
  skill: 'SKILL',
};

export class RouterLogView {
  private el: HTMLElement;
  private router: AIRouter;

  constructor(el: HTMLElement) {
    this.el = el;
    this.router = new AIRouter(new PermissionManager());
  }

  async render(): Promise<void> {
    await loadLanguage();
    const logs = await this.router.getLog();
    const rows = logs
      .map(
        (l) => `
        <div class="card log-entry">
          <span class="badge ${l.engine}">${BADGE_LABEL[l.engine] ?? l.engine.toUpperCase()}</span>
          <time>${new Date(l.timestamp).toLocaleTimeString()}</time>
          <div>${this.escape(l.taskSummary)}</div>
          <div class="muted">${this.escape(l.reason)}</div>
          <div class="muted mono">${this.escape(l.payloadSummary)} · ${l.latencyMs} ms · ${this.escape(t('logCloudAllowed'))}: ${l.cloudAllowed ? this.escape(t('logYes')) : this.escape(t('logNo'))}</div>
        </div>`,
      )
      .join('');
    this.el.innerHTML = `
      <section>
        <h2>${this.escape(t('logTitle'))}</h2>
        <p class="muted">${this.escape(t('logDesc'))}</p>
        ${logs.length === 0 ? `<div class="card muted">${this.escape(t('logEmpty'))}</div>` : rows}
        ${logs.length > 0 ? `<button class="btn danger" id="clear-log">${this.escape(t('logClear'))}</button>` : ''}
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
