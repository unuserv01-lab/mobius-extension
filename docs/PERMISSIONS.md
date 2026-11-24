# MOBIUS Permissions

## Manifest permissions (kept minimal)

| Permission | Why |
|---|---|
| `activeTab` | Read metadata of the tab the user is acting on. |
| `scripting` | Communicate with page scripts / content-script messaging. |
| `storage` | Local preferences, permission flags, memory, router log (`chrome.storage.local`). |
| `alarms` | Periodic TTL cleanup (every 5 minutes). |
| `sidePanel` | Dashboard: Onboarding, Router Log, Settings, History. |
| `host_permissions: <all_urls>` | The bubble and DOM context features work on any page the user opens. Page access itself is still gated by the opt-in toggles below. |

## Capability gates (opt-in by owner — P8)

All gates live in `PermissionManager` (`src/core/PermissionManager.ts`) and are toggled in the Side Panel (Onboarding / Settings). Defaults are the safe side.

| Capability gate | Used for | Default | If denied |
|---|---|---|---|
| Floating Bubble Overlay | Show the assistant bubble on webpages | ON | Bubble hidden; MOBIUS still reachable via the Side Panel. |
| Read Page / DOM Context | Read active tab text (WhatsApp Web chats, articles) | OFF | Chat-only mode without page context; the two demos refuse with an explanation instead of failing silently. |
| Cross-App DOM Actions | Type / insert replies into web inputs | OFF | Draft is shown in the bubble for manual copy; nothing is inserted. |
| Context History / Memory | Store task outcomes locally with TTL | ON (local only) | Stateless mode; zero memory saved. |
| Allow Cloud AI (Borrowed Intelligence) | Call Gemini cloud via Firebase AI Logic | OFF | AIRouter never calls the cloud, even if Nano is unavailable or the task is complex. The user is told the task needs Cloud AI and offered a 1-click enable. |

## Cloud-AI gate (separate from browser permissions)

- Every cloud call requires **both**: the task needs it (heavy reasoning / Nano unavailable) **and** the toggle is ON.
- Every cloud call is logged with a payload summary in the Router Log (Side Panel).
- **No memory is ever sent to the cloud.** Prompts sent to the cloud contain only the current task's input and (when the user allowed it) the current page text — never stored memory entries.

## Firebase App Check

Firebase AI Logic requires App Check. For hackathon judging, debug tokens are accepted:

1. Firebase console → Build → App Check → register the web app → **Manage debug tokens** → create one.
2. Paste it as `APP_CHECK_DEBUG_TOKEN` in `src/config/firebase.ts`, or set `self.FIREBASE_APPCHECK_DEBUG_TOKEN = '<token>'` in the browser console before loading the extension.
3. For production, paste a ReCaptcha Enterprise site key as `RECAPTCHA_ENTERPRISE_SITE_KEY` instead.
