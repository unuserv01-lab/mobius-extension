// BridgeClient — HTTP client for the MOBIUS laptop bridge (bridge/bridge.mjs).
//
// The bridge is the phone's way into this laptop: Android POSTs a task, the
// extension claims it via GET /bridge/tasks/next, runs it through the
// Orchestrator, and POSTs the outcome back. Two pollers share this client:
//
//   - Side panel (fast path): a live page, polls every BRIDGE_POLL_INTERVAL_MS
//     (3 s) while open. Typical latency: ~3 s + execution time.
//   - Service worker (fallback): chrome.alarms enforces a 1-minute minimum,
//     so when the panel is closed the latency is up to ~60 s + execution time.
//     The worker can also be suspended mid-task; the bridge lease (60 s,
//     3 attempts — see bridge/README.md) requeues the task in that case.
//
// SECURITY: the token lives in chrome.storage.local (mobius_settings) and is
// sent ONLY as the X-Mobius-Token header to the configured bridge URL. It is
// NEVER logged, NEVER put in a URL, and NEVER sent anywhere else. A missing
// token means "bridge off" — pollers stay silent, not an error.
import { DEFAULT_BRIDGE_URL, STORAGE_KEYS } from '../config/constants';
import type { MobiusSettings } from './types';

/** One queued task, as the bridge returns it. */
export interface BridgeTask {
  taskId: string;
  text: string;
  source: string;
  createdAt: number;
  attempts?: number;
}

export interface BridgeSettings {
  url: string;
  token: string;
}

export async function getBridgeSettings(): Promise<BridgeSettings> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const stored = data[STORAGE_KEYS.settings] as Partial<MobiusSettings> | undefined;
  return {
    url: (stored?.bridgeUrl ?? DEFAULT_BRIDGE_URL).replace(/\/+$/, ''),
    token: stored?.bridgeToken ?? '',
  };
}

/** True when a URL + token are configured. A missing token means "bridge off". */
export async function isBridgeConfigured(): Promise<boolean> {
  const s = await getBridgeSettings();
  return s.url.length > 0 && s.token.length > 0;
}

function headers(token: string): HeadersInit {
  return { 'Content-Type': 'application/json', 'X-Mobius-Token': token };
}

/**
 * Claim the oldest queued task (GET /bridge/tasks/next).
 * Returns null when the queue is empty or the bridge is not configured.
 * Throws on network failure / non-2xx so callers can log (throttled) instead
 * of silently assuming the queue is empty. The token never appears in errors.
 */
export async function pollNextTask(): Promise<BridgeTask | null> {
  const { url, token } = await getBridgeSettings();
  if (!token) return null;
  let res: Response;
  try {
    res = await fetch(`${url}/bridge/tasks/next`, { method: 'GET', headers: headers(token) });
  } catch (e) {
    throw new Error(`bridge unreachable at ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new Error(`bridge poll failed: HTTP ${res.status}`);
  const body = (await res.json()) as { task?: BridgeTask | null };
  return body.task ?? null;
}

/**
 * Post the outcome (done/failed) for a claimed task.
 * Throws on network failure / non-2xx — callers catch it; the bridge lease
 * requeues the task when the result never arrives, so nothing is lost silently.
 */
export async function postTaskResult(taskId: string, status: 'done' | 'failed', result: string): Promise<void> {
  const { url, token } = await getBridgeSettings();
  if (!token) throw new Error('bridge token not configured');
  const res = await fetch(`${url}/bridge/tasks/${encodeURIComponent(taskId)}/result`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ status, result }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`bridge result post failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
}
