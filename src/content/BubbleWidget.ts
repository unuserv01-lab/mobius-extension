// BubbleWidget — floating bubble + quick-input popover, rendered inside a
// Shadow DOM so host-site CSS (WhatsApp Web, Gmail, ...) never distorts it (P7).
// v7: logo DNA (purple-blue gradient + the real Möbius loop from the logo,
// NOT a text glyph), dark palette #04000F, i18n (id/en), chat history restore,
// deterministic sensitive-data scan on submit, and an unread-reply badge.
//
// UNREAD BADGE: when a result arrives while the sheet is CLOSED, a small
// circular badge appears ABOVE the bubble (#B388FF, count, "9+" past 9).
// Opening the sheet (bubble or badge click) resets the count to 0. Results
// that arrive while the sheet is already open never increment the count.
// Honest limit: the badge only exists on pages where the bubble is injected;
// with no tab open there is nowhere to show it.
import { APP_NAME } from '../config/constants';
import { ChatHistory } from '../core/ChatHistory';
import { getLang, loadLanguage, t, tf } from '../core/i18n';
import { scanSensitive, type SensitiveType } from '../core/SensitiveDataScanner';
import { LOGO_DATA_URI } from './logoDataUri';

const TYPE_LABEL: Record<SensitiveType, 'typeKtp' | 'typePhone' | 'typeAccount' | 'typeEmail' | 'typePassword'> = {
  ktp: 'typeKtp',
  phone: 'typePhone',
  account: 'typeAccount',
  email: 'typeEmail',
  password: 'typePassword',
};

const BUBBLE_CSS = `
  :host { all: initial; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .mobius-bubble {
    position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
    width: 56px; height: 56px; border-radius: 50%;
    background: linear-gradient(135deg, #1a73e8, #7c4dff);
    color: #fff; font-size: 26px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    cursor: grab; border: none; padding: 0;
    box-shadow: 0 4px 20px rgba(124, 77, 255, .55), 0 0 0 2px rgba(179, 136, 255, .35);
    user-select: none; overflow: hidden;
  }
  .mobius-bubble:active { cursor: grabbing; }
  .mobius-bubble img { width: 56px; height: 56px; border-radius: 50%; object-fit: cover; display: block; pointer-events: none; }
  .mobius-badge {
    position: fixed; right: 20px; bottom: 84px; z-index: 2147483647;
    min-width: 20px; height: 20px; padding: 0 5px; box-sizing: border-box;
    border-radius: 10px; background: #b388ff; color: #04000f;
    border: 2px solid #04000f; box-shadow: 0 0 10px rgba(179, 136, 255, .8);
    font-size: 11px; font-weight: 700; line-height: 16px; text-align: center;
    cursor: pointer; user-select: none;
  }
  .mobius-badge[hidden] { display: none; }
  .mobius-sheet {
    position: fixed; right: 20px; bottom: 88px; z-index: 2147483647;
    width: 320px; max-width: calc(100vw - 40px);
    background: #17122e; color: #f2edff; border-radius: 14px;
    border: 1px solid #221a3e;
    box-shadow: 0 8px 32px rgba(0,0,0,.5); padding: 14px;
    display: none;
  }
  .mobius-sheet.open { display: block; }
  .mobius-sheet h3 { margin: 0 0 4px; font-size: 15px; color: #f2edff; }
  .mobius-sheet p { margin: 0 0 10px; font-size: 12px; color: #b9b3d6; }
  .mobius-sheet textarea {
    width: 100%; box-sizing: border-box; min-height: 64px; resize: vertical;
    border: 1px solid #3a2e6b; border-radius: 8px; padding: 8px; font-size: 13px; font-family: inherit;
    background: #221a3e; color: #f2edff;
  }
  .mobius-sheet .row { display: flex; gap: 8px; margin-top: 10px; }
  .mobius-sheet button {
    flex: 1; border: none; border-radius: 8px; padding: 9px 10px;
    font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .mobius-send { background: linear-gradient(135deg, #1a73e8, #7c4dff); color: #fff; }
  .mobius-panel { background: #221a3e; color: #f2edff; border: 1px solid #3a2e6b; }
  .mobius-result { margin-top: 10px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; max-height: 220px; overflow: auto; }
  .mobius-result .prov { font-size: 11px; color: #b388ff; margin-top: 6px; }
  .mobius-error { color: #ef5350; }
  .mobius-history { margin-bottom: 10px; max-height: 140px; overflow: auto; font-size: 12px; line-height: 1.5; }
  .mobius-history .hist-label { color: #b9b3d6; font-size: 11px; margin-bottom: 4px; }
  .mobius-history .msg-user { color: #b388ff; margin: 2px 0; }
  .mobius-history .msg-asst { color: #f2edff; margin: 2px 0 6px; }
  .mobius-warn { margin-top: 10px; padding: 10px; border-radius: 8px; background: #2a1f0d; border: 1px solid #ffca28; color: #ffe082; font-size: 12px; line-height: 1.5; }
  .mobius-warn .row { display: flex; gap: 8px; margin-top: 8px; }
  .mobius-warn button { flex: 1; border: none; border-radius: 8px; padding: 8px 10px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .mobius-warn .go { background: #ffca28; color: #04000f; }
  .mobius-warn .stop { background: #221a3e; color: #f2edff; border: 1px solid #3a2e6b; }
`;

