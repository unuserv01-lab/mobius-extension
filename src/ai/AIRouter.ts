// AIRouter — decides on-device vs cloud vs local server (P3/P4, Workstream J v6)
// and LOGS EVERY decision.
// Engine setting (persisted in mobius_settings, default "auto"):
//   auto  — today's behavior: Nano first, cloud only if allowed, then local extractive fallback.
//   nano  — Gemini Nano on-device ONLY. Never calls cloud or the local server.
//   cloud — Cloud Gemini ONLY, and only if "Allow Cloud AI" is ON.
//   local — Local server (e.g. Ollama on the laptop) ONLY.
// An explicit engine choice NEVER silently switches to another engine: if the
// chosen engine fails, AIRouter logs the failure and falls back only to the
// local extractive summary (real, offline, labelled as such) so the demo
// still works — never to a different AI engine.
// Every routing decision is appended to chrome.storage.local and shown live
// in the Side Panel RouterLogView.
import { DEFAULT_ENGINE, STORAGE_KEYS } from '../config/constants';
import type { PermissionManager } from '../core/PermissionManager';
import type { EngineChoice, MobiusSettings, RouterDecision } from '../core/types';
import { CloudAI } from './CloudAI';
import { LocalServerAI, loadLocalServerConfig } from './LocalServerAI';
import { OnDeviceAI } from './OnDeviceAI';

export type GenerateResult =
  | { ok: true; text: string; engine: 'on-device' | 'cloud' | 'local-server' | 'local-fallback' }
  | { ok: false; error: string; engine: 'none' };

export class AIRouter {
  private permissions: PermissionManager;

  constructor(permissions: PermissionManager) {
    this.permissions = permissions;
  }

  /** Read the persisted engine choice; unknown/missing values fall back to "auto". */
  async getEngineChoice(): Promise<EngineChoice> {
    const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
    const stored = data[STORAGE_KEYS.settings] as Partial<MobiusSettings> | undefined;
    const choice = stored?.engine;
    return choice === 'auto' || choice === 'nano' || choice === 'cloud' || choice === 'local' ? choice : DEFAULT_ENGINE;
  }

