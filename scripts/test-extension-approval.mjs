// MOBIUS v9.1 — approval gate test harness (Node, BUKAN Chrome asli).
//
// Menguji KODE ASLI src/core/Orchestrator.ts + src/core/BridgeClient.ts yang
// dikompilasi dengan TypeScript repo sendiri ke direktori sementara /tmp,
// lalu dijalankan di Node dengan `chrome` global palsu (storage.local /
// session in-memory + model tab palsu). Yang diuji adalah logika keputusan
// gerbang persetujuan + guard eksekusi ganda lewat handleBrowserTask ASLI
// (private di TS, diakses runtime via bracket — sama seperti harness v9),
// BUKAN simulasi ulang logikanya. DOM Chrome asli, content script asli,
// dan chrome.tabs/scripting asli TIDAK tercakup.
//
// Cara jalan (satu perintah, dari root repo):
//   node scripts/test-extension-approval.mjs
// Keluar 0 bila semua kasus PASS, 1 bila ada yang FAIL, 2 bila harness
// sendiri error (kompilasi/import gagal).
//
// Kasus yang dicakup (5 kasus penugasan):
//   1. approved:true TANPA approvalId -> ditolak, 0 aksi.
//   2. approvalId PALSU / fingerprint beda -> ditolak, 0 aksi.
//   3. approvalId yang SAMA dipakai dua kali -> yang kedua ditolak.
//   4. (sisi ekstensi) task approved yang sudah tercatat dieksekusi lalu
//      di-claim ulang (attempts>1) -> ditolak guard "Hasil tidak diketahui,
//      cek manual di laptop", 0 aksi. (Sisi bridge kasus 4 ada di
//      bridge/test-approval-v040.mjs.)
//   5. Alur normal hold -> setuju -> jalan tetap LULUS.
// Plus: fungsi murni (canonicalStringify, fingerprint, isApprovalEntryValid),
// validasi approvalId di parseBrowserTask, dan guard TIDAK false-positive
// pada attempts>1 yang taskId-nya belum pernah dieksekusi.
//
// CATATAN JUJUR: storeApproval / consumeApproval / isBrowserTaskExecuted /
// markBrowserTaskExecuted TIDAK ter-export dari Orchestrator.ts (module-
// private) — jadi tidak bisa dipanggil langsung; semuanya diuji lewat
// handleBrowserTask asli, yang memanggil mereka. Itu justru lebih kuat:
// yang diuji adalah perilaku ujung-ke-ujung gerbangnya, bukan helpernya.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = '/tmp/mobius-approval-test/build';

// ---------------------------------------------------------------------------
// 0. Kompilasi kode asli + perbaiki impor agar bisa di-load Node ESM.
// ---------------------------------------------------------------------------
function build() {
  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(BUILD, { recursive: true });
  execFileSync(
    path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'),
    ['-p', path.join(REPO, 'tsconfig.json'), '--outDir', BUILD, '--declaration', 'false', '--sourceMap', 'false'],
    { cwd: REPO, stdio: 'pipe' },
  );
  // Symlink node_modules agar `firebase/*` (diimpor AIRouter->CloudAI) bisa
  // di-resolve dari /tmp. Bukan dependensi baru — pakai yang sudah ada.
  try {
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(BUILD, 'node_modules'), 'dir');
  } catch { /* sudah ada */ }
  // tsc mode bundler mengeluarkan impor relatif tanpa ekstensi; Node ESM
  // butuh `.js`. Impor JSON butuh `with { type: 'json' }`.
  let rewritten = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        const s = fs.readFileSync(p, 'utf8');
        const s2 = s.replace(/((?:from|import)\s+['"])(\.{1,2}\/[^'"]+)(['"])/g, (m, pre, spec, post) => {
          if (spec.endsWith('.json')) return `${pre}${spec}${post} with { type: 'json' }`;
          if (/\.(js|mjs|cjs)$/.test(spec)) return m;
          return `${pre}${spec}.js${post}`;
        });
        if (s2 !== s) { fs.writeFileSync(p, s2); rewritten++; }
      }
    }
  })(BUILD);
  console.log(`[build] tsc OK -> ${BUILD} (${rewritten} file impor diperbaiki)`);
}

// ---------------------------------------------------------------------------
// 1. Mock `chrome` global (minimal, in-memory).
// ---------------------------------------------------------------------------
const localStore = {};
const sessionStore = {};
const tabActions = []; // aksi yang benar-benar "terkirim" ke tab palsu
const navigations = []; // URL yang benar-benar "dinavigasi"
let fakeTab = { id: 1, url: 'https://example.com', title: 'Example Domain', status: 'complete', active: true, windowId: 1 };
const updatedListeners = new Set();

