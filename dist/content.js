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
    settings: "mobius_settings",
    chatHistory: "mobius_chat_history"
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
    /** Click the first visible clickable element whose text matches. */
    static clickText(text, exact) {
      const needle = exact ? text : text.toLowerCase();
      const candidates = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')];
      const el = candidates.find((c) => {
        if (!c.offsetParent) return false;
        const label = (c.innerText ?? c.textContent ?? "").trim();
        return exact ? label === needle : label.toLowerCase().includes(needle);
      });
      if (!el) return { ok: false, error: `No clickable element with text "${text}" found.` };
      el.click();
      return { ok: true };
    }
    /** Type into the page's search box (or the focused input). */
    static typeText(text) {
      var _a;
      const box = ((_a = document.activeElement) == null ? void 0 : _a.tagName) === "INPUT" ? document.activeElement : document.querySelector(
        'input[type="search"], input[name="q"], input[name="keyword"], input[placeholder*="ari" i], input[placeholder*="earch" i], input[type="text"]'
      );
      if (!box) return { ok: false, error: "No search box found on this page." };
      box.focus();
      box.value = "";
      const inserted = document.execCommand("insertText", false, text);
      if (!inserted) box.value = text;
      box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      return { ok: true };
    }
    /** Press Enter in the focused field, or submit its form. */
    static submit() {
      const active = document.activeElement;
      if (active) {
        active.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        active.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
        const form = active.closest("form");
        if (form) {
          form.requestSubmit();
          return { ok: true };
        }
        return { ok: true };
      }
      return { ok: false, error: "Nothing focused to submit — click the search box first." };
    }
    /** Scroll down ~one viewport (loads more results on infinite-scroll pages). */
    static scroll() {
      window.scrollBy({ top: window.innerHeight * 0.8, behavior: "instant" });
      return { ok: true };
    }
  }
  class ChatHistory {
    async add(role, text, retentionSeconds) {
      const now = Date.now();
      const msg = {
        id: `chat_${now}_${Math.random().toString(36).slice(2, 8)}`,
        role,
        text,
        createdAt: now,
        expiresAt: now + Math.max(60, retentionSeconds) * 1e3
      };
      const all = await this.readRaw();
      all.push(msg);
      await chrome.storage.local.set({ [STORAGE_KEYS.chatHistory]: all.slice(-200) });
      return msg;
    }
    async list(now = Date.now()) {
      const all = await this.readRaw();
      const kept = all.filter((m) => m.expiresAt > now).sort((a, b) => a.createdAt - b.createdAt);
      if (kept.length !== all.length) {
        await chrome.storage.local.set({ [STORAGE_KEYS.chatHistory]: kept });
      }
      return kept;
    }
    async clear() {
      await chrome.storage.local.set({ [STORAGE_KEYS.chatHistory]: [] });
    }
    /** Delete expired messages. Returns the number purged. */
    async purgeExpired(now = Date.now()) {
      const all = await this.readRaw();
      const kept = all.filter((m) => m.expiresAt > now);
      const purged = all.length - kept.length;
      if (purged > 0) await chrome.storage.local.set({ [STORAGE_KEYS.chatHistory]: kept });
      return purged;
    }
    async readRaw() {
      const data = await chrome.storage.local.get(STORAGE_KEYS.chatHistory);
      const list = data[STORAGE_KEYS.chatHistory];
      return Array.isArray(list) ? list : [];
    }
  }
  const DEFAULT_LANGUAGE = "id";
  const ID = {
    navOnboarding: "Onboarding",
    navRouterLog: "Log Router",
    navSettings: "Pengaturan",
    navHistory: "Riwayat",
    navChat: "Chat",
    onbWelcome: "Selamat datang di MOBIUS",
    onbIntro: "MOBIUS berjalan lokal di browser Anda. AI on-device (Gemini Nano) adalah default. Tidak ada data yang keluar dari perangkat Anda kecuali Anda mengizinkan Cloud AI di bawah.",
    onbHowItWorks: "Cara kerja",
    onbSteps: '1. Klik bubble mengambang di halaman mana pun.\n2. Tanyakan ke MOBIUS — mis. "Ringkas halaman ini" atau, di WhatsApp Web, "Balas pesan terakhir".\n3. MOBIUS membuat draf on-device, menyisipkan draf (bila aksi DOM aktif), dan mencatat setiap keputusan routing AI di tab Log Router.',
    gateBubble: "Bubble Mengambang",
    gateReadPage: "Baca Halaman / Konteks DOM",
    gateDomActions: "Aksi DOM Antar-Aplikasi",
    gateMemory: "Riwayat Konteks / Memori (lokal, TTL)",
    gateCloudAI: "Izinkan Cloud AI (Kecerdasan Pinjaman)",
    explainBubble: "Tampilkan bubble MOBIUS mengambang di halaman web.",
    explainReadPage: "Baca teks tab aktif (chat WhatsApp Web, artikel) supaya MOBIUS bisa memakai konteks halaman.",
    explainDomActions: "Ketik / sisipkan balasan ke input web (mis. kotak pesan WhatsApp Web).",
    explainMemory: "Simpan hasil tugas secara lokal di perangkat ini, dengan batas waktu (TTL).",
    explainCloudAI: "Izinkan Cloud AI (kecerdasan pinjaman). Saat OFF, MOBIUS tidak pernah memanggil cloud, bahkan bila AI on-device tidak tersedia.",
    denialNeeds: 'Ini butuh "{detail}" — saat ini OFF. Aktifkan di Side Panel MOBIUS (Onboarding / Pengaturan) untuk memakai fitur ini.',
    settingsTitle: "Pengaturan",
    setCloudAI: "Izinkan Cloud AI (Kecerdasan Pinjaman)",
    setCloudAIDesc: "Saat OFF (default), MOBIUS tidak pernah memanggil cloud — bahkan bila AI on-device tidak tersedia. Setiap panggilan cloud dicatat di Log Router.",
    setBubble: "Bubble Mengambang",
    setBubbleDesc: "Tampilkan bubble MOBIUS di halaman web.",
    setMemory: "Memori (lokal, TTL)",
    setMemoryDesc: "Simpan hasil tugas hanya di perangkat ini.",
    setEngine: "Mesin AI",
    setEngineDesc: 'Kecerdasan mana yang menjawab. Default "Otomatis" = Nano on-device dulu, cloud hanya bila diizinkan. Mesin yang dipilih eksplisit tidak pernah diam-diam pindah ke mesin lain — bila gagal, MOBIUS mencatatnya dan hanya fallback ke ringkasan ekstraktif lokal.',
    setEngineLabel: "Mesin",
    engineAuto: "Otomatis (Nano dulu, cloud bila diizinkan)",
    engineNano: "Nano on-device saja",
    engineCloud: 'Cloud Gemini saja (butuh "Izinkan Cloud AI")',
    engineLocal: "Server lokal saja (mis. Ollama di laptop ini)",
    setLocalBaseUrl: "URL dasar server lokal",
    setLocalModel: "Model server lokal",
    setLocalNote: 'Tidak ada model yang jalan di dalam browser — "server lokal" adalah program di laptop Anda (mis. Ollama: ollama serve, lalu ollama pull llama3.1). Extension hanya memanggilnya lewat HTTP. Bila server mati, MOBIUS mengatakannya, bukan pura-pura berhasil.',
    setSaveEngine: "Simpan pengaturan mesin",
    setSaved: "Tersimpan.",
    setTtl: "Batas waktu (TTL)",
    setTtlDesc: "Entri memori kedaluwarsa setelah sekian hari; data subagent sementara setelah sekian menit.",
    setMemoryTtl: "TTL Memori (hari)",
    setTempTtl: "TTL data sementara (menit)",
    setSaveTtl: "Simpan TTL",
    setFirebaseStatus: "Status Firebase AI Logic",
    setFirebaseOk: "Kunci Firebase sudah dikonfigurasi di src/config/firebase.ts. Gemini Nano on-device dan Gemini cloud tersedia lewat Firebase AI Logic SDK.",
    setFirebaseMissing: 'Kunci Firebase BELUM dikonfigurasi — tempel di src/config/firebase.ts (lihat README "Firebase setup"). Sampai saat itu, MOBIUS berjalan dengan Prompt API bawaan / fallback ekstraktif lokal dan tetap bekerja dengan baik.',
    setLanguage: "Bahasa",
    setLanguageDesc: "Berlaku untuk side panel dan bubble.",
    langIndonesian: "Bahasa Indonesia",
    langEnglish: "English",
    setChatHistory: "Riwayat chat",
    setChatHistoryDesc: "Berapa lama pesan chat disimpan.",
    retention1h: "1 jam",
    retention24h: "24 jam",
    retention7d: "7 hari",
    setSave: "Simpan",
    histTitle: "Riwayat & Memori",
    histDesc: "Hasil tugas yang diputuskan Core untuk disimpan — hanya lokal, dengan batas waktu. Tidak ada memori yang pernah dikirim ke cloud.",
    histEmpty: "Belum ada memori tersimpan.",
    histDelete: "Hapus",
    histClearAll: "Hapus semua memori",
    histSource: "sumber",
    histExpires: "kedaluwarsa",
    logTitle: "Log Router AI",
    logDesc: "Setiap keputusan routing yang dibuat MOBIUS — on-device dulu, cloud hanya bila diizinkan dan dibutuhkan. Diperbarui tiap 3 detik.",
    logEmpty: "Belum ada keputusan. Tanyakan sesuatu ke MOBIUS dari bubble.",
    logClear: "Hapus log",
    logCloudAllowed: "cloud diizinkan",
    logYes: "ya",
    logNo: "tidak",
    chatTitle: "Riwayat Chat",
    chatDesc: "Pesan yang Anda kirim dari bubble, disimpan di perangkat ini selama masa retensi di Pengaturan.",
    chatEmpty: "Belum ada pesan chat.",
    chatClear: "Hapus riwayat chat",
    chatYou: "Anda",
    bubbleDesc: "Tanyakan soal halaman ini, atau balas pesan WhatsApp terakhir. Diproses on-device secara default.",
    bubblePlaceholder: "cth. Ringkas halaman ini / Balas pesan terakhir",
    bubbleAsk: "Tanya MOBIUS",
    bubblePanel: "Panel Samping",
    bubbleThinking: "Berpikir on-device…",
    bubbleNoResponse: "Tidak ada respons dari inti MOBIUS. Muat ulang halaman dan coba lagi.",
    bubbleTaskFailed: "Tugas gagal.",
    bubbleUnreachable: "Tidak bisa menghubungi inti MOBIUS: ",
    bubbleSensitiveTitle: "Data sensitif ditemukan di pesan Anda: {types}. Belum ada yang dikirim.",
    bubbleSensitiveContinue: "Tetap lanjut",
    bubbleSensitiveCancel: "Batal",
    bubbleHistoryLabel: "Sebelumnya di chat ini",
    skillMatched: 'Skill "{skill}" cocok lewat kata kunci (skor {score}) — dijalankan secara deterministik, lokal.',
    skillDone: "Selesai: {skill}.",
    skillFailed: "Skill gagal: {message}",
    skillNoQuery: 'Sebutkan produknya — mis. "cari harga sepatu di Shopee".',
    skillNeedsReadPage: "Skill ini membaca halaman, jadi butuh izin baca halaman.",
    skillNeedsDomActions: "Skill ini mengubah halaman (klik / ketik / kirim), jadi butuh izin aksi DOM.",
    setBridge: "Laptop Bridge (tugas jarak jauh)",
    setBridgeDesc: "Terima tugas dari HP Android lewat bridge di laptop. Bridge harus jalan di laptop ini (bridge/bridge.mjs) dan token di bawah harus sama dengan MOBIUS_BRIDGE_TOKEN di laptop + di HP.",
    setBridgeUrl: "URL bridge",
    setBridgeToken: "Token bridge",
    setBridgeNote: "Token tidak pernah dicatat di log dan hanya dikirim ke URL bridge di atas sebagai header X-Mobius-Token. Bila panel samping terbuka, tugas diambil tiap 3 detik; bila tertutup, tiap 1 menit (batas alarm Chrome). Kosongkan token untuk mematikan bridge.",
    setSaveBridge: "Simpan pengaturan bridge",
    typeKtp: "nomor KTP",
    typePhone: "nomor HP",
    typeAccount: "nomor rekening",
    typeEmail: "email",
    typePassword: "kata sandi"
  };
  const EN = {
    navOnboarding: "Onboarding",
    navRouterLog: "Router Log",
    navSettings: "Settings",
    navHistory: "History",
    navChat: "Chat",
    onbWelcome: "Welcome to MOBIUS",
    onbIntro: "MOBIUS runs locally in your browser. On-device AI (Gemini Nano) is the default. Nothing leaves your device unless you explicitly allow Cloud AI below.",
    onbHowItWorks: "How it works",
    onbSteps: '1. Click the floating bubble on any page.\n2. Ask MOBIUS — e.g. "Summarize this page" or, on WhatsApp Web, "Reply to the last message".\n3. MOBIUS drafts on-device, inserts the draft (if DOM actions are on), and logs every AI routing decision in the Router Log tab.',
    gateBubble: "Floating Bubble Overlay",
    gateReadPage: "Read Page / DOM Context",
    gateDomActions: "Cross-App DOM Actions",
    gateMemory: "Context History / Memory (local, TTL)",
    gateCloudAI: "Allow Cloud AI (Borrowed Intelligence)",
    explainBubble: "Show the floating MOBIUS bubble on webpages.",
    explainReadPage: "Read the active tab text (WhatsApp Web chats, articles) so MOBIUS can use page context.",
    explainDomActions: "Type / insert replies into web inputs (e.g. the WhatsApp Web message box).",
    explainMemory: "Store task outcomes locally on this device, with a time limit (TTL).",
    explainCloudAI: "Allow Cloud AI (borrowed intelligence). When OFF, MOBIUS never calls the cloud, even if on-device AI is unavailable.",
    denialNeeds: 'This needs "{detail}" — it is currently OFF. Enable it in the MOBIUS Side Panel (Onboarding / Settings) to use this feature.',
    settingsTitle: "Settings",
    setCloudAI: "Allow Cloud AI (Borrowed Intelligence)",
    setCloudAIDesc: "When OFF (default), MOBIUS never calls the cloud — even if on-device AI is unavailable. Every cloud call is logged in the Router Log.",
    setBubble: "Floating Bubble",
    setBubbleDesc: "Show the MOBIUS bubble on webpages.",
    setMemory: "Memory (local, TTL)",
    setMemoryDesc: "Store task outcomes on this device only.",
    setEngine: "AI Engine",
    setEngineDesc: 'Which intelligence answers. Default "Auto" = Nano on-device first, cloud only if allowed. An explicit engine never silently switches to another one — if it fails, MOBIUS logs it and falls back only to the local extractive summary.',
    setEngineLabel: "Engine",
    engineAuto: "Auto (Nano first, cloud if allowed)",
    engineNano: "Nano on-device only",
    engineCloud: 'Cloud Gemini only (needs "Allow Cloud AI")',
    engineLocal: "Local server only (e.g. Ollama on this laptop)",
    setLocalBaseUrl: "Local server base URL",
    setLocalModel: "Local server model",
    setLocalNote: 'No model runs inside the browser — the "local server" is a program on your laptop (e.g. Ollama: ollama serve, then ollama pull llama3.1). The extension only calls it over HTTP. If the server is down, MOBIUS says so instead of pretending success.',
    setSaveEngine: "Save engine settings",
    setSaved: "Saved.",
    setTtl: "Time limits (TTL)",
    setTtlDesc: "Memory entries expire after this many days; temporary subagent data after this many minutes.",
    setMemoryTtl: "Memory TTL (days)",
    setTempTtl: "Temporary data TTL (minutes)",
    setSaveTtl: "Save TTL",
    setFirebaseStatus: "Firebase AI Logic status",
    setFirebaseOk: "Firebase keys are configured in src/config/firebase.ts. On-device Gemini Nano and cloud Gemini are available through the Firebase AI Logic SDK.",
    setFirebaseMissing: 'Firebase keys are NOT configured yet — paste them into src/config/firebase.ts (see README "Firebase setup"). Until then, MOBIUS runs on the built-in Prompt API / local extractive fallback and degrades gracefully.',
    setLanguage: "Language",
    setLanguageDesc: "Applies to the side panel and the bubble.",
    langIndonesian: "Bahasa Indonesia",
    langEnglish: "English",
    setChatHistory: "Chat history",
    setChatHistoryDesc: "How long chat messages are kept.",
    retention1h: "1 hour",
    retention24h: "24 hours",
    retention7d: "7 days",
    setSave: "Save",
    histTitle: "History & Memory",
    histDesc: "Task outcomes the Core decided to keep — stored locally only, with a time limit. No memory is ever sent to the cloud.",
    histEmpty: "No memory stored yet.",
    histDelete: "Delete",
    histClearAll: "Clear all memory",
    histSource: "source",
    histExpires: "expires",
    logTitle: "AI Router Log",
    logDesc: "Every routing decision MOBIUS makes — on-device first, cloud only when allowed and needed. Refreshes every 3 seconds.",
    logEmpty: "No decisions yet. Ask MOBIUS something from the bubble.",
    logClear: "Clear log",
    logCloudAllowed: "cloud allowed",
    logYes: "yes",
    logNo: "no",
    chatTitle: "Chat History",
    chatDesc: "Messages you sent from the bubble, kept on this device for the retention period in Settings.",
    chatEmpty: "No chat messages yet.",
    chatClear: "Clear chat history",
    chatYou: "You",
    bubbleDesc: "Ask about this page, or reply to the last WhatsApp message. Processed on-device by default.",
    bubblePlaceholder: "e.g. Summarize this page / Reply to the last message",
    bubbleAsk: "Ask MOBIUS",
    bubblePanel: "Side Panel",
    bubbleThinking: "Thinking on-device…",
    bubbleNoResponse: "No response from the MOBIUS core. Reload the page and try again.",
    bubbleTaskFailed: "Task failed.",
    bubbleUnreachable: "Could not reach the MOBIUS core: ",
    bubbleSensitiveTitle: "Sensitive data found in your message: {types}. Nothing was sent yet.",
    bubbleSensitiveContinue: "Continue anyway",
    bubbleSensitiveCancel: "Cancel",
    bubbleHistoryLabel: "Earlier in this chat",
    skillMatched: 'Skill "{skill}" matched by keyword (score {score}) — running deterministically, locally.',
    skillDone: "Done: {skill}.",
    skillFailed: "Skill failed: {message}",
    skillNoQuery: 'Name the product — e.g. "cari harga sepatu di Shopee".',
    skillNeedsReadPage: "This skill reads the page, so it needs the read-page permission.",
    skillNeedsDomActions: "This skill changes the page (click / type / submit), so it needs the DOM-actions permission.",
    setBridge: "Laptop Bridge (remote tasks)",
    setBridgeDesc: "Receive tasks from the Android phone via the bridge on this laptop. The bridge must run on this laptop (bridge/bridge.mjs) and the token below must match MOBIUS_BRIDGE_TOKEN on the laptop + the phone.",
    setBridgeUrl: "Bridge URL",
    setBridgeToken: "Bridge token",
    setBridgeNote: "The token is never logged and is only sent to the bridge URL above as the X-Mobius-Token header. While the side panel is open, tasks are picked up every 3 seconds; while closed, every 1 minute (Chrome alarm limit). Clear the token to turn the bridge off.",
    setSaveBridge: "Save bridge settings",
    typeKtp: "ID card number",
    typePhone: "phone number",
    typeAccount: "bank account number",
    typeEmail: "email",
    typePassword: "password"
  };
  const STRINGS = { id: ID, en: EN };
  let cachedLang = DEFAULT_LANGUAGE;
  async function loadLanguage() {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
      const stored = data[STORAGE_KEYS.settings];
      const lang = stored == null ? void 0 : stored.language;
      cachedLang = lang === "en" || lang === "id" ? lang : DEFAULT_LANGUAGE;
    } catch {
      cachedLang = DEFAULT_LANGUAGE;
    }
    return cachedLang;
  }
  function getLang() {
    return cachedLang;
  }
  function t(key, lang = cachedLang) {
    var _a;
    return ((_a = STRINGS[lang]) == null ? void 0 : _a[key]) ?? STRINGS.en[key] ?? key;
  }
  function tf(key, vars, lang = cachedLang) {
    let out = t(key, lang);
    for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, String(v));
    return out;
  }
  const TYPE_ORDER = ["ktp", "phone", "account", "email", "password"];
  const CONTIGUOUS_DIGITS = new RegExp("(?<!\\d)\\d{8,16}(?!\\d)", "g");
  const GROUPED_DIGITS = /\b\d{3,4}(?:[ -]\d{3,4}){2,3}\b/g;
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const PASSWORD_KEYWORDS = ["password", "passphrase", "kata sandi", "kata-sandi", "kata_sandi"];
  function scanSensitive(text, fileName = "") {
    const found = /* @__PURE__ */ new Set();
    scanTextInto(text, found);
    scanFileNameInto(fileName, found);
    return TYPE_ORDER.filter((t2) => found.has(t2)).map((type) => ({ type }));
  }
  function scanTextInto(text, found) {
    if (!text.trim()) return;
    for (const m of text.matchAll(CONTIGUOUS_DIGITS)) classifyDigits(m[0].replace(/\D/g, ""), found);
    for (const m of text.matchAll(GROUPED_DIGITS)) classifyDigits(m[0].replace(/\D/g, ""), found);
    if (EMAIL.test(text)) found.add("email");
    const lower = text.toLowerCase();
    if (PASSWORD_KEYWORDS.some((k) => lower.includes(k))) found.add("password");
  }
  function scanFileNameInto(fileName, found) {
    if (!fileName.trim()) return;
    const lower = fileName.toLowerCase();
    if (lower.includes("ktp")) found.add("ktp");
    if (lower.includes("rekening")) found.add("account");
    if (lower.includes("email")) found.add("email");
    if (PASSWORD_KEYWORDS.some((k) => lower.includes(k))) found.add("password");
    if (["no_hp", "no-hp", "nomor hp", "nomor-hp", "nomor_hp", "nohp"].some((k) => lower.includes(k))) found.add("phone");
    scanTextInto(fileName, found);
  }
  function classifyDigits(digits, found) {
    if (digits.length === 16) found.add("ktp");
    else if (isIndonesianPhone(digits)) found.add("phone");
    else if (digits.length >= 10 && digits.length <= 15) found.add("account");
  }
  function isIndonesianPhone(digits) {
    if (digits.startsWith("08") && digits.length >= 10 && digits.length <= 13) return true;
    if (digits.startsWith("628") && digits.length >= 11 && digits.length <= 13) return true;
    return false;
  }
  const LOGO_DATA_URI = "data:image/png;base64,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";
  const TYPE_LABEL = {
    ktp: "typeKtp",
    phone: "typePhone",
    account: "typeAccount",
    email: "typeEmail",
    password: "typePassword"
  };
  const BUBBLE_CSS = `
  :host { all: initial; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .mobius-bubble {
    position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
    width: 56px; height: 56px; border-radius: 50%;
    background: linear-gradient(135deg, #1a73e8, #7c4dff);
    color: #fff; font-size: 26px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    cursor: grab; border: none; padding: 0;
    box-shadow: 0 4px 20px rgba(124, 77, 255, .55), 0 0 0 2px rgba(179, 136, 255, .35);
    user-select: none; overflow: hidden;
  }
  .mobius-bubble:active { cursor: grabbing; }
  .mobius-bubble img { width: 56px; height: 56px; border-radius: 50%; object-fit: cover; display: block; pointer-events: none; }
  .mobius-badge {
    position: fixed; right: 20px; bottom: 84px; z-index: 2147483647;
    min-width: 20px; height: 20px; padding: 0 5px; box-sizing: border-box;
    border-radius: 10px; background: #b388ff; color: #04000f;
    border: 2px solid #04000f; box-shadow: 0 0 10px rgba(179, 136, 255, .8);
    font-size: 11px; font-weight: 700; line-height: 16px; text-align: center;
    cursor: pointer; user-select: none;
  }
  .mobius-badge[hidden] { display: none; }
  .mobius-sheet {
    position: fixed; right: 20px; bottom: 88px; z-index: 2147483647;
    width: 320px; max-width: calc(100vw - 40px);
    background: #17122e; color: #f2edff; border-radius: 14px;
    border: 1px solid #221a3e;
    box-shadow: 0 8px 32px rgba(0,0,0,.5); padding: 14px;
    display: none;
  }
  .mobius-sheet.open { display: block; }
  .mobius-sheet h3 { margin: 0 0 4px; font-size: 15px; color: #f2edff; }
  .mobius-sheet p { margin: 0 0 10px; font-size: 12px; color: #b9b3d6; }
  .mobius-sheet textarea {
    width: 100%; box-sizing: border-box; min-height: 64px; resize: vertical;
    border: 1px solid #3a2e6b; border-radius: 8px; padding: 8px; font-size: 13px; font-family: inherit;
    background: #221a3e; color: #f2edff;
  }
  .mobius-sheet .row { display: flex; gap: 8px; margin-top: 10px; }
  .mobius-sheet button {
    flex: 1; border: none; border-radius: 8px; padding: 9px 10px;
    font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .mobius-send { background: linear-gradient(135deg, #1a73e8, #7c4dff); color: #fff; }
  .mobius-panel { background: #221a3e; color: #f2edff; border: 1px solid #3a2e6b; }
  .mobius-result { margin-top: 10px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; max-height: 220px; overflow: auto; }
  .mobius-result .prov { font-size: 11px; color: #b388ff; margin-top: 6px; }
  .mobius-error { color: #ef5350; }
  .mobius-history { margin-bottom: 10px; max-height: 140px; overflow: auto; font-size: 12px; line-height: 1.5; }
  .mobius-history .hist-label { color: #b9b3d6; font-size: 11px; margin-bottom: 4px; }
  .mobius-history .msg-user { color: #b388ff; margin: 2px 0; }
  .mobius-history .msg-asst { color: #f2edff; margin: 2px 0 6px; }
  .mobius-warn { margin-top: 10px; padding: 10px; border-radius: 8px; background: #2a1f0d; border: 1px solid #ffca28; color: #ffe082; font-size: 12px; line-height: 1.5; }
  .mobius-warn .row { display: flex; gap: 8px; margin-top: 8px; }
  .mobius-warn button { flex: 1; border: none; border-radius: 8px; padding: 8px 10px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .mobius-warn .go { background: #ffca28; color: #04000f; }
  .mobius-warn .stop { background: #221a3e; color: #f2edff; border: 1px solid #3a2e6b; }
`;
  class BubbleWidget {
    constructor() {
      __publicField(this, "host");
      __publicField(this, "shadow");
      __publicField(this, "sheet");
      __publicField(this, "input");
      __publicField(this, "resultEl");
      __publicField(this, "historyEl");
      __publicField(this, "warnEl");
      __publicField(this, "badge");
      __publicField(this, "descEl");
      __publicField(this, "sendBtn");
      __publicField(this, "panelBtn");
      __publicField(this, "unreadCount", 0);
      __publicField(this, "pendingText", null);
      __publicField(this, "chatHistory", new ChatHistory());
      this.host = document.createElement("div");
      this.host.id = "mobius-bubble-host";
      this.shadow = this.host.attachShadow({ mode: "open" });
    }
    async mount() {
      if (document.getElementById("mobius-bubble-host")) return;
      await loadLanguage();
      const style = document.createElement("style");
      style.textContent = BUBBLE_CSS;
      this.shadow.appendChild(style);
      const bubble = document.createElement("button");
      bubble.className = "mobius-bubble";
      const logo = document.createElement("img");
      logo.src = LOGO_DATA_URI;
      logo.alt = APP_NAME;
      bubble.appendChild(logo);
      bubble.title = `${APP_NAME} — Personal AI Operating Layer`;
      bubble.setAttribute("aria-label", `${APP_NAME} assistant`);
      bubble.addEventListener("click", () => this.toggleSheet());
      this.makeDraggable(bubble);
      this.shadow.appendChild(bubble);
      const badge = document.createElement("div");
      badge.className = "mobius-badge";
      badge.hidden = true;
      badge.textContent = "0";
      badge.addEventListener("click", () => this.openSheet());
      this.badge = badge;
      this.shadow.appendChild(badge);
      const sheet = document.createElement("div");
      sheet.className = "mobius-sheet";
      sheet.innerHTML = `
      <h3>${APP_NAME}</h3>
      <p class="mobius-desc"></p>
      <div class="mobius-history" hidden></div>
      <textarea></textarea>
      <div class="row">
        <button class="mobius-send"></button>
        <button class="mobius-panel"></button>
      </div>
      <div class="mobius-warn" hidden></div>
      <div class="mobius-result" hidden></div>
    `;
      this.sheet = sheet;
      this.descEl = sheet.querySelector(".mobius-desc");
      this.historyEl = sheet.querySelector(".mobius-history");
      this.input = sheet.querySelector("textarea");
      this.sendBtn = sheet.querySelector(".mobius-send");
      this.panelBtn = sheet.querySelector(".mobius-panel");
      this.warnEl = sheet.querySelector(".mobius-warn");
      this.resultEl = sheet.querySelector(".mobius-result");
      this.sendBtn.addEventListener("click", () => void this.submit());
      this.panelBtn.addEventListener("click", () => {
        void chrome.runtime.sendMessage({ type: "MOBIUS_OPEN_PANEL" });
      });
      this.input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void this.submit();
      });
      this.shadow.appendChild(sheet);
      this.applyLanguage();
      await this.renderHistory();
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes.mobius_settings) return;
        void loadLanguage().then(() => {
          this.applyLanguage();
          void this.renderHistory();
        });
      });
      document.documentElement.appendChild(this.host);
    }
    applyLanguage() {
      this.descEl.textContent = t("bubbleDesc");
      this.input.placeholder = t("bubblePlaceholder");
      this.sendBtn.textContent = t("bubbleAsk");
      this.panelBtn.textContent = t("bubblePanel");
    }
    async renderHistory() {
      const messages = (await this.chatHistory.list()).slice(-6);
      if (messages.length === 0) {
        this.historyEl.hidden = true;
        this.historyEl.textContent = "";
        return;
      }
      this.historyEl.hidden = false;
      this.historyEl.textContent = "";
      const label = document.createElement("div");
      label.className = "hist-label";
      label.textContent = t("bubbleHistoryLabel");
      this.historyEl.appendChild(label);
      for (const m of messages) {
        const div = document.createElement("div");
        div.className = m.role === "user" ? "msg-user" : "msg-asst";
        div.textContent = m.role === "user" ? `${t("chatYou")}: ${m.text}` : m.text;
        this.historyEl.appendChild(div);
      }
      this.historyEl.scrollTop = this.historyEl.scrollHeight;
    }
    toggleSheet() {
      if (this.sheet.classList.contains("open")) {
        this.sheet.classList.remove("open");
      } else {
        this.openSheet();
      }
    }
    openSheet() {
      this.sheet.classList.add("open");
      this.resetUnread();
      this.input.focus();
      void this.renderHistory();
    }
    // --- Unread badge -------------------------------------------------------
    resetUnread() {
      this.unreadCount = 0;
      this.badge.hidden = true;
      this.badge.textContent = "0";
    }
    incrementUnread() {
      this.unreadCount += 1;
      this.badge.textContent = this.unreadCount > 9 ? "9+" : String(this.unreadCount);
      this.badge.hidden = false;
    }
    sheetIsOpen() {
      return this.sheet.classList.contains("open");
    }
    async submit() {
      const text = this.input.value.trim();
      if (!text) return;
      const findings = scanSensitive(text);
      if (findings.length > 0 && this.pendingText !== text) {
        this.pendingText = text;
        const types = findings.map((f) => t(TYPE_LABEL[f.type], getLang())).join(", ");
        this.warnEl.hidden = false;
        this.warnEl.textContent = "";
        const msg = document.createElement("div");
        msg.textContent = tf("bubbleSensitiveTitle", { types });
        this.warnEl.appendChild(msg);
        const row = document.createElement("div");
        row.className = "row";
        const go = document.createElement("button");
        go.className = "go";
        go.textContent = t("bubbleSensitiveContinue");
        go.addEventListener("click", () => {
          this.warnEl.hidden = true;
          void this.sendTask(this.pendingText ?? "");
        });
        const stop = document.createElement("button");
        stop.className = "stop";
        stop.textContent = t("bubbleSensitiveCancel");
        stop.addEventListener("click", () => {
          this.pendingText = null;
          this.warnEl.hidden = true;
        });
        row.appendChild(go);
        row.appendChild(stop);
        this.warnEl.appendChild(row);
        return;
      }
      this.pendingText = null;
      this.warnEl.hidden = true;
      await this.sendTask(text);
    }
    async sendTask(text) {
      this.showResult(t("bubbleThinking"), "");
      try {
        const res = await chrome.runtime.sendMessage({
          type: "MOBIUS_TASK",
          task: { id: `task_${Date.now()}`, intent: "chat", input: text, url: location.href }
        });
        const result = res == null ? void 0 : res.result;
        if (!result) {
          this.showResult(t("bubbleNoResponse"), "", true);
          return;
        }
        if (result.ok) {
          this.showResult(result.text ?? "", result.provenance ?? "");
          this.input.value = "";
        } else {
          this.showResult(result.error ?? t("bubbleTaskFailed"), "", true);
        }
      } catch (err) {
        this.showResult(`${t("bubbleUnreachable")}${err instanceof Error ? err.message : String(err)}`, "", true);
      }
      void this.renderHistory();
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
      if (!this.sheetIsOpen() && text !== t("bubbleThinking")) this.incrementUnread();
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
          this.badge.style.right = el.style.right;
          this.badge.style.bottom = `${Math.max(8, window.innerHeight - ev.clientY - 28 + 64)}px`;
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
    /** Does the visible page text contain `text`? */
    static findText(text, exact) {
      var _a;
      const body = ((_a = document.body) == null ? void 0 : _a.innerText) ?? "";
      const found = exact ? body.includes(text) : body.toLowerCase().includes(text.toLowerCase());
      return { ok: true, found };
    }
    /** All regex matches over the visible page text (capped). */
    static extract(pattern, max) {
      var _a;
      let re;
      try {
        re = new RegExp(pattern, "g");
      } catch {
        return { ok: false, error: `Invalid pattern: ${pattern}` };
      }
      const body = ((_a = document.body) == null ? void 0 : _a.innerText) ?? "";
      const matches = [...body.matchAll(re)].map((m) => m[0].trim()).filter(Boolean);
      return { ok: true, matches: matches.slice(0, Math.max(1, max)) };
    }
    /** Poll until `text` appears (or the timeout passes). */
    static async waitForText(text, timeoutMs) {
      var _a;
      const deadline = Date.now() + timeoutMs;
      for (; ; ) {
        const body = ((_a = document.body) == null ? void 0 : _a.innerText) ?? "";
        if (body.includes(text)) return { ok: true, found: true };
        if (Date.now() >= deadline) return { ok: true, found: false };
        await new Promise((r) => setTimeout(r, 500));
      }
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
    if ((msg == null ? void 0 : msg.type) === "MOBIUS_TOOL_CLICK_TEXT") {
      sendResponse(ActionExecutor.clickText(msg.text ?? "", msg.exact === true));
      return false;
    }
    if ((msg == null ? void 0 : msg.type) === "MOBIUS_TOOL_TYPE_TEXT") {
      sendResponse(ActionExecutor.typeText(msg.text ?? ""));
      return false;
    }
    if ((msg == null ? void 0 : msg.type) === "MOBIUS_TOOL_SUBMIT") {
      sendResponse(ActionExecutor.submit());
      return false;
    }
    if ((msg == null ? void 0 : msg.type) === "MOBIUS_TOOL_READ_PAGE") {
      sendResponse(DomReader.readPageText());
      return false;
    }
    if ((msg == null ? void 0 : msg.type) === "MOBIUS_TOOL_FIND_TEXT") {
      sendResponse(DomReader.findText(msg.text ?? "", msg.exact === true));
      return false;
    }
    if ((msg == null ? void 0 : msg.type) === "MOBIUS_TOOL_EXTRACT") {
      sendResponse(DomReader.extract(msg.pattern ?? "", msg.max ? Number(msg.max) : 5));
      return false;
    }
    if ((msg == null ? void 0 : msg.type) === "MOBIUS_TOOL_SCROLL") {
      sendResponse(ActionExecutor.scroll());
      return false;
    }
    if ((msg == null ? void 0 : msg.type) === "MOBIUS_TOOL_BACK") {
      history.back();
      sendResponse({ ok: true });
      return false;
    }
    if ((msg == null ? void 0 : msg.type) === "MOBIUS_TOOL_HOME") {
      location.href = `${location.origin}/`;
      sendResponse({ ok: true });
      return false;
    }
    if ((msg == null ? void 0 : msg.type) === "MOBIUS_TOOL_WAIT_FOR_TEXT") {
      void DomReader.waitForText(msg.text ?? "", msg.timeoutMs ? Number(msg.timeoutMs) : 5e3).then((r) => sendResponse(r));
      return true;
    }
    return false;
  });
})();
