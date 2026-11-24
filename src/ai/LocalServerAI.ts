// LocalServerAI — LOCAL SERVER engine (Workstream J, MOBIUS v6).
// Calls a model server running on the user's own laptop over plain HTTP,
// e.g. Ollama (`ollama serve`, default http://localhost:11434).
//
// HONEST LIMIT: no model runs purely inside the browser. The extension only
// POSTs the prompt to the local server and returns its answer. If the server
// is not running, generate() fails with a clear message — it NEVER silently
// falls back to another engine or pretends success. AIRouter decides what
// happens next (extractive fallback, labelled as such).
//
// Ollama API assumption (documented): POST {baseUrl}/api/generate with JSON
// { model, prompt, stream: false } returns JSON { response: "...", done: true }.
// Default model "llama3.1" is an ASSUMPTION — Ollama ships with no model
// pre-installed; pull one first (`ollama pull llama3.1`) or pick another
// installed model in Settings. Other OpenAI-compatible servers can be used
// only if they also answer /api/generate in this shape.
import {
  DEFAULT_LOCAL_SERVER_BASE_URL,
  DEFAULT_LOCAL_SERVER_MODEL,
  DEFAULT_LOCAL_SERVER_TIMEOUT_MS,
  STORAGE_KEYS,
} from '../config/constants';
import type { LocalServerSettings } from '../core/types';

export interface LocalServerConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export type LocalServerResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/** Read the persisted local-server config (same storage pattern as PermissionManager). */
export async function loadLocalServerConfig(): Promise<LocalServerConfig> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const stored = data[STORAGE_KEYS.settings] as Partial<LocalServerSettings> | undefined;
  return {
    baseUrl: (stored?.localServerBaseUrl ?? DEFAULT_LOCAL_SERVER_BASE_URL).replace(/\/+$/, ''),
    model: stored?.localServerModel ?? DEFAULT_LOCAL_SERVER_MODEL,
    timeoutMs: DEFAULT_LOCAL_SERVER_TIMEOUT_MS,
  };
}

export class LocalServerAI {
  static async generate(prompt: string, config?: LocalServerConfig): Promise<LocalServerResult> {
    const cfg = config ?? (await loadLocalServerConfig());
    const url = `${cfg.baseUrl}/api/generate`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, prompt, stream: false }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return {
            ok: false,
            error: `Local server timed out after ${cfg.timeoutMs / 1000}s at ${cfg.baseUrl} (model "${cfg.model}"). The server may be busy or the model too slow — try a smaller model.`,
          };
        }
        return {
          ok: false,
          error:
            `Local server unreachable at ${cfg.baseUrl} — is Ollama running? ` +
            `Start it with \`ollama serve\`, pull the model with \`ollama pull ${cfg.model}\`, ` +
            `and check the base URL in Settings. (No request reached any AI; nothing was sent to the cloud.)`,
        };
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          ok: false,
          error:
            `Local server at ${cfg.baseUrl} returned HTTP ${res.status}` +
            (body ? `: ${body.slice(0, 200)}` : '.') +
            ` Check the model name ("${cfg.model}" — is it pulled? run \`ollama list\`) and the base URL in Settings.`,
        };
      }
      const data = (await res.json()) as { response?: unknown };
      const text = typeof data.response === 'string' ? data.response.trim() : '';
      if (!text) return { ok: false, error: `Local server at ${cfg.baseUrl} returned an empty response for model "${cfg.model}".` };
      return { ok: true, text };
    } finally {
      clearTimeout(timer);
    }
  }
}
