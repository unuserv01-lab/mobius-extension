// PermissionManager — opt-in capability gates (P8).
// Every cross-tab / DOM capability requires EXPLICIT user opt-in in the
// side-panel Onboarding/Settings views. Denied capabilities degrade
// gracefully: the dependent feature is disabled and the user is told why.
import { STORAGE_KEYS } from '../config/constants';
import { DEFAULT_PERMISSIONS, type PermissionGates } from './types';

export type CapabilityKey = keyof PermissionGates;

const EXPLANATIONS: Record<CapabilityKey, string> = {
  bubble: 'Show the floating MOBIUS bubble on webpages.',
  readPage: 'Read the active tab text (WhatsApp Web chats, articles) so MOBIUS can use page context.',
  domActions: 'Type / insert replies into web inputs (e.g. the WhatsApp Web message box).',
  memory: 'Store task outcomes locally on this device, with a time limit (TTL).',
  cloudAI: 'Allow Cloud AI (borrowed intelligence). When OFF, MOBIUS never calls the cloud, even if on-device AI is unavailable.',
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
    return EXPLANATIONS[key];
  }

  /** Human-readable denial message for a capability the user has not opted into. */
  denialMessage(key: CapabilityKey): string {
    return (
      `This needs "${this.explain(key)}" — it is currently OFF. ` +
      `Enable it in the MOBIUS Side Panel (Onboarding / Settings) to use this feature.`
    );
  }
}
