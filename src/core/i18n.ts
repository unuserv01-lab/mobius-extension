// i18n — Bahasa Indonesia / English for the side panel + bubble (v7 alignment).
// Default: Bahasa Indonesia (Tuan's language). Persisted in mobius_settings
// as `language`. Proper nouns, model names (Gemini, Nano) and the tagline
// "Your Intelligence. Everywhere. Owned by You." are never translated.
// Views are async: call loadLanguage() once, then t(). Sync callers
// (PermissionManager) use the cached value — default 'id' until loaded.
import { STORAGE_KEYS } from '../config/constants';
import type { MobiusSettings } from './types';

export type Lang = 'id' | 'en';
export const DEFAULT_LANGUAGE: Lang = 'id';

export type StringKey =
  | 'navOnboarding'
  | 'navRouterLog'
  | 'navSettings'
  | 'navHistory'
  | 'navChat'
  | 'onbWelcome'
  | 'onbIntro'
  | 'onbHowItWorks'
  | 'onbSteps'
  | 'gateBubble'
  | 'gateReadPage'
  | 'gateDomActions'
  | 'gateMemory'
  | 'gateCloudAI'
  | 'explainBubble'
  | 'explainReadPage'
  | 'explainDomActions'
  | 'explainMemory'
  | 'explainCloudAI'
  | 'denialNeeds'
  | 'settingsTitle'
  | 'setCloudAI'
  | 'setCloudAIDesc'
  | 'setBubble'
  | 'setBubbleDesc'
  | 'setMemory'
  | 'setMemoryDesc'
  | 'setEngine'
  | 'setEngineDesc'
  | 'setEngineLabel'
  | 'engineAuto'
  | 'engineNano'
  | 'engineCloud'
  | 'engineLocal'
  | 'setLocalBaseUrl'
  | 'setLocalModel'
  | 'setLocalNote'
  | 'setSaveEngine'
  | 'setSaved'
  | 'setTtl'
  | 'setTtlDesc'
  | 'setMemoryTtl'
  | 'setTempTtl'
  | 'setSaveTtl'
  | 'setFirebaseStatus'
  | 'setFirebaseOk'
  | 'setFirebaseMissing'
  | 'setLanguage'
  | 'setLanguageDesc'
  | 'langIndonesian'
  | 'langEnglish'
  | 'setChatHistory'
  | 'setChatHistoryDesc'
  | 'retention1h'
  | 'retention24h'
  | 'retention7d'
  | 'setSave'
  | 'histTitle'
  | 'histDesc'
  | 'histEmpty'
  | 'histDelete'
  | 'histClearAll'
  | 'histSource'
  | 'histExpires'
  | 'logTitle'
  | 'logDesc'
  | 'logEmpty'
  | 'logClear'
  | 'logCloudAllowed'
  | 'logYes'
  | 'logNo'
  | 'chatTitle'
  | 'chatDesc'
  | 'chatEmpty'
  | 'chatClear'
  | 'chatYou'
  | 'bubbleDesc'
  | 'bubblePlaceholder'
  | 'bubbleAsk'
  | 'bubblePanel'
  | 'bubbleThinking'
  | 'bubbleNoResponse'
  | 'bubbleTaskFailed'
  | 'bubbleUnreachable'
  | 'bubbleSensitiveTitle'
  | 'bubbleSensitiveContinue'
  | 'bubbleSensitiveCancel'
  | 'bubbleHistoryLabel'
  | 'skillMatched'
  | 'skillDone'
  | 'skillFailed'
  | 'skillNoQuery'
  | 'skillNeedsReadPage'
  | 'skillNeedsDomActions'
  | 'setBridge'
  | 'setBridgeDesc'
  | 'setBridgeUrl'
  | 'setBridgeToken'
  | 'setBridgeNote'
  | 'setSaveBridge'
  | 'typeKtp'
  | 'typePhone'
  | 'typeAccount'
  | 'typeEmail'
  | 'typePassword'
  | 'awaitingApproval'
  | 'awaitingApprovalAt'
  | 'actClickText'
  | 'actTypeText'
  | 'actSubmit'
  | 'actNavigate'
  | 'actScroll'
  | 'actBack'
  | 'actHome'
  | 'approvalCardTitle'
  | 'approvalCardHint'
  | 'approvalCardHintSensitive'
  | 'approvalCardAt';

