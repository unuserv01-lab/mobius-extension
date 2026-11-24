var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
(function() {
  "use strict";
  const APP_NAME = "MOBIUS";
  const STORAGE_KEYS = {
    permissions: "mobius_permissions",
    memory: "mobius_memory",
    routerLog: "mobius_router_log",
    settings: "mobius_settings"
  };
  class ActionExecutor {
    static insertWhatsAppReply(text) {
      if (!location.hostname.includes("web.whatsapp.com")) {
        return { ok: false, error: "This is not WhatsApp Web." };
      }
      const box = document.querySelector(
        '[data-testid="conversation-compose-box-input"], div[contenteditable="true"][data-tab="10"], footer div[contenteditable="true"]'
      );
      if (!box) {
        return { ok: false, error: "WhatsApp message box not found. Click into a chat first." };
      }
      box.focus();
      const inserted = document.execCommand("insertText", false, text);
      if (!inserted) {
        box.textContent = text;
      }
      box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      box.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }
  }
  const BUBBLE_CSS = `
  :host { all: initial; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .mobius-bubble {
    position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
    width: 56px; height: 56px; border-radius: 50%;
    background: linear-gradient(135deg, #1a73e8, #7c4dff);
    color: #fff; font-size: 26px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    cursor: grab; border: none; box-shadow: 0 4px 16px rgba(0,0,0,.35);
    user-select: none; padding: 0;
  }
  .mobius-bubble:active { cursor: grabbing; }
  .mobius-sheet {
    position: fixed; right: 20px; bottom: 88px; z-index: 2147483647;
    width: 320px; max-width: calc(100vw - 40px);
    background: #fff; color: #111; border-radius: 14px;
    box-shadow: 0 8px 32px rgba(0,0,0,.3); padding: 14px;
    display: none;
  }
  .mobius-sheet.open { display: block; }
  .mobius-sheet h3 { margin: 0 0 4px; font-size: 15px; }
  .mobius-sheet p { margin: 0 0 10px; font-size: 12px; color: #555; }
  .mobius-sheet textarea {
    width: 100%; box-sizing: border-box; min-height: 64px; resize: vertical;
    border: 1px solid #ccc; border-radius: 8px; padding: 8px; font-size: 13px; font-family: inherit;
  }
  .mobius-sheet .row { display: flex; gap: 8px; margin-top: 10px; }
  .mobius-sheet button {
    flex: 1; border: none; border-radius: 8px; padding: 9px 10px;
    font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .mobius-send { background: #1a73e8; color: #fff; }
  .mobius-panel { background: #f1f3f4; color: #111; }
  .mobius-result { margin-top: 10px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; max-height: 220px; overflow: auto; }
  .mobius-result .prov { font-size: 11px; color: #1a73e8; margin-top: 6px; }
  .mobius-error { color: #b3261e; }
`;
  class BubbleWidget {
    constructor() {
      __publicField(this, "host");
      __publicField(this, "shadow");
      __publicField(this, "sheet");
      __publicField(this, "input");
      __publicField(this, "resultEl");
      this.host = document.createElement("div");
      this.host.id = "mobius-bubble-host";
      this.shadow = this.host.attachShadow({ mode: "open" });
    }
    mount() {
      if (document.getElementById("mobius-bubble-host")) return;
      const style = document.createElement("style");
      style.textContent = BUBBLE_CSS;
      this.shadow.appendChild(style);
      const bubble = document.createElement("button");
      bubble.className = "mobius-bubble";
      bubble.textContent = "M";
      bubble.title = `${APP_NAME} — Personal AI Operating Layer`;
      bubble.setAttribute("aria-label", `${APP_NAME} assistant`);
      bubble.addEventListener("click", () => this.toggleSheet());
      this.makeDraggable(bubble);
      this.shadow.appendChild(bubble);
      const sheet = document.createElement("div");
      sheet.className = "mobius-sheet";
      sheet.innerHTML = `
      <h3>${APP_NAME}</h3>
      <p>Ask about this page, or reply to the last WhatsApp message. Processed on-device by default.</p>
      <textarea placeholder="e.g. Summarize this page / Reply to the last message"></textarea>
      <div class="row">
        <button class="mobius-send">Ask ${APP_NAME}</button>
        <button class="mobius-panel">Side Panel</button>
      </div>
      <div class="mobius-result" hidden></div>
    `;
      this.sheet = sheet;
      this.input = sheet.querySelector("textarea");
      this.resultEl = sheet.querySelector(".mobius-result");
      sheet.querySelector(".mobius-send").addEventListener("click", () => void this.submit());
      sheet.querySelector(".mobius-panel").addEventListener("click", () => {
        void chrome.runtime.sendMessage({ type: "MOBIUS_OPEN_PANEL" });
      });
      this.input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void this.submit();
      });
      this.shadow.appendChild(sheet);
      document.documentElement.appendChild(this.host);
    }
    toggleSheet() {
      this.sheet.classList.toggle("open");
      if (this.sheet.classList.contains("open")) this.input.focus();
    }
    async submit() {
      const text = this.input.value.trim();
      if (!text) return;
      this.showResult("Thinking on-device…", "");
      try {
        const res = await chrome.runtime.sendMessage({
          type: "MOBIUS_TASK",
          task: { id: `task_${Date.now()}`, intent: "chat", input: text, url: location.href }
        });
        const result = res == null ? void 0 : res.result;
        if (!result) {
          this.showResult("No response from the MOBIUS core. Reload the page and try again.", "", true);
          return;
        }
        if (result.ok) this.showResult(result.text ?? "", result.provenance ?? "");
        else this.showResult(result.error ?? "Task failed.", "", true);
      } catch (err) {
        this.showResult(`Could not reach the MOBIUS core: ${err instanceof Error ? err.message : String(err)}`, "", true);
      }
    }
    showResult(text, provenance, isError = false) {
      this.resultEl.hidden = false;
      this.resultEl.classList.toggle("mobius-error", isError);
      this.resultEl.textContent = "";
      const body = document.createElement("div");
      body.textContent = text;
      this.resultEl.appendChild(body);
      if (provenance) {
        const prov = document.createElement("div");
        prov.className = "prov";
        prov.textContent = provenance;
        this.resultEl.appendChild(prov);
      }
    }
    /** Drag the bubble anywhere; a click (not a drag) toggles the sheet. */
    makeDraggable(el) {
      let startX = 0;
      let startY = 0;
      let moved = false;
      el.addEventListener("pointerdown", (e) => {
        startX = e.clientX;
        startY = e.clientY;
        moved = false;
        const onMove = (ev) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
          el.style.right = `${Math.max(8, window.innerWidth - ev.clientX - 28)}px`;
          el.style.bottom = `${Math.max(8, window.innerHeight - ev.clientY - 28)}px`;
        };
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          if (moved) el.addEventListener("click", (ev) => ev.stopPropagation(), { once: true, capture: true });
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });
    }
  }
  class DomReader {
    /** WhatsApp Web: read the last INCOMING message (class .message-in) and its sender. */
    static readLastWhatsAppMessage() {
      var _a;
      if (!location.hostname.includes("web.whatsapp.com")) {
        return { ok: false, error: "This is not WhatsApp Web (web.whatsapp.com)." };
      }
      const incoming = document.querySelectorAll(".message-in");
      if (incoming.length === 0) {
        return { ok: false, error: "No incoming messages found in the open chat. Open a chat with messages first." };
      }
      const last = incoming[incoming.length - 1];
      const textEl = last.querySelector('.selectable-text, [data-testid="msg-text"]');
      const text = ((textEl == null ? void 0 : textEl.textContent) ?? last.textContent ?? "").trim();
      if (!text) return { ok: false, error: "The last incoming message has no readable text (maybe media only)." };
      const senderEl = last.querySelector('[data-testid="msg-meta"]');
      const sender = ((_a = senderEl == null ? void 0 : senderEl.textContent) == null ? void 0 : _a.trim()) || void 0;
      return { ok: true, text, sender };
    }
    /** Generic page: readable text, capped at ~12k chars for the router. */
    static readPageText() {
      const root = document.querySelector("article") ?? document.querySelector("main") ?? document.querySelector('[role="main"]') ?? document.body;
      if (!root) return { ok: false, error: "Could not read this page." };
      const clone = root.cloneNode(true);
      clone.querySelectorAll("script, style, noscript, nav, header, footer, iframe, svg, button, input, textarea").forEach((el) => el.remove());
      const text = (clone.innerText ?? clone.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      if (text.length < 40) return { ok: false, error: "This page has too little readable text to summarize." };
      return { ok: true, text: text.slice(0, 12e3) };
    }
  }
  async function bubbleEnabled() {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEYS.permissions);
      const perms = data[STORAGE_KEYS.permissions];
      return (perms == null ? void 0 : perms.bubble) !== false;
    } catch {
      return true;
    }
  }
  void bubbleEnabled().then((enabled) => {
    if (enabled) new BubbleWidget().mount();
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const msg = message;
    if ((msg == null ? void 0 : msg.type) === "MOBIUS_READ_WA") {
      sendResponse(DomReader.readLastWhatsAppMessage());
      return false;
    }
    if ((msg == null ? void 0 : msg.type) === "MOBIUS_READ_PAGE") {
      sendResponse(DomReader.readPageText());
      return false;
    }
    if ((msg == null ? void 0 : msg.type) === "MOBIUS_INSERT_REPLY") {
      sendResponse(ActionExecutor.insertWhatsAppReply(msg.text ?? ""));
      return false;
    }
    return false;
  });
})();
