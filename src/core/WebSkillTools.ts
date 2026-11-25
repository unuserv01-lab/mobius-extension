// WebSkillTools — Layer 1 web tools for the SkillRunner (service-worker side).
// The runner runs in the service worker and cannot touch the DOM: every DOM
// action is forwarded to the active tab's content script (src/content/index.ts,
// MOBIUS_TOOL_* messages) or injected with chrome.scripting.executeScript
// (the whatsapp* tools below — the manifest already grants "scripting" +
// <all_urls>, so no manifest change is needed). Navigation runs here via
// chrome.tabs.
//
// NOT read-only (the old header claimed so — that was wrong): clickText,
// typeText, submit and whatsappOpenChat DO change page state, and are gated
// by the Orchestrator (runSkill checks the domActions permission BEFORE any
// step runs — see DOM_MUTATING_TOOLS below). A skill whose steps include any
// of them is refused whole when domActions is off, never run halfway.
// Navigation (navigate / back / home) is deliberately NOT gated: it only
// changes which page is shown, never modifies page content or submits
// anything, the URL comes from the skill JSON itself (author-controlled,
// deterministic), and the user sees it happen and can go back.
//
// WhatsApp Web read skill (v9, whatsapp_read.json) — READ-ONLY by design:
// it opens a chat, reads messages and summarizes them. It NEVER sends a
// message, never clicks Send, never types into the message box. The only
// page changes it makes are typing the contact name into the chat-list
// search box and clicking a chat row to open it (hence whatsappOpenChat is
// in DOM_MUTATING_TOOLS). Summarization calls CloudAI.generate() directly
// from this file (service-worker side) and ONLY when the cloudAI permission
// is on; when cloud AI is off — or the cloud call fails — the tool returns
// the raw transcript with an honest note instead of pretending it summarized.
//
// NOTE on the result channel: Orchestrator.formatSkillResult() only renders
// vars.prices / vars['prices.matches'] into the skill result text (the
// Orchestrator is owned by another workstream — do not "fix" it here). So
// the whatsappSummarize step stores its output under the var name "prices"
// (storeAs: "prices" in whatsapp_read.json). The name is a legacy of the
// price skills; the CONTENT is the WhatsApp summary (or the raw transcript
// with a note when no cloud summary was possible).
import { CloudAI } from '../ai/CloudAI';
import { failResult, okResult, type SkillToolAdapter, type ToolResult } from './SkillRunner';
import { PermissionManager } from './PermissionManager';

/** Steps that mutate page state and therefore require the domActions permission. */
export const DOM_MUTATING_TOOLS: ReadonlySet<string> = new Set(['clickText', 'typeText', 'submit', 'whatsappOpenChat']);

type ContentResult = { ok: boolean; text?: string; matches?: string[]; found?: boolean; error?: string };

/** Results returned by the injected WhatsApp Web page functions (JSON-able). */
type WaLoginState = { ok: boolean; loggedIn?: boolean; reason?: string };
type WaOpenChatResult = { ok: boolean; opened?: string; error?: string };
type WaExtractResult = { ok: boolean; count?: number; chat?: string; transcript?: string; error?: string };

/**
 * Strip leading read-verbs / fillers TaskRouter.extractQuery leaves in the
 * skill query, so only the contact name remains. Examples: "dari Moko" ->
 * "Moko"; "baca pesan whatsapp dari Moko" -> "Moko"; "chat whatsapp Moko" ->
 * "Moko". A contact whose name itself starts with one of these words
 * followed by a space (e.g. a contact literally named "Chat") would be
 * mangled — accepted edge case, the open-chat step then fails honestly.
 */
export function normalizeWaContact(raw: string): string {
  let name = raw.trim();
  for (;;) {
    const next = name
      .replace(/^(baca|ringkas|read|summarize|chat|pesan|whatsapp|wa|dari|dengan|with|sama|ke|kepada|buat|untuk)\s+/i, '')
      .trim();
    if (next === name) break;
    name = next;
  }
  return name;
}