const ID: Record<StringKey, string> = {
  navOnboarding: 'Onboarding',
  navRouterLog: 'Log Router',
  navSettings: 'Pengaturan',
  navHistory: 'Riwayat',
  navChat: 'Chat',
  onbWelcome: 'Selamat datang di MOBIUS',
  onbIntro:
    'MOBIUS berjalan lokal di browser Anda. AI on-device (Gemini Nano) adalah default. Tidak ada data yang keluar dari perangkat Anda kecuali Anda mengizinkan Cloud AI di bawah.',
  onbHowItWorks: 'Cara kerja',
  onbSteps:
    '1. Klik bubble mengambang di halaman mana pun.\n2. Tanyakan ke MOBIUS — mis. "Ringkas halaman ini" atau, di WhatsApp Web, "Balas pesan terakhir".\n3. MOBIUS membuat draf on-device, menyisipkan draf (bila aksi DOM aktif), dan mencatat setiap keputusan routing AI di tab Log Router.',
  gateBubble: 'Bubble Mengambang',
  gateReadPage: 'Baca Halaman / Konteks DOM',
  gateDomActions: 'Aksi DOM Antar-Aplikasi',
  gateMemory: 'Riwayat Konteks / Memori (lokal, TTL)',
  gateCloudAI: 'Izinkan Cloud AI (Kecerdasan Pinjaman)',
  explainBubble: 'Tampilkan bubble MOBIUS mengambang di halaman web.',
  explainReadPage: 'Baca teks tab aktif (chat WhatsApp Web, artikel) supaya MOBIUS bisa memakai konteks halaman.',
  explainDomActions: 'Ketik / sisipkan balasan ke input web (mis. kotak pesan WhatsApp Web).',
  explainMemory: 'Simpan hasil tugas secara lokal di perangkat ini, dengan batas waktu (TTL).',
  explainCloudAI:
    'Izinkan Cloud AI (kecerdasan pinjaman). Saat OFF, MOBIUS tidak pernah memanggil cloud, bahkan bila AI on-device tidak tersedia.',
  denialNeeds: 'Ini butuh "{detail}" — saat ini OFF. Aktifkan di Side Panel MOBIUS (Onboarding / Pengaturan) untuk memakai fitur ini.',
  settingsTitle: 'Pengaturan',
  setCloudAI: 'Izinkan Cloud AI (Kecerdasan Pinjaman)',
  setCloudAIDesc:
    'Saat OFF (default), MOBIUS tidak pernah memanggil cloud — bahkan bila AI on-device tidak tersedia. Setiap panggilan cloud dicatat di Log Router.',
  setBubble: 'Bubble Mengambang',
  setBubbleDesc: 'Tampilkan bubble MOBIUS di halaman web.',
  setMemory: 'Memori (lokal, TTL)',
  setMemoryDesc: 'Simpan hasil tugas hanya di perangkat ini.',
  setEngine: 'Mesin AI',
  setEngineDesc:
    'Kecerdasan mana yang menjawab. Default "Otomatis" = Nano on-device dulu, cloud hanya bila diizinkan. Mesin yang dipilih eksplisit tidak pernah diam-diam pindah ke mesin lain — bila gagal, MOBIUS mencatatnya dan hanya fallback ke ringkasan ekstraktif lokal.',
  setEngineLabel: 'Mesin',
  engineAuto: 'Otomatis (Nano dulu, cloud bila diizinkan)',
  engineNano: 'Nano on-device saja',
  engineCloud: 'Cloud Gemini saja (butuh "Izinkan Cloud AI")',
  engineLocal: 'Server lokal saja (mis. Ollama di laptop ini)',
  setLocalBaseUrl: 'URL dasar server lokal',
  setLocalModel: 'Model server lokal',
  setLocalNote:
    'Tidak ada model yang jalan di dalam browser — "server lokal" adalah program di laptop Anda (mis. Ollama: ollama serve, lalu ollama pull llama3.1). Extension hanya memanggilnya lewat HTTP. Bila server mati, MOBIUS mengatakannya, bukan pura-pura berhasil.',
  setSaveEngine: 'Simpan pengaturan mesin',
  setSaved: 'Tersimpan.',
  setTtl: 'Batas waktu (TTL)',
  setTtlDesc: 'Entri memori kedaluwarsa setelah sekian hari; data subagent sementara setelah sekian menit.',
  setMemoryTtl: 'TTL Memori (hari)',
  setTempTtl: 'TTL data sementara (menit)',
  setSaveTtl: 'Simpan TTL',
  setFirebaseStatus: 'Status Firebase AI Logic',
  setFirebaseOk:
    'Kunci Firebase sudah dikonfigurasi di src/config/firebase.ts. Gemini Nano on-device dan Gemini cloud tersedia lewat Firebase AI Logic SDK.',
  setFirebaseMissing:
    'Kunci Firebase BELUM dikonfigurasi — tempel di src/config/firebase.ts (lihat README "Firebase setup"). Sampai saat itu, MOBIUS berjalan dengan Prompt API bawaan / fallback ekstraktif lokal dan tetap bekerja dengan baik.',
  setLanguage: 'Bahasa',
  setLanguageDesc: 'Berlaku untuk side panel dan bubble.',
  langIndonesian: 'Bahasa Indonesia',
  langEnglish: 'English',
  setChatHistory: 'Riwayat chat',
  setChatHistoryDesc: 'Berapa lama pesan chat disimpan.',
  retention1h: '1 jam',
  retention24h: '24 jam',
  retention7d: '7 hari',
  setSave: 'Simpan',
  histTitle: 'Riwayat & Memori',
  histDesc:
    'Hasil tugas yang diputuskan Core untuk disimpan — hanya lokal, dengan batas waktu. Tidak ada memori yang pernah dikirim ke cloud.',
  histEmpty: 'Belum ada memori tersimpan.',
  histDelete: 'Hapus',
  histClearAll: 'Hapus semua memori',
  histSource: 'sumber',
  histExpires: 'kedaluwarsa',
  logTitle: 'Log Router AI',
  logDesc:
    'Setiap keputusan routing yang dibuat MOBIUS — on-device dulu, cloud hanya bila diizinkan dan dibutuhkan. Diperbarui tiap 3 detik.',
  logEmpty: 'Belum ada keputusan. Tanyakan sesuatu ke MOBIUS dari bubble.',
  logClear: 'Hapus log',
  logCloudAllowed: 'cloud diizinkan',
  logYes: 'ya',
  logNo: 'tidak',
  chatTitle: 'Riwayat Chat',
  chatDesc: 'Pesan yang Anda kirim dari bubble, disimpan di perangkat ini selama masa retensi di Pengaturan.',
  chatEmpty: 'Belum ada pesan chat.',
  chatClear: 'Hapus riwayat chat',
  chatYou: 'Anda',
  bubbleDesc: 'Tanyakan soal halaman ini, atau balas pesan WhatsApp terakhir. Diproses on-device secara default.',
  bubblePlaceholder: 'cth. Ringkas halaman ini / Balas pesan terakhir',
  bubbleAsk: 'Tanya MOBIUS',
  bubblePanel: 'Panel Samping',
  bubbleThinking: 'Berpikir on-device…',
  bubbleNoResponse: 'Tidak ada respons dari inti MOBIUS. Muat ulang halaman dan coba lagi.',
  bubbleTaskFailed: 'Tugas gagal.',
  bubbleUnreachable: 'Tidak bisa menghubungi inti MOBIUS: ',
  bubbleSensitiveTitle: 'Data sensitif ditemukan di pesan Anda: {types}. Belum ada yang dikirim.',
  bubbleSensitiveContinue: 'Tetap lanjut',
  bubbleSensitiveCancel: 'Batal',
  bubbleHistoryLabel: 'Sebelumnya di chat ini',
  skillMatched: 'Skill "{skill}" cocok lewat kata kunci (skor {score}) — dijalankan secara deterministik, lokal.',
  skillDone: 'Selesai: {skill}.',
  skillFailed: 'Skill gagal: {message}',
  skillNoQuery: 'Sebutkan produknya — mis. "cari harga sepatu di Shopee".',
  skillNeedsReadPage: 'Skill ini membaca halaman, jadi butuh izin baca halaman.',
  skillNeedsDomActions: 'Skill ini mengubah halaman (klik / ketik / kirim), jadi butuh izin aksi DOM.',
  setBridge: 'Laptop Bridge (tugas jarak jauh)',
  setBridgeDesc:
    'Terima tugas dari HP Android lewat bridge di laptop. Bridge harus jalan di laptop ini (bridge/bridge.mjs) dan token di bawah harus sama dengan MOBIUS_BRIDGE_TOKEN di laptop + di HP.',
  setBridgeUrl: 'URL bridge',
  setBridgeToken: 'Token bridge',
  setBridgeNote:
    'Token tidak pernah dicatat di log dan hanya dikirim ke URL bridge di atas sebagai header X-Mobius-Token. Bila panel samping terbuka, tugas diambil tiap 3 detik; bila tertutup, tiap 1 menit (batas alarm Chrome). Kosongkan token untuk mematikan bridge.',
  setSaveBridge: 'Simpan pengaturan bridge',
  typeKtp: 'nomor KTP',
  typePhone: 'nomor HP',
  typeAccount: 'nomor rekening',
  typeEmail: 'email',
  typePassword: 'kata sandi',
  awaitingApproval:
    'Menunggu persetujuan: {what}. Tugas ini menunggu persetujuan Tuan di HP. Setelah Tuan menyetujui, laptop akan menjalankannya.',
  awaitingApprovalAt:
    'Menunggu persetujuan: {what} di {url}. Tugas ini menunggu persetujuan Tuan di HP. Setelah Tuan menyetujui, laptop akan menjalankannya.',
  actClickText: 'Klik teks "{text}"',
  actTypeText: 'Ketik "{text}"',
  actSubmit: 'Kirim/submit formulir',
  actNavigate: 'Buka {url}',
  actScroll: 'Scroll halaman',
  actBack: 'Kembali ke halaman sebelumnya',
  actHome: 'Ke halaman utama',
  approvalCardTitle: 'Menunggu persetujuan di HP',
  approvalCardHint:
    'Buka HP untuk menyetujui atau menolak. Di HP kamu bisa memilih untuk mengingat persetujuan ini.',
  approvalCardHintSensitive:
    'Aksi sensitif — buka HP untuk menyetujui atau menolak. Persetujuan ini tidak bisa diingat selamanya.',
  approvalCardAt: 'di {url}',
};

