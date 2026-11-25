// MOBIUS v6 — Laptop bridge server (Workstream K, part 1)
//
// WHY THIS EXISTS (design decision, 24 Nov 2026):
// A Chrome extension CANNOT run shell commands or touch laptop files
// directly (Chrome security boundary — no child_process, no fs access to
// the user's disk outside the browser profile). So the bridge is a small
// server program that runs ON THE LAPTOP, next to Chrome:
//   phone (Android app) --LAN--> bridge --HTTP--> extension (in Chrome)
//   extension --HTTP--> bridge --spawn/fs--> laptop shell + files
// The extension-side client that talks to this bridge EXISTS since v8
// (src/core/BridgeClient.ts + polling in the side panel & service worker).
// The Android client is built by another agent.
//
// SECURITY MODEL — read this before running:
//  - Token auth: every endpoint except GET /health requires the header
//    `X-Mobius-Token: <MOBIUS_BRIDGE_TOKEN>`. No token env var = server
//    refuses to start. Never commit a real token anywhere.
//  - LAN-only by default: binds 127.0.0.1. `--lan` binds 0.0.0.0, which
//    exposes the bridge to the LOCAL NETWORK ONLY (same Wi-Fi). Never
//    port-forward it to the internet. No port-forwarding instructions
//    are given anywhere in this project, on purpose.
//  - /exec runs ONLY commands on a strict allowlist (see ALLOWLIST below)
//    via spawn() with shell:false — no shell, no pipes, no redirects,
//    no metacharacters, nothing destructive (no rm, no curl/wget).
//  - /read and /write only touch files INSIDE --root (default
//    ~/mobius-bridge). Any path escaping the root ("..", absolute paths
//    outside it, symlinks pointing out) is rejected with 403.
//  - Tasks live in memory only. No DB, no persistence. Restart = tasks gone.
//  - The bridge never touches Firebase / App Check. It is plain Node stdlib.
//
// USAGE:
//   MOBIUS_BRIDGE_TOKEN=change-me-<random> node bridge.mjs [--lan] [--port 8787] [--root ~/mobius-bridge]
//
// Node stdlib ONLY — no npm dependencies, no `npm install` needed.

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const VERSION = '0.3.0';
const TASK_TTL_MS = 10 * 60 * 1000; // tasks expire after 10 minutes
// Lease (v8): a claimed task is leased, not owned forever. If the extension
// dies mid-task (service worker suspended, laptop asleep), the lease expires
// and the task returns to the queue for another attempt — max MAX_ATTEMPTS,
// then it expires for real. The two env vars are TEST-ONLY knobs (short
// lease/sweep so the recovery path can be exercised without waiting a
// minute); production defaults are 60 s / 30 s.
const LEASE_MS = Number(process.env.MOBIUS_BRIDGE_LEASE_MS || 60_000);
const MAX_ATTEMPTS = 3;
const SWEEP_MS = Number(process.env.MOBIUS_BRIDGE_SWEEP_MS || 30_000);
const EXEC_TIMEOUT_MS = 30_000; // 30 s, kill on timeout
const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB JSON bodies
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB read/write files

