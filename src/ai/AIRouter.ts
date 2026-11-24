// AIRouter — decides on-device vs cloud (P3/P4) and LOGS EVERY decision.
// Rules:
//  1. On-device (Gemini Nano) FIRST, always.
//  2. Cloud ONLY if: the task needs heavy reasoning OR Nano is unavailable,
//     AND the user enabled "Allow Cloud AI" (default OFF).
//  3. If cloud is needed but not allowed, we say so and offer a 1-click
//     enable prompt — we never call the cloud silently.
//  4. If both AI paths fail, we fall back to a local extractive summary
//     (real, offline, labelled as such) so the demo still works.
// Every routing decision is appended to chrome.storage.local and shown live
// in the Side Panel RouterLogView.
import { CLOUD_ESCALATION_MIN_CHARS, STORAGE_KEYS } from '../config/constants';
import type { PermissionManager } from '../core/PermissionManager';
import type { RouterDecision } from '../core/types';
import { CloudAI } from './CloudAI';
import { OnDeviceAI } from './OnDeviceAI';

export type GenerateResult =
  | { ok: true; text: string; engine: 'on-device' | 'cloud' | 'local-fallback' }
  | { ok: false; error: string; engine: 'none' };

export class AIRouter {
  private permissions: PermissionManager;

  constructor(permissions: PermissionManager) {
    this.permissions = permissions;
  }

  async generate(
    taskId: string,
    prompt: string,
    opts: { needsHeavyReasoning: boolean; pageTextChars: number },
  ): Promise<GenerateResult> {
    const cloudAllowed = await this.permissions.isAllowed('cloudAI');
    const started = Date.now();

    // Step 1: on-device first.
    const onDevice = await OnDeviceAI.generate(prompt);
    if (onDevice.ok) {
      await this.log({
        taskId,
        taskSummary: prompt.slice(0, 80).replace(/\s+/g, ' '),
        engine: 'on-device',
        reason: 'Default intelligence (P3): Gemini Nano on-device.',
        latencyMs: Date.now() - started,
        cloudAllowed,
        payloadSummary: `prompt ${prompt.length} chars, on-device`,
      });
      return { ok: true, text: onDevice.text, engine: 'on-device' };
    }
    // Narrowed once here so later branches never re-derive the union.
    const nanoError = onDevice.error;

    // Step 2: cloud escalation — only if needed AND permitted.
    // (Nano-unavailable alone is enough to consider cloud; a long/complex
    // task is the other trigger.)
    {
      if (!cloudAllowed) {
        await this.log({
          taskId,
          taskSummary: prompt.slice(0, 80).replace(/\s+/g, ' '),
          engine: 'local-fallback',
          reason: `Nano unavailable (${nanoError}); cloud NOT called — "Allow Cloud AI" is OFF.`,
          latencyMs: Date.now() - started,
          cloudAllowed,
          payloadSummary: `prompt ${prompt.length} chars, no cloud call`,
        });
        const fallback = this.extractiveFallback(prompt);
        if (fallback) return { ok: true, text: fallback, engine: 'local-fallback' };
        return {
          ok: false,
          error:
            `${nanoError} Cloud AI is OFF, so MOBIUS did not call the cloud. ` +
            `Enable "Allow Cloud AI" in Settings to let MOBIUS escalate, or enable Gemini Nano at chrome://flags/#prompt-api-for-gemini-nano.`,
          engine: 'none',
        };
      }
      const cloud = await CloudAI.generate(prompt);
      if (cloud.ok) {
        await this.log({
          taskId,
          taskSummary: prompt.slice(0, 80).replace(/\s+/g, ' '),
          engine: 'cloud',
          reason: `Escalated: Nano unavailable (${nanoError}) and cloud is allowed.`,
          latencyMs: Date.now() - started,
          cloudAllowed,
          payloadSummary: `prompt ${prompt.length} chars -> cloud Gemini`,
        });
        return { ok: true, text: cloud.text, engine: 'cloud' };
      }
      await this.log({
        taskId,
        taskSummary: prompt.slice(0, 80).replace(/\s+/g, ' '),
        engine: 'local-fallback',
        reason: `Both engines failed — Nano: ${nanoError}; Cloud: ${cloud.error}.`,
        latencyMs: Date.now() - started,
        cloudAllowed,
        payloadSummary: `prompt ${prompt.length} chars, both engines failed`,
      });
      const fallback = this.extractiveFallback(prompt);
      if (fallback) return { ok: true, text: fallback, engine: 'local-fallback' };
      return { ok: false, error: `On-device failed (${nanoError}); cloud failed (${cloud.error}).`, engine: 'none' };
    }
    return { ok: false, error: nanoError, engine: 'none' };
  }

  /** Local, offline, deterministic extractive summary of the page content embedded in the prompt. */
  private extractiveFallback(prompt: string): string | null {
    const match = prompt.match(/Content:\n?"""([\s\S]*?)"""/) ?? prompt.match(/Last message: """([\s\S]*?)"""/);
    const text = match?.[1]?.trim();
    if (!text) return null;
    const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 20);
    const picked = sentences.slice(0, 5);
    if (picked.length === 0) return null;
    return `[Local extractive summary — no AI available]\n- ${picked.join('\n- ')}`;
  }

  async log(entry: Omit<RouterDecision, 'id' | 'timestamp'>): Promise<void> {
    const full: RouterDecision = { ...entry, id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, timestamp: Date.now() };
    const data = await chrome.storage.local.get(STORAGE_KEYS.routerLog);
    const logs = Array.isArray(data[STORAGE_KEYS.routerLog]) ? (data[STORAGE_KEYS.routerLog] as RouterDecision[]) : [];
    logs.unshift(full);
    await chrome.storage.local.set({ [STORAGE_KEYS.routerLog]: logs.slice(0, 200) });
  }

  async getLog(): Promise<RouterDecision[]> {
    const data = await chrome.storage.local.get(STORAGE_KEYS.routerLog);
    return Array.isArray(data[STORAGE_KEYS.routerLog]) ? (data[STORAGE_KEYS.routerLog] as RouterDecision[]) : [];
  }

  async clearLog(): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEYS.routerLog]: [] });
  }
}
