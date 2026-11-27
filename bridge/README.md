# MOBIUS v6 — Laptop Bridge Server

Server kecil di **laptop** yang menjembatani extension Chrome dengan dunia
luar. Satu kalimat: **extension Chrome tidak bisa menjalankan shell atau
menyentuh file laptop** (batas keamanan Chrome), jadi bridge inilah yang
melakukannya atas nama extension — dan juga menjadi pintu masuk HP Android
ke laptop.

```
HP Android --(Wi-Fi/LAN)--> bridge --(HTTP localhost)--> extension Chrome
extension Chrome ----------(HTTP localhost)------------> bridge --(spawn/fs)--> shell + file laptop
```

Bridge ini **hanya server**. Client Android dibangun oleh agen lain; **client
extension SUDAH ADA sejak v8** (`src/core/BridgeClient.ts` + polling di side
panel & service worker) — file ini mendefinisikan API yang mereka panggil.

## Menjalankan (di laptop Tuan)

Tidak perlu `npm install`. Node.js saja (stdlib only, tanpa dependensi).

```bash
# 1. Buat token acak (sekali saja, simpan baik-baik — JANGAN commit ke repo):
openssl rand -hex 32

# 2. Jalankan — localhost saja (default, paling aman):
MOBIUS_BRIDGE_TOKEN=change-me-<token-acak-anda> node bridge.mjs

# 3. Kalau HP Android perlu mencapai bridge lewat Wi-Fi yang sama:
MOBIUS_BRIDGE_TOKEN=change-me-<token-acak-anda> node bridge.mjs --lan

# Opsi lain:
MOBIUS_BRIDGE_TOKEN=change-me-<token-acak-anda> node bridge.mjs --lan --port 8787 --root ~/mobius-bridge
```

| Flag | Default | Arti |
| --- | --- | --- |
| `--port <n>` | `8787` | Port yang didengarkan |
| `--root <dir>` | `~/mobius-bridge` | Satu-satunya direktori yang boleh dibaca/ditulis `/read`/`/write` (juga cwd default `/exec`). Dibuat otomatis bila belum ada. `~/` di depan akan di-expand. |
| `--lan` | mati | Dengarkan di `0.0.0.0` (LAN, Wi-Fi yang sama) bukan `127.0.0.1` |

**Tanpa `MOBIUS_BRIDGE_TOKEN`, server MENOLAK start** — tidak ada token
default. Contoh `change-me-...` di atas hanya contoh, bukan token sungguhan.
Jangan pernah menulis token asli di file, di chat, atau di repo.

## Auth

Semua endpoint **kecuali `GET /health`** wajib membawa header:

```
X-Mobius-Token: <MOBIUS_BRIDGE_TOKEN>
```

Tanpa header → `401 missing X-Mobius-Token header`; token salah → `401
invalid token`. Perbandingan token memakai `timingSafeEqual`.

## HTTP API (semua JSON)

### `GET /health` — tanpa auth

```json
{ "ok": true, "version": "0.4.0", "time": "2026-11-24T04:48:52.255Z" }
```

### `POST /exec` — jalankan perintah (allowlist ketat)

Request: `{ "command": "node", "args": ["--version"], "cwd": "sub/dir" }`
(`cwd` opsional; default = `--root`; harus di dalam `--root`.)

Response: `{ "stdout": "v24.22.1\n", "stderr": "", "exitCode": 0, "timedOut": false }`

- Timeout **30 detik** — perintah yang melewatinya di-kill (`SIGKILL`) dan
  `timedOut: true`.
- Dijalankan via `spawn()` dengan `shell: false` — **tidak ada shell**,
  jadi pipe (`|`), redirect (`>`), `$(...)`, backtick, `&&` secara teknis
  tidak mungkin terjadi; argumen yang mengandung karakter itu tetap
  ditolak eksplisit dengan `403`.
- Perintah yang gagal (mis. `git status` di luar repo) **bukan** error HTTP:
  HTTP tetap 200, `exitCode` dan `stderr` membawa pesan aslinya.

#### Allowlist (lengkap — yang tidak ada di sini = `403`)

| Perintah | Yang diizinkan |
| --- | --- |
| `git status` | flag `--short`, `--porcelain`, `--branch` |
| `git log` | flag `--oneline`, `--stat`, `--name-only`, `-n <1-50>` |
| `git diff` | flag `--stat`, `--name-only` |
| `git branch` | flag `--list`, `-a` |
| `ls` | flag `-l`, `-a`, `-h`, `-1`; direktori opsional harus di dalam `--root` |
| `cat <file>` | tepat satu path, harus di dalam `--root` |
| `node --version` | hanya itu |
| `npm --version` | hanya itu |
| `pwd` | tanpa argumen |

