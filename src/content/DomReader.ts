// DomReader — extracts clean context from the active page (content-script side).
// WhatsApp Web: last incoming message + sender. Gmail: visible message text.
// Generic page: main readable text (article / main / body, capped).
export class DomReader {
  /** WhatsApp Web: read the last INCOMING message (class .message-in) and its sender. */
  static readLastWhatsAppMessage(): { ok: true; text: string; sender?: string } | { ok: false; error: string } {
    if (!location.hostname.includes('web.whatsapp.com')) {
      return { ok: false, error: 'This is not WhatsApp Web (web.whatsapp.com).' };
    }
    const incoming = document.querySelectorAll('.message-in');
    if (incoming.length === 0) {
      return { ok: false, error: 'No incoming messages found in the open chat. Open a chat with messages first.' };
    }
    const last = incoming[incoming.length - 1];
    const textEl = last.querySelector('.selectable-text, [data-testid="msg-text"]');
    const text = (textEl?.textContent ?? last.textContent ?? '').trim();
    if (!text) return { ok: false, error: 'The last incoming message has no readable text (maybe media only).' };
    // Sender name (group chats): the element with the coloured author name.
    const senderEl = last.querySelector('[data-testid="msg-meta"]');
    const sender = senderEl?.textContent?.trim() || undefined;
    return { ok: true, text, sender };
  }

  /** Generic page: readable text, capped at ~12k chars for the router. */
  static readPageText(): { ok: true; text: string } | { ok: false; error: string } {
    const root =
      document.querySelector('article') ??
      document.querySelector('main') ??
      document.querySelector('[role="main"]') ??
      document.body;
    if (!root) return { ok: false, error: 'Could not read this page.' };
    const clone = root.cloneNode(true) as HTMLElement;
    // Strip noise: scripts, styles, nav, ads, hidden nodes.
    clone.querySelectorAll('script, style, noscript, nav, header, footer, iframe, svg, button, input, textarea').forEach((el) => el.remove());
    const text = (clone.innerText ?? clone.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length < 40) return { ok: false, error: 'This page has too little readable text to summarize.' };
    return { ok: true, text: text.slice(0, 12_000) };
  }

  /** Does the visible page text contain `text`? */
  static findText(text: string, exact: boolean): { ok: true; found: boolean } {
    const body = document.body?.innerText ?? '';
    const found = exact ? body.includes(text) : body.toLowerCase().includes(text.toLowerCase());
    return { ok: true, found };
  }

  /** All regex matches over the visible page text (capped). */
  static extract(pattern: string, max: number): { ok: true; matches: string[] } | { ok: false; error: string } {
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'g');
    } catch {
      return { ok: false, error: `Invalid pattern: ${pattern}` };
    }
    const body = document.body?.innerText ?? '';
    const matches = [...body.matchAll(re)].map((m) => m[0].trim()).filter(Boolean);
    return { ok: true, matches: matches.slice(0, Math.max(1, max)) };
  }

  /** Poll until `text` appears (or the timeout passes). */
  static async waitForText(text: string, timeoutMs: number): Promise<{ ok: true; found: boolean }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const body = document.body?.innerText ?? '';
      if (body.includes(text)) return { ok: true, found: true };
      if (Date.now() >= deadline) return { ok: true, found: false };
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