export class WebSkillTools implements SkillToolAdapter {
  private tabId: number | null = null;
  /** Contact name of the chat opened by whatsappOpenChat (used as the sender label for incoming messages). */
  private lastChatName: string | null = null;
  async call(tool: string, args: Record<string, string>): Promise<ToolResult> {
    switch (tool) {
      case 'navigate':
        return this.navigate(args.url ?? '');
      case 'clickText':
        return this.toTab('MOBIUS_TOOL_CLICK_TEXT', { text: args.text ?? '', exact: args.exact === 'true' });
      case 'typeText':
        return this.toTab('MOBIUS_TOOL_TYPE_TEXT', { text: args.text ?? '' });
      case 'submit':
        return this.toTab('MOBIUS_TOOL_SUBMIT', {});
      case 'readScreen':
        return this.readScreen(args.limit ? Number(args.limit) : 200);
      case 'findText':
        return this.toTab('MOBIUS_TOOL_FIND_TEXT', { text: args.text ?? '', exact: args.exact === 'true' });
      case 'extract':
        return this.extract(args.pattern ?? '', args.max ? Number(args.max) : 5);
      case 'scroll':
        return this.toTab('MOBIUS_TOOL_SCROLL', {});
      case 'back':
        return this.toTab('MOBIUS_TOOL_BACK', {});
      case 'home':
        return this.toTab('MOBIUS_TOOL_HOME', {});
      case 'wait':
        await new Promise((r) => setTimeout(r, args.ms ? Number(args.ms) : 1000));
        return okResult(`Waited ${args.ms ?? '1000'}ms.`);
      case 'waitForText':
        return this.toTab('MOBIUS_TOOL_WAIT_FOR_TEXT', { text: args.text ?? '', timeoutMs: String(args.timeoutMs ? Number(args.timeoutMs) : 5000) });
      case 'whatsappOpen':
        return this.whatsappOpen();
      case 'whatsappOpenChat':
        return this.whatsappOpenChat(args.contact ?? '');
      case 'whatsappExtract':
        return this.whatsappExtract(args.max ? Number(args.max) : 30);
      case 'whatsappSummarize':
        return this.whatsappSummarize(args.transcript ?? '');
      default:
        return failResult(`Unknown tool: ${tool}`);
    }
  }

  private async navigate(rawUrl: string): Promise<ToolResult> {
    if (!rawUrl) return failResult('navigate needs a url.');
    const url = encodeURI(rawUrl);
    try {
      const tab = await this.activeTab();
      if (tab?.id !== undefined) {
        this.tabId = tab.id;
        await chrome.tabs.update(tab.id, { url });
        await this.waitForLoad(tab.id, 20_000);
        return okResult(`Opened ${url}`);
      }
      const created = await chrome.tabs.create({ url });
      if (created.id !== undefined) {
        this.tabId = created.id;
        await this.waitForLoad(created.id, 20_000);
        return okResult(`Opened ${url} in a new tab`);
      }
      return failResult('Could not open a tab.');
    } catch (e) {
      return failResult(e instanceof Error ? e.message : String(e));
    }
  }

  private async readScreen(limit: number): Promise<ToolResult> {
    const res = await this.toTab('MOBIUS_TOOL_READ_PAGE', {});
    if (!res.success || !res.data?.text) return res;
    const text = res.data.text;
    const capped = text.slice(0, Math.max(1000, limit * 100));
    return okResult(capped.slice(0, 400) + (capped.length > 400 ? '…' : ''), { text: capped });
  }

