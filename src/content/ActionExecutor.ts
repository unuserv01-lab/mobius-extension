// ActionExecutor — performs DOM actions on the user's behalf (content-script side).
// Only runs when the user opted into "Cross-App DOM Actions" (checked in the Core).
// WhatsApp Web: insert text into the message box (contenteditable) and fire
// the input event so React picks it up. Never clicks "send" automatically —
// the user presses Enter / Send, keeping the human in the loop for the MVP.
// Skill tools (v7) are read-only page interactions: click a visible element,
// type into a search box, submit a form, scroll. Nothing here buys, checks
// out, or sends anything.
export class ActionExecutor {
  static insertWhatsAppReply(text: string): { ok: true } | { ok: false; error: string } {
    if (!location.hostname.includes('web.whatsapp.com')) {
      return { ok: false, error: 'This is not WhatsApp Web.' };
    }
    const box = document.querySelector<HTMLElement>(
      '[data-testid="conversation-compose-box-input"], div[contenteditable="true"][data-tab="10"], footer div[contenteditable="true"]',
    );
    if (!box) {
      return { ok: false, error: 'WhatsApp message box not found. Click into a chat first.' };
    }
    box.focus();
    // Use execCommand('insertText') so WhatsApp's React state updates correctly.
    const inserted = document.execCommand('insertText', false, text);
    if (!inserted) {
      box.textContent = text;
    }
    box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }

  /** Click the first visible clickable element whose text matches. */
  static clickText(text: string, exact: boolean): { ok: true } | { ok: false; error: string } {
    const needle = exact ? text : text.toLowerCase();
    const candidates = [...document.querySelectorAll<HTMLElement>('button, a, [role="button"], input[type="submit"]')];
    const el = candidates.find((c) => {
      if (!c.offsetParent) return false; // hidden
      const label = (c.innerText ?? c.textContent ?? '').trim();
      return exact ? label === needle : label.toLowerCase().includes(needle);
    });
    if (!el) return { ok: false, error: `No clickable element with text "${text}" found.` };
    el.click();
    return { ok: true };
  }

  /** Type into the page's search box (or the focused input). */
  static typeText(text: string): { ok: true } | { ok: false; error: string } {
    const box =
      (document.activeElement as HTMLInputElement | null)?.tagName === 'INPUT'
        ? (document.activeElement as HTMLInputElement)
        : document.querySelector<HTMLInputElement>(
            'input[type="search"], input[name="q"], input[name="keyword"], input[placeholder*="ari" i], input[placeholder*="earch" i], input[type="text"]',
          );
    if (!box) return { ok: false, error: 'No search box found on this page.' };
    box.focus();
    box.value = '';
    const inserted = document.execCommand('insertText', false, text);
    if (!inserted) box.value = text;
    box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return { ok: true };
  }

  /** Press Enter in the focused field, or submit its form. */
  static submit(): { ok: true } | { ok: false; error: string } {
    const active = document.activeElement as HTMLElement | null;
    if (active) {
      active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      active.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      const form = active.closest('form');
      if (form) {
        form.requestSubmit();
        return { ok: true };
      }
      return { ok: true };
    }
    return { ok: false, error: 'Nothing focused to submit — click the search box first.' };
  }

  /** Scroll down ~one viewport (loads more results on infinite-scroll pages). */
  static scroll(): { ok: true } {
    window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'instant' as ScrollBehavior });
    return { ok: true };
  }
}