function storageArea(area) {
  return {
    get: async (keys) => {
      const out = {};
      const list = keys === undefined ? Object.keys(area) : Array.isArray(keys) ? keys : [keys];
      for (const k of list) if (k in area) out[k] = area[k];
      return out;
    },
    set: async (obj) => { Object.assign(area, obj); },
    remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete area[k]; },
    clear: async () => { for (const k of Object.keys(area)) delete area[k]; },
  };
}

function installChromeMock() {
  globalThis.chrome = {
    storage: { local: storageArea(localStore), session: storageArea(sessionStore) },
    tabs: {
      query: async (q) => {
        if (q?.url) return []; // tidak ada tab WhatsApp Web palsu
        return [{ ...fakeTab }];
      },
      get: async (id) => ({ ...fakeTab, id }),
      update: async (id, props) => {
        if (props.url) {
          fakeTab = { ...fakeTab, url: props.url, status: 'complete' };
          navigations.push(props.url);
        }
        for (const l of [...updatedListeners]) l(id, { status: 'complete' });
        return { ...fakeTab };
      },
      create: async (props) => {
        fakeTab = { id: 2, url: props.url ?? '', title: '', status: 'complete', active: true, windowId: 1 };
        if (props.url) navigations.push(props.url);
        return { ...fakeTab };
      },
      sendMessage: async (tabId, msg) => {
        tabActions.push({ tabId, ...msg });
        if (msg.type === 'MOBIUS_TOOL_READ_PAGE') return { ok: true, text: 'teks halaman palsu' };
        return { ok: true };
      },
      onUpdated: {
        addListener: (l) => updatedListeners.add(l),
        removeListener: (l) => updatedListeners.delete(l),
      },
    },
    windows: { update: async () => ({}) },
    scripting: { executeScript: async () => [{ result: null }] },
    runtime: { lastError: undefined, getURL: (p) => `chrome-extension://mock/${p}` },
  };
}

