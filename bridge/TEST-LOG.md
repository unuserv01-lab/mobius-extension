# MOBIUS v6 bridge — TEST LOG

Tanggal: 24 Nov 2026, ~11:48 WIB. Node v24.22.1. Token tes: `test-token-123`
(token palsu yang jelas, hanya untuk tes — bukan token sungguhan).
Root tes: `/tmp/mobius-test-root` (dihapus setelah tes).
Server dimatikan setelah pengujian; tidak ada server yang dibiarkan berjalan.

## 1. Start tanpa token → menolak start (PASS)

```
$ node bridge.mjs
[mobius-bridge] FATAL: MOBIUS_BRIDGE_TOKEN is not set.
  Set it before starting, e.g.:
    MOBIUS_BRIDGE_TOKEN=change-me-<random-string> node bridge.mjs
```

## 2. Start dengan token (PASS)

```
$ MOBIUS_BRIDGE_TOKEN=test-token-123 node bridge.mjs --port 8787 --root /tmp/mobius-test-root
[mobius-bridge] v0.1.0 listening on http://127.0.0.1:8787
[mobius-bridge] root: /tmp/mobius-test-root
[mobius-bridge] mode: localhost only (127.0.0.1)
[mobius-bridge] auth: X-Mobius-Token required on all endpoints except GET /health
```

## 3. Hasil curl (semua PASS)

| # | Cek | Hasil |
| --- | --- | --- |
| 1 | `GET /health` tanpa auth | `{"ok":true,"version":"0.1.0","time":"2026-11-24T04:48:52.255Z"}` |
| 2 | `POST /exec` tanpa token | `401 {"ok":false,"error":"missing X-Mobius-Token header"}` |
| 3 | `POST /exec {"command":"node","args":["--version"]}` | `{"stdout":"v24.22.1\n","stderr":"","exitCode":0,"timedOut":false}` |
| 4 | `POST /exec {"command":"pwd","args":[]}` | `{"stdout":"/tmp/mobius-test-root\n",...,"exitCode":0}` |
| 5 | `POST /exec {"command":"rm","args":["-rf","/"]}` | `403 rejected: command not on the allowlist: rm ...` |
| 6 | `POST /exec {"command":"curl","args":["http://example.com"]}` | `403 rejected: command not on the allowlist: curl ...` |
| 7 | `POST /exec {"command":"ls","args":["-l; rm -rf /"]}` | `403 rejected: shell metacharacters are not allowed ...` |
| 8 | `POST /exec {"command":"git","args":["push"]}` | `403 rejected: only "git status\|log\|diff\|branch" are allowed ...` |
| 9 | `POST /write {"path":"hello.txt","content":"halo mobius v6"}` | `{"bytesWritten":14}` |
| 10 | `POST /read {"path":"hello.txt"}` | `{"content":"halo mobius v6"}` |
| 11 | `POST /read {"path":"../../etc/passwd"}` | `403 path must be inside the allowed root: /tmp/mobius-test-root` |
| 12 | `POST /write {"path":"../escape.txt","content":"x"}` | `403 path must be inside the allowed root: /tmp/mobius-test-root` |
| 13 | `POST /task {"text":"ringkas halaman ini","source":"phone-test"}` | `{"accepted":true,"taskId":"b59bf734-e8e2-4605-81af-5996f3a8cac9"}` |
| 14 | `GET /task/b59bf734-...` | `{"taskId":"...","status":"queued"}` |
| 15 | `GET /bridge/tasks/next` (extension poll) | `{"task":{"taskId":"...","text":"ringkas halaman ini","source":"phone-test","createdAt":1795495732552}}` |
| 16 | `GET /bridge/tasks/next` kedua | `{"task":null}` (tugas sudah di-claim, tidak dikirim dua kali) |
| 17 | `POST /bridge/tasks/<id>/result {"status":"done","result":"ringkasan: ini halaman tes"}` | `{"taskId":"...","status":"done"}` |
| 18 | `GET /task/<id>` | `{"taskId":"...","status":"done","result":"ringkasan: ini halaman tes"}` |
| 19 | `GET /task/nope-123` | `404 {"ok":false,"error":"unknown task id"}` |

## 4. Cek tambahan (PASS)

