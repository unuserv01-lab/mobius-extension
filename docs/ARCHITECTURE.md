# MOBIUS Architecture

## Principles (non-negotiable)

- **P1 — Local Browser = control center.** Orchestrator, memory, cache, permission gate, context management run locally (service worker + `chrome.storage.local`).
- **P2 — Subagent = temporary worker.** Created per task by `AgentFactory`, destroyed when the task ends. Never persistent.
- **P3 — On-device AI = default.** All inference runs on-device first (Gemini Nano via Firebase AI Logic).
- **P4 — Cloud AI = borrowed intelligence.** Gemini cloud only when needed AND permitted.
- **P5 — Memory = owned by Core.** Subagents report results; the Core decides what is stored. Subagents never write memory directly.
- **P6 — Task done = runtime stopped.** `AbortController` + `TempStore.wipe()` on task end; TTL cleanup via `chrome.alarms` every 5 minutes.
- **P7 — Bubble = entry point only.** The product is the AI layer that understands tab/DOM context.
- **P8 — Permissions = opt-in.** Every capability needs explicit user opt-in; denied capabilities degrade gracefully.
- **P9 — Zero-capital.** Free tiers only (Firebase Spark, Chrome built-in Gemini Nano).
- **P10 — Privacy by design.** User data stays on-device unless the user explicitly permits a cloud call for that task. No memory is ever sent to the cloud.

## Component map

```
src/config/constants.ts      APP_NAME, TTL defaults, storage keys
src/config/firebase.ts       Firebase init + App Check (debug-token support)
src/core/Orchestrator.ts     Task intake, permission gates, lifecycle, memory write path
src/core/TaskRouter.ts       Keyword intent -> subagent type (wa-reply / summarize / chat)
src/core/ContextManager.ts   Active tab metadata + DOM snippet + recent tasks (per-task only)
src/core/MemoryStore.ts      chrome.storage.local, TTL entries, purgeExpired()
src/core/PermissionManager.ts Opt-in gates + plain-language explanations
src/agent/SubAgent.ts        Temporary worker: context -> AI -> DOM action -> report
src/agent/AgentFactory.ts    Creates one SubAgent per task
src/agent/AgentScope.ts      AbortController + timeout + TempStore lifecycle
src/agent/TempStore.ts       In-memory, TTL-bound temp data; wiped on task end
src/ai/OnDeviceAI.ts         Gemini Nano via Firebase AI Logic (inferenceMode 'on-device'),
                             fallback to Chrome Prompt API
src/ai/CloudAI.ts            Gemini cloud (gemini-2.0-flash) via Firebase AI Logic
src/ai/AIRouter.ts           on-device-first decision + audit log of every decision
src/ai/PromptBuilder.ts      Prompt construction with local context
src/background/service-worker.ts  Core runtime + TTL alarm + action -> side panel
src/content/index.ts         Content-script entry: bubble mount + message handlers
src/content/BubbleWidget.ts  Shadow DOM bubble + quick-input popover
src/content/DomReader.ts     WhatsApp Web last message / generic page text
src/content/ActionExecutor.ts Insert draft into WhatsApp Web message box
src/ui/*                     Side Panel: Onboarding, RouterLog, Settings, History
```

## Message flow (one task)

```
1. Bubble click -> input -> chrome.runtime.sendMessage({ type: 'MOBIUS_TASK', task })
2. Service worker -> Orchestrator.handleTask(task)
3. Permission gates (readPage / domActions) — deny => graceful failure message
4. TaskRouter -> intent; ContextManager -> per-task context (tab, DOM snippet)
5. AgentFactory.create(kind) -> SubAgent.run()
6. SubAgent -> AIRouter.generate() -> OnDeviceAI first; CloudAI only if allowed
7. SubAgent -> chrome.tabs.sendMessage(tabId, { MOBIUS_READ_WA | MOBIUS_READ_PAGE | MOBIUS_INSERT_REPLY })
8. SubAgent reports result; AgentScope.cleanup() wipes TempStore; agent destroyed
9. Core decides what to persist -> MemoryStore (TTL)
10. Result back to bubble; Router Log updated in the Side Panel
```

## Memory flow (one direction only)

```
SubAgent --(report result)--> Core --(decide)--> MemoryStore
SubAgent NEVER writes MemoryStore directly.
```

`MemoryEntry`: `id, type ('fact' | 'preference' | 'task_result'), content, source (task_id / subagent_type), created_at, ttl_seconds, expires_at`.

## Build

`npm install && npm run build` (`tsc --noEmit` + Vite, three bundles: `background.js`, `content.js`, side-panel app). Output is `dist/`, loadable unpacked at `chrome://extensions`.