// ---------------------------------------------------------------------------
// 2. Runner kasus.
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, evidence) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${evidence ? ` — ${evidence}` : ''}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}${evidence ? ` — ${evidence}` : ''}`);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const PAYLOAD = {
  type: 'browser_act',
  url: 'https://example.com',
  actions: [
    { tool: 'clickText', text: 'Beli' },
    { tool: 'typeText', text: 'hello' },
  ],
};
const payloadCopy = (over = {}) => JSON.parse(JSON.stringify({ ...PAYLOAD, ...over }));

async function main() {
  build();
  installChromeMock();
  // Izin seperti pengguna yang sudah opt-in (domActions/readPage default OFF).
  localStore.mobius_permissions = { bubble: true, readPage: true, domActions: true, memory: true, cloudAI: false };

  const orchMod = await import(path.join(BUILD, 'src', 'core', 'Orchestrator.js'));
  const bridgeMod = await import(path.join(BUILD, 'src', 'core', 'BridgeClient.js'));
  const { Orchestrator, canonicalStringify, computeBrowserTaskFingerprint, isApprovalEntryValid, APPROVAL_SESSION_KEY, EXECUTED_TASKS_SESSION_KEY, APPROVAL_TTL_MS } = orchMod;
  const { parseBrowserTask, toMobiusTask, postTaskHeartbeat } = bridgeMod;
  const orch = new Orchestrator();
  const run = (task) => orch.handleTask(task); // handleBrowserTask via handleTask (browserTask)
  const parseResult = (res) => { try { return JSON.parse(res.text); } catch { return null; } };
  const resetActionLog = () => { tabActions.length = 0; navigations.length = 0; };
  const sessionApprovals = () => sessionStore[APPROVAL_SESSION_KEY] ?? {};
  const sessionExecuted = () => sessionStore[EXECUTED_TASKS_SESSION_KEY] ?? {};

  console.log('\n== A. Fungsi murni (pure, ter-export) ==');
  check('canonicalStringify: urutan key tidak berpengaruh',
    canonicalStringify({ b: 1, a: { d: 4, c: 3 } }) === canonicalStringify({ a: { c: 3, d: 4 }, b: 1 }),
    `{"b":1,"a":{"d":4,"c":3}} == {"a":{"c":3,"d":4},"b":1}`);
  check('canonicalStringify: undefined di-drop dari object, jadi null di array',
    canonicalStringify({ a: undefined, b: [undefined, 1] }) === '{"b":[null,1]}');
  const fpHold = computeBrowserTaskFingerprint(payloadCopy());
  const fpApproved = computeBrowserTaskFingerprint(payloadCopy({ approved: true }));
  check('fingerprint: field `approved` sengaja dikecualikan (hold == resubmission)',
    fpHold === fpApproved, `fp=${fpHold}`);
  check('fingerprint: aksi berbeda -> fingerprint berbeda',
    computeBrowserTaskFingerprint(payloadCopy({ actions: [{ tool: 'clickText', text: 'Bayar' }] })) !== fpHold);
  check('fingerprint: url berbeda -> fingerprint berbeda',
    computeBrowserTaskFingerprint(payloadCopy({ url: 'https://example.org' })) !== fpHold);
  check('fingerprint: urutan key JSON berbeda -> fingerprint sama',
    computeBrowserTaskFingerprint({ actions: PAYLOAD.actions, url: PAYLOAD.url, type: 'browser_act' }) === fpHold);
  const now = Date.now();
  const entry = { fingerprint: fpHold, expiresAt: now + APPROVAL_TTL_MS };
  check('isApprovalEntryValid: entri cocok + belum kedaluwarsa -> true', isApprovalEntryValid(entry, fpHold, now) === true);
  check('isApprovalEntryValid: entri hilang -> false', isApprovalEntryValid(undefined, fpHold, now) === false);
  check('isApprovalEntryValid: fingerprint beda -> false', isApprovalEntryValid(entry, 'x', now) === false);
  check('isApprovalEntryValid: kedaluwarsa (now == expiresAt) -> false', isApprovalEntryValid(entry, fpHold, entry.expiresAt) === false);
  check('isApprovalEntryValid: kedaluwarsa (now > expiresAt) -> false', isApprovalEntryValid(entry, fpHold, entry.expiresAt + 1) === false);
  check('APPROVAL_TTL_MS = 10 menit', APPROVAL_TTL_MS === 600_000, `APPROVAL_TTL_MS=${APPROVAL_TTL_MS}`);

  console.log('\n== B. parseBrowserTask / toMobiusTask (BridgeClient) ==');
  check('parseBrowserTask: approvalId valid diteruskan',
    parseBrowserTask(JSON.stringify({ ...PAYLOAD, approved: true, approvalId: 'appr-123' }))?.approvalId === 'appr-123');
  check('parseBrowserTask: approvalId string kosong -> undefined (dianggap tidak ada)',
    parseBrowserTask(JSON.stringify({ ...PAYLOAD, approved: true, approvalId: '' }))?.approvalId === undefined);
  check('parseBrowserTask: approvalId >128 karakter -> undefined',
    parseBrowserTask(JSON.stringify({ ...PAYLOAD, approved: true, approvalId: 'x'.repeat(129) }))?.approvalId === undefined);
  check('parseBrowserTask: approvalId bukan string -> undefined',
    parseBrowserTask(JSON.stringify({ ...PAYLOAD, approved: true, approvalId: 123 }))?.approvalId === undefined);
  check('parseBrowserTask: approved harus boolean true (string "true" tidak dihitung)',
    parseBrowserTask(JSON.stringify({ ...PAYLOAD, approved: 'true' }))?.approved === false);
  check('toMobiusTask: attempts diteruskan ke MobiusTask',
    toMobiusTask({ taskId: 't1', text: JSON.stringify(PAYLOAD), source: 'phone', createdAt: 0, attempts: 2 }).attempts === 2);
  check('postTaskHeartbeat: tanpa konfigurasi bridge -> false, tidak throw',
    (await postTaskHeartbeat('t1')) === false);

  console.log('\n== KASUS 1: approved:true TANPA approvalId -> ditolak, 0 aksi ==');
  resetActionLog();
  const r1 = parseResult(await run({ id: 't-case1', intent: 'browser', input: '', browserTask: payloadCopy({ approved: true }), attempts: 1 }));
  check('status failed + pesan "approval tidak valid atau sudah dipakai"',
    r1?.status === 'failed' && r1?.message === 'approval tidak valid atau sudah dipakai', `status=${r1?.status} message=${r1?.message}`);
  check('0 langkah dieksekusi (steps kosong)', eq(r1?.steps, []), `steps=${JSON.stringify(r1?.steps)}`);
  check('0 aksi ke tab (tidak ada navigasi/klik/ketik)', tabActions.length === 0 && navigations.length === 0,
    `tabActions=${tabActions.length} navigations=${navigations.length}`);

  console.log('\n== KASUS 2a: approvalId PALSU (tidak pernah disimpan) -> ditolak, 0 aksi ==');
  resetActionLog();
  const r2a = parseResult(await run({ id: 't-case2a', intent: 'browser', input: '', browserTask: payloadCopy({ approved: true, approvalId: 'appr-palsu-tidak-pernah-ada' }), attempts: 1 }));
  check('status failed + pesan approval tidak valid',
    r2a?.status === 'failed' && r2a?.message === 'approval tidak valid atau sudah dipakai', `status=${r2a?.status}`);
  check('0 aksi ke tab', tabActions.length === 0 && navigations.length === 0, `tabActions=${tabActions.length}`);

  console.log('\n== KASUS 2b: approvalId ASLI tapi fingerprint beda -> ditolak, 0 aksi, entri TETAP ada ==');
  resetActionLog();
  const hold2b = parseResult(await run({ id: 't-case2b-hold', intent: 'browser', input: '', browserTask: payloadCopy(), attempts: 1 }));
  const id2b = hold2b?.approvalId;
  check('hold mengembalikan approvalId', typeof id2b === 'string' && id2b.length > 0, `approvalId=${id2b}`);
  resetActionLog();
  const r2b = parseResult(await run({ id: 't-case2b-resubmit', intent: 'browser', input: '',
    browserTask: payloadCopy({ approved: true, approvalId: id2b, actions: [{ tool: 'clickText', text: 'Bayar' }] }), attempts: 1 }));
  check('status failed + pesan approval tidak valid (aksi diubah)',
    r2b?.status === 'failed' && r2b?.message === 'approval tidak valid atau sudah dipakai', `status=${r2b?.status}`);
  check('0 aksi ke tab', tabActions.length === 0 && navigations.length === 0, `tabActions=${tabActions.length}`);
  check('entri approval TETAP tersimpan setelah fingerprint mismatch (ponsel boleh kirim ulang yang benar)',
    sessionApprovals()[id2b]?.fingerprint === fpHold, `entry masih ada: ${id2b in sessionApprovals()}`);
  // Bukti entri masih bisa dipakai: kirim ulang payload yang BENAR dengan id yang sama -> harus jalan.
  resetActionLog();
  const r2bFix = parseResult(await run({ id: 't-case2b-fix', intent: 'browser', input: '', browserTask: payloadCopy({ approved: true, approvalId: id2b }), attempts: 1 }));
  check('kirim ulang payload BENAR dengan id yang sama -> done (entri memang dipertahankan)',
    r2bFix?.status === 'done', `status=${r2bFix?.status}`);
  check('aksi benar-benar jalan (navigate + clickText + typeText)',
    navigations.length === 1 && tabActions.map((a) => a.type).join(',') === 'MOBIUS_TOOL_CLICK_TEXT,MOBIUS_TOOL_TYPE_TEXT',
    `navigations=${JSON.stringify(navigations)} tabActions=${JSON.stringify(tabActions.map((a) => a.type))}`);

  console.log('\n== KASUS 5: alur normal hold -> setuju -> jalan ==');
  resetActionLog();
  const hold5 = parseResult(await run({ id: 't-case5-hold', intent: 'browser', input: '', browserTask: payloadCopy(), attempts: 1 }));
  const id5 = hold5?.approvalId;
  check('hold -> status awaiting_approval', hold5?.status === 'awaiting_approval', `status=${hold5?.status}`);
  check('hold -> approvalId diberikan + pendingActions berisi 2 aksi mutating',
    typeof id5 === 'string' && id5.length > 0 && hold5?.pendingActions?.length === 2,
    `approvalId=${id5} pendingActions=${JSON.stringify(hold5?.pendingActions?.map((p) => p.tool))}`);
  check('hold -> 0 aksi jalan, tab tidak berubah', tabActions.length === 0 && navigations.length === 0, `tabActions=${tabActions.length}`);
  check('hold -> entri tersimpan di session dengan fingerprint cocok + expiresAt ~+10 menit',
    sessionApprovals()[id5]?.fingerprint === fpHold &&
    sessionApprovals()[id5]?.expiresAt > Date.now() &&
    sessionApprovals()[id5]?.expiresAt <= Date.now() + APPROVAL_TTL_MS,
    `expiresAt=${sessionApprovals()[id5]?.expiresAt}`);
  resetActionLog();
  const r5 = parseResult(await run({ id: 't-case5-run', intent: 'browser', input: '', browserTask: payloadCopy({ approved: true, approvalId: id5 }), attempts: 1 }));
  check('resubmission approved -> status done', r5?.status === 'done', `status=${r5?.status} message=${r5?.message}`);
  check('semua langkah OK (navigate + 2 aksi)', r5?.steps?.length === 3 && r5.steps.every((s) => s.ok),
    `steps=${JSON.stringify(r5?.steps?.map((s) => s.tool + ':' + s.ok))}`);
  check('navigasi + klik + ketik benar-benar terkirim ke tab',
    navigations.length === 1 && navigations[0] === 'https://example.com' &&
    tabActions.map((a) => a.type).join(',') === 'MOBIUS_TOOL_CLICK_TEXT,MOBIUS_TOOL_TYPE_TEXT',
    `navigations=${JSON.stringify(navigations)}`);
  check('approvalId sudah DIHAPUS dari session setelah dipakai (single-use)',
    !(id5 in sessionApprovals()), `masih ada: ${id5 in sessionApprovals()}`);
  check('taskId dicatat sebagai executed SEBELUM/SESUDAH jalan (guard punya jejak)',
    typeof sessionExecuted()['t-case5-run'] === 'number', `executed=${JSON.stringify(sessionExecuted())}`);

  console.log('\n== KASUS 3: approvalId yang SAMA dipakai dua kali -> yang kedua ditolak ==');
  resetActionLog();
  const r3 = parseResult(await run({ id: 't-case3-replay', intent: 'browser', input: '', browserTask: payloadCopy({ approved: true, approvalId: id5 }), attempts: 1 }));
  check('replay -> status failed + pesan approval tidak valid atau sudah dipakai',
    r3?.status === 'failed' && r3?.message === 'approval tidak valid atau sudah dipakai', `status=${r3?.status}`);
  check('replay -> 0 aksi ke tab', tabActions.length === 0 && navigations.length === 0, `tabActions=${tabActions.length}`);

  console.log('\n== KASUS 4 (sisi ekstensi): task approved sudah dieksekusi, di-claim ulang attempts=2 -> guard menolak ==');
  // Skenario: approval baru yang valid untuk payload P2, tapi taskId-nya
  // sudah tercatat executed (dari kasus 5) -> consume lolos, guard menolak.
  const P2 = payloadCopy({ url: 'https://example.org', actions: [{ tool: 'clickText', text: 'Beli2' }] });
  resetActionLog();
  const hold4 = parseResult(await run({ id: 't-case4-hold', intent: 'browser', input: '', browserTask: P2, attempts: 1 }));
  const id4 = hold4?.approvalId;
  check('hold P2 -> awaiting_approval + approvalId', hold4?.status === 'awaiting_approval' && typeof id4 === 'string', `approvalId=${id4}`);
  resetActionLog();
  const r4 = parseResult(await run({ id: 't-case5-run', intent: 'browser', input: '', browserTask: { ...P2, approved: true, approvalId: id4 }, attempts: 2 }));
  check('re-claim attempts=2 taskId sudah executed -> failed "Hasil tidak diketahui, cek manual di laptop"',
    r4?.status === 'failed' && r4?.message === 'Hasil tidak diketahui, cek manual di laptop', `status=${r4?.status} message=${r4?.message}`);
  check('guard -> 0 aksi ke tab (tidak ada eksekusi ulang)', tabActions.length === 0 && navigations.length === 0, `tabActions=${tabActions.length}`);
  check('guard -> approval tetap ter-consume (sudah dihapus) meski guard menolak',
    !(id4 in sessionApprovals()), `masih ada: ${id4 in sessionApprovals()}`);

  console.log('\n== KASUS 4b (kontrol guard): attempts=2 tapi taskId BARU -> TIDAK diblokir ==');
  const P3 = payloadCopy({ url: 'https://example.net', actions: [{ tool: 'clickText', text: 'OK' }] });
  resetActionLog();
  const hold4b = parseResult(await run({ id: 't-case4b-hold', intent: 'browser', input: '', browserTask: P3, attempts: 1 }));
  const id4b = hold4b?.approvalId;
  resetActionLog();
  const r4b = parseResult(await run({ id: 't-case4b-run-BARU', intent: 'browser', input: '', browserTask: { ...P3, approved: true, approvalId: id4b }, attempts: 2 }));
  check('attempts=2 + taskId baru -> done (guard tidak false-positive)',
    r4b?.status === 'done', `status=${r4b?.status} message=${r4b?.message}`);
  check('aksi jalan', navigations.length === 1 && tabActions.length === 1, `navigations=${navigations.length} tabActions=${tabActions.length}`);

  console.log(`\n==== RINGKASAN: ${passed} PASS, ${failed} FAIL ====`);
  if (failed > 0) {
    console.log('GAGAL: ' + failures.join(' | '));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('[harness-error]', e);
  process.exit(2);
});
