// Side Panel entry — tab router for the four views.
import { HistoryView } from './HistoryView';
import { OnboardingView } from './OnboardingView';
import { RouterLogView } from './RouterLogView';
import { SettingsView } from './SettingsView';

type TabId = 'onboarding' | 'router' | 'settings' | 'history';

const viewEl = document.getElementById('view')!;
const tabButtons = [...document.querySelectorAll<HTMLButtonElement>('#tabs button')];
let currentTab: TabId = 'router';
let refreshTimer: ReturnType<typeof setInterval> | null = null;

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

render();