**Ditolak selalu (403):** `rm`, `mv`, `cp`, `mkdir`, `chmod`, `curl`,
`wget`, `ssh`, `sudo`, `sh`, `bash`, `python`, `pip`, `git push/pull/
fetch/clone/reset/checkout`, dan perintah apa pun yang tidak terdaftar.
Alasan: bridge ini sengaja **read-only / diagnostik** — tidak ada yang
destruktif dan tidak ada yang mengambil data dari internet.

### `POST /read` — baca file teks

Request: `{ "path": "catatan.txt" }` (relatif terhadap `--root`, atau
absolut selama masih di dalam `--root`). Response: `{ "content": "..." }`.

- Path yang keluar dari `--root` (`../`, absolut di luar root, symlink
  yang menunjuk ke luar) → `403`.
- File tidak ada → `404`. Bukan file / tidak bisa dibaca → `400`.
- Maksimal file **5 MB** (`413` bila lebih).

### `POST /write` — tulis file teks

Request: `{ "path": "catatan.txt", "content": "isi..." }`.
Response: `{ "bytesWritten": 14 }`.

- Aturan root yang sama seperti `/read` (`403` bila keluar).
- Direktori induk dibuat otomatis (masih di dalam `--root`).
- Maksimal konten **5 MB** (`413` bila lebih).

### `POST /task` — remote gateway (HP → bridge)

Request dari HP Android: `{ "text": "ringkas halaman ini", "source": "phone" }`
(`source` opsional, default `"phone"`; `text` maksimal 10.000 karakter).

Response langsung (tidak menunggu eksekusi): `202 { "accepted": true, "taskId": "b59bf734-..." }`.

### `GET /bridge/tasks/next` — extension mengambil tugas (polling)

Endpoint yang di-poll extension. Mengembalikan tugas `queued` tertua dan
menandainya `running` — sekaligus **memulai lease 60 detik** dan menaikkan
`attempts` (jadi tidak pernah dikirim dua kali dalam satu lease):

```json
{ "task": { "taskId": "...", "text": "ringkas halaman ini", "source": "phone", "createdAt": 1795495732552, "attempts": 1 } }
```

Bila antrean kosong: `{ "task": null }`.

**Keputusan polling: short poll, bukan long-poll — dua tingkat (v8).** Service
worker Manifest V3 bisa di-suspend Chrome kapan saja, sehingga koneksi
long-poll yang dipegang lama tidak bisa diandalkan; short poll mudah di-retry
dan cukup untuk kasus ini.

- **Panel samping terbuka:** side panel adalah halaman hidup, jadi ia poll
  tiap **3 detik**. Latensi tipikal: ~3 detik + waktu eksekusi.
- **Panel tertutup:** service worker hanya bisa mengandalkan `chrome.alarms`,
  dan Chrome memaksakan minimum **1 menit**. Latensi tipikal: sampai ~60
  detik + waktu eksekusi.
- **Worker mati di tengah tugas:** lease 60 detik habis → tugas kembali ke
  `queued` untuk percobaan berikutnya (maksimal 3 kali, lalu `expired`).
  Tugas yang berjalan lebih dari 60 detik berisiko dijalankan dua kali —
  skill yang dikirim saat ini (pencarian harga, read-only) aman terhadap itu;
  jangan kirim tugas non-idempotent tanpa memikirkan ini dulu.

### Lease & recovery (v8)

Setiap claim memulai lease **60 detik** (`MOBIUS_BRIDGE_LEASE_MS`, hanya
untuk tes). Sweep tiap 30 detik (`MOBIUS_BRIDGE_SWEEP_MS`, hanya untuk tes):

- Tugas `running` yang lease-nya habis → kembali `queued` (`attempts` tetap
  menghitung berapa kali sudah di-claim).
- Setelah **3 kali claim** tanpa hasil → `expired`.
- TTL keseluruhan **10 menit** tetap menang atas segalanya.

### Heartbeat (v0.4.0)