// ---------------------------------------------------------------------------
// Config: token (required), CLI flags
// ---------------------------------------------------------------------------
const TOKEN = process.env.MOBIUS_BRIDGE_TOKEN;
if (!TOKEN) {
  console.error(
    '[mobius-bridge] FATAL: MOBIUS_BRIDGE_TOKEN is not set.\n' +
      '  Set it before starting, e.g.:\n' +
      '    MOBIUS_BRIDGE_TOKEN=change-me-<random-string> node bridge.mjs\n' +
      '  Use a long random value (e.g. `openssl rand -hex 32`).\n' +
      '  The server refuses to start without a token — there is no default.',
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
let port = 8787;
let lan = false;
let rootArg = path.join(os.homedir(), 'mobius-bridge');
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--lan') lan = true;
  else if (a === '--port') port = Number(argv[++i]);
  else if (a === '--root') rootArg = argv[++i];
  else if (a === '--help' || a === '-h') {
    console.log(
      'Usage: MOBIUS_BRIDGE_TOKEN=<token> node bridge.mjs [--lan] [--port 8787] [--root ~/mobius-bridge]\n' +
        '  --lan   listen on 0.0.0.0 (LAN, same Wi-Fi only) instead of 127.0.0.1\n' +
        '  --port  port to listen on (default 8787)\n' +
        '  --root  allowed file root for /read and /write (default ~/mobius-bridge)',
    );
    process.exit(0);
  } else {
    console.error('[mobius-bridge] Unknown argument: ' + a);
    process.exit(1);
  }
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('[mobius-bridge] Invalid --port: ' + port);
  process.exit(1);
}

// Expand a leading "~/" in --root to the home directory.
if (rootArg.startsWith('~/')) rootArg = path.join(os.homedir(), rootArg.slice(2));
const ROOT = path.resolve(rootArg);
fs.mkdirSync(ROOT, { recursive: true });

const HOST = lan ? '0.0.0.0' : '127.0.0.1';

// ---------------------------------------------------------------------------
// /exec allowlist — the ONLY commands the bridge will ever run.
// Everything else -> 403. Deliberately small, read-only / dev-diagnostic.
// Nothing destructive, nothing that fetches from the network, nothing
// that can write outside the command's own normal output.
//
//  git status | git log | git diff | git branch
//    Extra args limited to a small flag whitelist per subcommand
//    (see validateExec). No git push/pull/fetch/clone/reset/checkout,
//    no -c, no --upload-pack, no pathspec tricks.
//  ls [flags] [dir-inside-root]   Flags: -l, -a, -h, -1.
//  cat <file-inside-root>         Exactly one path, inside --root.
//  node --version
//  npm --version
//  pwd                            No args.
//
// REJECTED, always: rm, mv, cp, mkdir, chmod, chown, curl, wget, ssh, scp,
// sudo, sh, bash, powershell, python*, pip*, any command not listed above,
// and ANY argument containing shell metacharacters (; & | $ ` \ " ' < > ( )
// { } * ? ~ ! # newline) — spawn() runs with shell:false anyway, so even a
// smuggled metacharacter could never become a shell operator; the check
// exists so the rejection is explicit and loud (403, not a silent no-op).
// ---------------------------------------------------------------------------
const META_CHARS = new Set([';', '&', '|', '$', '`', '\\', '"', "'", '<', '>', '(', ')', '{', '}', '*', '?', '~', '!', '#', '\n', '\r', '\0']);
function hasMeta(s) {
  for (const ch of s) if (META_CHARS.has(ch)) return true;
  return false;
}

const GIT_FLAGS = {
  status: new Set(['--short', '--porcelain', '--branch']),
  log: new Set(['--oneline', '--stat', '--name-only']),
  diff: new Set(['--stat', '--name-only']),
  branch: new Set(['--list', '-a']),
};

// Returns { ok: true, cmd, args, cwd } or { ok: false, error }.
function validateExec(body) {
  const command = body?.command;
  const args = body?.args ?? [];
  const cwd = body?.cwd;
  if (typeof command !== 'string' || !command) return { ok: false, error: 'command must be a non-empty string' };
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    return { ok: false, error: 'args must be an array of strings' };
  }
  if (hasMeta(command) || args.some(hasMeta)) {
    return { ok: false, error: 'rejected: shell metacharacters are not allowed (no pipes, redirects, $(), backticks, etc.)' };
  }
  if (cwd !== undefined) {
    if (typeof cwd !== 'string') return { ok: false, error: 'cwd must be a string' };
    const resolvedCwd = resolveInsideRoot(cwd);
    if (!resolvedCwd) return { ok: false, error: 'cwd must be inside the allowed root: ' + ROOT };
    return finishExec(command, args, resolvedCwd);
  }
  return finishExec(command, args, ROOT);
}

