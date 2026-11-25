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
{ "ok": true, "version": "0.1.0", "time": "2026-11-24T04:48:52.255Z" }
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

### `POST /bridge/tasks/:id/result` — extension mengembalikan hasil

Request: `{ "status": "done", "result": "ringkasan..." }` atau
`{ "status": "failed", "result": "pesan error" }`.
Response: `{ "taskId": "...", "status": "done" }`.

Tugas yang tidak dikenal → `404`; tugas yang sudah kedaluwarsa → `410`;
tugas yang sedang **tidak** `running` (sudah di-requeue karena lease habis,
atau sudah selesai) → `409` — worker yang telat tidak boleh menimpa hasil
re-run; `status` selain `done`/`failed` → `400`.

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
  dalam **60 detik** (lease) kembali ke antrean, maksimal **3 percobaan**.
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

Extension yang memanggil bridge harus memakai token yang sama dan
mengirim header `X-Mobius-Token`. CORS diizinkan (`Access-Control-Allow-
Origin: *`, termasuk header token) supaya `fetch()` dari service worker
extension tidak diblokir preflight.

## Tes

Lihat `TEST-LOG.md` — 19 cek dijalankan 24 Nov 2026 (health, auth 401,
exec diizinkan/ditolak, read/write + traversal, round-trip task lengkap),
ditambah **8 cek lease/recovery (v8, 25 Nov 2026)**. Semua lolos. Server
tes dimatikan setelah pengujian; tidak ada server yang dibiarkan berjalan.
