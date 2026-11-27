// MOBIUS bridge v0.4.0 — live test: heartbeat + no-requeue tugas approved.
//
// Menjalankan bridge.mjs ASLI sebagai child process (token palsu
// test-token-123, root /tmp sementara, LEASE_MS kecil agar cepat), lalu
// menguji lewat HTTP sungguhan. Server dimatikan + root /tmp dihapus
// setelah tes.
//
// Cara jalan (satu perintah, dari root repo):
//   node bridge/test-approval-v040.mjs
// Keluar 0 bila semua kasus PASS, 1 bila ada yang FAIL, 2 bila harness
// sendiri error (server tidak mau start, dsb).
//
// Kasus yang dicakup (5 kasus penugasan):
//   4. (sisi bridge) Task approved: lease habis setelah aksi mutating ->
//      status 'failed' "Hasil tidak diketahui, cek manual di laptop" dan
//      TIDAK PERNAH muncul lagi di /bridge/tasks/next (tidak direqueue).
// Plus regresi + heartbeat:
//   - heartbeat memperpanjang lease tugas running (masih running setelah
//     lease awal habis; setelah lease baru habis, tugas BIASA kembali queued)
//   - heartbeat: unknown -> 404, bukan running -> 409, tanpa token -> 401,
//     token salah -> 401
//   - tugas biasa tetap direqueue sampai MAX_ATTEMPTS=3 lalu expired
//   - result kedua ke tugas done -> 409; result ke tugas expired -> 410
//
// Server di-restart antar kelompok skenario supaya antrean in-memory
// selalu bersih (tidak ada kontaminasi antar kelompok).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'bridge.mjs');
const TOKEN = 'test-token-123';
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-test-root-v040-'));

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, p, body, token = TOKEN) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) headers['X-Mobius-Token'] = token;
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* bukan JSON */ }
  return { status: res.status, json };
}

let server = null;
async function startServer() {
  server = spawn('node', [BRIDGE, '--port', String(PORT), '--root', ROOT], {
    env: { ...process.env, MOBIUS_BRIDGE_TOKEN: TOKEN, MOBIUS_BRIDGE_LEASE_MS: '5000', MOBIUS_BRIDGE_SWEEP_MS: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write('[bridge] ' + d));
  server.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write('[bridge:err] ' + d));
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(BASE + '/health');
      if (res.ok) {
        const h = await res.json();
        console.log(`[server] start OK: ${BASE} version=${h.version}`);
        return;
      }
    } catch { /* belum siap */ }
    if (Date.now() > deadline) throw new Error('bridge tidak mau start dalam 10 dtk');
    await sleep(200);
  }
}
async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  s.kill('SIGTERM');
  await Promise.race([new Promise((r) => s.on('exit', r)), sleep(3000).then(() => s.kill('SIGKILL'))]);
  await sleep(300);
}

