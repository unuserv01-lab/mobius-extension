// Shared message / task types for MOBIUS (core <-> content script <-> side panel).

export type TaskIntent = 'wa-reply' | 'summarize' | 'chat' | 'skill';

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
