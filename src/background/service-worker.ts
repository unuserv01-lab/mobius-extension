// Service worker — Core runtime (P1). Owns the Orchestrator, the TTL
// cleanup alarm (every 5 minutes), and the extension action (opens Side Panel).
// v8: also owns the bridge slow-poll alarm (every 1 minute, the chrome.alarms
// minimum) as a fallback for remote tasks while the side panel is closed —
// the panel itself polls every 3 s while open (see src/ui/main.ts).
import { BRIDGE_ALARM_MINUTES, TEMP_CLEANUP_ALARM_MINUTES } from '../config/constants';
import { clearBridgeRunning, isTakeoverActive, pollNextTask, postOrchestratorResult, setBridgeRunning, toMobiusTask, type BridgeTask } from '../core/BridgeClient';
import { Orchestrator } from '../core/Orchestrator';
import { loadLanguage } from '../core/i18n';
import type { MobiusTask, TaskResult } from '../core/types';

const orchestrator = new Orchestrator();

// One remote task at a time per client: the bridge delivers each task once,
// and a second claim while one is running would only add queue pressure.
let bridgeBusy = false;

// Load the persisted UI language once at startup (default 'id').
void loadLanguage();

// Task intake: bubble / side panel -> Core (local, never leaves the browser by default).
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const msg = message as { type?: string; task?: MobiusTask };
  if (msg?.type === 'MOBIUS_TASK' && msg.task) {
    const task: MobiusTask = { ...msg.task, tabId: msg.task.tabId ?? sender.tab?.id, url: msg.task.url ?? sender.tab?.url };
    orchestrator
      .handleTask(task)
      .then((result: TaskResult) => sendResponse({ ok: true, result }))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // async response
  }
  if (msg?.type === 'MOBIUS_OPEN_PANEL') {
    chrome.sidePanel.open({ windowId: sender.tab?.windowId ?? -1 }).catch(() => undefined);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// Extension toolbar icon opens the Side Panel dashboard.
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
});

// TTL cleanup (P6 / memory model): purge expired memory + chat history;
// router log is capped on write.
chrome.alarms.create('mobius-ttl-cleanup', { periodInMinutes: TEMP_CLEANUP_ALARM_MINUTES });
// Bridge slow poll (v8): chrome.alarms enforces a 1-minute minimum, so this
// is only a fallback — the side panel polls every 3 s while open. Latency
// while the panel is closed: up to ~60 s + execution time. If this worker is
// suspended mid-task, the bridge lease (60 s, 3 attempts) requeues the task.
chrome.alarms.create('mobius-bridge-poll', { periodInMinutes: BRIDGE_ALARM_MINUTES });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'mobius-bridge-poll') {
    void pollBridgeFromWorker();
    return;
  }
  if (alarm.name !== 'mobius-ttl-cleanup') return;
  orchestrator
    .getMemoryStore()
    .purgeExpired()
    .then((purged) => {
      if (purged > 0) console.log(`[MOBIUS] TTL cleanup purged ${purged} expired memory entries.`);
    })
    .catch((err: unknown) => console.warn('[MOBIUS] TTL cleanup failed:', err));
  orchestrator
    .getChatHistory()
    .purgeExpired()
    .then((purged) => {
      if (purged > 0) console.log(`[MOBIUS] TTL cleanup purged ${purged} expired chat messages.`);
    })
    .catch((err: unknown) => console.warn('[MOBIUS] Chat cleanup failed:', err));
});

console.log('[MOBIUS] Core service worker started.');

/**
 * Bridge slow poll (worker side). Claims one task, runs it through the
 * Orchestrator (browser tasks run their structured handler; everything else
 * is skill match first, then routing — same as a local task), and posts the
 * outcome back. A task with no tab context (remote tasks have none) runs
 * fine for skills + chat; page-dependent intents (summarize / wa-reply)
 * fail honestly when there is no active tab to read. v9: claims nothing
 * while the user has taken over (takeover flag — see BridgeClient.ts).
 */
async function pollBridgeFromWorker(): Promise<void> {
  if (bridgeBusy) return;
  // v9 takeover: when the user has taken over from the banner, this poller
  // claims NOTHING (same as the panel poller). In-flight tasks are not
  // affected — the flag only stops NEW claims.
  if (await isTakeoverActive()) return;
  let task: BridgeTask | null;
  try {
    task = await pollNextTask();
  } catch (e) {
    // Bridge down / unreachable is normal when it is not running — one line,
    // no token, no stack. (The panel path throttles the same warning.)
    console.warn('[MOBIUS] Bridge poll failed:', e instanceof Error ? e.message : String(e));
    return;
  }
  if (!task) return;
  bridgeBusy = true;
  // Announce the running task so the side-panel TakeoverBanner shows even
  // when the panel did not claim this task itself.
  await setBridgeRunning(task.taskId).catch(() => undefined);
  try {
    const mobiusTask: MobiusTask = toMobiusTask(task);
    const result = await orchestrator.handleTask(mobiusTask);
    await postOrchestratorResult(task.taskId, result);
  } catch (e) {
    // Worker error (e.g. suspended mid-task): report failure if we still can;
    // if the bridge is gone too, its lease requeues the task anyway.
    try {
      await postOrchestratorResult(task.taskId, {
        taskId: task.taskId,
        ok: false,
        engine: 'none',
        text: '',
        provenance: 'Failed',
        error: e instanceof Error ? e.message : String(e),
      });
    } catch {
      // Nothing more we can do — the lease is the safety net.
    }
  } finally {
    bridgeBusy = false;
    await clearBridgeRunning().catch(() => undefined);
  }
}