Extension yang masih mengerjakan tugas `running` boleh memperpanjang
lease-nya dengan `POST /bridge/tasks/:id/heartbeat` (auth sama seperti
endpoint bridge lain). Setiap heartbeat menggeser `leaseExpiresAt` menjadi
**sekarang + 60 detik** (`MOBIUS_BRIDGE_LEASE_MS`, sama seperti lease awal),
jadi tugas panjang tidak di-requeue di tengah jalan selama extension
mengirim heartbeat berkala (mis. tiap 30 detik). Response:
`{ "taskId": "...", "status": "running", "leaseExpiresAt": 1795... }` —
`leaseExpiresAt` baru disertakan supaya pemanggil bisa memverifikasi
perpanjangan itu terjadi. Tugas tidak dikenal → `404`; tugas yang sedang
tidak `running` (sudah di-requeue, sudah selesai, atau sudah `failed`/
`expired`) → `409` dengan pesan yang sama seperti endpoint result
(`task is not running (it was requeued or already finished)`).

### Tugas approved TIDAK PERNAH di-requeue (v0.4.0)

Tugas yang `text`-nya ter-parse sebagai JSON dengan `approved === true`
adalah pengiriman ulang dari HP setelah Tuan menyetujui aksi mutating —
hasil eksekusinya tidak diketahui bila lease habis, dan mengulanginya
buta-buta bisa mengulang aksi itu sendiri (mis. pembelian). Karena itu,
bila lease tugas approved habis, sweep **TIDAK** mengembalikannya ke
`queued`, berapa pun `attempts`-nya:

- Status akhir: **`failed`**, dengan `result` =
  `"Hasil tidak diketahui, cek manual di laptop"` (pesan yang sama dengan
  yang dipakai extension). `claimedAt`/`leaseExpiresAt` dibersihkan.
- Tugas itu terminal: `GET /bridge/tasks/next` tidak akan pernah
  mengembalikannya lagi, dan HP harus menampilkan pesan itu ke Tuan supaya
  ia mengecek manual di laptop.
- Tugas **biasa** (teks polos atau JSON tanpa `approved: true`) tetap
  di-requeue seperti sebelumnya, sampai 3 percobaan lalu `expired`.

### Browser takeover tasks (v9) — HP mengendalikan browser laptop

Tugas biasa (`text` polos) tetap jalan seperti v8 (chat/skill). Untuk
mengendalikan browser, HP mengirim `text` berupa **string JSON** — bridge
hanya membawa teks polos, jadi struktur tugas di-encode di dalam `text`.
Extension mendeteksi JSON dengan field `type` `browser_*` dan menjalankannya
secara deterministik (tanpa LLM, tanpa skill match) lewat `WebSkillTools`.

#### Bentuk task (POST /task, field `text` = JSON string ini)

```json
{ "type": "browser_navigate", "url": "https://example.com" }
```

```json
{ "type": "browser_read", "url": "https://example.com/artikel" }
```

```json
{
  "type": "browser_act",
  "url": "https://example.com/login",
  "actions": [
    { "tool": "typeText", "text": "nama pengguna" },
    { "tool": "clickText", "text": "Masuk" },
    { "tool": "waitForText", "text": "Beranda", "timeoutMs": "5000" },
    { "tool": "readScreen", "limit": "200" }
  ],
  "approved": false
}
```

| Field | Arti |
| --- | --- |
| `type` | `browser_navigate` (buka URL saja), `browser_read` (buka URL + baca isi halaman), atau `browser_act` (buka URL bila ada + jalankan `actions` berurutan). `type` lain / JSON rusak / teks polos = tugas biasa v8, TIDAK pernah dieksekusi sebagai browser task. |
| `url` | Wajib untuk `browser_navigate` dan `browser_read`; opsional untuk `browser_act` (tanpa `url`, aksi jalan di tab aktif saat ini). |
| `actions` | Daftar langkah `browser_act` (dan bacaan tambahan untuk `browser_read`). Setiap langkah: `{ "tool": "<nama tool>", ...argumen string }`. Tool yang tersedia = tool `WebSkillTools`: `navigate`, `clickText`, `typeText`, `submit`, `readScreen`, `findText`, `extract`, `scroll`, `back`, `home`, `wait`, `waitForText`. Langkah pertama yang gagal menghentikan tugas (langkah sesudahnya tidak jalan). |
| `approved` | Persetujuan untuk aksi mutating — lihat protokol di bawah. Default `false`. |
| `approvalId` | (v8.1, opsional) Id yang mengikat pengiriman ulang yang disetujui dengan hasil `awaiting_approval` sebelumnya — HP mengisi ini dari field `approvalId` hasil tersebut (juga bisa dikirim sebagai field `approvalId` di POST /task). Bridge hanya menyimpan + mengembalikannya, tidak pernah menafsirkan: id yang salah/tidak ada tidak bisa menyetujui apa pun dengan sendirinya. |