- `--help` mencetak usage dan keluar 0.
- `--lan` di port 8788: log `listening on http://0.0.0.0:8788`, mode
  `LAN (0.0.0.0 — same Wi-Fi only, NEVER port-forward)`, `/health` menjawab.
- `ls -l` di root `~/workspace/mobius-extension` (bukan repo git):
  `exitCode 0`, listing lengkap dikembalikan.
- `git status --short` di direktori yang sama: perintah **dijalankan**
  (allowlist lolos), git sendiri menjawab
  `fatal: not a git repository ...` dengan `exitCode 128` — perilaku benar:
  bridge mengembalikan output git apa adanya, bukan error HTTP.
- Setelah `kill`, `curl /health` gagal konek — server benar-benar mati.

## Yang TIDAK dites (butuh perangkat Tuan)

- Round-trip sungguhan HP → bridge → extension Chrome → HP (butuh laptop
  Tuan + HP Android + extension yang sudah punya client bridge).
- `--lan` dari perangkat lain di Wi-Fi yang sama (hanya bind address yang
  diverifikasi, bukan koneksi antar-perangkat).
- Perintah `/exec` yang timeout 30 detik (kill-on-timeout belum dieksekusi
  live; jalurnya ada di kode — `spawn` timeout + `SIGKILL` — tapi tidak ada
  perintah allowlist yang wajar berjalan >30 dtk untuk mengujinya).
- Kedaluwarsa tugas 10 menit (logika sweep ada + interval 30 dtk, belum
  ditunggu live 10 menit).

---

# v8 — Lease/recovery + regression (25 Nov 2026, ~12:46 WIB)

Node v24.22.1. Token tes: `test-token-123` (palsu, hanya untuk tes).
Root tes: `/tmp/mobius-test-root-v8` (dihapus setelah tes). Server dimatikan
setelah pengujian; tidak ada server yang dibiarkan berjalan.
Perubahan yang dites: bridge v0.2.0 — lease 60 detik, maks 3 percobaan,
requeue saat lease habis, `409` untuk result pada tugas yang tidak `running`,
`attempts` di semua respons tugas. Knob tes (hanya untuk tes):
`MOBIUS_BRIDGE_LEASE_MS=2000` + `MOBIUS_BRIDGE_SWEEP_MS=1000` di server B.

## A. Regresi alur tugas asli (timing default, port 8789) — semua PASS

| # | Cek | Hasil |
| --- | --- | --- |
| A1 | `GET /health` | `{"ok":true,"version":"0.2.0",...}` |
| A2 | `POST /exec` tanpa token | `401` |
| A3 | `POST /exec {"command":"rm","args":["-rf","/"]}` | `403 rejected: command not on the allowlist: rm ...` |
| R13 | `POST /task {"text":"ringkas halaman ini","source":"phone-test"}` | `{"accepted":true,"taskId":"efb7a592-..."}` |
| R14 | `GET /task/<id>` | `{"status":"queued","attempts":0}` |
| R15 | `GET /bridge/tasks/next` | task + `"attempts":1` |
| R16 | `GET /bridge/tasks/next` kedua | `{"task":null}` |
| R17 | `POST /bridge/tasks/<id>/result {"status":"done","result":"ringkasan: ini halaman tes"}` | `{"status":"done"}` |
| R18 | `GET /task/<id>` | `{"status":"done","attempts":1,"result":"ringkasan: ini halaman tes"}` |
| R19 | `GET /task/nope-123` | `404` |

## B. Lease/recovery (lease 2 dtk, sweep 1 dtk, port 8787) — semua PASS

| # | Cek | Hasil |
| --- | --- | --- |
| L1 | `POST /task {"text":"tugas lease"}` | `accepted`, taskId `06cdf191-...` |
| L2 | `GET /bridge/tasks/next` (claim ke-1) | task, `"attempts":1` |
| L3 | `GET /bridge/tasks/next` lagi | `{"task":null}` (tidak dikirim dua kali) |
| L4 | Tunggu 4 dtk (lease 2 dtk + sweep 1 dtk) → `GET /task/<id>` | `{"status":"queued","attempts":1}` — kembali ke antrean |
| L5 | `POST result` ke tugas yang sudah di-requeue | `409` |
| L6 | Claim ke-2 → tunggu 4 dtk | `"attempts":2`, lalu `{"status":"queued","attempts":2}` |
| L7 | Claim ke-3 (`"attempts":3`) → tunggu 4 dtk | `{"status":"expired","attempts":3}` — maks 3 percobaan |
| L8a | `POST result` ke tugas expired | `410` |
| L8b | Tugas baru: claim → result `done` → `GET` | `{"status":"done","attempts":1,"result":"beres"}`; result kedua → `409` |