const EN: Record<StringKey, string> = {
  navOnboarding: 'Onboarding',
  navRouterLog: 'Router Log',
  navSettings: 'Settings',
  navHistory: 'History',
  navChat: 'Chat',
  onbWelcome: 'Welcome to MOBIUS',
  onbIntro:
    'MOBIUS runs locally in your browser. On-device AI (Gemini Nano) is the default. Nothing leaves your device unless you explicitly allow Cloud AI below.',
  onbHowItWorks: 'How it works',
  onbSteps:
    '1. Click the floating bubble on any page.\n2. Ask MOBIUS — e.g. "Summarize this page" or, on WhatsApp Web, "Reply to the last message".\n3. MOBIUS drafts on-device, inserts the draft (if DOM actions are on), and logs every AI routing decision in the Router Log tab.',
  gateBubble: 'Floating Bubble Overlay',
  gateReadPage: 'Read Page / DOM Context',
  gateDomActions: 'Cross-App DOM Actions',
  gateMemory: 'Context History / Memory (local, TTL)',
  gateCloudAI: 'Allow Cloud AI (Borrowed Intelligence)',
  explainBubble: 'Show the floating MOBIUS bubble on webpages.',
  explainReadPage: 'Read the active tab text (WhatsApp Web chats, articles) so MOBIUS can use page context.',
  explainDomActions: 'Type / insert replies into web inputs (e.g. the WhatsApp Web message box).',
  explainMemory: 'Store task outcomes locally on this device, with a time limit (TTL).',
  explainCloudAI:
    'Allow Cloud AI (borrowed intelligence). When OFF, MOBIUS never calls the cloud, even if on-device AI is unavailable.',
  denialNeeds: 'This needs "{detail}" — it is currently OFF. Enable it in the MOBIUS Side Panel (Onboarding / Settings) to use this feature.',
  settingsTitle: 'Settings',
  setCloudAI: 'Allow Cloud AI (Borrowed Intelligence)',
  setCloudAIDesc:
    'When OFF (default), MOBIUS never calls the cloud — even if on-device AI is unavailable. Every cloud call is logged in the Router Log.',
  setBubble: 'Floating Bubble',
  setBubbleDesc: 'Show the MOBIUS bubble on webpages.',
  setMemory: 'Memory (local, TTL)',
  setMemoryDesc: 'Store task outcomes on this device only.',
  setEngine: 'AI Engine',
  setEngineDesc:
    'Which intelligence answers. Default "Auto" = Nano on-device first, cloud only if allowed. An explicit engine never silently switches to another one — if it fails, MOBIUS logs it and falls back only to the local extractive summary.',
  setEngineLabel: 'Engine',
  engineAuto: 'Auto (Nano first, cloud if allowed)',
  engineNano: 'Nano on-device only',
  engineCloud: 'Cloud Gemini only (needs "Allow Cloud AI")',
  engineLocal: 'Local server only (e.g. Ollama on this laptop)',
  setLocalBaseUrl: 'Local server base URL',
  setLocalModel: 'Local server model',
  setLocalNote:
    'No model runs inside the browser — the "local server" is a program on your laptop (e.g. Ollama: ollama serve, then ollama pull llama3.1). The extension only calls it over HTTP. If the server is down, MOBIUS says so instead of pretending success.',
  setSaveEngine: 'Save engine settings',
  setSaved: 'Saved.',
  setTtl: 'Time limits (TTL)',
  setTtlDesc: 'Memory entries expire after this many days; temporary subagent data after this many minutes.',
  setMemoryTtl: 'Memory TTL (days)',
  setTempTtl: 'Temporary data TTL (minutes)',
  setSaveTtl: 'Save TTL',
  setFirebaseStatus: 'Firebase AI Logic status',
  setFirebaseOk:
    'Firebase keys are configured in src/config/firebase.ts. On-device Gemini Nano and cloud Gemini are available through the Firebase AI Logic SDK.',
  setFirebaseMissing:
    'Firebase keys are NOT configured yet — paste them into src/config/firebase.ts (see README "Firebase setup"). Until then, MOBIUS runs on the built-in Prompt API / local extractive fallback and degrades gracefully.',
  setLanguage: 'Language',
  setLanguageDesc: 'Applies to the side panel and the bubble.',
  langIndonesian: 'Bahasa Indonesia',
  langEnglish: 'English',
  setChatHistory: 'Chat history',
  setChatHistoryDesc: 'How long chat messages are kept.',
  retention1h: '1 hour',
  retention24h: '24 hours',
  retention7d: '7 days',
  setSave: 'Save',
  histTitle: 'History & Memory',
  histDesc:
    'Task outcomes the Core decided to keep — stored locally only, with a time limit. No memory is ever sent to the cloud.',
  histEmpty: 'No memory stored yet.',
  histDelete: 'Delete',
  histClearAll: 'Clear all memory',
  histSource: 'source',
  histExpires: 'expires',
  logTitle: 'AI Router Log',
  logDesc:
    'Every routing decision MOBIUS makes — on-device first, cloud only when allowed and needed. Refreshes every 3 seconds.',
  logEmpty: 'No decisions yet. Ask MOBIUS something from the bubble.',
  logClear: 'Clear log',
  logCloudAllowed: 'cloud allowed',
  logYes: 'yes',
  logNo: 'no',
  chatTitle: 'Chat History',
  chatDesc: 'Messages you sent from the bubble, kept on this device for the retention period in Settings.',
  chatEmpty: 'No chat messages yet.',
  chatClear: 'Clear chat history',
  chatYou: 'You',
  bubbleDesc: 'Ask about this page, or reply to the last WhatsApp message. Processed on-device by default.',
  bubblePlaceholder: 'e.g. Summarize this page / Reply to the last message',
  bubbleAsk: 'Ask MOBIUS',
  bubblePanel: 'Side Panel',
  bubbleThinking: 'Thinking on-device…',
  bubbleNoResponse: 'No response from the MOBIUS core. Reload the page and try again.',
  bubbleTaskFailed: 'Task failed.',
  bubbleUnreachable: 'Could not reach the MOBIUS core: ',
  bubbleSensitiveTitle: 'Sensitive data found in your message: {types}. Nothing was sent yet.',
  bubbleSensitiveContinue: 'Continue anyway',
  bubbleSensitiveCancel: 'Cancel',
  bubbleHistoryLabel: 'Earlier in this chat',
  skillMatched: 'Skill "{skill}" matched by keyword (score {score}) — running deterministically, locally.',
  skillDone: 'Done: {skill}.',
  skillFailed: 'Skill failed: {message}',
  skillNoQuery: 'Name the product — e.g. "cari harga sepatu di Shopee".',
  skillNeedsReadPage: 'This skill reads the page, so it needs the read-page permission.',
  skillNeedsDomActions: 'This skill changes the page (click / type / submit), so it needs the DOM-actions permission.',
  setBridge: 'Laptop Bridge (remote tasks)',
  setBridgeDesc:
    'Receive tasks from the Android phone via the bridge on this laptop. The bridge must run on this laptop (bridge/bridge.mjs) and the token below must match MOBIUS_BRIDGE_TOKEN on the laptop + the phone.',
  setBridgeUrl: 'Bridge URL',
  setBridgeToken: 'Bridge token',
  setBridgeNote:
    'The token is never logged and is only sent to the bridge URL above as the X-Mobius-Token header. While the side panel is open, tasks are picked up every 3 seconds; while closed, every 1 minute (Chrome alarm limit). Clear the token to turn the bridge off.',
  setSaveBridge: 'Save bridge settings',
  typeKtp: 'ID card number',
  typePhone: 'phone number',
  typeAccount: 'bank account number',
  typeEmail: 'email',
  typePassword: 'password',
  awaitingApproval:
    'Waiting for approval: {what}. This task is waiting for your approval on your phone. Once you approve, the laptop will run it.',
  awaitingApprovalAt:
    'Waiting for approval: {what} on {url}. This task is waiting for your approval on your phone. Once you approve, the laptop will run it.',
  actClickText: 'Click the text "{text}"',
  actTypeText: 'Type "{text}"',
  actSubmit: 'Submit the form',
  actNavigate: 'Open {url}',
  actScroll: 'Scroll the page',
  actBack: 'Go back to the previous page',
  actHome: 'Go to the home page',
  approvalCardTitle: 'Waiting for approval on your phone',
  approvalCardHint:
    'Open your phone to approve or reject. On your phone you can choose to remember this approval.',
  approvalCardHintSensitive:
    'Sensitive action — open your phone to approve or reject. This approval can never be remembered forever.',
  approvalCardAt: 'on {url}',
};