async function postTask(text, extra = {}) {
  const r = await req('POST', '/task', { text, source: 'test-approval-v040', ...extra });
  if (r.status !== 202) throw new Error(`POST /task gagal: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.taskId;
}
async function claimNext() {
  const r = await req('GET', '/bridge/tasks/next');
  if (r.status !== 200) throw new Error(`GET /next gagal: ${r.status}`);
  return r.json.task;
}
async function getTask(id) {
  const r = await req('GET', `/task/${id}`);
  if (r.status !== 200) throw new Error(`GET /task gagal: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

async function main() {
  console.log(`[test] bridge=${BRIDGE}\n[test] root=${ROOT} port=${PORT} LEASE_MS=5000 SWEEP_MS=1000`);

  // ---- A. Heartbeat memperpanjang lease (tugas biasa) ----
  console.log('\n== A. Heartbeat memperpanjang lease ==');
  await startServer();
  const hbId = await postTask('tugas heartbeat');
  const hbClaim = await claimNext();
  check('A1 claim ke-1: attempts=1', hbClaim?.taskId === hbId && hbClaim?.attempts === 1,
    `taskId=${hbClaim?.taskId?.slice(0, 8)} attempts=${hbClaim?.attempts}`);
  check('A2 claim kedua: null (tidak dikirim dua kali)', (await claimNext()) === null);
  await sleep(3000); // lease awal 5 dtk: tersisa ~2 dtk
  const hb = await req('POST', `/bridge/tasks/${hbId}/heartbeat`, {});
  check('A3 heartbeat -> 200 + leaseExpiresAt baru (~now+5000)',
    hb.status === 200 && hb.json?.status === 'running' &&
    typeof hb.json?.leaseExpiresAt === 'number' && hb.json.leaseExpiresAt > Date.now() + 3000,
    `status=${hb.status} leaseExpiresAt=${hb.json?.leaseExpiresAt}`);
  await sleep(3000); // total 6 dtk > lease awal 5 dtk
  const hbStill = await getTask(hbId);
  check('A4 setelah 6 dtk (lease awal habis): MASIH running berkat heartbeat',
    hbStill.status === 'running' && hbStill.attempts === 1, `status=${hbStill.status}`);
  await sleep(6000); // total 12 dtk > lease hasil heartbeat (~8 dtk)
  const hbBack = await getTask(hbId);
  check('A5 setelah lease heartbeat habis: tugas BIASA kembali queued (regresi requeue)',
    hbBack.status === 'queued' && hbBack.attempts === 1, `status=${hbBack.status}`);
  // Bersihkan antrean: claim + selesaikan, supaya kelompok berikut bersih.
  const hbReclaim = await claimNext();
  check('A6 re-claim tugas biasa: attempts=2', hbReclaim?.taskId === hbId && hbReclaim?.attempts === 2, `attempts=${hbReclaim?.attempts}`);
  const hbDone = await req('POST', `/bridge/tasks/${hbId}/result`, { status: 'done', result: 'beres' });
  check('A7 result done -> 200', hbDone.status === 200 && hbDone.json?.status === 'done', `status=${hbDone.status}`);
  const hbDone2 = await req('POST', `/bridge/tasks/${hbId}/result`, { status: 'done', result: 'lagi' });
  check('A8 result kedua ke tugas done -> 409', hbDone2.status === 409, `status=${hbDone2.status}`);

  console.log('\n== A2. Error cases heartbeat ==');
  const e1 = await req('POST', `/bridge/tasks/${hbId}/heartbeat`, {}, null);
  check('E1 heartbeat tanpa token -> 401', e1.status === 401, `status=${e1.status}`);
  const e2 = await req('POST', `/bridge/tasks/${hbId}/heartbeat`, {}, 'token-salah');
  check('E2 heartbeat token salah -> 401', e2.status === 401 && e2.json?.error === 'invalid token', `status=${e2.status}`);
  const e3 = await req('POST', '/bridge/tasks/id-tidak-ada/heartbeat', {});
  check('E3 heartbeat unknown id -> 404', e3.status === 404, `status=${e3.status}`);
  const e4 = await req('POST', `/bridge/tasks/${hbId}/heartbeat`, {});
  check('E4 heartbeat ke tugas done -> 409 pesan requeue', e4.status === 409 &&
    e4.json?.error === 'task is not running (it was requeued or already finished)', `status=${e4.status}`);
  const queuedId = await postTask('tugas queued untuk heartbeat');
  const e5 = await req('POST', `/bridge/tasks/${queuedId}/heartbeat`, {});
  check('E5 heartbeat ke tugas queued (belum running) -> 409', e5.status === 409, `status=${e5.status}`);
  await stopServer();

  // ---- B. KASUS 4 (sisi bridge): task approved, lease habis -> failed, TIDAK direqueue ----
  console.log('\n== KASUS 4 (sisi bridge): task approved lease habis -> failed, tidak direqueue ==');
  await startServer();
  const approvedText = JSON.stringify({
    type: 'browser_act', url: 'https://example.com',
    actions: [{ tool: 'clickText', text: 'Beli' }],
    approved: true, approvalId: 'appr-123',
  });
  const apId = await postTask(approvedText, { approvalId: 'appr-123' });
  check('B1 POST task approved diterima (202)', typeof apId === 'string' && apId.length > 0, `taskId=${apId.slice(0, 8)}`);
  const apClaim = await claimNext();
  check('B2 claim: attempts=1 + approvalId di-echo', apClaim?.taskId === apId && apClaim?.attempts === 1 && apClaim?.approvalId === 'appr-123',
    `attempts=${apClaim?.attempts} approvalId=${apClaim?.approvalId}`);
  await sleep(7000); // lease 5 dtk + sweep 1 dtk
  const apAfter = await getTask(apId);
  check('B3 setelah lease habis: status failed (BUKAN queued)',
    apAfter.status === 'failed', `status=${apAfter.status} attempts=${apAfter.attempts}`);
  check('B4 result = "Hasil tidak diketahui, cek manual di laptop"',
    apAfter.result === 'Hasil tidak diketahui, cek manual di laptop', `result=${JSON.stringify(apAfter.result)}`);
  check('B5 attempts tetap 1 (tidak pernah dicoba ulang)', apAfter.attempts === 1, `attempts=${apAfter.attempts}`);
  check('B6 /bridge/tasks/next -> task null (TIDAK muncul lagi di antrean)',
    (await claimNext()) === null);
  await sleep(7000); // satu siklus lease lagi — pastikan tetap tidak muncul
  check('B7 setelah 7 dtk lagi: tetap tidak muncul di /next + status tetap failed',
    (await claimNext()) === null && (await getTask(apId)).status === 'failed');
  const apHb = await req('POST', `/bridge/tasks/${apId}/heartbeat`, {});
  check('B8 heartbeat ke tugas approved yang sudah failed -> 409', apHb.status === 409, `status=${apHb.status}`);
  const apResult = await req('POST', `/bridge/tasks/${apId}/result`, { status: 'done', result: 'terlambat' });
  check('B9 result terlambat ke tugas failed -> 409', apResult.status === 409, `status=${apResult.status}`);
  await stopServer();

  // ---- C. Regresi: tugas biasa tetap direqueue sampai 3x lalu expired ----
  console.log('\n== C. Regresi: tugas biasa direqueue (max 3 attempts) ==');
  await startServer();
  const plId = await postTask('tugas biasa regresi');
  const c1 = await claimNext();
  check('C1 claim ke-1 attempts=1', c1?.taskId === plId && c1?.attempts === 1, `attempts=${c1?.attempts}`);
  await sleep(7000);
  const c1q = await getTask(plId);
  check('C2 lease habis -> kembali queued attempts=1', c1q.status === 'queued' && c1q.attempts === 1, `status=${c1q.status}`);
  const c2 = await claimNext();
  check('C3 claim ke-2 attempts=2', c2?.taskId === plId && c2?.attempts === 2, `attempts=${c2?.attempts}`);
  const late = await req('POST', `/bridge/tasks/${plId}/result`, { status: 'done', result: 'x' });
  check('C4 result saat running (sebelum lease habis) -> 200 (bukan 409)', late.status === 200, `status=${late.status}`);
  const c2done = await getTask(plId);
  check('C5 setelah result done: status done + result utuh', c2done.status === 'done' && c2done.result === 'x', `status=${c2done.status}`);
  // Siklus penuh sampai expired (tugas baru).
  const exId = await postTask('tugas biasa sampai expired');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const cl = await claimNext();
    check(`C6.${attempt} claim ke-${attempt} attempts=${attempt}`, cl?.taskId === exId && cl?.attempts === attempt, `attempts=${cl?.attempts}`);
    await sleep(7000);
  }
  const exAfter = await getTask(exId);
  check('C7 setelah 3x lease habis: status expired attempts=3', exAfter.status === 'expired' && exAfter.attempts === 3,
    `status=${exAfter.status} attempts=${exAfter.attempts}`);
  const exResult = await req('POST', `/bridge/tasks/${exId}/result`, { status: 'done', result: 'x' });
  check('C8 result ke tugas expired -> 410', exResult.status === 410, `status=${exResult.status}`);
  const exNext = await claimNext();
  check('C9 /next kosong setelah expired', exNext === null);
  const noAuth = await req('POST', '/task', { text: 'x' }, null);
  check('C10 POST /task tanpa token -> 401', noAuth.status === 401, `status=${noAuth.status}`);
  await stopServer();

  console.log(`\n==== RINGKASAN: ${passed} PASS, ${failed} FAIL ====`);
  if (failed > 0) {
    console.log('GAGAL: ' + failures.join(' | '));
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error('[harness-error]', e);
    process.exitCode = 2;
  })
  .finally(async () => {
    await stopServer();
    fs.rmSync(ROOT, { recursive: true, force: true });
    console.log(`[test] root ${ROOT} dihapus; server mati.`);
  });