function finishExec(command, args, cwd) {
  // node / npm: only --version. pwd: no args.
  if (command === 'node' || command === 'npm') {
    if (args.length === 1 && args[0] === '--version') return { ok: true, cmd: command, args, cwd };
    return { ok: false, error: 'rejected: only "' + command + ' --version" is allowed' };
  }
  if (command === 'pwd') {
    if (args.length === 0) return { ok: true, cmd: command, args, cwd };
    return { ok: false, error: 'rejected: pwd takes no arguments' };
  }
  if (command === 'ls') {
    const flags = new Set(['-l', '-a', '-h', '-1']);
    let dir = cwd;
    for (const a of args) {
      if (flags.has(a)) continue;
      if (a.startsWith('-')) return { ok: false, error: 'rejected: ls flag not allowed: ' + a };
      const resolved = resolveInsideRoot(a);
      if (!resolved) return { ok: false, error: 'rejected: ls path must be inside the allowed root: ' + ROOT };
      dir = resolved;
    }
    // Keep only flags in argv; the directory becomes the cwd of the listing.
    return { ok: true, cmd: 'ls', args: args.filter((a) => flags.has(a)), cwd: dir };
  }
  if (command === 'cat') {
    if (args.length !== 1) return { ok: false, error: 'rejected: cat takes exactly one file path' };
    const resolved = resolveInsideRoot(args[0]);
    if (!resolved) return { ok: false, error: 'rejected: cat path must be inside the allowed root: ' + ROOT };
    return { ok: true, cmd: 'cat', args: [resolved], cwd };
  }
  if (command === 'git') {
    const sub = args[0];
    if (!sub || !Object.prototype.hasOwnProperty.call(GIT_FLAGS, sub)) {
      return { ok: false, error: 'rejected: only "git status|log|diff|branch" are allowed (no push/pull/fetch/clone/reset/checkout)' };
    }
    const allowed = GIT_FLAGS[sub];
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === '-n' && sub === 'log') {
        const n = args[i + 1];
        if (n === undefined || !/^[0-9]{1,2}$/.test(n) || Number(n) < 1 || Number(n) > 50) {
          return { ok: false, error: 'rejected: git log -n needs a number 1-50' };
        }
        i++;
        continue;
      }
      if (allowed.has(a)) continue;
      return { ok: false, error: 'rejected: git ' + sub + ' flag not allowed: ' + a };
    }
    return { ok: true, cmd: 'git', args, cwd };
  }
  return { ok: false, error: 'rejected: command not on the allowlist: ' + command + ' (allowed: git status/log/diff/branch, ls, cat, node --version, npm --version, pwd)' };
}

function runExec(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: false, timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, EXEC_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err), exitCode: -1, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code === null ? -1 : code, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// Path safety for /read, /write, and path arguments to /exec.
// resolveInsideRoot(p): absolute or root-relative path -> absolute path
// inside ROOT, or null if it escapes. Also rejects symlinks that point
// outside ROOT (checked on the existing target / its existing parent).
// ---------------------------------------------------------------------------
function resolveInsideRoot(p) {
  if (typeof p !== 'string' || !p) return null;
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(ROOT, p);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  try {
    // If the target exists, its real path must also be inside ROOT.
    const real = fs.realpathSync(abs);
    if (real !== ROOT && !real.startsWith(ROOT + path.sep)) return null;
  } catch {
    // Does not exist yet (e.g. a new file for /write): check the nearest
    // existing parent instead, so a symlink parent cannot smuggle it out.
    let parent = path.dirname(abs);
    while (!fs.existsSync(parent)) {
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    try {
      const realParent = fs.realpathSync(parent);
      if (realParent !== ROOT && !realParent.startsWith(ROOT + path.sep)) return null;
    } catch { return null; }
  }
  return abs;
}

// ---------------------------------------------------------------------------
// Tasks (remote gateway): in-memory only, 10-minute TTL, no persistence.
// Flow: phone POST /task -> bridge stores (queued) -> extension polls
// GET /bridge/tasks/next (SHORT poll, every 3-5 s — chosen over long-poll
// because a Manifest V3 service worker cannot reliably hold a long-lived
// fetch: it can be suspended at any time, and a short poll is trivially
// retried; cost is a few seconds of latency, documented in the README)
// -> extension POSTs the result to /bridge/tasks/:id/result
// -> phone polls GET /task/:id.
// Claiming a task marks it `running` AND starts a 60 s lease (attempts+1).
// If the lease expires before a result arrives (extension suspended, laptop
// asleep, bridge unreachable), the sweep returns the task to `queued` for
// another attempt; after MAX_ATTEMPTS (3) claims it expires instead. The
// overall 10-minute TTL still wins over everything. A late result for a
// requeued task is rejected with 409, so a stale worker can never overwrite
// the outcome of the re-run.
// ---------------------------------------------------------------------------
const tasks = new Map(); // id -> { taskId, text, source, status, result, createdAt, expiresAt, attempts, claimedAt, leaseExpiresAt, approvalId }
function sweepTasks() {
  const now = Date.now();
  for (const [id, t] of tasks) {
    if (t.status === 'done' || t.status === 'failed' || t.status === 'expired') continue;
    if (now > t.expiresAt) {
      t.status = 'expired';
      continue;
    }
    if (t.status === 'running' && t.leaseExpiresAt !== null && now > t.leaseExpiresAt) {
      if (t.attempts >= MAX_ATTEMPTS) {
        t.status = 'expired';
      } else {
        // Lease expired: back to the queue for another attempt.
        t.status = 'queued';
        t.claimedAt = null;
        t.leaseExpiresAt = null;
      }
    }
  }
}
setInterval(sweepTasks, SWEEP_MS).unref();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Mobius-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}
function sendError(res, status, error) {
  sendJson(res, status, { ok: false, error });
}