const STRINGS: Record<Lang, Record<StringKey, string>> = { id: ID, en: EN };

let cachedLang: Lang = DEFAULT_LANGUAGE;
let loaded = false;

/** Load the persisted language (call once at startup in each context). */
export async function loadLanguage(): Promise<Lang> {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
    const stored = data[STORAGE_KEYS.settings] as Partial<MobiusSettings> | undefined;
    const lang = stored?.language;
    cachedLang = lang === 'en' || lang === 'id' ? lang : DEFAULT_LANGUAGE;
  } catch {
    cachedLang = DEFAULT_LANGUAGE;
  }
  loaded = true;
  return cachedLang;
}

export function getLang(): Lang {
  return cachedLang;
}

export function isLanguageLoaded(): boolean {
  return loaded;
}

/** Translate a key in the given (or cached) language. Unknown keys fall back to English, then the key itself. */
export function t(key: StringKey, lang: Lang = cachedLang): string {
  return STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
}

/** Fill {placeholders} in a translated string. */
export function tf(key: StringKey, vars: Record<string, string | number>, lang: Lang = cachedLang): string {
  let out = t(key, lang);
  for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, String(v));
  return out;
}

/** Persist the language choice (merge into mobius_settings, never wipe other keys). */
export async function setLanguage(lang: Lang): Promise<void> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const stored = (data[STORAGE_KEYS.settings] as Partial<MobiusSettings> | undefined) ?? {};
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: { ...stored, language: lang } });
  cachedLang = lang;
  loaded = true;
}
