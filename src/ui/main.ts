// Side Panel entry — tab router for the views (v7: + Chat tab, i18n labels,
// live re-render when the language changes in Settings).
import { loadLanguage, t } from '../core/i18n';
import { ChatView } from './ChatView';
import { HistoryView } from './HistoryView';
import { OnboardingView } from './OnboardingView';
import { RouterLogView } from './RouterLogView';
import { SettingsView } from './SettingsView';

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