  async generate(
    taskId: string,
    prompt: string,
    opts: { needsHeavyReasoning: boolean; pageTextChars: number },
  ): Promise<GenerateResult> {
    const cloudAllowed = await this.permissions.isAllowed('cloudAI');
    const engineChoice = await this.getEngineChoice();
    const started = Date.now();
    const summary = prompt.slice(0, 80).replace(/\s+/g, ' ');
    const payload = (detail: string): string => `prompt ${prompt.length} chars, ${detail}`;

    // Explicit engine choices: exactly one engine, no silent switching.
    if (engineChoice === 'nano') {
      const nano = await OnDeviceAI.generate(prompt);
      if (nano.ok) {
        await this.log({ taskId, taskSummary: summary, engine: 'on-device', reason: 'Engine "nano": Gemini Nano on-device (explicit choice).', latencyMs: Date.now() - started, cloudAllowed, payloadSummary: payload('on-device, explicit') });
        return { ok: true, text: nano.text, engine: 'on-device' };
      }
      return this.failWithFallback(taskId, summary, prompt, started, cloudAllowed, `Engine "nano" failed: ${nano.error}`, payload('nano failed, no other engine tried'));
    }
    if (engineChoice === 'cloud') {
      if (!cloudAllowed) {
        await this.log({ taskId, taskSummary: summary, engine: 'local-fallback', reason: 'Engine "cloud" chosen but "Allow Cloud AI" is OFF — cloud NOT called.', latencyMs: Date.now() - started, cloudAllowed, payloadSummary: payload('cloud not allowed') });
        const fallback = this.extractiveFallback(prompt);
        if (fallback) return { ok: true, text: fallback, engine: 'local-fallback' };
        return { ok: false, error: 'Engine "cloud" is selected but "Allow Cloud AI" is OFF, so MOBIUS did not call the cloud. Enable "Allow Cloud AI" in Settings or switch the engine back to "auto".', engine: 'none' };
      }
      const cloud = await CloudAI.generate(prompt);
      if (cloud.ok) {
        await this.log({ taskId, taskSummary: summary, engine: 'cloud', reason: 'Engine "cloud": cloud Gemini (explicit choice).', latencyMs: Date.now() - started, cloudAllowed, payloadSummary: payload('cloud Gemini, explicit') });
        return { ok: true, text: cloud.text, engine: 'cloud' };
      }
      return this.failWithFallback(taskId, summary, prompt, started, cloudAllowed, `Engine "cloud" failed: ${cloud.error}`, payload('cloud failed, no other engine tried'));
    }
    if (engineChoice === 'local') {
      const cfg = await loadLocalServerConfig();
      const local = await LocalServerAI.generate(prompt, cfg);
      if (local.ok) {
        await this.log({ taskId, taskSummary: summary, engine: 'local-server', reason: `Engine "local": local server at ${cfg.baseUrl} (model "${cfg.model}", explicit choice).`, latencyMs: Date.now() - started, cloudAllowed, payloadSummary: payload(`local server ${cfg.baseUrl} model ${cfg.model}`) });
        return { ok: true, text: local.text, engine: 'local-server' };
      }
      return this.failWithFallback(taskId, summary, prompt, started, cloudAllowed, `Engine "local" failed: ${local.error}`, payload(`local server ${cfg.baseUrl} failed, no other engine tried`));
    }

    // "auto" (default) — today's behavior, unchanged.
    const onDevice = await OnDeviceAI.generate(prompt);
    if (onDevice.ok) {
      await this.log({ taskId, taskSummary: summary, engine: 'on-device', reason: 'Default intelligence (P3): Gemini Nano on-device.', latencyMs: Date.now() - started, cloudAllowed, payloadSummary: payload('on-device') });
      return { ok: true, text: onDevice.text, engine: 'on-device' };
    }
    // Narrowed once here so later branches never re-derive the union.
    const nanoError = onDevice.error;

    // Step 2: cloud escalation — only if needed AND permitted.
    if (!cloudAllowed) {
      await this.log({ taskId, taskSummary: summary, engine: 'local-fallback', reason: `Nano unavailable (${nanoError}); cloud NOT called — "Allow Cloud AI" is OFF.`, latencyMs: Date.now() - started, cloudAllowed, payloadSummary: payload('no cloud call') });
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
      await this.log({ taskId, taskSummary: summary, engine: 'cloud', reason: `Escalated: Nano unavailable (${nanoError}) and cloud is allowed.`, latencyMs: Date.now() - started, cloudAllowed, payloadSummary: payload('-> cloud Gemini') });
      return { ok: true, text: cloud.text, engine: 'cloud' };
    }
    await this.log({ taskId, taskSummary: summary, engine: 'local-fallback', reason: `Both engines failed — Nano: ${nanoError}; Cloud: ${cloud.error}.`, latencyMs: Date.now() - started, cloudAllowed, payloadSummary: payload('both engines failed') });
    const fallback = this.extractiveFallback(prompt);
    if (fallback) return { ok: true, text: fallback, engine: 'local-fallback' };
    return { ok: false, error: `On-device failed (${nanoError}); cloud failed (${cloud.error}).`, engine: 'none' };
  }

  /**
   * Log an explicit-engine failure, then try ONLY the local extractive
   * summary — never another AI engine. Returns the fallback result, or an
   * honest error when even the extractive summary has nothing to work with.
   */
  private async failWithFallback(
    taskId: string,
    taskSummary: string,
    prompt: string,
    started: number,
    cloudAllowed: boolean,
    reason: string,
    payloadSummary: string,
  ): Promise<GenerateResult> {
    await this.log({ taskId, taskSummary, engine: 'local-fallback', reason: `${reason} — no other engine tried (explicit engine choice).`, latencyMs: Date.now() - started, cloudAllowed, payloadSummary });
    const fallback = this.extractiveFallback(prompt);
    if (fallback) return { ok: true, text: fallback, engine: 'local-fallback' };
    return { ok: false, error: `${reason} No local extractive summary was possible either.`, engine: 'none' };
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