  private async extract(pattern: string, max: number): Promise<ToolResult> {
    if (!pattern) return failResult('extract needs a pattern.');
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'g');
    } catch {
      return failResult(`Invalid pattern: ${pattern}`);
    }
    const res = await this.toTab('MOBIUS_TOOL_EXTRACT', { pattern, max: String(max) });
    if (!res.success) return res;
    const matches = res.data?.matches ? res.data.matches.split('\n').filter(Boolean) : [];
    void re;
    if (matches.length === 0) return failResult('No matches found on this page.');
    const shown = matches.slice(0, max);
    return okResult(`Found ${matches.length} price(s): ${shown.join(', ')}`, { matches: shown.join('\n'), count: String(matches.length) });
  }

  // ---- WhatsApp Web read skill (v9) -------------------------------------
  //
  // Flow: whatsappOpen (reuse the open web.whatsapp.com tab, or navigate the
  // active tab there; verify the chat list is loaded, fail honestly when the
  // QR/login page is showing) -> whatsappOpenChat (type the contact name in
  // the chat-list search box, click the matching row) -> whatsappExtract
  // (scroll the conversation pane up to load history, read up to N messages
  // as "[time] sender: text" lines) -> whatsappSummarize (cloud AI summary,
  // or the raw transcript with an honest note when cloud is unavailable).
  // Nothing here ever sends a message.

  /** Prefer an already-open WhatsApp Web tab; otherwise navigate the active tab there. Then verify login. */
  private async whatsappOpen(): Promise<ToolResult> {
    try {
      const waTabs = await chrome.tabs.query({ url: '*://web.whatsapp.com/*' });
      const existing = waTabs.find((t) => t.id !== undefined);
      if (existing?.id !== undefined) {
        this.tabId = existing.id;
        try {
          await chrome.tabs.update(existing.id, { active: true });
          if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
        } catch {
          // Activation is best-effort; the tab still exists and can be scripted.
        }
        await this.ensureTabLoaded(existing.id);
      } else {
        const nav = await this.navigate('https://web.whatsapp.com');
        if (!nav.success) return nav;
      }
      if (this.tabId === null) return failResult('Tidak ada tab WhatsApp Web yang bisa dibuka.');
      let state: WaLoginState;
      try {
        state = await this.runInTab(this.tabId, waCheckLogin, []);
      } catch (e) {
        return failResult(`Tidak bisa memeriksa WhatsApp Web: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!state.ok) return failResult(state.reason ?? 'WhatsApp Web tidak menjawab.');
      if (!state.loggedIn) {
        return failResult(
          state.reason ??
            'WhatsApp Web belum tertaut / belum login di tab ini. Buka web.whatsapp.com di Chrome laptop, pindai kode QR dengan HP, lalu coba lagi.',
        );
      }
      return okResult('WhatsApp Web terbuka dan daftar chat termuat.');
    } catch (e) {
      return failResult(e instanceof Error ? e.message : String(e));
    }
  }

  /** Type the contact name into the chat-list search box and open the matching chat. Mutating (click + type) — gated by domActions. */
  private async whatsappOpenChat(contact: string): Promise<ToolResult> {
    const name = normalizeWaContact(contact);
    if (!name) return failResult('Sebutkan nama kontak — mis. "baca whatsapp Moko".');
    if (/^(terakhir|terbaru)$/i.test(name)) {
      return failResult(
        'Skill ini membaca chat dari SATU kontak yang disebut namanya — mis. "baca whatsapp Moko". Untuk pesan terakhir tanpa nama kontak, tanyakan langsung (mis. "balas pesan terakhir").',
      );
    }
    if (this.tabId === null) return failResult('Tab WhatsApp Web belum dibuka — jalankan langkah whatsappOpen dulu.');
    let res: WaOpenChatResult;
    try {
      res = await this.runInTab(this.tabId, waOpenChatInPage, [name]);
    } catch (e) {
      return failResult(`Tidak bisa membuka chat di WhatsApp Web: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) return failResult(res.error ?? 'Tidak bisa membuka chat.');
    this.lastChatName = res.opened ?? name;
    return okResult(`Chat "${this.lastChatName}" dibuka.`, { chat: this.lastChatName });
  }

  /** Scroll the conversation pane up to load history, then read the newest messages. Read-only. */
  private async whatsappExtract(max: number): Promise<ToolResult> {
    if (this.tabId === null) return failResult('Tab WhatsApp Web belum dibuka — jalankan langkah whatsappOpen dulu.');
    const chat = this.lastChatName ?? 'Kontak';
    let res: WaExtractResult;
    try {
      res = await this.runInTab(this.tabId, waExtractInPage, [chat, Math.max(1, Math.min(50, max || 30))]);
    } catch (e) {
      return failResult(`Tidak bisa membaca pesan di WhatsApp Web: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok || !res.transcript) return failResult(res.error ?? 'Tidak bisa membaca pesan.');
    return okResult(`${res.count ?? 0} pesan dari chat "${res.chat ?? chat}" dibaca.`, {
      transcript: res.transcript,
      count: String(res.count ?? 0),
      chat: res.chat ?? chat,
    });
  }

  /**
   * Summarize the transcript with cloud Gemini (CloudAI.generate).
   * Cloud AI is called ONLY when the cloudAI permission is on. When it is
   * off — or the cloud call fails — the tool still succeeds but returns the
   * raw transcript with an honest note, so the phone gets the messages
   * instead of a fake "summary". Never invents content.
   */
  private async whatsappSummarize(transcript: string): Promise<ToolResult> {
    const text = (transcript ?? '').trim();
    if (!text) return failResult('Tidak ada transkrip untuk diringkas.');
    const cloudAllowed = await new PermissionManager().isAllowed('cloudAI');
    if (!cloudAllowed) {
      const body = `Ringkasan cloud nonaktif — aktifkan "Izinkan Cloud AI" di Pengaturan MOBIUS untuk ringkasan otomatis. Transkrip mentah:\n${text}`;
      return okResult(body, { matches: body });
    }
    const prompt =
      'Ringkas percakapan WhatsApp berikut dalam Bahasa Indonesia.\n' +
      'Aturan: hanya pakai isi percakapan di bawah, jangan tambah fakta dari luar. ' +
      'Format: 3-6 poin singkat; sebut siapa berkata apa bila relevan; sertakan waktu bila penting. ' +
      'Bila ada janji atau kesepakatan (jumlah, tanggal, bayar), tulis eksplisit. ' +
      'Bila percakapan tidak jelas, katakan begitu.\n\n' +
      `Percakapan (format [waktu] pengirim: teks):\n${text}`;
    const res = await CloudAI.generate(prompt);
    if (res.ok) return okResult(res.text, { matches: res.text });
    const body = `Ringkasan cloud gagal (${res.error}). Transkrip mentah:\n${text}`;
    return okResult(body, { matches: body });
  }

  /** Run a self-contained page function in the given tab; returns its JSON-able result. */
  private async runInTab<T>(tabId: number, func: (...args: never[]) => Promise<T>, args: unknown[]): Promise<T> {
    const results = (await chrome.scripting.executeScript({
      target: { tabId },
      func: func as (...args: unknown[]) => Promise<T>,
      args,
    })) as Array<{ result?: T }>;
    const result = results?.[0]?.result;
    if (result === undefined || result === null) {
      throw new Error('WhatsApp Web tidak menjawab (script tidak berjalan di tab).');
    }
    return result;
  }

  private async toTab(type: string, payload: Record<string, string | boolean>): Promise<ToolResult> {
    try {
      const tab = await this.activeTab();
      if (tab?.id === undefined) return failResult('No active tab — open a page first.');
      this.tabId = tab.id;
      const res = (await chrome.tabs.sendMessage(tab.id, { type, ...payload })) as ContentResult | undefined;
      if (!res) return failResult('Content script did not answer (reload the page and try again).');
      if (!res.ok) return failResult(res.error ?? 'Tool failed on the page.');
      if (res.text !== undefined) return okResult(res.text.slice(0, 400), { text: res.text });
      if (res.matches !== undefined) return okResult(res.matches.join(', '), { matches: res.matches.join('\n') });
      if (res.found !== undefined) return res.found ? okResult(`Found "${(payload as { text?: string }).text ?? ''}" on the page.`) : failResult(`"${(payload as { text?: string }).text ?? ''}" not found on the page.`);
      return okResult('Done.');
    } catch (e) {
      return failResult(e instanceof Error ? e.message : String(e));
    }
  }

  private async activeTab(): Promise<chrome.tabs.Tab | undefined> {
    if (this.tabId !== null) {
      try {
        const tab = await chrome.tabs.get(this.tabId);
        if (tab) return tab;
      } catch {
        this.tabId = null;
      }
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  }

  private async ensureTabLoaded(tabId: number): Promise<void> {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return;
    } catch {
      return;
    }
    await this.waitForLoad(tabId, 20_000);
  }

  private waitForLoad(tabId: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      const listener = (id: number, info: { status?: string }): void => {
        if (id === tabId && info.status === 'complete') {
          clearTimeout(timer);
          done();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }
}

// ---- Injected WhatsApp Web page functions (v9) ---------------------------
// These run INSIDE the web.whatsapp.com tab via chrome.scripting.executeScript.
// They must stay self-contained: no closures, no imports, only JSON-able
// args/return values. WhatsApp Web DOM selectors drift over time — the
// function names and the fallback chains below are the first place to check
// when the skill starts failing on the live site (see README "WhatsApp Web
// read skill").

/** Poll until the chat list is visible (logged in) or the QR/login page shows (not linked). */
async function waCheckLogin(): Promise<WaLoginState> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  if (!location.hostname.includes('web.whatsapp.com')) {
    return { ok: false, reason: 'Tab ini bukan WhatsApp Web (web.whatsapp.com).' };
  }
  const LOGIN_TEXT = [
    /log in to whatsapp web/i,
    /masuk ke whatsapp web/i,
    /use whatsapp on your computer/i,
    /scan (the|this) qr/i,
    /pindai kode qr/i,
  ];
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (document.querySelector('[data-testid="chat-list-search"], [data-testid="chat-list"], #pane-main')) {
      return { ok: true, loggedIn: true };
    }
    const bodyText = document.body?.innerText ?? '';
    if (document.querySelector('[data-testid="qrcode"]') || LOGIN_TEXT.some((re) => re.test(bodyText))) {
      return {
        ok: true,
        loggedIn: false,
        reason:
          'WhatsApp Web belum tertaut / belum login di tab ini. Buka web.whatsapp.com di Chrome laptop, pindai kode QR dengan HP, lalu coba lagi.',
      };
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        reason:
          'WhatsApp Web tidak menunjukkan daftar chat maupun halaman login setelah 20 detik — mungkin masih memuat, atau tampilan WhatsApp Web berubah.',
      };
    }
    await sleep(1000);
  }
}

/** Type the contact name into the chat-list search box, click the matching row, verify the conversation opened. */
async function waOpenChatInPage(contact: string): Promise<WaOpenChatResult> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const needle = contact.trim().toLowerCase();
  if (!needle) return { ok: false, error: 'Nama kontak kosong.' };
  const searchScope = document.querySelector('[data-testid="chat-list-search"]') ?? document;
  const box = (searchScope.querySelector('div[contenteditable="true"], input[type="text"], input') ??
    document.querySelector('div[contenteditable="true"][data-tab="3"]')) as HTMLElement | null;
  if (!box) {
    return { ok: false, error: 'Kotak cari chat WhatsApp Web tidak ditemukan — tampilan WhatsApp Web mungkin berubah.' };
  }
  box.click();
  box.focus();
  const inserted = document.execCommand('insertText', false, contact);
  if (!inserted) (box as HTMLInputElement).value = contact;
  box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: contact }));
  await sleep(2000);
  const listRoot = document.querySelector('[data-testid="chat-list"], #pane-side') ?? document;
  const titles = [...listRoot.querySelectorAll('span[title]')];
  const exact = titles.find((el) => (el.getAttribute('title') ?? '').trim().toLowerCase() === needle);
  const partial = exact ?? titles.find((el) => (el.getAttribute('title') ?? '').trim().toLowerCase().includes(needle));
  if (!partial) {
    return { ok: false, error: `Chat dengan "${contact}" tidak ditemukan di daftar chat WhatsApp Web. Periksa ejaan nama kontak.` };
  }
  const name = (partial.getAttribute('title') ?? contact).trim();
  (partial as HTMLElement).click();
  const deadline = Date.now() + 8000;
  for (;;) {
    const header = document.querySelector('#main header [title], [data-testid="conversation-header"] [title]');
    const headerName = (header?.getAttribute('title') ?? '').trim();
    if (headerName && headerName.toLowerCase().includes(needle)) return { ok: true, opened: headerName };
    if (document.querySelector('#main .message-in, #main .message-out')) return { ok: true, opened: name };
    if (Date.now() >= deadline) {
      return { ok: false, error: `Chat "${name}" diklik tapi panel percakapan tidak terbuka — tampilan WhatsApp Web mungkin berubah.` };
    }
    await sleep(500);
  }
}

/**
 * Scroll the conversation pane to the top (a few times, so older history
 * loads), then read the newest messages as "[time] sender: text" lines.
 * Sender: "Saya" for outgoing; the group-author element when present, else
 * the chat name (correct for 1:1 chats; group authors fall back to the chat
 * name when WhatsApp does not expose the author element). Media-only
 * messages are kept as "[media/lampiran]" so the count stays honest.
 */
async function waExtractInPage(chatName: string, maxMessages: number): Promise<WaExtractResult> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const first = document.querySelector('#main .message-in, #main .message-out, .message-in, .message-out');
  if (!first) return { ok: false, error: 'Tidak ada pesan di chat yang terbuka.' };
  let container: HTMLElement | null = null;
  let el: HTMLElement | null = first as HTMLElement;
  for (let i = 0; i < 12 && el; i++) {
    if (el.scrollHeight > el.clientHeight + 20) {
      container = el;
      break;
    }
    el = el.parentElement;
  }
  if (container) {
    for (let i = 0; i < 5; i++) {
      const before = container.scrollHeight;
      container.scrollTop = 0;
      await sleep(1200);
      if (container.scrollHeight === before && container.scrollTop === 0) break;
    }
    container.scrollTop = container.scrollHeight;
    await sleep(400);
  }
  const scope = container ?? document;
  const rows = [...scope.querySelectorAll('.message-in, .message-out')].slice(-Math.max(1, maxMessages));
  const lines: string[] = [];
  for (const row of rows) {
    const textEl = row.querySelector('[data-testid="msg-text"], .selectable-text');
    const text = (textEl?.textContent ?? '').trim().replace(/\s+/g, ' ');
    const meta = (row.querySelector('[data-testid="msg-meta"]')?.textContent ?? '').trim();
    const time = (meta.match(/\d{1,2}[.:]\d{2}/) ?? ['??:??'])[0];
    const isOut = row.classList.contains('message-out');
    const author = row.querySelector('[data-testid="msg-author"]')?.textContent?.trim();
    const sender = isOut ? 'Saya' : author || chatName || 'Kontak';
    lines.push(`[${time}] ${sender}: ${text || '[media/lampiran]'}`);
  }
  if (lines.length === 0) {
    return { ok: false, error: 'Pesan ditemukan tapi tidak ada teks yang bisa dibaca (mungkin hanya media).' };
  }
  let transcript = lines.join('\n');
  const MAX_CHARS = 6000;
  while (transcript.length > MAX_CHARS && lines.length > 1) {
    lines.shift();
    transcript = lines.join('\n');
  }
  return { ok: true, count: lines.length, chat: chatName, transcript };
}
