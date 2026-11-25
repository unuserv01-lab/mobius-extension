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
import type { BrowserAction, BrowserTaskPayload, BrowserTaskResult, BrowserTaskType, MobiusSettings, MobiusTask, TaskResult } from './types';

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

// ---------------------------------------------------------------------------
// Browser takeover (v9)
// ---------------------------------------------------------------------------

const BROWSER_TASK_TYPES: ReadonlySet<string> = new Set(['browser_navigate', 'browser_read', 'browser_act']);

/**
 * Parse a bridge task's `text` as a structured browser task. The bridge only
 * carries plain text, so the phone sends the task as a JSON string (see
 * bridge/README.md for the contract). Returns null for ordinary text tasks,
 * for malformed JSON, and for an unknown `type` — those fall back to the v8
 * chat task, exactly as before. An unknown `browser_*` type is therefore
 * NEVER executed; the phone must use one of the three known types.
 */
export function parseBrowserTask(text: string): BrowserTaskPayload | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.type !== 'string' || !BROWSER_TASK_TYPES.has(obj.type)) return null;
  const type = obj.type as BrowserTaskType;
  const url = typeof obj.url === 'string' ? obj.url : undefined;
  const actions = Array.isArray(obj.actions)
    ? (obj.actions.filter((a): a is BrowserAction => typeof a === 'object' && a !== null && typeof (a as { tool?: unknown }).tool === 'string') as BrowserAction[])
    : undefined;
  return { type, url, actions, approved: obj.approved === true };
}

/** Convert a claimed bridge task into the MobiusTask the Orchestrator runs:
 * a structured browser task becomes intent 'browser' with its payload
 * attached; anything else stays the v8 chat task. */
export function toMobiusTask(task: BridgeTask): MobiusTask {
  const browser = parseBrowserTask(task.text);
  if (browser) return { id: task.taskId, intent: 'browser', input: task.text, browserTask: browser };
  return { id: task.taskId, intent: 'chat', input: task.text };
}

/** Parse a browser task's TaskResult text back into its structured result.
 * Returns null when the text is not a BrowserTaskResult JSON (i.e. the
 * result came from an ordinary task). */
export function parseBrowserTaskResult(text: string): BrowserTaskResult | null {
  if (!text || !text.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text) as Partial<BrowserTaskResult>;
    if (parsed.status !== 'done' && parsed.status !== 'failed' && parsed.status !== 'awaiting_approval') return null;
    if (typeof parsed.type !== 'string' || !BROWSER_TASK_TYPES.has(parsed.type)) return null;
    return parsed as BrowserTaskResult;
  } catch {
    return null;
  }
}

/**
 * Post an Orchestrator result back to the bridge, honouring the browser-task
 * contract: for a browser task the result text IS the BrowserTaskResult JSON,
 * and the bridge status follows its `status` field — 'done' for done AND for
 * awaiting_approval (the extension finished processing; the phone must show
 * the approval dialog), 'failed' only for an execution failure. Ordinary
 * tasks keep the v8 mapping (ok -> done, else failed + error). Both pollers
 * (side panel + service worker) must use this — never postTaskResult directly
 * for a claimed task.
 *
 * (v8.1) An awaiting_approval result is ALSO announced to the side panel
 * via chrome.storage.local ([APPROVAL_STORAGE_KEY]) so the panel can show
 * the approval card ("Menunggu persetujuan di HP — …") while the phone
 * decides. The announcement is cleared when the same task later finishes
 * (done/failed). A stale announcement (older than
 * APPROVAL_PENDING_STALE_MS) is ignored by the card. The announcement is
 * best-effort: a storage failure never blocks posting the result.
 */
export async function postOrchestratorResult(taskId: string, result: TaskResult): Promise<void> {
  const browser = parseBrowserTaskResult(result.text);
  if (browser) {
    if (browser.status === 'awaiting_approval') {
      await announceApprovalPending(taskId, browser).catch(() => undefined);
    } else {
      await clearApprovalPending(taskId).catch(() => undefined);
    }
    await postTaskResult(taskId, browser.status === 'failed' ? 'failed' : 'done', result.text);
    return;
  }
  await postTaskResult(taskId, result.ok ? 'done' : 'failed', result.ok ? result.text : result.error ?? 'task failed');
}

// ---------------------------------------------------------------------------
// Approval card announcement (v8.1) — the panel-side half of the
// cross-device approval card. The phone owns the decision (approve/reject
// + grant scope); the extension only announces "waiting for the phone"
// so the user looking at the laptop sees the same state. The card itself
// lives in src/ui/ApprovalCard.ts; mount it from the panel (one line,
// see that file). No new transport: this reuses chrome.storage.local,
// the same channel as the takeover flag + running announcement.
// ---------------------------------------------------------------------------

