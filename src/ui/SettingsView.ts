// SettingsView — cloud AI toggle, engine, TTL, Firebase status, language,
// chat retention. (v7: language picker id/en + chat retention 1h/24h/7d.)
import {
  CHAT_RETENTION_CHOICES,
  DEFAULT_CHAT_RETENTION_SECONDS,
  DEFAULT_ENGINE,
  DEFAULT_LOCAL_SERVER_BASE_URL,
  DEFAULT_LOCAL_SERVER_MODEL,
  DEFAULT_MEMORY_TTL_SECONDS,
  DEFAULT_TEMP_TTL_SECONDS,
  STORAGE_KEYS,
} from '../config/constants';
import { isFirebaseConfigured } from '../config/firebase';
import { getLang, loadLanguage, setLanguage, t, type Lang } from '../core/i18n';
import { PermissionManager } from '../core/PermissionManager';
import type { EngineChoice, MobiusSettings } from '../core/types';

export class SettingsView {
  private el: HTMLElement;
  private permissions = new PermissionManager();

  constructor(el: HTMLElement) {
    this.el = el;
  }

  async render(): Promise<void> {
    await loadLanguage();
    const gates = await this.permissions.getAll();
    const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
    const stored = data[STORAGE_KEYS.settings] as Partial<MobiusSettings> | undefined;
    const settings: MobiusSettings = {
      memoryTtlSeconds: stored?.memoryTtlSeconds ?? DEFAULT_MEMORY_TTL_SECONDS,
      tempTtlSeconds: stored?.tempTtlSeconds ?? DEFAULT_TEMP_TTL_SECONDS,
      engine: stored?.engine ?? DEFAULT_ENGINE,
      localServerBaseUrl: stored?.localServerBaseUrl ?? DEFAULT_LOCAL_SERVER_BASE_URL,
      localServerModel: stored?.localServerModel ?? DEFAULT_LOCAL_SERVER_MODEL,
      language: stored?.language ?? getLang(),
      chatRetentionSeconds: stored?.chatRetentionSeconds ?? DEFAULT_CHAT_RETENTION_SECONDS,
    };
    const engine = settings.engine ?? DEFAULT_ENGINE;
    const lang = settings.language ?? getLang();
    const retention = settings.chatRetentionSeconds ?? DEFAULT_CHAT_RETENTION_SECONDS;
    this.el.innerHTML = `
      <section>
        <h2>${this.escape(t('settingsTitle'))}</h2>
        <div class="card">
          <div class="row">
            <label><strong>${this.escape(t('setCloudAI'))}</strong>
              <small>${this.escape(t('setCloudAIDesc'))}</small></label>
            <input type="checkbox" class="switch" id="cloud-toggle" ${gates.cloudAI ? 'checked' : ''} />
          </div>
          <div class="row">
            <label><strong>${this.escape(t('setBubble'))}</strong>
              <small>${this.escape(t('setBubbleDesc'))}</small></label>
            <input type="checkbox" class="switch" id="bubble-toggle" ${gates.bubble ? 'checked' : ''} />
          </div>
          <div class="row">
            <label><strong>${this.escape(t('setMemory'))}</strong>
              <small>${this.escape(t('setMemoryDesc'))}</small></label>
            <input type="checkbox" class="switch" id="memory-toggle" ${gates.memory ? 'checked' : ''} />
          </div>
        </div>
        <div class="card">
          <strong>${this.escape(t('setLanguage'))}</strong>
          <p class="muted">${this.escape(t('setLanguageDesc'))}</p>
          <select id="language-select">
            <option value="id" ${lang === 'id' ? 'selected' : ''}>${this.escape(t('langIndonesian'))}</option>
            <option value="en" ${lang === 'en' ? 'selected' : ''}>${this.escape(t('langEnglish'))}</option>
          </select>
        </div>
        <div class="card">
          <strong>${this.escape(t('setChatHistory'))}</strong>
          <p class="muted">${this.escape(t('setChatHistoryDesc'))}</p>
          <select id="chat-retention">
            ${CHAT_RETENTION_CHOICES.map(
              (c) => `<option value="${c.seconds}" ${retention === c.seconds ? 'selected' : ''}>${this.escape(t(c.labelKey))}</option>`,
            ).join('')}
          </select>
          <br /><br />
          <button class="btn primary" id="save-chat-retention">${this.escape(t('setSave'))}</button>
          <span class="muted" id="chat-saved"></span>
        </div>
        <div class="card">
          <strong>${this.escape(t('setEngine'))}</strong>
          <p class="muted">${this.escape(t('setEngineDesc'))}</p>
          <label class="muted">${this.escape(t('setEngineLabel'))}</label>
          <select id="engine-select">
            <option value="auto" ${engine === 'auto' ? 'selected' : ''}>${this.escape(t('engineAuto'))}</option>
            <option value="nano" ${engine === 'nano' ? 'selected' : ''}>${this.escape(t('engineNano'))}</option>
            <option value="cloud" ${engine === 'cloud' ? 'selected' : ''}>${this.escape(t('engineCloud'))}</option>
            <option value="local" ${engine === 'local' ? 'selected' : ''}>${this.escape(t('engineLocal'))}</option>
          </select>
          <br /><br />
          <label class="muted">${this.escape(t('setLocalBaseUrl'))}</label>
          <input type="text" id="local-base-url" value="${this.escape(settings.localServerBaseUrl ?? '')}" placeholder="http://localhost:11434" />
          <br /><br />
          <label class="muted">${this.escape(t('setLocalModel'))}</label>
          <input type="text" id="local-model" value="${this.escape(settings.localServerModel ?? '')}" placeholder="llama3.1" />
          <p class="muted">${this.escape(t('setLocalNote'))}</p>
          <button class="btn primary" id="save-engine">${this.escape(t('setSaveEngine'))}</button>
          <span class="muted" id="engine-saved"></span>
        </div>
        <div class="card">
          <strong>${this.escape(t('setTtl'))}</strong>
          <p class="muted">${this.escape(t('setTtlDesc'))}</p>
          <label class="muted">${this.escape(t('setMemoryTtl'))}</label>
          <input type="number" id="memory-ttl" min="1" max="90" value="${Math.round(settings.memoryTtlSeconds / 86400)}" />
          <br /><br />
          <label class="muted">${this.escape(t('setTempTtl'))}</label>
          <input type="number" id="temp-ttl" min="1" max="120" value="${Math.round(settings.tempTtlSeconds / 60)}" />
          <br /><br />
          <button class="btn primary" id="save-ttl">${this.escape(t('setSaveTtl'))}</button>
          <span class="muted" id="ttl-saved"></span>
        </div>
        <div class="card">
          <strong>${this.escape(t('setFirebaseStatus'))}</strong>
          <p class="muted">${this.escape(isFirebaseConfigured() ? t('setFirebaseOk') : t('setFirebaseMissing'))}</p>
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

    // Language applies immediately (main.ts re-renders on storage change).
    this.el.querySelector('#language-select')?.addEventListener('change', (e) => {
      const value = (e.target as HTMLSelectElement).value as Lang;
      void setLanguage(value);
    });

    this.el.querySelector('#save-chat-retention')?.addEventListener('click', () => {
      const seconds = Number((this.el.querySelector('#chat-retention') as HTMLSelectElement).value) || DEFAULT_CHAT_RETENTION_SECONDS;
      void this.saveSettings({ chatRetentionSeconds: seconds }).then(() => {
        const saved = this.el.querySelector('#chat-saved');
        if (saved) saved.textContent = t('setSaved');
      });
    });

    this.el.querySelector('#save-engine')?.addEventListener('click', () => {
      const engineChoice = (this.el.querySelector('#engine-select') as HTMLSelectElement).value as EngineChoice;
      const baseUrl = (this.el.querySelector('#local-base-url') as HTMLInputElement).value.trim() || DEFAULT_LOCAL_SERVER_BASE_URL;
      const model = (this.el.querySelector('#local-model') as HTMLInputElement).value.trim() || DEFAULT_LOCAL_SERVER_MODEL;
      void this.saveSettings({ engine: engineChoice, localServerBaseUrl: baseUrl, localServerModel: model }).then(() => {
        const saved = this.el.querySelector('#engine-saved');
        if (saved) saved.textContent = t('setSaved');
      });
    });

    this.el.querySelector('#save-ttl')?.addEventListener('click', () => {
      const memDays = Number((this.el.querySelector('#memory-ttl') as HTMLInputElement).value) || 7;
      const tempMin = Number((this.el.querySelector('#temp-ttl') as HTMLInputElement).value) || 15;
      void this.saveSettings({ memoryTtlSeconds: memDays * 86400, tempTtlSeconds: tempMin * 60 }).then(() => {
        const saved = this.el.querySelector('#ttl-saved');
        if (saved) saved.textContent = t('setSaved');
      });
    });
  }

  /** Merge partial settings into chrome.storage.local (never wipe other keys). */
  private async saveSettings(patch: Partial<MobiusSettings>): Promise<void> {
    const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
    const stored = (data[STORAGE_KEYS.settings] as Partial<MobiusSettings> | undefined) ?? {};
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: { ...stored, ...patch } });
  }

  private escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
