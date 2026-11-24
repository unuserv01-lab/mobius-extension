// OnboardingView — permission explain + opt-in toggles (P8).
// Every capability is explained in plain language before the user opts in.
import { PermissionManager, type CapabilityKey } from '../core/PermissionManager';
import type { PermissionGates } from '../core/types';

const GATES: { key: CapabilityKey; title: string }[] = [
  { key: 'bubble', title: 'Floating Bubble Overlay' },
  { key: 'readPage', title: 'Read Page / DOM Context' },
  { key: 'domActions', title: 'Cross-App DOM Actions' },
  { key: 'memory', title: 'Context History / Memory (local, TTL)' },
  { key: 'cloudAI', title: 'Allow Cloud AI (Borrowed Intelligence)' },
];

export class OnboardingView {
  private el: HTMLElement;
  private permissions = new PermissionManager();

  constructor(el: HTMLElement) {
    this.el = el;
  }

  async render(): Promise<void> {
    const gates: PermissionGates = await this.permissions.getAll();
    this.el.innerHTML = `
      <section>
        <h2>Welcome to MOBIUS</h2>
        <p class="muted">MOBIUS runs locally in your browser. On-device AI (Gemini Nano) is the default.
        Nothing leaves your device unless you explicitly allow Cloud AI below.</p>
        <div class="card" id="gates"></div>
        <div class="card">
          <strong>How it works</strong>
          <p class="muted">1. Click the floating bubble on any page.<br>
          2. Ask MOBIUS — e.g. "Summarize this page" or, on WhatsApp Web, "Reply to the last message".<br>
          3. MOBIUS drafts on-device, inserts the draft (if DOM actions are on), and logs every AI routing decision in the Router Log tab.</p>
        </div>
      </section>`;
    const container = this.el.querySelector('#gates')!;
    for (const g of GATES) {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('label');
      label.innerHTML = `<strong>${g.title}</strong><small>${this.permissions.explain(g.key)}</small>`;
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'switch';
      toggle.checked = gates[g.key];
      toggle.addEventListener('change', () => {
        void this.permissions.set(g.key, toggle.checked);
      });
      row.appendChild(label);
      row.appendChild(toggle);
      container.appendChild(row);
    }
  }
}
