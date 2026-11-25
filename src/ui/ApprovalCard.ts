// ApprovalCard — side-panel card shown while a bridge task waits for the
// phone's approval (v8.1, cross-device approval card).
//
// The phone owns the decision: the user approves/rejects on the HP (and
// chooses "ingat: sekali / chat ini / selamanya" there); the laptop only
// shows the waiting state, so the user looking at Chrome sees the same
// state as the phone. This card is READ-ONLY by design — it has no
// approve/reject buttons, because a click in the laptop panel must never
// stand in for the phone's approval. (Delegating the decision to the
// laptop is a follow-up, not v8.1.)
//
// State source: chrome.storage.local key `mobius_bridge_approval`, written
// by postOrchestratorResult() (see BridgeClient.ts) when a browser task
// returns awaiting_approval, cleared when the same task finishes. The card
// listens to storage changes, so it appears/disappears without polling.
//
// WIRING (untuk koordinator — satu baris di src/ui/main.ts, di samping
// TakeoverBanner):
//   import { ApprovalCard } from './ApprovalCard';
//   const approvalCard = new ApprovalCard();
//   approvalCard.mount();
//
// Styling is inline on purpose (same pattern as TakeoverBanner.ts):
// src/ui/index.html is NOT owned by this workstream. Colours follow the
// v7 palette (amber "cloud" badge: #3a2f10 / #fdd663); the sensitive tier
// uses the error red already used for destructive actions.
import {
  APPROVAL_STORAGE_KEY,
  getApprovalPending,
  type ApprovalPendingState,
} from '../core/BridgeClient';
import { t, tf } from '../core/i18n';

export class ApprovalCard {
  private el: HTMLDivElement | null = null;
  private listening = false;

  /** Create the element and insert it above the panel content. Safe to call
   * once; a second call is a no-op. */
  mount(): void {
    if (this.el) return;
    const main = document.getElementById('view');
    const card = document.createElement('div');
    card.id = 'mobius-approval-card';
    card.style.display = 'none';
    card.style.width = '100%';
    card.style.boxSizing = 'border-box';
    card.style.padding = '10px 14px';
    card.style.borderBottom = '1px solid #fdd663';
    card.style.background = '#3a2f10';
    card.style.color = '#fdd663';
    card.style.fontSize = '13px';
    card.style.fontFamily = 'inherit';
    card.style.textAlign = 'left';
    if (main?.parentElement) {
      main.parentElement.insertBefore(card, main);
    } else {
      document.body.prepend(card);
    }
    this.el = card;
    if (!this.listening) {
      this.listening = true;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[APPROVAL_STORAGE_KEY]) {
          void this.refresh();
        }
      });
    }
    void this.refresh();
  }

  /** Re-read the announcement and update visibility/text. */
  async refresh(): Promise<void> {
    if (!this.el) return;
    const state = await getApprovalPending().catch(() => null);
    if (!state) {
      this.el.style.display = 'none';
      this.el.textContent = '';
      return;
    }
    this.el.style.display = 'block';
    this.render(state);
  }

  private render(state: ApprovalPendingState): void {
    if (!this.el) return;
    // Build with DOM APIs (no innerHTML): pending-action descriptions come
    // from the task and must never be parsed as HTML.
    this.el.textContent = '';
    const title = document.createElement('div');
    title.style.fontWeight = '700';
    title.textContent = t('approvalCardTitle');
    this.el.appendChild(title);
    const sensitive = state.pendingActions.some((a) => a.tier === 'sensitive');
    const lines = state.pendingActions.map((a) => `• ${a.description}`);
    if (state.url) lines.push(tf('approvalCardAt', { url: state.url }));
    const body = document.createElement('div');
    body.style.marginTop = '4px';
    body.style.opacity = '0.9';
    body.textContent = lines.join('\n');
    this.el.appendChild(body);
    const hint = document.createElement('div');
    hint.style.marginTop = '4px';
    hint.style.opacity = '0.8';
    hint.textContent = sensitive ? t('approvalCardHintSensitive') : t('approvalCardHint');
    this.el.appendChild(hint);
  }
}