export class BubbleWidget {
  private host: HTMLElement;
  private shadow: ShadowRoot;
  private sheet!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private resultEl!: HTMLElement;
  private historyEl!: HTMLElement;
  private warnEl!: HTMLElement;
  private badge!: HTMLElement;
  private descEl!: HTMLElement;
  private sendBtn!: HTMLButtonElement;
  private panelBtn!: HTMLButtonElement;
  private unreadCount = 0;
  private pendingText: string | null = null;
  private chatHistory = new ChatHistory();

  constructor() {
    this.host = document.createElement('div');
    this.host.id = 'mobius-bubble-host';
    this.shadow = this.host.attachShadow({ mode: 'open' });
  }

  async mount(): Promise<void> {
    if (document.getElementById('mobius-bubble-host')) return;
    await loadLanguage();
    const style = document.createElement('style');
    style.textContent = BUBBLE_CSS;
    this.shadow.appendChild(style);

    const bubble = document.createElement('button');
    bubble.className = 'mobius-bubble';
    const logo = document.createElement('img');
    logo.src = LOGO_DATA_URI;
    logo.alt = APP_NAME;
    bubble.appendChild(logo);
    bubble.title = `${APP_NAME} — Personal AI Operating Layer`;
    bubble.setAttribute('aria-label', `${APP_NAME} assistant`);
    bubble.addEventListener('click', () => this.toggleSheet());
    this.makeDraggable(bubble);
    this.shadow.appendChild(bubble);

    // Unread-reply badge (hidden until a result arrives while closed).
    const badge = document.createElement('div');
    badge.className = 'mobius-badge';
    badge.hidden = true;
    badge.textContent = '0';
    badge.addEventListener('click', () => this.openSheet());
    this.badge = badge;
    this.shadow.appendChild(badge);

    const sheet = document.createElement('div');
    sheet.className = 'mobius-sheet';
    sheet.innerHTML = `
      <h3>${APP_NAME}</h3>
      <p class="mobius-desc"></p>
      <div class="mobius-history" hidden></div>
      <textarea></textarea>
      <div class="row">
        <button class="mobius-send"></button>
        <button class="mobius-panel"></button>
      </div>
      <div class="mobius-warn" hidden></div>
      <div class="mobius-result" hidden></div>
    `;
    this.sheet = sheet;
    this.descEl = sheet.querySelector('.mobius-desc')!;
    this.historyEl = sheet.querySelector('.mobius-history')!;
    this.input = sheet.querySelector('textarea')!;
    this.sendBtn = sheet.querySelector('.mobius-send')!;
    this.panelBtn = sheet.querySelector('.mobius-panel')!;
    this.warnEl = sheet.querySelector('.mobius-warn')!;
    this.resultEl = sheet.querySelector('.mobius-result')!;
    this.sendBtn.addEventListener('click', () => void this.submit());
    this.panelBtn.addEventListener('click', () => {
      void chrome.runtime.sendMessage({ type: 'MOBIUS_OPEN_PANEL' });
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void this.submit();
    });
    this.shadow.appendChild(sheet);

    this.applyLanguage();
    await this.renderHistory();

    // Re-localize live when the language changes in Settings.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.mobius_settings) return;
      void loadLanguage().then(() => {
        this.applyLanguage();
        void this.renderHistory();
      });
    });

    document.documentElement.appendChild(this.host);
  }

  private applyLanguage(): void {
    this.descEl.textContent = t('bubbleDesc');
    this.input.placeholder = t('bubblePlaceholder');
    this.sendBtn.textContent = t('bubbleAsk');
    this.panelBtn.textContent = t('bubblePanel');
  }

  private async renderHistory(): Promise<void> {
    const messages = (await this.chatHistory.list()).slice(-6);
    if (messages.length === 0) {
      this.historyEl.hidden = true;
      this.historyEl.textContent = '';
      return;
    }
    this.historyEl.hidden = false;
    this.historyEl.textContent = '';
    const label = document.createElement('div');
    label.className = 'hist-label';
    label.textContent = t('bubbleHistoryLabel');
    this.historyEl.appendChild(label);
    for (const m of messages) {
      const div = document.createElement('div');
      div.className = m.role === 'user' ? 'msg-user' : 'msg-asst';
      div.textContent = m.role === 'user' ? `${t('chatYou')}: ${m.text}` : m.text;
      this.historyEl.appendChild(div);
    }
    this.historyEl.scrollTop = this.historyEl.scrollHeight;
  }

  private toggleSheet(): void {
    if (this.sheet.classList.contains('open')) {
      this.sheet.classList.remove('open');
    } else {
      this.openSheet();
    }
  }

  private openSheet(): void {
    this.sheet.classList.add('open');
    this.resetUnread();
    this.input.focus();
    void this.renderHistory();
  }

  // --- Unread badge -------------------------------------------------------
  private resetUnread(): void {
    this.unreadCount = 0;
    this.badge.hidden = true;
    this.badge.textContent = '0';
  }

  private incrementUnread(): void {
    this.unreadCount += 1;
    this.badge.textContent = this.unreadCount > 9 ? '9+' : String(this.unreadCount);
    this.badge.hidden = false;
  }

  private sheetIsOpen(): boolean {
    return this.sheet.classList.contains('open');
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim();
    if (!text) return;
    // Sensitive-data scan (deterministic, local) BEFORE anything is sent.
    // Findings name the TYPE only — the value is never shown or logged.
    const findings = scanSensitive(text);
    if (findings.length > 0 && this.pendingText !== text) {
      this.pendingText = text;
      const types = findings.map((f) => t(TYPE_LABEL[f.type], getLang())).join(', ');
      this.warnEl.hidden = false;
      this.warnEl.textContent = '';
      const msg = document.createElement('div');
      msg.textContent = tf('bubbleSensitiveTitle', { types });
      this.warnEl.appendChild(msg);
      const row = document.createElement('div');
      row.className = 'row';
      const go = document.createElement('button');
      go.className = 'go';
      go.textContent = t('bubbleSensitiveContinue');
      go.addEventListener('click', () => {
        this.warnEl.hidden = true;
        void this.sendTask(this.pendingText ?? '');
      });
      const stop = document.createElement('button');
      stop.className = 'stop';
      stop.textContent = t('bubbleSensitiveCancel');
      stop.addEventListener('click', () => {
        this.pendingText = null;
        this.warnEl.hidden = true;
      });
      row.appendChild(go);
      row.appendChild(stop);
      this.warnEl.appendChild(row);
      return;
    }
    this.pendingText = null;
    this.warnEl.hidden = true;
    await this.sendTask(text);
  }

  private async sendTask(text: string): Promise<void> {
    this.showResult(t('bubbleThinking'), '');
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'MOBIUS_TASK',
        task: { id: `task_${Date.now()}`, intent: 'chat', input: text, url: location.href },
      });
      const result = res?.result as { ok: boolean; text?: string; provenance?: string; error?: string } | undefined;
      if (!result) {
        this.showResult(t('bubbleNoResponse'), '', true);
        return;
      }
      if (result.ok) {
        this.showResult(result.text ?? '', result.provenance ?? '');
        this.input.value = '';
      } else {
        this.showResult(result.error ?? t('bubbleTaskFailed'), '', true);
      }
    } catch (err) {
      this.showResult(`${t('bubbleUnreachable')}${err instanceof Error ? err.message : String(err)}`, '', true);
    }
    void this.renderHistory();
  }

  private showResult(text: string, provenance: string, isError = false): void {
    this.resultEl.hidden = false;
    this.resultEl.classList.toggle('mobius-error', isError);
    this.resultEl.textContent = '';
    const body = document.createElement('div');
    body.textContent = text;
    this.resultEl.appendChild(body);
    if (provenance) {
      const prov = document.createElement('div');
      prov.className = 'prov';
      prov.textContent = provenance;
      this.resultEl.appendChild(prov);
    }
    // Badge: only when the sheet is closed — a result the user already sees
    // (sheet open) is not "unread". The thinking indicator is not a result.
    if (!this.sheetIsOpen() && text !== t('bubbleThinking')) this.incrementUnread();
  }

  /** Drag the bubble anywhere; a click (not a drag) toggles the sheet. */
  private makeDraggable(el: HTMLElement): void {
    let startX = 0;
    let startY = 0;
    let moved = false;
    el.addEventListener('pointerdown', (e) => {
      startX = e.clientX;
      startY = e.clientY;
      moved = false;
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
        el.style.right = `${Math.max(8, window.innerWidth - ev.clientX - 28)}px`;
        el.style.bottom = `${Math.max(8, window.innerHeight - ev.clientY - 28)}px`;
        // The badge stays above the bubble while dragging.
        this.badge.style.right = el.style.right;
        this.badge.style.bottom = `${Math.max(8, window.innerHeight - ev.clientY - 28 + 64)}px`;
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (moved) el.addEventListener('click', (ev) => ev.stopPropagation(), { once: true, capture: true });
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }
}
