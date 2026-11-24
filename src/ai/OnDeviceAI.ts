// OnDeviceAI — Gemini Nano via the Firebase AI Logic JS SDK (P3).
// This is the DEFAULT intelligence: inference runs on-device first.
// Runtime path: Firebase AI Logic -> getAI() -> getGenerativeModel() with
// inferenceMode 'on-device' (Gemini Nano). If the SDK reports Nano as
// unavailable (or Firebase is not configured), we fall back to Chrome's
// built-in Prompt API (LanguageModel) when present, and finally to a local
// extractive summary so the extension still works offline.
import { getAI, getGenerativeModel, GoogleAIBackend } from 'firebase/ai';
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
        const model = getGenerativeModel(ai, {
          model: 'gemini-nano',
          inferenceMode: 'on-device',
        } as unknown as Parameters<typeof getGenerativeModel>[1]);
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
