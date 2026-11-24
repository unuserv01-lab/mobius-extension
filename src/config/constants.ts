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

// chrome.storage.local keys (all local, never synced to any cloud).
export const STORAGE_KEYS = {
  permissions: 'mobius_permissions',
  memory: 'mobius_memory',
  routerLog: 'mobius_router_log',
  settings: 'mobius_settings',
} as const;
