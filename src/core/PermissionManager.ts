// PermissionManager — opt-in capability gates (P8).
// Every cross-tab / DOM capability requires EXPLICIT user opt-in in the
// side-panel Onboarding/Settings views. Denied capabilities degrade
// gracefully: the dependent feature is disabled and the user is told why.
import { STORAGE_KEYS } from '../config/constants';
import { t, tf, type StringKey } from './i18n';
import { DEFAULT_PERMISSIONS, type PermissionGates } from './types';

export type CapabilityKey = keyof PermissionGates;

const EXPLANATIONS: Record<CapabilityKey, StringKey> = {
  bubble: 'explainBubble',
  readPage: 'explainReadPage',
  domActions: 'explainDomActions',
  memory: 'explainMemory',
  cloudAI: 'explainCloudAI',
};

export class PermissionManager {
  private cache: PermissionGates | null = null;

  async getAll(): Promise<PermissionGates> {
    if (this.cache) return this.cache;
    const data = await chrome.storage.local.get(STORAGE_KEYS.permissions);
    const stored = data[STORAGE_KEYS.permissions] as Partial<PermissionGates> | undefined;
    this.cache = { ...DEFAULT_PERMISSIONS, ...(stored ?? {}) };
    return this.cache;
  }

  async isAllowed(key: CapabilityKey): Promise<boolean> {
    const gates = await this.getAll();
    return gates[key];
  }

  async set(key: CapabilityKey, value: boolean): Promise<PermissionGates> {
    const gates = await this.getAll();
    gates[key] = value;
    this.cache = gates;
    await chrome.storage.local.set({ [STORAGE_KEYS.permissions]: gates });
    return gates;
  }

  explain(key: CapabilityKey): string {
    return t(EXPLANATIONS[key]);
  }

  /** Human-readable denial message for a capability the user has not opted into. */
  denialMessage(key: CapabilityKey): string {
    return tf('denialNeeds', { detail: this.explain(key) });
  }
}
