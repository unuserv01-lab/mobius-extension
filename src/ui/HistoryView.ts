// HistoryView — past tasks + stored core memory (inspect & delete). (v7: i18n.)
import { loadLanguage, t } from '../core/i18n';
import { MemoryStore } from '../core/MemoryStore';

export class HistoryView {
  private el: HTMLElement;
  private memory = new MemoryStore();

  constructor(el: HTMLElement) {
    this.el = el;
  }

  async render(): Promise<void> {
    await loadLanguage();
    const entries = await this.memory.list();
    const rows = entries
      .map(
        (e) => `
        <div class="card log-entry">
          <span class="badge ${e.type === 'task_result' ? 'on-device' : 'cloud'}">${e.type}</span>
          <time>${new Date(e.createdAt).toLocaleString()}</time>
          <div>${this.escape(e.content)}</div>
          <div class="muted mono">${this.escape(t('histSource'))}: ${this.escape(e.source)} · ${this.escape(t('histExpires'))} ${new Date(e.expiresAt).toLocaleString()}</div>
          <button class="btn danger" data-del="${e.id}">${this.escape(t('histDelete'))}</button>
        </div>`,
      )
      .join('');
    this.el.innerHTML = `
      <section>
        <h2>${this.escape(t('histTitle'))}</h2>
        <p class="muted">${this.escape(t('histDesc'))}</p>
        ${entries.length === 0 ? `<div class="card muted">${this.escape(t('histEmpty'))}</div>` : rows}
        ${entries.length > 0 ? `<button class="btn danger" id="clear-all">${this.escape(t('histClearAll'))}</button>` : ''}
      </section>`;
    this.el.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        void this.memory.remove(btn.dataset.del!).then(() => this.render());
      });
    });
    this.el.querySelector('#clear-all')?.addEventListener('click', () => {
      void this.memory.clear().then(() => this.render());
    });
  }

  private escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
