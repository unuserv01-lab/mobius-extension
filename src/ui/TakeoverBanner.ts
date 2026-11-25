// TakeoverBanner — side-panel banner shown while MOBIUS controls the browser (v9).
//
// Two states, both clickable (the whole banner is one button):
//   - running: "MOBIUS sedang mengendalikan browser — klik untuk mengambil
//     alih". Click sets the takeover flag (chrome.storage.local) — both
//     pollers stop claiming NEW tasks; the task already running finishes.
//   - paused: "MOBIUS dijeda — Anda mengendalikan browser. Klik untuk
//     melanjutkan." Click clears the flag and polling resumes. The paused
//     banner stays visible while the flag is set, so there is always a way
//     back — without it the flag could never be cleared from the panel.
//   - hidden: no bridge task running and the flag is clear.
//
// The banner knows a task is running from the shared storage announcement
// (mobius_bridge_running, written by BOTH pollers — see BridgeClient.ts),
// so it shows whichever client claimed the task. A stale announcement
// (worker suspended mid-task) is ignored via TAKEOVER_RUNNING_STALE_MS.
//
// Styling is inline on purpose: src/ui/index.html is NOT owned by this
// workstream, so the banner brings its own styles. Colours follow the v7
// palette (amber "cloud" badge: #3a2f10 / #fdd663).
import {
  BRIDGE_RUNNING_STORAGE_KEY,
  TAKEOVER_STORAGE_KEY,
  getBridgeRunning,
  isTakeoverActive,
  setTakeoverActive,
} from '../core/BridgeClient';

type BannerState = 'hidden' | 'running' | 'paused';

const TEXT_RUNNING = 'MOBIUS sedang mengendalikan browser — klik untuk mengambil alih';
const TEXT_PAUSED = 'MOBIUS dijeda — Anda mengendalikan browser. Klik untuk melanjutkan.';

export class TakeoverBanner {
  private el: HTMLButtonElement | null = null;
  private state: BannerState = 'hidden';
  private listening = false;

  /** Create the element and insert it above the panel content. Safe to call
   * once; a second call is a no-op. */
  mount(): void {
    if (this.el) return;
    const main = document.getElementById('view');
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'mobius-takeover-banner';
    button.style.display = 'none';
    button.style.width = '100%';
    button.style.boxSizing = 'border-box';
    button.style.padding = '10px 14px';
    button.style.border = 'none';
    button.style.borderBottom = '1px solid #fdd663';
    button.style.background = '#3a2f10';
    button.style.color = '#fdd663';
    button.style.fontSize = '13px';
    button.style.fontWeight = '700';
    button.style.textAlign = 'left';
    button.style.cursor = 'pointer';
    button.style.fontFamily = 'inherit';
    button.addEventListener('click', () => void this.onClick());
    if (main?.parentElement) {
      main.parentElement.insertBefore(button, main);
    } else {
      document.body.prepend(button);
    }
    this.el = button;
    if (!this.listening) {
      this.listening = true;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[TAKEOVER_STORAGE_KEY] || changes[BRIDGE_RUNNING_STORAGE_KEY]) {
          void this.refresh();
        }
      });
    }
    void this.refresh();
  }

  /** Re-read the flag + running announcement and update visibility/text. */
  async refresh(): Promise<void> {
    if (!this.el) return;
    const [takeover, running] = await Promise.all([isTakeoverActive(), getBridgeRunning()]);
    const next: BannerState = takeover ? 'paused' : running ? 'running' : 'hidden';
    if (next === this.state) return;
    this.state = next;
    if (next === 'hidden') {
      this.el.style.display = 'none';
      this.el.textContent = '';
      return;
    }
    this.el.style.display = 'block';
    this.el.textContent = next === 'running' ? TEXT_RUNNING : TEXT_PAUSED;
  }

  private async onClick(): Promise<void> {
    if (this.state === 'running') {
      // Take over: stop both pollers from claiming new tasks. The task
      // already running is allowed to finish; the banner flips to paused.
      await setTakeoverActive(true);
    } else if (this.state === 'paused') {
      await setTakeoverActive(false);
    }
    await this.refresh();
  }
}
