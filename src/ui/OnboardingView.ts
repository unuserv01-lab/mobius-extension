// OnboardingView — permission explain + opt-in toggles (P8). (v7: i18n.)
// Every capability is explained in plain language before the user opts in.
import { loadLanguage, t, type StringKey } from '../core/i18n';
import { PermissionManager, type CapabilityKey } from '../core/PermissionManager';
import type { PermissionGates } from '../core/types';

const GATES: { key: CapabilityKey; titleKey: StringKey }[] = [
  { key: 'bubble', titleKey: 'gateBubble' },
  { key: 'readPage', titleKey: 'gateReadPage' },
  { key: 'domActions', titleKey: 'gateDomActions' },
  { key: 'memory', titleKey: 'gateMemory' },
  { key: 'cloudAI', titleKey: 'gateCloudAI' },
];

export class OnboardingView {
  private el: HTMLElement;
  private permissions = new PermissionManager();

  constructor(el: HTMLElement) {
    this.el = el;
  }

  async render(): Promise<void> {
    await loadLanguage();
    const gates: PermissionGates = await this.permissions.getAll();
    this.el.innerHTML = `
      <section>
        <h2>${this.escape(t('onbWelcome'))}</h2>
        <p class="muted">${this.escape(t('onbIntro'))}</p>
        <div class="card" id="gates"></div>
        <div class="card">
          <strong>${this.escape(t('onbHowItWorks'))}</strong>
          <p class="muted">${this.escape(t('onbSteps')).replace(/\n/g, '<br>')}</p>
        </div>
      </section>`;
    const container = this.el.querySelector('#gates')!;
    for (const g of GATES) {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('label');
      label.innerHTML = `<strong>${this.escape(t(g.titleKey))}</strong><small>${this.escape(this.permissions.explain(g.key))}</small>`;
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

  private escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
