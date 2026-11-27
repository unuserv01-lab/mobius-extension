// Shared message / task types for MOBIUS (core <-> content script <-> side panel).

export type TaskIntent = 'wa-reply' | 'summarize' | 'chat' | 'skill' | 'browser';

/** Language of the UI (side panel + bubble). Default 'id'. */
export type Language = 'id' | 'en';

export interface MobiusTask {
  id: string;
  intent: TaskIntent;
  input: string;
  tabId?: number;
  url?: string;
  /** Optional page text already read by the content script (kept local). */
  pageText?: string;
  /** Browser-takeover payload (v9): set only when the task came from the
   * bridge as a structured browser task (see parseBrowserTask in
   * BridgeClient.ts). When present, the Orchestrator runs it through
   * handleBrowserTask() and never through skill match / LLM routing. */
  browserTask?: BrowserTaskPayload;
  /** (v9.1) Claim attempt count from the bridge (1 = first claim, >1 =
   * re-claim after a lease expiry). The Orchestrator's double-execution
   * guard uses it: a re-claimed mutating task whose taskId is already
   * recorded is never run twice. */
  attempts?: number;
}

// ---------------------------------------------------------------------------
// Browser takeover (v9) — remote control of the laptop browser from the phone
// via the bridge. The phone POSTs /task with `text` = a JSON string (the
// bridge only carries plain text); the extension parses it with
// parseBrowserTask() and attaches the payload here. Full contract (task +
// result JSON) is documented in bridge/README.md.
// ---------------------------------------------------------------------------

/** Task type of a browser-takeover task (the `type` field of the JSON text). */
export type BrowserTaskType = 'browser_navigate' | 'browser_read' | 'browser_act';

/** One step inside a browser_act task. `tool` is a WebSkillTools tool name
 * (navigate / clickText / typeText / submit / readScreen / findText /
 * extract / scroll / back / home / wait / waitForText); the remaining fields
 * are that tool's string args. */
export interface BrowserAction {
  tool: string;
  [key: string]: string | boolean | number | undefined;
}

/** A parsed browser-takeover task. `approved` gates mutating actions:
 * clickText / typeText / submit NEVER run unless approved === true
 * (fail closed — see handleBrowserTask in Orchestrator.ts). */
export interface BrowserTaskPayload {
  type: BrowserTaskType;
  /** Target URL (required for browser_navigate / browser_read; optional for
   * browser_act, which may act on the current page instead). */
  url?: string;
  /** Steps for browser_act (and optional extra reads for browser_read). */
  actions?: BrowserAction[];
  /** Phone-side approval for mutating actions. Absent/false = not approved. */
  approved?: boolean;
  /** (v9.1) Single-use approval id echoed back by the phone on resubmission.
   * Only meaningful together with approved=true; the Orchestrator verifies
   * it against the stored approval (exact payload fingerprint, 10-min TTL,
   * consumed on first use) and rejects anything else without running. */
  approvalId?: string;
}

/** One executed step, as reported back to the phone. */
export interface BrowserStepResult {
  tool: string;
  ok: boolean;
  message: string;
}

/** Structured result of a browser task, serialized as the TaskResult text
 * (and as the bridge result string). The phone parses this JSON. */
export interface BrowserTaskResult {
  /** done = executed; failed = honest failure (page / element / permission);
   * awaiting_approval = mutating actions held back, nothing was executed. */
  status: 'done' | 'failed' | 'awaiting_approval';
  type: BrowserTaskType;
  /** Final URL of the active tab after the task ('' when no tab). */
  url: string;
  /** Page title of the active tab after the task ('' when no tab). */
  title: string;
  steps: BrowserStepResult[];
  /** Extracted page text (capped) — only for browser_read / read steps. */
  text?: string;
  /** Only for awaiting_approval: the mutating actions that were NOT run.
   * `tier` (v8.1) is the risk tier of that action: 'moderate' (reversible
   * mutation — the phone MAY remember the approval) or 'sensitive'
   * (irreversible / send / delete — the phone must ask every time and
   * must never remember it forever). */
  pendingActions?: { tool: string; description: string; tier?: 'moderate' | 'sensitive' }[];
  /** (v8.1) Only for awaiting_approval: stable id linking this hold to the
   * resubmitted approved task. The phone echoes it back as `approvalId`
   * when it resends the task with approved=true (see bridge/README.md);
   * the bridge also accepts it on POST /task and returns it on
   * GET /bridge/tasks/next and GET /task/:id. */
  approvalId?: string;
  /** Short human-readable summary (also stored in local chat history). */
  message: string;
  /** Only for failed: why it failed. */
  error?: string;
}

export interface TaskResult {
  taskId: string;
  ok: boolean;
  engine: 'on-device' | 'cloud' | 'local-server' | 'local-fallback' | 'skill' | 'none';
  text: string;
  /** Human-readable provenance, e.g. "Processed Locally via Gemini Nano". */
  provenance: string;
  error?: string;
}

/** Engine selection (Workstream J, v6). "auto" = today's behavior (Nano first, cloud if allowed). */
export type EngineChoice = 'auto' | 'nano' | 'cloud' | 'local';

/** Local-server (e.g. Ollama) connection settings, persisted in mobius_settings. */
export interface LocalServerSettings {
  localServerBaseUrl: string;
  localServerModel: string;
}

export type RouterDecision = {
  id: string;
  timestamp: number;
  taskId: string;
  taskSummary: string;
  engine: 'on-device' | 'cloud' | 'local-server' | 'local-fallback' | 'skill';
  reason: string;
  latencyMs: number;
  cloudAllowed: boolean;
  /** Short payload summary only — never full user content. */
  payloadSummary: string;
};

export interface MemoryEntry {
  id: string;
  type: 'fact' | 'preference' | 'task_result';
  content: string;
  source: string; // task_id / subagent type
  createdAt: number;
  ttlSeconds: number;
  expiresAt: number;
}

export interface PermissionGates {
  bubble: boolean;
  readPage: boolean;
  domActions: boolean;
  memory: boolean;
  cloudAI: boolean;
}

export const DEFAULT_PERMISSIONS: PermissionGates = {
  bubble: true, // default ON (entry point)
  readPage: false, // opt-in
  domActions: false, // opt-in
  memory: true, // opt-in, default ON (local only)
  cloudAI: false, // default OFF — P4: cloud is borrowed intelligence
};

export interface MobiusSettings extends Partial<LocalServerSettings> {
  memoryTtlSeconds: number;
  tempTtlSeconds: number;
  /** Engine selection, default 'auto'. Persisted in chrome.storage.local (mobius_settings). */
  engine?: EngineChoice;
  /** UI language for the side panel + bubble, default 'id'. */
  language?: Language;
  /** Chat-history retention, seconds. Same choices as Android: 1h / 24h / 7d. Default 24h. */
  chatRetentionSeconds?: number;
  /** Laptop bridge URL for remote tasks from the phone, default http://localhost:8787. */
  bridgeUrl?: string;
  /** Laptop bridge token (same value as MOBIUS_BRIDGE_TOKEN on the bridge + Android). Never logged. */
  bridgeToken?: string;
}