Startup log server B mengonfirmasi konfigurasi baru:
`tasks: 10-min TTL, 60 s lease, max 3 attempts (requeue on lease expiry)`.
Setelah `kill`, `curl /health` gagal konek — server benar-benar mati.

## Yang TIDAK dites (butuh perangkat Tuan — sama seperti v6)

- Round-trip sungguhan HP → bridge → extension Chrome → HP (butuh laptop
  Tuan + HP Android + extension v8 yang sudah punya client bridge).
- Lease 60 detik dengan timing produksi (tes di atas memakai knob 2 dtk;
  logika sweep yang sama, tapi durasi produksi belum ditunggu live).
- TTL 10 menit penuh (belum ditunggu live 10 menit).

---

# v9 — Browser takeover + open+show (26 Nov 2026, ~02:40 WIB)

Node v24.22.1. Token tes: `test-token-123` (palsu, hanya untuk tes).
Root tes: `/tmp/mobius-test-root-v9` (dihapus setelah tes).
Server dimatikan setelah pengujian; tidak ada server yang dibiarkan berjalan.
Perubahan yang dites: bridge v0.2.0 (tidak berubah dari v8) membawa task
`browser_*` sebagai teks JSON; eksekusi di extension
(`Orchestrator.handleBrowserTask` + `WebSkillTools`, kontrak di
bridge/README.md "Browser takeover tasks (v9)").

## A. Regresi (server asli + curl) — 30/30 PASS

Diulang penuh dari TEST-LOG v6 + v8, semua lolos:
- v6 (12 cek): health, auth 401, exec node --version / pwd, rm/curl/metachar/
  git-push ditolak 403, read/write + traversal 403.
- v8 (9 cek): POST /task accepted, GET queued attempts 0, claim attempts 1,
  claim kedua null, result done, GET done + result, unknown task 404.
- v8 lease (9 cek, lease 2 dtk / sweep 1 dtk): claim ke-1, claim lagi null,
  kembali queued setelah lease habis, result ke tugas requeue -> 409,
  claim ke-2 queued attempts 2, claim ke-3 -> expired attempts 3,
  result ke expired -> 410, tugas baru claim -> done -> result kedua 409.
- Server A (port 8789) dan B (port 8787) dikonfirmasi mati setelah kill.

## B. Transport takeover di bridge (server asli + curl) — 2/2 PASS

| # | Cek | Hasil |
| --- | --- | --- |
| T1 | POST /task teks JSON `browser_act`, lalu GET /bridge/tasks/next | task ter-claim dengan teks JSON utuh (`browser_act` + url + actions) |
| T2 | POST result JSON `awaiting_approval`, lalu GET /task/:id | status `done`, result JSON `awaiting_approval` kembali utuh |

## C. Logika takeover extension (harness Node, BUKAN Chrome asli) — 16/16 PASS

Kode TypeScript ekstensi ASLI (`Orchestrator.ts` + `WebSkillTools.ts` +
`BridgeClient.ts`, dibundle dari `src/`) dijalankan di Node v24 dengan
`chrome` global palsu + model tab palsu (halaman example.com, artikel,
devpost.com: judul + teks + elemen). Yang diuji: logika keputusan
(approval gate, permission gate, validasi, urutan langkah, bentuk result
JSON, tab tetap terbuka). Yang TIDAK diuji di sini: DOM Chrome asli,
content script asli, `chrome.tabs`/`chrome.scripting` asli.

