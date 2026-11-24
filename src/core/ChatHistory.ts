// ChatHistory — persistent chat messages (bubble <-> side panel), v7 alignment.
// Same retention options as Android (1 hour / 24 hours / 7 days, from
// Settings.chatRetentionSeconds). Backed by chrome.storage.local; expired
// messages are purged by the service worker's TTL alarm and on read.
// Unlike MemoryStore (task outcomes the Core chooses to keep), this is the
// user's own conversation: user + assistant turns, in order.
import { STORAGE_KEYS } from '../config/constants';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  expiresAt: number;
}

export class ChatHistory {
  async add(role: ChatMessage['role'], text: string, retentionSeconds: number): Promise<ChatMessage> {
    const now = Date.now();
    const msg: ChatMessage = {
      id: `chat_${now}_${Math.random().toString(36).slice(2, 8)}`,
      role,
      text,
      createdAt: now,
      expiresAt: now + Math.max(60, retentionSeconds) * 1000,
    };
    const all = await this.readRaw();
    all.push(msg);
    await chrome.storage.local.set({ [STORAGE_KEYS.chatHistory]: all.slice(-200) });
    return msg;
  }

  async list(now = Date.now()): Promise<ChatMessage[]> {
    const all = await this.readRaw();
    const kept = all.filter((m) => m.expiresAt > now).sort((a, b) => a.createdAt - b.createdAt);
    if (kept.length !== all.length) {
      await chrome.storage.local.set({ [STORAGE_KEYS.chatHistory]: kept });
    }
    return kept;
  }

  async clear(): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEYS.chatHistory]: [] });
  }

  /** Delete expired messages. Returns the number purged. */
  async purgeExpired(now = Date.now()): Promise<number> {
    const all = await this.readRaw();
    const kept = all.filter((m) => m.expiresAt > now);
    const purged = all.length - kept.length;
    if (purged > 0) await chrome.storage.local.set({ [STORAGE_KEYS.chatHistory]: kept });
    return purged;
  }

  private async readRaw(): Promise<ChatMessage[]> {
    const data = await chrome.storage.local.get(STORAGE_KEYS.chatHistory);
    const list = data[STORAGE_KEYS.chatHistory];
    return Array.isArray(list) ? (list as ChatMessage[]) : [];
  }
}