Navigasi memakai tab aktif (atau tab baru bila belum ada); setelah navigasi,
extension menunggu halaman selesai dimuat (maks. 20 detik). `extract` butuh
field `pattern` (regex) dan opsional `max`; `waitForText` butuh `text` dan
opsional `timeoutMs`.

#### Bentuk result (POST /bridge/tasks/:id/result, field `result` = JSON string ini)

Extension selalu mengembalikan result berupa **JSON string** dengan bentuk:

```json
{
  "status": "done",
  "type": "browser_read",
  "url": "https://example.com/artikel",
  "title": "Judul Halaman",
  "steps": [
    { "tool": "navigate", "ok": true, "message": "Opened https://example.com/artikel" },
    { "tool": "readScreen", "ok": true, "message": "…" }
  ],
  "text": "isi halaman yang terbaca (maks. 2000 karakter)",
  "message": "browser_read selesai: 2/2 langkah OK — Judul Halaman."
}
```

Untuk `awaiting_approval`, result membawa dua field tambahan (v8.1):

```json
{
  "status": "awaiting_approval",
  "type": "browser_act",
  "url": "https://example.com/...",
  "title": "",
  "steps": [],
  "pendingActions": [
    { "tool": "clickText", "description": "Klik teks \"Beli\"", "tier": "moderate" },
    { "tool": "submit", "description": "Kirim/submit formulir", "tier": "sensitive" }
  ],
  "approvalId": "3f9a…c21e",
  "message": "Menunggu persetujuan: Klik teks \"Beli\"; Kirim/submit formulir di https://example.com/.... Tugas ini menunggu persetujuan Tuan di HP. Setelah Tuan menyetujui, laptop akan menjalankannya."
}
```

| `pendingActions[].tier` | Arti |
| --- | --- |
| `moderate` | Aksi mengubah state tapi reversibel (klik/ketik). HP BOLEH mengingat persetujuan ini (sekali / chat ini / selamanya). |
| `sensitive` | Aksi irreversible / kirim (`submit`). HP SELALU bertanya; TIDAK BOLEH diingat selamanya (maksimal "chat ini"). |

| `status` | Arti | Status bridge (`POST result`) |
| --- | --- | --- |
| `done` | Semua langkah berhasil. | `done` |
| `failed` | Gagal secara jujur — halaman tidak bisa dimuat, elemen tidak ditemukan, tidak ada tab, permission `readPage`/`domActions` mati, atau tugas tidak valid (mis. `browser_read` tanpa `url`). `steps` berisi langkah yang sudah jalan, `error` berisi alasannya. | `failed` |
| `awaiting_approval` | Tugas mutating ditahan — TIDAK ADA yang dieksekusi, bahkan navigasi. Lihat protokol persetujuan. | `done` (extension selesai memproses; HP harus menampilkan dialog persetujuan) |

`url`/`title` = tab aktif setelah tugas (string kosong bila tidak ada tab).
`text` hanya ada bila ada langkah baca. HP membaca hasil lewat
`GET /task/:id` lalu `JSON.parse(result)`.

#### Protokol persetujuan (approval) — FAIL CLOSED

Aturan keras: aksi yang **mengubah** halaman — `clickText`, `typeText`,
`submit` ( persis `DOM_MUTATING_TOOLS` di `src/core/WebSkillTools.ts`) —
**TIDAK BOLEH dieksekusi tanpa persetujuan dari HP.** Baca saja
(`navigate`, `readScreen`, `extract`, `findText`, `scroll`, `wait`,
`waitForText`, `back`, `home`) tidak butuh persetujuan.

Alur lengkap:

```
1. HP  POST /task { "text": "{\"type\":\"browser_act\",\"url\":\"...\",\"actions\":[{\"tool\":\"clickText\",\"text\":\"Beli\"}]}" }
2. Ext GET  /bridge/tasks/next  -> klaim tugas
3. Ext mendeteksi aksi mutating + approved != true
    -> TIDAK mengeksekusi apa pun (tab tidak disentuh sama sekali)
    -> POST result { "status": "done", "result": "<JSON awaiting_approval>" }
4. HP  GET  /task/:id -> status done, result JSON:
    {
      "status": "awaiting_approval",
      "type": "browser_act",
      "url": "https://example.com/...",
      "title": "",
      "steps": [],
      "pendingActions": [
        { "tool": "clickText", "description": "Klik teks \"Beli\"", "tier": "moderate" }
      ],
      "approvalId": "3f9a…c21e",
      "message": "Menunggu persetujuan: Klik teks \"Beli\" di https://example.com/.... Tugas ini menunggu persetujuan Tuan di HP. Setelah Tuan menyetujui, laptop akan menjalankannya."
    }
5. HP  menampilkan dialog persetujuan dari `pendingActions[].description`
    + `url` ("MOBIUS akan: Klik teks \"Beli\" di https://... — Setuju?").
    Dialog ini di sisi Android; extension tidak punya UI persetujuan
    (panel laptop hanya menampilkan kartu "Menunggu persetujuan di HP").
    Tier per aksi (`moderate`/`sensitive`) menentukan pilihan "ingat"
    yang ditawarkan dialog: `moderate` boleh sekali/chat ini/selamanya,
    `sensitive` hanya sekali/chat ini.
6. Bila user SETUJU, HP mengirim tugas BARU (taskId baru) dengan isi yang
    SAMA persis + "approved": true + "approvalId" yang sama:
    { "type": "browser_act", "url": "...", "actions": [...], "approved": true, "approvalId": "3f9a…c21e" }
    (boleh juga dikirim sebagai field `approvalId` di POST /task — bridge
    mengembalikan id itu di GET /bridge/tasks/next dan GET /task/:id.)
    -> extension mengeksekusi dan mengembalikan status done/failed seperti biasa.
    Bila user MENOLAK, HP tidak mengirim apa-apa — tugas selesai sebagai
    awaiting_approval, tidak ada efek samping.
```

Jaminan fail-closed (diuji di sisi extension):

- `approved` absen, `false`, atau bukan boolean `true` → ditahan.
- Tugas yang sudah disetujui (`approved: true`) TETAP butuh permission
  `domActions` aktif di laptop; bila mati → `failed` jujur, tidak dieksekusi.
- `pendingActions` hanya berisi aksi mutating — aksi baca dalam tugas yang
  sama TIDAK ikut dieksekusi saat ditahan (tugas ditolak utuh, bukan
  setengah jalan).
- Tugas `awaiting_approval` adalah terminal: tugas follow-up yang disetujui
  adalah tugas BARU (taskId baru, lease + attempts sendiri).

#### Takeover: user mengambil alih browser (v9)

Saat tugas bridge sedang berjalan, panel samping menampilkan banner
**"MOBIUS sedang mengendalikan browser — klik untuk mengambil alih"**.
Klik banner menulis flag `mobius_takeover = { active: true, at: <ms> }` ke
`chrome.storage.local`. **Kedua poller menghormati flag ini**: panel
(`setInterval` 3 detik) dan service worker (alarm `mobius-bridge-poll`
1 menit) tidak mengklaim tugas baru selama flag aktif. Tugas yang sudah
berjalan saat flag dipasang dibiarkan selesai. Banner berubah menjadi
**"MOBIUS dijeda — Anda mengendalikan browser. Klik untuk melanjutkan."**
dan tetap tampil selama flag aktif — klik lagi menghapus flag dan polling
berlanjut. Tanpa flag aktif, banner hilang saat tidak ada tugas berjalan.
Status tugas yang sedang berjalan diumumkan lewat key
`mobius_bridge_running = { taskId, startedAt }` (ditulis kedua poller,
dihapus saat tugas selesai; entri lebih tua dari 120 detik dianggap basi).

### `POST /bridge/tasks/:id/result` — extension mengembalikan hasil

Request: `{ "status": "done", "result": "ringkasan..." }` atau
`{ "status": "failed", "result": "pesan error" }`.
Response: `{ "taskId": "...", "status": "done" }`.

Tugas yang tidak dikenal → `404`; tugas yang sudah kedaluwarsa → `410`;
tugas yang sedang **tidak** `running` (sudah di-requeue karena lease habis,
atau sudah selesai) → `409` — worker yang telat tidak boleh menimpa hasil
re-run; `status` selain `done`/`failed` → `400`.

### `POST /bridge/tasks/:id/heartbeat` — extension memperpanjang lease (v0.4.0)