function checkAuth(req, res) {
  const token = req.headers['x-mobius-token'];
  if (typeof token !== 'string') { sendError(res, 401, 'missing X-Mobius-Token header'); return false; }
  const a = Buffer.from(token);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    sendError(res, 401, 'invalid token');
    return false;
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('request body too large (max 1 MB)')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('request body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    // CORS preflight (extension fetch + phone client).
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Mobius-Token',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      res.end();
      return;
    }

    // GET /health — no auth (liveness probe only; reveals nothing sensitive).
    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { ok: true, version: VERSION, time: new Date().toISOString() });
      return;
    }

    // Everything else requires the token.
    if (!checkAuth(req, res)) return;

    // POST /exec
    if (req.method === 'POST' && pathname === '/exec') {
      let body;
      try { body = await readBody(req); } catch (e) { sendError(res, 400, e.message); return; }
      const v = validateExec(body);
      if (!v.ok) { sendError(res, 403, v.error); return; }
      const out = await runExec(v.cmd, v.args, v.cwd);
      sendJson(res, 200, { stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode, timedOut: out.timedOut });
      return;
    }

    // POST /read
    if (req.method === 'POST' && pathname === '/read') {
      let body;
      try { body = await readBody(req); } catch (e) { sendError(res, 400, e.message); return; }
      const resolved = resolveInsideRoot(body?.path);
      if (!resolved) { sendError(res, 403, 'path must be inside the allowed root: ' + ROOT); return; }
      try {
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) { sendError(res, 400, 'not a file: ' + body.path); return; }
        if (stat.size > MAX_FILE_BYTES) { sendError(res, 413, 'file too large (max 5 MB)'); return; }
        sendJson(res, 200, { content: fs.readFileSync(resolved, 'utf8') });
      } catch (e) {
        if (e.code === 'ENOENT') sendError(res, 404, 'file not found: ' + body.path);
        else sendError(res, 400, 'cannot read file: ' + e.message);
      }
      return;
    }

    // POST /write
    if (req.method === 'POST' && pathname === '/write') {
      let body;
      try { body = await readBody(req); } catch (e) { sendError(res, 400, e.message); return; }
      if (typeof body?.content !== 'string') { sendError(res, 400, 'content must be a string'); return; }
      if (Buffer.byteLength(body.content, 'utf8') > MAX_FILE_BYTES) { sendError(res, 413, 'content too large (max 5 MB)'); return; }
      const resolved = resolveInsideRoot(body?.path);
      if (!resolved) { sendError(res, 403, 'path must be inside the allowed root: ' + ROOT); return; }
      try {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, body.content, 'utf8');
        sendJson(res, 200, { bytesWritten: Buffer.byteLength(body.content, 'utf8') });
      } catch (e) { sendError(res, 400, 'cannot write file: ' + e.message); }
      return;
    }

    // POST /task — remote gateway: accept a task from the phone.
    if (req.method === 'POST' && pathname === '/task') {
      let body;
      try { body = await readBody(req); } catch (e) { sendError(res, 400, e.message); return; }
      if (typeof body?.text !== 'string' || !body.text.trim()) { sendError(res, 400, 'text must be a non-empty string'); return; }
      if (body.text.length > 10000) { sendError(res, 413, 'text too long (max 10000 chars)'); return; }
      if (body.source !== undefined && typeof body.source !== 'string') { sendError(res, 400, 'source must be a string'); return; }
      // (v8.1) approvalId: opaque link between an awaiting_approval result
      // and the phone's resubmission with approved=true. The bridge never
      // interprets it — it only stores and echoes it — so a wrong/missing id
      // can never approve anything by itself; approval still requires the
      // phone to send approved=true AND the extension to see it.
      if (body.approvalId !== undefined && (typeof body.approvalId !== 'string' || body.approvalId.length > 128)) {
        sendError(res, 400, 'approvalId must be a string of at most 128 chars'); return;
      }
      sweepTasks();
      const taskId = crypto.randomUUID();
      const now = Date.now();
      tasks.set(taskId, {
        taskId,
        text: body.text,
        source: body.source ?? 'phone',
        status: 'queued',
        result: null,
        createdAt: now,
        expiresAt: now + TASK_TTL_MS,
        attempts: 0,
        claimedAt: null,
        leaseExpiresAt: null,
        approvalId: body.approvalId ?? null,
      });
      sendJson(res, 202, { accepted: true, taskId });
      return;
    }

    // GET /bridge/tasks/next — extension polling endpoint (short poll).
    // Claims the oldest queued task (marks it `running`, starts a 60 s lease,
    // attempts+1) and returns it. Returns { task: null } when the queue is empty.
    if (req.method === 'GET' && pathname === '/bridge/tasks/next') {
      sweepTasks();
      for (const t of tasks.values()) {
        if (t.status === 'queued') {
          t.status = 'running';
          t.attempts += 1;
          t.claimedAt = Date.now();
          t.leaseExpiresAt = t.claimedAt + LEASE_MS;
          const taskOut = { taskId: t.taskId, text: t.text, source: t.source, createdAt: t.createdAt, attempts: t.attempts };
          if (t.approvalId) taskOut.approvalId = t.approvalId; // (v8.1) echo, bila ada
          sendJson(res, 200, { task: taskOut });
          return;
        }
      }
      sendJson(res, 200, { task: null });
      return;
    }

    // POST /bridge/tasks/:id/result — extension posts the outcome back.
    // Only a `running` task accepts a result: a requeued task (lease expired)
    // answers 409 so a stale worker cannot overwrite the re-run's outcome.
    {
      const m = pathname.match(/^\/bridge\/tasks\/([^/]+)\/result$/);
      if (req.method === 'POST' && m) {
        let body;
        try { body = await readBody(req); } catch (e) { sendError(res, 400, e.message); return; }
        sweepTasks();
        const t = tasks.get(decodeURIComponent(m[1]));
        if (!t) { sendError(res, 404, 'unknown task id'); return; }
        if (t.status === 'expired') { sendError(res, 410, 'task expired'); return; }
        if (t.status !== 'running') { sendError(res, 409, 'task is not running (it was requeued or already finished)'); return; }
        const status = body?.status;
        if (status !== 'done' && status !== 'failed') { sendError(res, 400, 'status must be "done" or "failed"'); return; }
        t.status = status;
        t.result = body.result !== undefined ? body.result : null;
        t.claimedAt = null;
        t.leaseExpiresAt = null;
        sendJson(res, 200, { taskId: t.taskId, status: t.status });
        return;
      }
    }

    // GET /task/:id — phone polls for the outcome.
    {
      const m = pathname.match(/^\/task\/([^/]+)$/);
      if (req.method === 'GET' && m) {
        sweepTasks();
        const t = tasks.get(decodeURIComponent(m[1]));
        if (!t) { sendError(res, 404, 'unknown task id'); return; }
        const out = { taskId: t.taskId, status: t.status, attempts: t.attempts };
        if (t.approvalId) out.approvalId = t.approvalId; // (v8.1) echo, bila ada
        if (t.result !== null && t.result !== undefined) out.result = t.result;
        sendJson(res, 200, out);
        return;
      }
    }

    sendError(res, 404, 'unknown route: ' + req.method + ' ' + pathname);
  } catch (e) {
    console.error('[mobius-bridge] internal error:', e);
    try { sendError(res, 500, 'internal error: ' + e.message); } catch { /* socket gone */ }
  }
});

server.listen(port, HOST, () => {
  console.log('[mobius-bridge] v' + VERSION + ' listening on http://' + HOST + ':' + port);
  console.log('[mobius-bridge] root: ' + ROOT);
  console.log('[mobius-bridge] mode: ' + (lan ? 'LAN (0.0.0.0 — same Wi-Fi only, NEVER port-forward)' : 'localhost only (127.0.0.1)'));
  console.log('[mobius-bridge] auth: X-Mobius-Token required on all endpoints except GET /health');
  console.log('[mobius-bridge] tasks: 10-min TTL, 60 s lease, max 3 attempts (requeue on lease expiry)');
});