| # | Kasus | Hasil |
| --- | --- | --- |
| a | Teks biasa -> tugas chat v8 (intent `chat`, tanpa `browserTask`) | PASS |
| a2 | JSON rusak -> chat | PASS |
| a3 | Type `browser_*` tak dikenal -> chat, tidak dieksekusi | PASS |
| a4 | Parse `browser_act` OK, `approved` default false | PASS |
| b | `browser_navigate` example.com -> done, url + title cocok, tab tetap terbuka di halaman itu | PASS |
| open+show | `browser_navigate` devpost.com -> done, url + title cocok, tab tetap terbuka | PASS |
| c | `browser_read` artikel -> done + teks isi | PASS |
| d | `browser_act` read-only tanpa approved -> done (3 langkah OK) | PASS |
| e | `browser_act` mutating TANPA approved -> `awaiting_approval`, steps kosong, tab tidak berubah, tidak ada klik | PASS |
| f | Follow-up `approved=true` -> done, klik + ketik tercatat | PASS |
| g | `approved=true` tapi domActions OFF -> failed jujur (`domActions permission is off`), tidak ada klik | PASS |
| h1 | `browser_navigate` URL tidak valid -> failed jujur | PASS |
| h2 | `browser_read` tanpa url -> failed jujur (validasi, tanpa sentuh tab) | PASS |
| i | Elemen tidak ditemukan -> failed di langkah `clickText`, langkah sesudahnya tidak jalan | PASS |
| r1 | `parseBrowserTaskResult` untuk `awaiting_approval` | PASS |
| r2 | `parseBrowserTaskResult` teks biasa -> null | PASS |

Pemeriksaan kode "open + show" (26 Nov 02:35, dari Tuan): `browser_navigate`
hanya menjalankan langkah `navigate` (`chrome.tabs.update`/`create` +
tunggu load) lalu melaporkan url/title; TIDAK ada login, TIDAK ada isi
kredensial, dan TIDAK ada `chrome.tabs.remove` di seluruh `src/` — tab
dibiarkan terbuka di halaman itu. (Grep: `tabs.remove`/`tabs.discard` = 0
kemunculan; `password`/`credential` hanya di SensitiveDataScanner,
label i18n, dan field token bridge di Settings — bukan di jalur browser task.)

## Yang TIDAK dites (butuh laptop + Chrome Tuan + HP Android)

- Round-trip sungguhan HP -> bridge -> extension Chrome -> HP untuk SEMUA
  kasus di atas (harness memakai tab palsu; DOM asli, content script asli,
  dan `chrome.tabs` asli belum dieksekusi).
- "Open + show" di Chrome asli — langkah tes untuk Tuan (lihat bawah):
  1. Pastikan extension v9 terpasang + bridge jalan + token sama di HP.
  2. Dari HP: "buka example.com di laptop" (atau "buka devpost.com di laptop").
  3. Lihat laptop: tab Chrome harus terbuka di halaman yang benar
     (URL + judul cocok dengan yang diminta).
  4. Pastikan TIDAK ada login terjadi (tidak ada form login terisi, tidak
     ada akun yang masuk sendiri) dan tab TETAP terbuka setelah tugas
     selesai (tidak tertutup).
  5. Ulangi dengan situs lain (mis. devpost.com) bila mau.
- Lease 60 detik timing produksi dan TTL 10 menit penuh (sama seperti v8).

---

# v0.4.0 — Heartbeat + no-requeue tugas approved (26 Nov 2026, ~12:00 WIB)

Node v24.22.1. Token tes: `test-token-123` (palsu, hanya untuk tes).
Root tes: `/tmp/mobius-test-root-v10` (dihapus setelah tes). Server dimatikan
setelah pengujian; tidak ada server yang dibiarkan berjalan.
Perubahan yang dites: bridge v0.4.0 — endpoint baru
`POST /bridge/tasks/:id/heartbeat` (perpanjang lease `running` sebesar
`MOBIUS_BRIDGE_LEASE_MS`), dan sweep TIDAK PERNAH me-requeue tugas approved
(`text` ter-parse sebagai JSON dengan `approved === true`): lease habis →
`failed` dengan result `"Hasil tidak diketahui, cek manual di laptop"`.
Knob tes (hanya untuk tes): `MOBIUS_BRIDGE_LEASE_MS=5000` +
`MOBIUS_BRIDGE_SWEEP_MS=1000`, port 8787.

Startup log mengonfirmasi versi + aturan baru:
`[mobius-bridge] v0.4.0 listening on http://127.0.0.1:8787` dan
`tasks: 10-min TTL, 60 s lease, max 3 attempts (requeue on lease expiry; approved tasks never requeue — lease expiry -> failed)`.
`GET /health` → `{"ok":true,"version":"0.4.0",...}`.

