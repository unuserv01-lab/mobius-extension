// ContextManager — per-task context, assembled locally (P1).
// Gathers active-tab metadata + an optional DOM snippet from the content
// script. Context is ephemeral: it lives for one task and is never stored
// unless the Core explicitly decides to persist a summary in MemoryStore.
import { MAX_ONDEVICE_CHARS } from '../config/constants';

export interface TaskContext {
  tabId?: number;
  url?: string;
  title?: string;
  domain?: string;
  /** Cleaned page text, truncated for on-device inference. */
  pageText?: string;
  timeIso: string;
  recentTaskSummaries: string[];
}

export class ContextManager {
  /** Assemble context for a task. pageText is supplied by the caller (content script). */
  async build(tabId: number | undefined, pageText: string | undefined, recentTaskSummaries: string[]): Promise<TaskContext> {
    let tab: chrome.tabs.Tab | undefined;
    try {
      if (typeof tabId === 'number') {
        tab = await chrome.tabs.get(tabId);
      } else {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tab = active;
      }
    } catch {
      tab = undefined; // no tab access — degrade gracefully, context stays minimal
    }
    const url = tab?.url ?? '';
    let domain = '';
    try {
      domain = url ? new URL(url).hostname : '';
    } catch {
      domain = '';
    }
    const cleanText = pageText ? pageText.replace(/\s+/g, ' ').trim().slice(0, MAX_ONDEVICE_CHARS) : undefined;
    return {
      tabId: tab?.id,
      url: url || undefined,
      title: tab?.title,
      domain: domain || undefined,
      pageText: cleanText,
      timeIso: new Date().toISOString(),
      recentTaskSummaries: recentTaskSummaries.slice(0, 5),
    };
  }
}
