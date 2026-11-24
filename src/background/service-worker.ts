// Service worker — Core runtime (P1). Owns the Orchestrator, the TTL
// cleanup alarm (every 5 minutes), and the extension action (opens Side Panel).
import { TEMP_CLEANUP_ALARM_MINUTES } from '../config/constants';
import { Orchestrator } from '../core/Orchestrator';
import type { MobiusTask, TaskResult } from '../core/types';

const orchestrator = new Orchestrator();

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

// TTL cleanup (P6 / memory model): purge expired memory + router log is capped on write.
chrome.alarms.create('mobius-ttl-cleanup', { periodInMinutes: TEMP_CLEANUP_ALARM_MINUTES });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'mobius-ttl-cleanup') return;
  orchestrator
    .getMemoryStore()
    .purgeExpired()
    .then((purged) => {
      if (purged > 0) console.log(`[MOBIUS] TTL cleanup purged ${purged} expired memory entries.`);
    })
    .catch((err: unknown) => console.warn('[MOBIUS] TTL cleanup failed:', err));
});

console.log('[MOBIUS] Core service worker started.');
