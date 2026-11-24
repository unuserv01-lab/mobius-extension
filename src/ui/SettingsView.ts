// SettingsView — "Allow Cloud AI" toggle, TTL settings, and Firebase status.
import { DEFAULT_MEMORY_TTL_SECONDS, DEFAULT_TEMP_TTL_SECONDS, STORAGE_KEYS } from '../config/constants';
import { isFirebaseConfigured } from '../config/firebase';
import { PermissionManager } from '../core/PermissionManager';
import type { MobiusSettings } from '../core/types';

export class SettingsView {
  private el: HTMLElement;
  private permissions = new PermissionManager();

  constructor(el: HTMLElement) {
    this.el = el;
  }

  async render(): Promise<void> {
    const gates = await this.permissions.getAll();
    const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
    const stored = data[STORAGE_KEYS.settings] as Partial<MobiusSettings> | undefined;
    const settings: MobiusSettings = {
      memoryTtlSeconds: stored?.memoryTtlSeconds ?? DEFAULT_MEMORY_TTL_SECONDS,
      tempTtlSeconds: stored?.tempTtlSeconds ?? DEFAULT_TEMP_TTL_SECONDS,
    };
    this.el.innerHTML = `
      <section>
        <h2>Settings</h2>
        <div class="card">
          <div class="row">
            <label><strong>Allow Cloud AI (Borrowed Intelligence)</strong>
              <small>When OFF (default), MOBIUS never calls the cloud — even if on-device AI is unavailable. Every cloud call is logged in the Router Log.</small></label>
            <input type="checkbox" class="switch" id="cloud-toggle" ${gates.cloudAI ? 'checked' : ''} />
          </div>
          <div class="row">
            <label><strong>Floating Bubble</strong>
              <small>Show the MOBIUS bubble on webpages.</small></label>
            <input type="checkbox" class="switch" id="bubble-toggle" ${gates.bubble ? 'checked' : ''} />
          </div>
          <div class="row">
            <label><strong>Memory (local, TTL)</strong>
              <small>Store task outcomes on this device only.</small></label>
            <input type="checkbox" class="switch" id="memory-toggle" ${gates.memory ? 'checked' : ''} />
          </div>
        </div>
        <div class="card">
          <strong>Time limits (TTL)</strong>
          <p class="muted">Memory entries expire after this many days; temporary subagent data after this many minutes.</p>
          <label class="muted">Memory TTL (days)</label>
          <input type="number" id="memory-ttl" min="1" max="90" value="${Math.round(settings.memoryTtlSeconds / 86400)}" />
          <br /><br />
          <label class="muted">Temporary data TTL (minutes)</label>
          <input type="number" id="temp-ttl" min="1" max="120" value="${Math.round(settings.tempTtlSeconds / 60)}" />
          <br /><br />
          <button class="btn primary" id="save-ttl">Save TTL</button>
          <span class="muted" id="ttl-saved"></span>
        </div>
        <div class="card">
          <strong>Firebase AI Logic status</strong>
          <p class="muted">${isFirebaseConfigured()
            ? 'Firebase keys are configured in src/config/firebase.ts. On-device Gemini Nano and cloud Gemini are available through the Firebase AI Logic SDK.'
            : 'Firebase keys are NOT configured yet — paste them into src/config/firebase.ts (see README "Firebase setup"). Until then, MOBIUS runs on the built-in Prompt API / local extractive fallback and degrades gracefully.'}</p>
        </div>
      </section>`;

    const bind = (id: string, key: 'cloudAI' | 'bubble' | 'memory') => {
      const toggle = this.el.querySelector<HTMLInputElement>(`#${id}`);
      toggle?.addEventListener('change', () => {
        void this.permissions.set(key, toggle.checked);
      });
    };
    bind('cloud-toggle', 'cloudAI');
    bind('bubble-toggle', 'bubble');
    bind('memory-toggle', 'memory');

    this.el.querySelector('#save-ttl')?.addEventListener('click', () => {
      const memDays = Number((this.el.querySelector('#memory-ttl') as HTMLInputElement).value) || 7;
      const tempMin = Number((this.el.querySelector('#temp-ttl') as HTMLInputElement).value) || 15;
      void chrome.storage.local
        .set({ [STORAGE_KEYS.settings]: { memoryTtlSeconds: memDays * 86400, tempTtlSeconds: tempMin * 60 } })
        .then(() => {
          const saved = this.el.querySelector('#ttl-saved');
          if (saved) saved.textContent = 'Saved.';
        });
    });
  }
}
