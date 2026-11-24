// HistoryView — past tasks + stored core memory (inspect & delete).
import { MemoryStore } from '../core/MemoryStore';

export class HistoryView {
  private el: HTMLElement;
  private memory = new MemoryStore();

  constructor(el: HTMLElement) {
    this.el = el;
  }

  async render(): Promise<void> {
    const entries = await this.memory.list();
    const rows = entries
      .map(
        (e) => `
        <div class="card log-entry">
          <span class="badge ${e.type === 'task_result' ? 'on-device' : 'cloud'}">${e.type}</span>
          <time>${new Date(e.createdAt).toLocaleString()}</time>
          <div>${this.escape(e.content)}</div>
          <div class="muted mono">source: ${this.escape(e.source)} · expires ${new Date(e.expiresAt).toLocaleString()}</div>
          <button class="btn danger" data-del="${e.id}">Delete</button>
        </div>`,
      )
      .join('');
    this.el.innerHTML = `
      <section>
        <h2>History &amp; Memory</h2>
        <p class="muted">Task outcomes the Core decided to keep — stored locally only, with a time limit. No memory is ever sent to the cloud.</p>
        ${entries.length === 0 ? '<div class="card muted">No memory stored yet.</div>' : rows}
        ${entries.length > 0 ? '<button class="btn danger" id="clear-all">Clear all memory</button>' : ''}
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
