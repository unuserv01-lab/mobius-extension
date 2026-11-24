# MOBIUS — Personal AI Operating Layer

> **Your browser, with a mind of its own — and it stays yours.**
> *"Your Intelligence. Everywhere. Owned by You."*

A Chrome Extension (Manifest V3) for the **Firebase #BuildHybridAI 2026** hackathon — **Web/Chrome track**. MOBIUS is a Personal AI Operating Layer: an AI layer that lives across browser tabs as a floating bubble assistant, understands the active page/tab context, and acts across web applications — with the browser itself as the control center.

**On-device AI (Gemini Nano) is the default intelligence. Cloud AI (Gemini) is borrowed intelligence — called only when needed AND permitted by the user. Memory is owned by the Core, never by subagents, and never sent to the cloud.**

---

## What it does (MVP)

- **Floating bubble** (Shadow DOM, draggable) on any webpage + **Side Panel dashboard** (Onboarding, live Router Log, Settings, History).
- **Core Orchestrator** (service worker): task intake, intent routing, permission gates, subagent lifecycle, core-owned memory with TTL.
- **Hybrid AI routing via Firebase AI Logic JS SDK**: Gemini Nano on-device first; Gemini cloud fallback only when "Allow Cloud AI" is ON — every decision logged live in the Router Log.
- **Two end-to-end cross-app demos:**
  1. **WhatsApp Web smart reply** — read the last incoming message on `web.whatsapp.com`, draft a reply on-device, insert it into the message box (send stays with the user).
  2. **Active-page summarizer** — summarize short text on-device (works offline via local fallback); long/complex synthesis escalates to Cloud Gemini only when allowed.
- **Local MemoryStore** with TTL cleanup (chrome.alarms every 5 min) + History UI to inspect/delete entries.
- **Permission onboarding** with plain-language explanations and graceful degradation when anything is denied.

## Quick start

### 1. Chrome flags (Gemini Nano / Prompt API)

1. Open `chrome://flags/#prompt-api-for-gemini-nano` and set it to **Enabled**.
2. Open `chrome://flags/#optimization-guide-on-device-model` and set it to **Enabled (BypassPerfRequirement)**.
3. Restart Chrome, then open `chrome://components` and click **Check for update** on **Optimization Guide On Device Model** until it downloads.
4. Requires Chrome 138+ on desktop.

### 2. Firebase setup (free Spark plan, $0)

1. Create a project at https://console.firebase.google.com (Spark plan).
2. Project settings → "Your apps" → Web app → copy the `firebaseConfig` values into `src/config/firebase.ts`:
   - `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`
3. **Build → AI Logic** → enable the Gemini API (Vertex AI or Gemini Developer API backend).
4. **Build → App Check** → register the web app and enable the **debug provider** for hackathon judging:
   - Paste the debug token into `APP_CHECK_DEBUG_TOKEN` in `src/config/firebase.ts`, or set it in the console: `self.FIREBASE_APPCHECK_DEBUG_TOKEN = '<token>'`.
   - (Production) paste a ReCaptcha Enterprise site key into `RECAPTCHA_ENTERPRISE_SITE_KEY`.
5. **Until real keys are pasted**, MOBIUS still runs: it uses Chrome's built-in Prompt API when available, then a local extractive fallback — and every limitation is shown to the user instead of failing silently.

### 3. Build & load unpacked

```bash
npm install
npm run build        # tsc --noEmit + vite build -> dist/
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `dist/` folder. Click the MOBIUS toolbar icon to open the Side Panel, and enable the capabilities you want in **Onboarding** (Read Page / DOM Context is required for the two demos).

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/PERMISSIONS.md](docs/PERMISSIONS.md).

```
Bubble (Shadow DOM) -> Core Orchestrator (service worker, local)
  -> TaskRouter (intent) -> AgentFactory -> SubAgent (temporary, per task)
  -> AIRouter: Gemini Nano on-device first | Gemini cloud only if allowed
  -> Content script: DomReader + ActionExecutor (WhatsApp Web, any page)
SubAgent --reports--> Core --decides--> MemoryStore (local, TTL)
```

## How Firebase AI Logic is used

- **On-device**: `getAI(app, { backend: new GoogleAIBackend() })` + `getGenerativeModel(ai, { model: 'gemini-nano', inferenceMode: 'on-device' })` — called at runtime in `src/ai/OnDeviceAI.ts` (with a Chrome Prompt API fallback).
- **Cloud**: the same SDK, `getGenerativeModel(ai, { model: 'gemini-2.0-flash' })` — called at runtime in `src/ai/CloudAI.ts`, gated by the "Allow Cloud AI" toggle and logged in `src/ai/AIRouter.ts`.
- **App Check** is initialized in `src/config/firebase.ts` with debug-token support for judging.

## Demo video shot list (≤ 3 minutes)

See [docs/DEMO-SHOT-LIST.md](docs/DEMO-SHOT-LIST.md).

## MVP scope & future work

**In scope:** bubble + side panel, orchestrator + routing, hybrid AI via Firebase AI Logic, the two demos above, local memory + TTL, permission onboarding.
**Out of scope (roadmap):** voice input, multi-tab autonomous chains, cross-device sync.

## License

Apache 2.0 — see [LICENSE](LICENSE).
