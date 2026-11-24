// SettingsView — "Allow Cloud AI" toggle, TTL settings, and Firebase status.
import {
  DEFAULT_ENGINE,
  DEFAULT_LOCAL_SERVER_BASE_URL,
  DEFAULT_LOCAL_SERVER_MODEL,
  DEFAULT_MEMORY_TTL_SECONDS,
  DEFAULT_TEMP_TTL_SECONDS,
  STORAGE_KEYS,
} from '../config/constants';
import { isFirebaseConfigured } from '../config/firebase';
import { PermissionManager } from '../core/PermissionManager';
import type { EngineChoice, MobiusSettings } from '../core/types';

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
      engine: stored?.engine ?? DEFAULT_ENGINE,
      localServerBaseUrl: stored?.localServerBaseUrl ?? DEFAULT_LOCAL_SERVER_BASE_URL,
      localServerModel: stored?.localServerModel ?? DEFAULT_LOCAL_SERVER_MODEL,
    };
    const engine = settings.engine ?? DEFAULT_ENGINE;
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
          <strong>AI Engine</strong>
          <p class="muted">Which intelligence answers. Default "Auto" = Nano on-device first, cloud only if allowed. An explicit engine never silently switches to another one — if it fails, MOBIUS logs it and falls back only to the local extractive summary.</p>
          <label class="muted">Engine</label>
          <select id="engine-select">
            <option value="auto" ${engine === 'auto' ? 'selected' : ''}>Auto (Nano first, cloud if allowed)</option>
            <option value="nano" ${engine === 'nano' ? 'selected' : ''}>Nano on-device only</option>
            <option value="cloud" ${engine === 'cloud' ? 'selected' : ''}>Cloud Gemini only (needs "Allow Cloud AI")</option>
            <option value="local" ${engine === 'local' ? 'selected' : ''}>Local server only (e.g. Ollama on this laptop)</option>
          </select>
          <br /><br />
          <label class="muted">Local server base URL</label>
          <input type="text" id="local-base-url" value="${settings.localServerBaseUrl}" placeholder="http://localhost:11434" />
          <br /><br />
          <label class="muted">Local server model</label>
          <input type="text" id="local-model" value="${settings.localServerModel}" placeholder="llama3.1" />
          <p class="muted">No model runs inside the browser — the "local server" is a program on your laptop (e.g. Ollama: <span class="mono">ollama serve</span>, then <span class="mono">ollama pull llama3.1</span>). The extension only calls it over HTTP. If the server is down, MOBIUS says so instead of pretending success.</p>
          <button class="btn primary" id="save-engine">Save engine settings</button>
          <span class="muted" id="engine-saved"></span>
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

    this.el.querySelector('#save-engine')?.addEventListener('click', () => {
      const engineChoice = (this.el.querySelector('#engine-select') as HTMLSelectElement).value as EngineChoice;
      const baseUrl = (this.el.querySelector('#local-base-url') as HTMLInputElement).value.trim() || DEFAULT_LOCAL_SERVER_BASE_URL;
      const model = (this.el.querySelector('#local-model') as HTMLInputElement).value.trim() || DEFAULT_LOCAL_SERVER_MODEL;
      void this.saveSettings({ engine: engineChoice, localServerBaseUrl: baseUrl, localServerModel: model }).then(() => {
        const saved = this.el.querySelector('#engine-saved');
        if (saved) saved.textContent = 'Saved.';
      });
    });

    this.el.querySelector('#save-ttl')?.addEventListener('click', () => {
      const memDays = Number((this.el.querySelector('#memory-ttl') as HTMLInputElement).value) || 7;
      const tempMin = Number((this.el.querySelector('#temp-ttl') as HTMLInputElement).value) || 15;
      void this.saveSettings({ memoryTtlSeconds: memDays * 86400, tempTtlSeconds: tempMin * 60 }).then(() => {
        const saved = this.el.querySelector('#ttl-saved');
        if (saved) saved.textContent = 'Saved.';
      });
    });
  }

  /** Merge partial settings into chrome.storage.local (never wipe other keys). */
  private async saveSettings(patch: Partial<MobiusSettings>): Promise<void> {
    const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
    const stored = (data[STORAGE_KEYS.settings] as Partial<MobiusSettings> | undefined) ?? {};
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: { ...stored, ...patch } });
  }
}
