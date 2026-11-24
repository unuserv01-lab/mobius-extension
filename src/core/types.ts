// Shared message / task types for MOBIUS (core <-> content script <-> side panel).

export type TaskIntent = 'wa-reply' | 'summarize' | 'chat';

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
  engine: 'on-device' | 'cloud' | 'local-fallback' | 'none';
  text: string;
  /** Human-readable provenance, e.g. "Processed Locally via Gemini Nano". */
  provenance: string;
  error?: string;
}

export type RouterDecision = {
  id: string;
  timestamp: number;
  taskId: string;
  taskSummary: string;
  engine: 'on-device' | 'cloud' | 'local-fallback';
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

export interface MobiusSettings {
  memoryTtlSeconds: number;
  tempTtlSeconds: number;
}