## A. Heartbeat memperpanjang lease — PASS

| # | Cek | Hasil |
| --- | --- | --- |
| H1 | `POST /task {"text":"tugas heartbeat"}` | `accepted`, taskId `e34db103-...` |
| H2 | `GET /bridge/tasks/next` (claim) | task, `"attempts":1` |
| H3 | Tunggu 3 dtk → `POST /bridge/tasks/<id>/heartbeat` | `{"taskId":"...","status":"running","leaseExpiresAt":1795669228706}` (lease baru = heartbeat + 5 dtk) |
| H4 | Tunggu 3 dtk lagi (total 6 dtk > lease awal 5 dtk) → `GET /task/<id>` | `{"status":"running","attempts":1}` — masih running, TIDAK direqueue |
| H5 | Tunggu 6 dtk lagi (lease hasil heartbeat habis) → `GET /task/<id>` | `{"status":"queued","attempts":1}` — setelah lease baru habis, tugas biasa kembali ke antrean seperti biasa |

## B. Tugas approved TIDAK direqueue — PASS

| # | Cek | Hasil |
| --- | --- | --- |
| P1 | `POST /task` teks JSON `{"type":"browser_act","url":"https://example.com","actions":[{"tool":"clickText","text":"Beli"}],"approved":true,"approvalId":"appr-123"}` (+ field `approvalId` di POST) | `accepted`, taskId `deb63e39-...` |
| P2 | `GET /bridge/tasks/next` (claim) | task + `"attempts":1`, `"approvalId":"appr-123"` |
| P3 | Tunggu 7 dtk (lease 5 dtk + sweep 1 dtk) → `GET /task/<id>` | `{"status":"failed","attempts":1,"approvalId":"appr-123","result":"Hasil tidak diketahui, cek manual di laptop"}` |
| P4 | `GET /bridge/tasks/next` | `{"task":null}` — tugas approved TIDAK kembali ke antrean |

## C. Regresi tugas biasa — PASS

| # | Cek | Hasil |
| --- | --- | --- |
| R1 | `POST /task {"text":"tugas biasa regresi"}` → claim | task, `"attempts":1` |
| R2 | Tunggu 7 dtk → `GET /task/<id>` | `{"status":"queued","attempts":1}` — tugas biasa tetap direqueue |

## D. Error cases heartbeat — semua PASS

| # | Cek | Hasil |
| --- | --- | --- |
| E1 | Heartbeat tanpa token | `401` |
| E2 | Heartbeat token salah | `401 {"ok":false,"error":"invalid token"}` |
| E3 | Heartbeat unknown id | `404 {"ok":false,"error":"unknown task id"}` |
| E4 | Heartbeat ke tugas `queued` (bukan `running`) | `409 {"ok":false,"error":"task is not running (it was requeued or already finished)"}` |
| E5 | Heartbeat ke tugas approved yang sudah `failed` | `409` (pesan sama) |
| E6 | Heartbeat ke tugas `done` | `409` (pesan sama) |

## E. Token tidak masuk log — PASS

`grep -n "console.log"` di `bridge.mjs`: hanya 6 baris log startup
(version, root, mode, auth, tasks) — tidak satu pun mencetak nilai token.
`grep -n "TOKEN"`: nilai token hanya dibaca dari env (`const TOKEN =
process.env.MOBIUS_BRIDGE_TOKEN`) dan dibandingkan di `checkAuth`
(`Buffer.from(TOKEN)`); pesan FATAL/usage hanya menyebut NAMA env var dan
placeholder, bukan nilainya. Baris log `auth: X-Mobius-Token required ...`
hanya menyebut nama header, bukan nilai token.

Setelah `kill`, `curl /health` gagal konek — server benar-benar mati.

## Yang TIDAK dites (butuh perangkat Tuan — sama seperti v6/v8/v9)

- Heartbeat dari extension Chrome asli (tes di atas memakai curl; client
  extension `BridgeClient.ts` belum memanggil endpoint ini — itu jalur agen
  extension).
- Lease 60 detik timing produksi dan TTL 10 menit penuh (tes memakai knob
  5 dtk / 1 dtk; logika sweep yang sama, tapi durasi produksi belum
  ditunggu live).
