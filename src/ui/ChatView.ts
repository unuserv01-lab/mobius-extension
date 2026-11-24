// ChatView — persisted chat history (v7): the user's own conversation with
// MOBIUS, stored by the Core in chrome.storage.local, kept for the retention
// period chosen in Settings. Survives side-panel reopen.
import { ChatHistory } from '../core/ChatHistory';
import { loadLanguage, t } from '../core/i18n';

export class ChatView {
  private el: HTMLElement;
  private chatHistory = new ChatHistory();

  constructor(el: HTMLElement) {
    this.el = el;
  }

  async render(): Promise<void> {
    await loadLanguage();
    const messages = await this.chatHistory.list();
    const rows = messages
      .map(
        (m) => `
        <div class="card chat-msg ${m.role}">
          <div class="who">${m.role === 'user' ? this.escape(t('chatYou')) : 'MOBIUS'} · ${new Date(m.createdAt).toLocaleString()}</div>
          <div>${this.escape(m.text)}</div>
        </div>`,
      )
      .join('');
    this.el.innerHTML = `
      <section>
        <h2>${this.escape(t('chatTitle'))}</h2>
        <p class="muted">${this.escape(t('chatDesc'))}</p>
        ${messages.length === 0 ? `<div class="card muted">${this.escape(t('chatEmpty'))}</div>` : rows}
        ${messages.length > 0 ? `<button class="btn danger" id="clear-chat">${this.escape(t('chatClear'))}</button>` : ''}
      </section>`;
    this.el.querySelector('#clear-chat')?.addEventListener('click', () => {
      void this.chatHistory.clear().then(() => this.render());
    });
  }

  private escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
