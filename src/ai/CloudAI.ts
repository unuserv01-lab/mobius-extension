// CloudAI — Gemini (cloud) via the Firebase AI Logic JS SDK (P4).
// Borrowed intelligence: called ONLY when the user enabled "Allow Cloud AI"
// AND AIRouter decided the task needs it. Every call is logged by AIRouter.
import { getAI, getGenerativeModel, GoogleAIBackend } from 'firebase/ai';
import { getFirebaseApp } from '../config/firebase';

export class CloudAI {
  static async generate(prompt: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    try {
      const app = getFirebaseApp(); // throws a clear error if keys are placeholders
      const ai = getAI(app, { backend: new GoogleAIBackend() });
      // gemini-3.8-flash: gemini-2.0-flash is superseded (2.5-flash already
      // rejected for new users, verified on Android 24 Nov). 3.8-flash was
      // accepted by the same Firebase AI Logic backend on Android (v3 test).
      const model = getGenerativeModel(ai, { model: 'gemini-3.8-flash' });
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      if (!text || !text.trim()) return { ok: false, error: 'Cloud Gemini returned an empty response.' };
      return { ok: true, text: text.trim() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
