// MOBIUS — single source of truth for the product name and defaults.
// Rename the product by editing APP_NAME here only (P: naming).
export const APP_NAME = 'MOBIUS';
export const APP_CODENAME = 'Gembul';
export const APP_TAGLINE = 'Your Intelligence. Everywhere. Owned by You.';
export const APP_VERSION = '0.1.0';

// TTL defaults (seconds). P6: task done = runtime stopped, temp data cleaned by TTL.
export const DEFAULT_MEMORY_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const DEFAULT_TEMP_TTL_SECONDS = 15 * 60; // 15 minutes
export const TEMP_CLEANUP_ALARM_MINUTES = 5; // chrome.alarms cadence (P: memory model)

// AI routing thresholds (AIRouter heuristics).
export const CLOUD_ESCALATION_MIN_CHARS = 2000; // long text -> cloud candidate
export const MAX_ONDEVICE_CHARS = 8000; // truncate context sent to Nano

// Engine selection (Workstream J, v6). Default 'auto' = today's behavior.
export const DEFAULT_ENGINE = 'auto' as const;
export const DEFAULT_LOCAL_SERVER_BASE_URL = 'http://localhost:11434';
export const DEFAULT_LOCAL_SERVER_MODEL = 'llama3.1'; // assumption: pull it first (`ollama pull llama3.1`)
export const DEFAULT_LOCAL_SERVER_TIMEOUT_MS = 60_000; // 60 s

// Chat-history retention (seconds) — same choices as Android Settings TTL.
export const DEFAULT_CHAT_RETENTION_SECONDS = 24 * 60 * 60; // 24 hours
export const CHAT_RETENTION_CHOICES = [
  { labelKey: 'retention1h', seconds: 60 * 60 },
  { labelKey: 'retention24h', seconds: 24 * 60 * 60 },
  { labelKey: 'retention7d', seconds: 7 * 24 * 60 * 60 },
] as const;

// chrome.storage.local keys (all local, never synced to any cloud).
export const STORAGE_KEYS = {
  permissions: 'mobius_permissions',
  memory: 'mobius_memory',
  routerLog: 'mobius_router_log',
  settings: 'mobius_settings',
  chatHistory: 'mobius_chat_history',
} as const;