Extension yang masih mengerjakan tugas `running` memanggil endpoint ini
berkala (mis. tiap 30 detik) supaya tugas panjang tidak di-requeue di
tengah jalan. Tidak perlu body (body kosong / `{}` cukup). Setiap
heartbeat menggeser `leaseExpiresAt` menjadi **sekarang + 60 detik**
(`MOBIUS_BRIDGE_LEASE_MS`, sama seperti lease awal). Response:
`{ "taskId": "...", "status": "running", "leaseExpiresAt": 1795... }`.
Auth: header `X-Mobius-Token` yang sama seperti endpoint bridge lain.
Tugas tidak dikenal → `404`; tugas yang sedang tidak `running` → `409`
dengan pesan yang sama seperti endpoint result.

### `GET /task/:id` — HP mengecek hasil (polling)

Response: `{ "taskId": "...", "status": "queued|running|done|failed|expired", "attempts": 1, "result": "..." }`
(`result` hanya ada bila extension sudah mengembalikannya; `attempts` =
berapa kali tugas sudah di-claim.)

## Batas keamanan & jujur (honest limits)

- **LAN-only secara default.** `--lan` membuka bridge ke jaringan lokal
  (Wi-Fi yang sama) — **bukan internet**. Jangan pernah port-forward
  bridge ini; tidak ada instruksi port-forwarding di proyek ini, sengaja.
  Siapa pun di Wi-Fi yang sama yang tahu token bisa memanggil `/exec` —
  jadi token harus panjang/acak dan Wi-Fi rumah harus ber-password.
- **Token satu saja**, dibagikan antara extension, HP, dan bridge. Tidak
  ada akun/pengguna terpisah. Kalau token bocor, ganti dan restart semua.
- **Tugas hanya di memori.** Tidak ada database, tidak ada persistensi.
  Restart server = semua tugas antrean hilang. Tugas kedaluwarsa setelah
  **10 menit** (`status: expired`); tugas yang di-claim tapi tidak selesai
  dalam **60 detik** (lease) kembali ke antrean, maksimal **3 percobaan** —
  **kecuali tugas approved** (`approved: true` di dalam `text`): lease
  habis → `failed` dengan result `"Hasil tidak diketahui, cek manual di
  laptop"`, tidak pernah di-requeue (lihat "Tugas approved TIDAK PERNAH
  di-requeue").
- **Latensi polling**: beberapa detik dari HP → extension (lihat di atas).
- **Tidak ada enkripsi transport** (HTTP biasa). Ini disengaja untuk LAN
  rumah; jangan jalankan di jaringan publik/tidak dipercaya.
- **Tidak menyentuh Firebase / App Check.** Bridge ini murni Node stdlib.
- Catatan MIUI/HP tidak berlaku di sini — ini berjalan di **laptop**, bukan
  di HP.

## Alur end-to-end (untuk agen client)

```
1. HP     POST /task {text}            -> {accepted, taskId}
2. Ext    GET  /bridge/tasks/next      -> {task}            (panel: poll 3 dtk;
                                                            worker: alarm 1 mnt)
3. Ext    kerjakan tugas di Chrome (AIRouter, dst — di luar bridge)
4. Ext    POST /bridge/tasks/:id/result {status, result}
5. HP     GET  /task/:id               -> {status: done, result} (poll)
```
Bila langkah 3–4 tidak selesai dalam 60 detik (lease), tugas kembali ke
antrean dan diambil lagi — maksimal 3 percobaan (lihat "Lease & recovery").

Untuk tugas browser (v9), langkah 3 adalah eksekusi deterministik
`browser_navigate` / `browser_read` / `browser_act` dan langkah 4 membawa
result JSON terstruktur (`done` / `failed` / `awaiting_approval`) — lihat
"Browser takeover tasks (v9)" di atas, termasuk protokol persetujuan yang
membuat langkah 3–4 berulang bila aksi mutating butuh persetujuan HP.

Extension yang memanggil bridge harus memakai token yang sama dan
mengirim header `X-Mobius-Token`. CORS diizinkan (`Access-Control-Allow-
Origin: *`, termasuk header token) supaya `fetch()` dari service worker
extension tidak diblokir preflight.

## Tes

Lihat `TEST-LOG.md` — 19 cek dijalankan 24 Nov 2026 (health, auth 401,
exec diizinkan/ditolak, read/write + traversal, round-trip task lengkap),
ditambah **8 cek lease/recovery (v8, 25 Nov 2026)** dan **cek heartbeat +
no-requeue tugas approved (v0.4.0, 26 Nov 2026)**. Semua lolos. Server
tes dimatikan setelah pengujian; tidak ada server yang dibiarkan berjalan.
