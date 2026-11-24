// ActionExecutor — performs DOM actions on the user's behalf (content-script side).
// Only runs when the user opted into "Cross-App DOM Actions" (checked in the Core).
// WhatsApp Web: insert text into the message box (contenteditable) and fire
// the input event so React picks it up. Never clicks "send" automatically —
// the user presses Enter / Send, keeping the human in the loop for the MVP.
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
}