/** chrome.storage.local key for the pending-approval announcement. */
export const APPROVAL_STORAGE_KEY = 'mobius_bridge_approval';
/** An approval wait is a phone round-trip; 10 minutes (the bridge task
 * TTL) is the safe staleness bound. */
export const APPROVAL_PENDING_STALE_MS = 10 * 60_000;

export interface ApprovalPendingState {
  taskId: string;
  approvalId?: string;
  type: string;
  url: string;
  pendingActions: { tool: string; description: string; tier?: 'moderate' | 'sensitive' }[];
  at: number;
}

/** Announce that a bridge task is waiting for the phone's approval. */
export async function announceApprovalPending(
  taskId: string,
  browser: { type: string; url: string; pendingActions?: { tool: string; description: string; tier?: 'moderate' | 'sensitive' }[]; approvalId?: string },
): Promise<void> {
  const state: ApprovalPendingState = {
    taskId,
    approvalId: browser.approvalId,
    type: browser.type,
    url: browser.url,
    pendingActions: browser.pendingActions ?? [],
    at: Date.now(),
  };
  await chrome.storage.local.set({ [APPROVAL_STORAGE_KEY]: state });
}

/** Clear the announcement, but only when it belongs to this task (another
 * task may already be waiting — never clear someone else's card). */
export async function clearApprovalPending(taskId: string): Promise<void> {
  const current = await getApprovalPending();
  if (current && current.taskId === taskId) {
    await chrome.storage.local.remove(APPROVAL_STORAGE_KEY);
  }
}

/** Read the announcement; null when none or stale. */
export async function getApprovalPending(): Promise<ApprovalPendingState | null> {
  const data = await chrome.storage.local.get(APPROVAL_STORAGE_KEY);
  const state = data[APPROVAL_STORAGE_KEY] as ApprovalPendingState | undefined;
  if (!state || typeof state.at !== 'number') return null;
  if (Date.now() - state.at > APPROVAL_PENDING_STALE_MS) return null;
  return state;
}

// ---------------------------------------------------------------------------
// Takeover flag (v9) — the user taking the browser back from MOBIUS.
// ---------------------------------------------------------------------------

/** chrome.storage.local key for the takeover flag. Kept here (not in
 * constants.ts) so this workstream owns it; the value is
 * { active: boolean, at: number } — `at` is when the user took over. */
export const TAKEOVER_STORAGE_KEY = 'mobius_takeover';

/** Key under which a running bridge task is announced to the side panel, so
 * the TakeoverBanner can show while EITHER poller executes a task. Value is
 * { taskId: string, startedAt: number }; removed when the task finishes.
 * A stale entry (older than TAKEOVER_RUNNING_STALE_MS) is treated as "no
 * task running" — e.g. the worker was suspended mid-task. */
export const BRIDGE_RUNNING_STORAGE_KEY = 'mobius_bridge_running';
/** Lease is 60 s; a task legitimately running longer is already in requeue
 * territory, so 120 s is a safe staleness bound. */
export const TAKEOVER_RUNNING_STALE_MS = 120_000;

export interface TakeoverState {
  active: boolean;
  at: number;
}

export interface BridgeRunningState {
  taskId: string;
  startedAt: number;
}

/** True when the user has taken over: both pollers must NOT claim new tasks.
 * A task already running when the flag was set is allowed to finish. */
export async function isTakeoverActive(): Promise<boolean> {
  const data = await chrome.storage.local.get(TAKEOVER_STORAGE_KEY);
  const state = data[TAKEOVER_STORAGE_KEY] as TakeoverState | undefined;
  return state?.active === true;
}

/** Set (user clicked the banner) or clear (user clicked resume) the flag. */
export async function setTakeoverActive(active: boolean): Promise<void> {
  await chrome.storage.local.set({ [TAKEOVER_STORAGE_KEY]: { active, at: Date.now() } satisfies TakeoverState });
}

/** Announce that a bridge task started running (written by both pollers so
 * the side-panel banner can show it whichever client claimed the task). */
export async function setBridgeRunning(taskId: string): Promise<void> {
  await chrome.storage.local.set({ [BRIDGE_RUNNING_STORAGE_KEY]: { taskId, startedAt: Date.now() } satisfies BridgeRunningState });
}

/** Clear the running announcement (always in a finally block). */
export async function clearBridgeRunning(): Promise<void> {
  await chrome.storage.local.remove(BRIDGE_RUNNING_STORAGE_KEY);
}

/** Read the running announcement; null when none or stale. */
export async function getBridgeRunning(): Promise<BridgeRunningState | null> {
  const data = await chrome.storage.local.get(BRIDGE_RUNNING_STORAGE_KEY);
  const state = data[BRIDGE_RUNNING_STORAGE_KEY] as BridgeRunningState | undefined;
  if (!state || typeof state.startedAt !== 'number') return null;
  if (Date.now() - state.startedAt > TAKEOVER_RUNNING_STALE_MS) return null;
  return state;
}
