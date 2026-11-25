// Side Panel entry — tab router for the views (v7: + Chat tab, i18n labels,
// live re-render when the language changes in Settings).
// v8: also runs the bridge fast poll — while the panel is open, claim remote
// tasks from the laptop bridge every 3 s and forward them to the service
// worker (MOBIUS_TASK). The worker stays the only executor.
import { BRIDGE_POLL_INTERVAL_MS } from '../config/constants';
import { clearBridgeRunning, isTakeoverActive, pollNextTask, postOrchestratorResult, setBridgeRunning, toMobiusTask, type BridgeTask } from '../core/BridgeClient';
import { loadLanguage, t } from '../core/i18n';
import type { TaskResult } from '../core/types';
import { ChatView } from './ChatView';
import { HistoryView } from './HistoryView';
import { OnboardingView } from './OnboardingView';
import { RouterLogView } from './RouterLogView';
import { SettingsView } from './SettingsView';
import { TakeoverBanner } from './TakeoverBanner';
import { ApprovalCard } from './ApprovalCard';

type TabId = 'onboarding' | 'router' | 'chat' | 'settings' | 'history';

const viewEl = document.getElementById('view')!;
const tabButtons = [...document.querySelectorAll<HTMLButtonElement>('#tabs button')];
let currentTab: TabId = 'router';
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function applyTabLabels(): void {
  for (const b of tabButtons) {
    const tab = b.dataset.tab as TabId;
    b.textContent =
      tab === 'onboarding'
        ? t('navOnboarding')
        : tab === 'router'
          ? t('navRouterLog')
          : tab === 'chat'
            ? t('navChat')
            : tab === 'settings'
              ? t('navSettings')
              : t('navHistory');
  }
}

function render(): void {
  tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === currentTab));
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  switch (currentTab) {
    case 'onboarding':
      new OnboardingView(viewEl).render();
      break;
    case 'router':
      new RouterLogView(viewEl).render();
      // Live audit log: refresh every 3s while this tab is open.
      refreshTimer = setInterval(() => new RouterLogView(viewEl).render(), 3000);
      break;
    case 'chat':
      new ChatView(viewEl).render();
      break;
    case 'settings':
      new SettingsView(viewEl).render();
      break;
    case 'history':
      new HistoryView(viewEl).render();
      break;
  }
}

tabButtons.forEach((b) => {
  b.addEventListener('click', () => {
    currentTab = (b.dataset.tab ?? 'router') as TabId;
    render();
  });
});

// Header logo (extension pages can load their own icons without
// web_accessible_resources).
const logo = document.getElementById('logo') as HTMLImageElement | null;
if (logo) logo.src = chrome.runtime.getURL('icons/icon48.png');

// Re-localize when the language changes (e.g. picked in Settings).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.mobius_settings) return;
  void loadLanguage().then(() => {
    applyTabLabels();
    render();
  });
});

void loadLanguage().then(() => {
  applyTabLabels();
  render();
});

// Takeover banner (v9): shows while a bridge task runs; click = take over
// (sets the flag that stops both pollers claiming new tasks).
const takeoverBanner = new TakeoverBanner();
takeoverBanner.mount();

// Approval card (v8.1): read-only panel "Menunggu persetujuan di HP" while a
// bridge task awaits approval on the phone (announced via chrome.storage.local).
// The decision stays on the phone; this card never approves or rejects.
const approvalCard = new ApprovalCard();
approvalCard.mount();

// Bridge fast poll (v8): the panel is a live page, so setInterval is reliable
// while it is open — unlike the service worker, which Chrome can suspend.
// Runs even when the bridge is not configured (pollNextTask short-circuits
// on a missing token with a storage read only, no network). One task at a
// time; a poll failure is warned at most once a minute, not every 3 s.
// v9: when the user has taken over (flag in chrome.storage.local) the poller
// claims NOTHING — the banner is the only way back (click = resume).
let bridgeBusy = false;
let bridgeWarnedAt = 0;

async function pollBridgeOnce(): Promise<void> {
  if (bridgeBusy) return;
  if (await isTakeoverActive()) return;
  let task: BridgeTask | null;
  try {
    task = await pollNextTask();
  } catch (e) {
    const now = Date.now();
    if (now - bridgeWarnedAt > 60_000) {
      bridgeWarnedAt = now;
      console.warn('[MOBIUS] Bridge poll failed:', e instanceof Error ? e.message : String(e));
    }
    return;
  }
  if (!task) return;
  bridgeBusy = true;
  // Announce the running task so the TakeoverBanner shows (and so the
  // worker-side poller sees the panel is busy — it checks bridgeBusy only
  // locally, this is the shared signal).
  await setBridgeRunning(task.taskId).catch(() => undefined);
  await takeoverBanner.refresh();
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'MOBIUS_TASK',
      task: toMobiusTask(task),
    })) as { ok?: boolean; error?: string; result?: TaskResult } | undefined;
    const result = res?.result;
    if (result) {
      // Browser tasks: result.text is the BrowserTaskResult JSON; the bridge
      // status follows its status field (see postOrchestratorResult).
      await postOrchestratorResult(task.taskId, result);
    } else {
      await postOrchestratorResult(task.taskId, {
        taskId: task.taskId,
        ok: false,
        engine: 'none',
        text: '',
        provenance: 'Failed',
        error: res?.error ?? 'task failed (no result from worker)',
      });
    }
  } catch (e) {
    // Worker did not answer (e.g. suspended): report failure if we still can;
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
    await takeoverBanner.refresh();
  }
}

setInterval(() => void pollBridgeOnce(), BRIDGE_POLL_INTERVAL_MS);
