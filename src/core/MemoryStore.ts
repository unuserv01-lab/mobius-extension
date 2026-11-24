// MemoryStore — core-owned local memory (P5: subagents NEVER write here directly).
// Backed by chrome.storage.local. Every entry carries a TTL; expired entries
// are purged by the service worker's chrome.alarms job (every 5 min).
// No memory is ever transmitted to the cloud (P10).
import { STORAGE_KEYS } from '../config/constants';
import type { MemoryEntry } from './types';

export class MemoryStore {
  private async readAll(): Promise<MemoryEntry[]> {
    const data = await chrome.storage.local.get(STORAGE_KEYS.memory);
    const entries = data[STORAGE_KEYS.memory];
    return Array.isArray(entries) ? (entries as MemoryEntry[]) : [];
  }

  private async writeAll(entries: MemoryEntry[]): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEYS.memory]: entries });
  }

  /** Core-only write. Called by Orchestrator after a SubAgent reports. */
  async add(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'expiresAt'>): Promise<MemoryEntry> {
    const now = Date.now();
    const full: MemoryEntry = {
      ...entry,
      id: `mem_${now}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      expiresAt: now + entry.ttlSeconds * 1000,
    };
    const entries = await this.readAll();
    entries.push(full);
    await this.writeAll(entries);
    return full;
  }

  async list(): Promise<MemoryEntry[]> {
    const entries = await this.readAll();
    return entries.sort((a, b) => b.createdAt - a.createdAt);
  }

  async remove(id: string): Promise<void> {
    const entries = (await this.readAll()).filter((e) => e.id !== id);
    await this.writeAll(entries);
  }

  async clear(): Promise<void> {
    await this.writeAll([]);
  }

  /** Delete expired entries. Returns the number purged. */
  async purgeExpired(now = Date.now()): Promise<number> {
    const entries = await this.readAll();
    const kept = entries.filter((e) => e.expiresAt > now);
    const purged = entries.length - kept.length;
    if (purged > 0) await this.writeAll(kept);
    return purged;
  }
}
