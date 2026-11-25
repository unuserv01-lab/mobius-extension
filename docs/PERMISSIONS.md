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

Firebase AI Logic can use App Check, but **a debug token alone does NOT turn it on** (v8 correction — the earlier text claimed it did). The Firebase JS SDK has no public DebugProvider for web; the `FIREBASE_APPCHECK_DEBUG_TOKEN` global is only honored when App Check is initialized with a real provider. To actually enable App Check:

1. Firebase console → Build → App Check → register the web app.
2. Paste a ReCaptcha Enterprise site key as `RECAPTCHA_ENTERPRISE_SITE_KEY` in `src/config/firebase.ts`.
3. (Optional) also paste a debug token as `APP_CHECK_DEBUG_TOKEN` — it only takes effect together with the provider above.

Current state: App Check enforcement is **OFF** in the Firebase console (monitoring only), so cloud AI works without App Check. If a debug token is set without a site key, the extension logs a clear warning that App Check is NOT initialized.
