// OnDeviceAI — Gemini Nano via the Firebase AI Logic JS SDK (P3).
// This is the DEFAULT intelligence: inference runs on-device first.
// Runtime path: Firebase AI Logic -> getAI() -> getGenerativeModel() with
// { mode: InferenceMode.ONLY_ON_DEVICE } (HybridParams, firebase 12.19.0).
// If Nano is unavailable, generateContent throws (never falls back to cloud);
// we then try Chrome's built-in Prompt API (LanguageModel) when present,
// and AIRouter finally falls back to a local extractive summary.
// BUG FIX 24 Nov 2026 (found by Claude's repo review, verified against the
// installed SDK types): the old call passed { model: 'gemini-nano',
// inferenceMode: 'on-device' } behind an `as unknown as` cast. Neither key
// exists in HybridParams, so the SDK treated it as a plain cloud ModelParams
// call with a model named "gemini-nano" — the prompt left the device before
// erroring, even with "Allow Cloud AI" OFF. ONLY_ON_DEVICE can never reach cloud.
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from 'firebase/ai';
import { getFirebaseApp, isFirebaseConfigured } from '../config/firebase';

export type OnDeviceResult = { ok: true; text: string; source: 'firebase-nano' | 'prompt-api' } | { ok: false; error: string };

async function tryPromptApi(prompt: string): Promise<string | null> {
  try {
    const g = globalThis as unknown as { LanguageModel?: { create: (opts?: unknown) => Promise<{ prompt: (p: string) => Promise<string> }> } };
    if (!g.LanguageModel) return null;
    const session = await g.LanguageModel.create({ initialPrompts: [{ role: 'system', content: 'You are MOBIUS, a concise on-device assistant.' }] });
    return await session.prompt(prompt);
  } catch {
    return null;
  }
}

export class OnDeviceAI {
  /** Returns true when Nano can plausibly run (Firebase on-device model or Prompt API). */
  static async isAvailable(): Promise<boolean> {
    if (isFirebaseConfigured()) return true; // SDK will report availability at call time
    const g = globalThis as unknown as { LanguageModel?: unknown };
    return Boolean(g.LanguageModel);
  }

  static async generate(prompt: string): Promise<OnDeviceResult> {
    // Path 1: Firebase AI Logic, Gemini Nano on-device (REQUIRED runtime call).
    if (isFirebaseConfigured()) {
      try {
        const app = getFirebaseApp();
        const ai = getAI(app, { backend: new GoogleAIBackend() });
        const model = getGenerativeModel(ai, { mode: InferenceMode.ONLY_ON_DEVICE });
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        if (text && text.trim()) return { ok: true, text: text.trim(), source: 'firebase-nano' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Fall through to the Prompt API before giving up.
        const fallback = await tryPromptApi(prompt);
        if (fallback) return { ok: true, text: fallback.trim(), source: 'prompt-api' };
        return { ok: false, error: `Gemini Nano (Firebase AI Logic) unavailable: ${message}` };
      }
    }
    // Path 2: Chrome built-in Prompt API (no Firebase config needed).
    const viaPromptApi = await tryPromptApi(prompt);
    if (viaPromptApi) return { ok: true, text: viaPromptApi.trim(), source: 'prompt-api' };
    return {
      ok: false,
      error: isFirebaseConfigured()
        ? 'Gemini Nano is not available in this Chrome (enable chrome://flags/#prompt-api-for-gemini-nano and use Chrome 138+).'
        : 'Firebase is not configured (paste keys in src/config/firebase.ts) and no built-in Prompt API was found.',
    };
  }
}
