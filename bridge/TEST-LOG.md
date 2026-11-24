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
