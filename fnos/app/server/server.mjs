// server.mjs — the fnOS side of SpektraLab.
//
// One process, no npm dependencies, Node.js 22 (the `nodejs_v22` runtime the
// package declares in `manifest`). It does three things:
//
//   1. serves the built interface (`web/`) under the unified-gateway prefix;
//   2. owns `spektralab-host` — spawns it, relays the binary frames of
//      `desktop/HOST-PROTOCOL.md`, restarts it when a GPU driver fault takes it
//      down, and keeps the last of its stderr for the failure dialog;
//   3. is the interface's file system: listing, sidecars, small JSON stores,
//      uploads and downloads, scoped to the directories fnOS has authorised.
//
// Pixels never go through JSON. A host request and its reply are the protocol's
// own framing (u32 header_len, u32 payload_len, JSON, binary), streamed in both
// directions so a 45 MP `write_image` does not sit in this process's heap.
//
// Environment comes from fnOS (see core-concepts/environment-variables):
//   TRIM_APPDEST, TRIM_PKGVAR, TRIM_PKGHOME, TRIM_DATA_SHARE_PATHS,
//   TRIM_DATA_ACCESSIBLE_PATHS, TRIM_APPVER
// Local development may set SPK_APPDEST / SPK_PKGVAR / SPK_PORT instead.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = process.env.SPK_APPDEST || path.resolve(HERE, '..');
const WEB_DIR = path.join(HERE, 'web');
const HOST_BIN = process.env.SPK_HOST || path.join(APP_ROOT, 'host', 'spektralab-host');
const ENGINE_DIR = process.env.SPK_ENGINE || path.join(APP_ROOT, 'host', 'engine');
const VAR_DIR = process.env.SPK_PKGVAR || process.env.TRIM_PKGVAR || path.resolve(APP_ROOT, '..', 'var');
const HOME_DIR = process.env.TRIM_PKGHOME || VAR_DIR;
const SOCKET_PATH = process.env.SPK_SOCKET || process.env.TRIM_APPDEST_SOCKET || path.join(APP_ROOT, 'app.sock');
const TCP_PORT = Number(process.env.SPK_PORT || 0);
const VERSION = process.env.TRIM_APPVER || process.env.SPK_VERSION || '1.3.6';

// The engine inherits this process's environment. fnOS does not create the
// package user's passwd home (/home/spektralab), and Mesa disables its pipeline
// cache when it cannot write $HOME/.cache — point the host at the package's own
// home and a cache under var/ before it is spawned. (cmd/main sets the same
// two variables; this is the belt to its braces for a host started by hand.)
if (process.env.TRIM_PKGHOME) process.env.HOME = process.env.TRIM_PKGHOME;
if (!process.env.XDG_CACHE_HOME) process.env.XDG_CACHE_HOME = path.join(VAR_DIR, 'cache');

const PREFIX = '/app/spektralab';
const IMAGE_EXTENSIONS = new Set([
  '3fr', 'ari', 'arw', 'bay', 'cr2', 'cr3', 'crw', 'dcr', 'dng', 'erf', 'fff', 'iiq', 'k25', 'kdc', 'mef',
  'mos', 'mrw', 'nef', 'nrw', 'orf', 'pef', 'raf', 'raw', 'rw2', 'rwl', 'sr2', 'srf', 'srw', 'x3f',
  'tif', 'tiff', 'jpg', 'jpeg', 'png',
]);

const log = (...a) => console.log(new Date().toISOString(), ...a);
const logError = (...a) => console.error(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- directories

function splitPaths(value) {
  return String(value || '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
}

const dataShares = splitPaths(process.env.TRIM_DATA_SHARE_PATHS);
const accessible = splitPaths(process.env.TRIM_DATA_ACCESSIBLE_PATHS);
const uploadsDir = path.join(VAR_DIR, 'uploads');
const exportsDir = dataShares[0] || path.join(VAR_DIR, 'exports');
const sidecarsDir = path.join(VAR_DIR, 'sidecars');
const storeDir = path.join(VAR_DIR, 'store');

for (const d of [VAR_DIR, uploadsDir, sidecarsDir, storeDir, exportsDir, HOME_DIR, process.env.XDG_CACHE_HOME]) {
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch (e) {
    logError('mkdir', d, e.message);
  }
}

/** The roots the interface may browse. Everything else is refused. */
const roots = [];
function addRoot(label, dir, kind) {
  if (!dir) return;
  const p = path.resolve(dir);
  if (roots.some((r) => r.path === p)) return;
  roots.push({ label, path: p, kind });
}
addRoot('导出 / Exports', exportsDir, 'exports');
for (const p of dataShares) addRoot(`共享 / ${path.basename(p)}`, p, 'share');
for (const p of accessible) addRoot(`已授权 / ${path.basename(p)}`, p, 'authorized');
addRoot('上传 / Uploads', uploadsDir, 'uploads');
addRoot('应用数据 / App data', VAR_DIR, 'data');
if (HOME_DIR !== VAR_DIR) addRoot('用户目录 / Home', HOME_DIR, 'home');

function canonical(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    // A path that does not exist yet: canonicalise the nearest parent.
    try {
      return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      return abs;
    }
  }
}

function isWithin(root, p) {
  const r = canonical(root);
  const q = canonical(p);
  return q === r || q.startsWith(r + path.sep);
}

function insideRoots(p) {
  return roots.some((r) => isWithin(r.path, p));
}

/** A user-supplied path -> canonical absolute path inside a declared root. */
function safePath(raw, { mustExist = false } = {}) {
  if (typeof raw !== 'string' || !raw || raw.includes('\0')) throw httpError(400, 'bad path');
  if (!path.isAbsolute(raw)) throw httpError(400, 'path must be absolute');
  const p = canonical(raw);
  if (!insideRoots(p)) throw httpError(403, 'path is outside the authorised folders');
  if (mustExist && !fs.existsSync(p)) throw httpError(404, 'not found');
  return p;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function isImage(name) {
  const ext = name.toLowerCase().split('.').pop();
  return IMAGE_EXTENSIONS.has(ext);
}

function entryFor(p) {
  const st = fs.statSync(p);
  return {
    path: p,
    name: path.basename(p),
    size: st.size,
    mtime_ms: st.mtimeMs,
    type: st.isDirectory() ? 'dir' : 'file',
    image: st.isFile() && isImage(path.basename(p)),
  };
}

async function listDir(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const d of entries) {
    if (d.name.startsWith('.')) continue;
    const p = path.join(dir, d.name);
    let st;
    try {
      st = await fsp.lstat(p);
    } catch {
      continue;
    }
    // Symlinks are not followed: a link inside a share must not become a way
    // out of the authorised roots.
    if (st.isSymbolicLink()) continue;
    if (!st.isDirectory() && !(st.isFile() && isImage(d.name))) continue;
    out.push({
      path: p,
      name: d.name,
      size: st.size,
      mtime_ms: st.mtimeMs,
      type: st.isDirectory() ? 'dir' : 'file',
      image: st.isFile() && isImage(d.name),
    });
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1));
  return out;
}

async function listImages(dir) {
  return (await listDir(dir)).filter((e) => e.type === 'file' && e.image).map(({ type, image, ...e }) => e);
}

async function expand(paths) {
  const out = [];
  for (const raw of Array.isArray(paths) ? paths : []) {
    let p;
    try {
      p = safePath(raw, { mustExist: true });
    } catch {
      continue;
    }
    let st;
    try {
      st = await fsp.stat(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...(await listImages(p)));
    else if (st.isFile() && isImage(p)) out.push(entryFor(p));
  }
  return out;
}

// -------------------------------------------------------------------- sidecars

function standardized(p) {
  return path.resolve(p);
}

function sidecarKey(image) {
  const hex = createHash('sha256').update(Buffer.from(standardized(image), 'utf8')).digest('hex');
  return `${path.basename(image)}-${hex.slice(0, 16)}.spektra.json`;
}

function identity(image) {
  const p = standardized(image);
  const v = { path: p };
  try {
    const st = fs.statSync(image);
    v.size = st.size;
    v.inode = st.ino;
    v.volumeID = st.dev;
  } catch {
    /* a frame that has not landed yet */
  }
  return v;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

async function writeAtomic(target, text) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.partial-${process.pid}`;
  await fsp.writeFile(tmp, text);
  await fsp.rename(tmp, target);
}

function userSidecarsDir(user) {
  return path.join(sidecarsDir, safeUser(user));
}

async function sidecarPath(image, user) {
  return path.join(userSidecarsDir(user), sidecarKey(image));
}

async function sidecarLoad(image, user) {
  const own = await sidecarPath(image, user);
  const v = readJson(own);
  if (v) return v;
  // A moved frame: a sidecar whose remembered file is gone and whose
  // fingerprint (inode + volume + size) is this file's.
  const wanted = identity(image);
  if (wanted.inode !== undefined) {
    let names = [];
    try {
      names = await fsp.readdir(userSidecarsDir(user));
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith('.spektra.json')) continue;
      const p = path.join(userSidecarsDir(user), name);
      const old = readJson(p);
      const src = old && old.source;
      if (!src) continue;
      const remembered = typeof src.path === 'string' ? src.path : '';
      if (!remembered || fs.existsSync(remembered)) continue;
      if (src.inode === wanted.inode && src.volumeID === wanted.volumeID && src.size === wanted.size) {
        old.source = wanted;
        await writeAtomic(own, JSON.stringify(old, null, 2));
        if (p !== own) await fsp.rm(p, { force: true });
        return old;
      }
    }
  }
  return null;
}

async function sidecarSave(image, sidecar, user) {
  const v = { ...sidecar, source: identity(image) };
  const target = await sidecarPath(image, user);
  await writeAtomic(target, JSON.stringify(v, null, 2));
  return target;
}

function safeUser(raw) {
  const s = String(raw || 'local');
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : 'local';
}

// ------------------------------------------------------------------- host link

class ByteQueue {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  push(c) {
    if (c.length) {
      this.chunks.push(c);
      this.length += c.length;
    }
  }
  take(n) {
    if (n <= 0) return Buffer.alloc(0);
    const first = this.chunks[0];
    if (first.length >= n) {
      const out = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.length -= n;
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const c = this.chunks[0];
      const k = Math.min(c.length, n - off);
      c.copy(out, off, 0, k);
      off += k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    this.length -= n;
    return out;
  }
}

const MAX_HEADER = 64 * 1024 * 1024;

// A session owns the decoded frame and every render texture made from it. The
// interface closes its session when it switches frames, but a closed tab or a
// crashed browser never gets to: the engine then keeps that memory until the
// app is stopped. Close the tab, wait this long, and the engine is restarted so
// the memory is actually returned. Long enough that a reload, a tab switch or a
// second window does not pay for a restart; short enough that "I quit the app"
// does not leave a 24 MP frame resident for the rest of the day.
const IDLE_RESTART_MS = Number(process.env.SPK_IDLE_RESTART_MS || 90_000);

class HostLink {
  constructor() {
    this.child = null;
    this.queue = new ByteQueue();
    this.pending = new Map();
    this.nextId = 1;
    this.state = { phase: 'starting' };
    this.stderrTail = [];
    this.stopping = false;
    this.restarts = [];
    this.writeChain = Promise.resolve();
    this.hello = null;
    this.sse = new Set();
    this.lastFailure = null;
    this.lastActivity = Date.now();
    this.idleTimer = null;
  }

  /** Any request or event from the interface means somebody is still there. */
  touch() {
    this.lastActivity = Date.now();
    this.disarmIdle();
  }

  disarmIdle() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Armed when the last event-stream client goes away. */
  armIdle() {
    this.disarmIdle();
    const wait = Math.max(0, this.lastActivity + IDLE_RESTART_MS - Date.now());
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.sse.size > 0) return;
      if (this.pending.size > 0) {
        // A long render or export is still in flight; it is not idle.
        this.lastActivity = Date.now();
        this.armIdle();
        return;
      }
      if (Date.now() - this.lastActivity < IDLE_RESTART_MS) {
        this.armIdle();
        return;
      }
      log(`no interface for ${Math.round(IDLE_RESTART_MS / 1000)} s; restarting the engine to release its sessions`);
      void this.restart();
    }, wait);
    // Never keep the process alive just to do this.
    this.idleTimer.unref?.();
  }

  snapshot() {
    if (this.state.phase === 'ready') return { phase: 'ready', hello: this.hello };
    return this.state;
  }

  broadcast() {
    const data = JSON.stringify(this.snapshot());
    for (const res of this.sse) {
      try {
        res.write(`event: state\ndata: ${data}\n\n`);
      } catch {
        this.sse.delete(res);
      }
    }
  }

  setState(state) {
    this.state = state;
    this.broadcast();
  }

  start() {
    this.stopping = false;
    if (this.child) return;
    this.setState({ phase: 'starting' });
    let child;
    try {
      child = spawn(HOST_BIN, ['--resources', ENGINE_DIR, '--log-level', 'info'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (e) {
      this.setState({ phase: 'failed', reason: `cannot start ${HOST_BIN}: ${e.message}` });
      return;
    }
    this.child = child;
    this.queue = new ByteQueue();
    child.stdout.on('data', (c) => this.onStdout(c));
    child.stderr.on('data', (c) => {
      for (const line of c.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        while (this.stderrTail.length > 80) this.stderrTail.shift();
        logError('[host]', line);
      }
    });
    child.on('error', (e) => {
      this.fail(`host failed to start: ${e.message}`);
    });
    child.on('exit', (code, signal) => {
      const was = this.child;
      this.child = null;
      if (this.stopping) return;
      logError(`host exited (${code ?? 'signal'} ${signal ?? ''})`);
      this.failAll({ code: 'host_exited', message: `the engine process exited (${code ?? signal})` });
      this.scheduleRestart(code, signal);
      void was;
    });
    this.helloRequest();
  }

  async helloRequest() {
    try {
      const { header } = await this.requestBuffer({ method: 'hello', params: {} }, 45_000);
      if (header && header.ok) {
        this.hello = header.result;
        this.setState({ phase: 'ready', hello: header.result });
        log('engine ready', header.result?.backend?.device_name ?? header.result?.backend?.error ?? '');
      } else {
        this.setState({ phase: 'failed', reason: header?.error?.message ?? 'the engine did not answer hello', detail: this.stderrTail.join('\n') });
      }
    } catch (e) {
      this.setState({ phase: 'failed', reason: e.message, detail: this.stderrTail.join('\n') });
    }
  }

  scheduleRestart(code, signal) {
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 120_000);
    this.restarts.push(now);
    if (this.restarts.length > 3) {
      this.setState({
        phase: 'failed',
        reason: `the engine stopped ${this.restarts.length} times in two minutes (${code ?? signal})`,
        detail: this.stderrTail.join('\n'),
      });
      return;
    }
    this.setState({ phase: 'restarting', reason: `the engine stopped (${code ?? signal})`, attempt: this.restarts.length });
    setTimeout(() => {
      if (!this.stopping) this.start();
    }, 1000);
  }

  fail(reason) {
    this.lastFailure = reason;
    this.setState({ phase: 'failed', reason, detail: this.stderrTail.join('\n') });
  }

  failAll(error) {
    for (const [, p] of this.pending) {
      if (p.kind === 'buffer') p.reject(new Error(error.message));
      else if (!p.res.headersSent) {
        try {
          p.res.writeHead(502, { 'content-type': 'application/json' });
          p.res.end(JSON.stringify({ ok: false, error }));
        } catch {
          /* gone */
        }
      } else {
        try {
          p.res.destroy();
        } catch {
          /* gone */
        }
      }
    }
    this.pending.clear();
  }

  async stop() {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* already gone */
    }
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone */
        }
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
  }

  async restart() {
    log('restart requested');
    this.restarts = [];
    await this.stop();
    this.stopping = false;
    this.start();
  }

  /** A request whose reply is small enough to buffer (hello, diagnostics). */
  requestBuffer(req, timeoutMs = 120_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`host request ${req.method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        kind: 'buffer',
        chunks: [],
        remaining: 0,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.enqueueWrite(this.frameFor({ id, ...req }), (e) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  frameFor(header, payload) {
    const text = Buffer.from(JSON.stringify(header), 'utf8');
    const body = payload || Buffer.alloc(0);
    const prefix = Buffer.alloc(8);
    prefix.writeUInt32LE(text.length, 0);
    prefix.writeUInt32LE(body.length, 4);
    return [prefix, text, body];
  }

  enqueueWrite(parts, onError) {
    const run = async () => {
      try {
        for (const part of parts) await this.write(part);
      } catch (e) {
        onError?.(e);
      }
    };
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }

  write(buf) {
    return new Promise((resolve, reject) => {
      const child = this.child;
      if (!child || !child.stdin.writable) {
        reject(new Error('the engine is not running'));
        return;
      }
      if (child.stdin.write(buf)) resolve();
      else child.stdin.once('drain', resolve);
    });
  }

  /** A request whose HTTP body is the protocol frame; streamed to the host. */
  async pipeRequest(req, res) {
    this.touch();
    const q = new ByteQueue();
    const idRef = { id: 0 };
    let header = null;
    let remaining = 0;
    let pendingSet = false;

    const takeHeader = () => {
      if (q.length < 8) return false;
      const head = q.take(8);
      const hlen = head.readUInt32LE(0);
      const plen = head.readUInt32LE(4);
      if (hlen > MAX_HEADER) throw new Error(`header length ${hlen} exceeds bound`);
      if (q.length < hlen) {
        // Put it back; wait for the rest. (A header this size is not expected;
        // the request headers the interface sends are a few hundred bytes.)
        q.chunks.unshift(Buffer.concat([head]));
        q.length += 8;
        return false;
      }
      const text = q.take(hlen).toString('utf8');
      header = JSON.parse(text);
      if (!header || typeof header !== 'object' || typeof header.method !== 'string') throw new Error('bad request header');
      idRef.id = this.nextId++;
      header.id = idRef.id;
      remaining = plen;
      this.pending.set(idRef.id, { kind: 'http', res, headerWritten: false });
      const out = Buffer.from(JSON.stringify(header), 'utf8');
      const prefix = Buffer.alloc(8);
      prefix.writeUInt32LE(out.length, 0);
      prefix.writeUInt32LE(plen, 4);
      this.enqueueWrite([prefix, out], (e) => this.failRequest(idRef.id, e));
      pendingSet = true;
      return true;
    };

    try {
      for await (const chunk of req) {
        q.push(chunk);
        if (!header) {
          while (!header && takeHeader()) {
            /* header parsed */
          }
        }
        if (header) {
          const take = Math.min(q.length, remaining);
          if (take > 0) {
            const piece = q.take(take);
            remaining -= take;
            await this.write(piece);
          }
          if (remaining === 0) {
            // The client sent exactly one frame. Anything after it is a bug.
            break;
          }
        }
      }
      if (!header) {
        throw new Error('request ended before its header');
      }
      if (remaining !== 0) throw new Error(`request ended ${remaining} bytes short of its payload`);
      if (!pendingSet) throw new Error('request was not registered');
      void res;
    } catch (e) {
      if (idRef.id) this.failRequest(idRef.id, e);
      else {
        try {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: { code: 'bad_request', message: e.message } }));
        } catch {
          /* gone */
        }
      }
    }
    // A client that never opened the event stream (or lost it silently) still
    // gets the same backstop once its request is done.
    if (this.sse.size === 0) this.armIdle();
  }

  failRequest(id, e) {
    const p = this.pending.get(id);
    this.pending.delete(id);
    if (!p) return;
    if (p.kind === 'buffer') {
      p.reject(e);
      return;
    }
    try {
      if (!p.res.headersSent) {
        p.res.writeHead(502, { 'content-type': 'application/json' });
        p.res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: e.message } }));
      } else {
        p.res.destroy();
      }
    } catch {
      /* gone */
    }
  }

  onStdout(chunk) {
    this.queue.push(chunk);
    for (;;) {
      if (!this.frame) {
        if (this.queue.length < 8) break;
        const head = this.queue.take(8);
        const hlen = head.readUInt32LE(0);
        const plen = head.readUInt32LE(4);
        if (hlen > MAX_HEADER) {
          logError('host sent an oversized header; restarting it');
          this.restart();
          return;
        }
        if (this.queue.length < hlen) {
          this.queue.chunks.unshift(Buffer.concat([head]));
          this.queue.length += 8;
          break;
        }
        const text = this.queue.take(hlen).toString('utf8');
        let header;
        try {
          header = JSON.parse(text);
        } catch {
          logError('host sent malformed JSON; restarting it');
          this.restart();
          return;
        }
        this.frame = { header, prefix: Buffer.concat([head, Buffer.from(text, 'utf8')]), plen, remaining: plen };
        const id = header.id;
        if (header.event) {
          this.frame.pending = null;
          const data = JSON.stringify(header);
          for (const res of this.sse) {
            try {
              res.write(`event: host\ndata: ${data}\n\n`);
            } catch {
              this.sse.delete(res);
            }
          }
        } else {
          const p = this.pending.get(id);
          this.frame.pending = p || null;
          if (p) this.pending.delete(id);
          if (p && p.kind === 'http') {
            if (!p.res.headersSent) p.res.writeHead(200, { 'content-type': 'application/octet-stream' });
            p.res.write(this.frame.prefix);
          } else if (p && p.kind === 'buffer') {
            p.chunks.push(this.frame.prefix);
          }
        }
      }
      const take = Math.min(this.queue.length, this.frame.remaining);
      if (take > 0) {
        const piece = this.queue.take(take);
        this.frame.remaining -= take;
        const p = this.frame.pending;
        if (p && p.kind === 'http') p.res.write(piece);
        else if (p && p.kind === 'buffer') p.chunks.push(piece);
      }
      if (this.frame.remaining === 0) {
        const { header, pending } = this.frame;
        this.frame = null;
        if (pending && pending.kind === 'http') pending.res.end();
        else if (pending && pending.kind === 'buffer') {
          const body = Buffer.concat(pending.chunks);
          let parsed = null;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            parsed = null;
          }
          if (parsed && parsed.ok === false) pending.reject(new Error(parsed.error?.message ?? 'host error'));
          else pending.resolve({ header: parsed ?? header, payload: Buffer.alloc(0) });
        }
        continue;
      }
      break;
    }
  }
}

const host = new HostLink();

// ------------------------------------------------------------------ HTTP glue

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

async function readJsonBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw httpError(413, 'request body too large');
    chunks.push(c);
  }
  if (!n) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function userOf(req) {
  return safeUser(req.headers['x-trim-userid']);
}

function mimeFor(p) {
  switch (path.extname(p).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.mjs': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.svg': return 'image/svg+xml';
    case '.woff2': return 'font/woff2';
    case '.txt': return 'text/plain; charset=utf-8';
    case '.map': return 'application/json; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function serveStatic(req, res, pathname) {
  let rel = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : pathname;
  if (!rel.startsWith('/')) rel = '/' + rel;
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const target = path.normalize(path.join(WEB_DIR, decodeURIComponent(rel)));
  if (!isWithin(WEB_DIR, target)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  let file = target;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // SPA fallback: only for routes without a file extension.
    if (path.extname(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    file = path.join(WEB_DIR, 'index.html');
  }
  const st = fs.statSync(file);
  res.writeHead(200, {
    'content-type': mimeFor(file),
    'content-length': st.size,
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
}

function redirect(res, location) {
  res.writeHead(301, { location });
  res.end();
}

async function handleApi(req, res, url) {
  const p = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : url.pathname;
  const q = url.searchParams;
  const user = userOf(req);

  // The host bridge. The body is one protocol frame; the reply is one frame.
  if (p === '/api/host' && req.method === 'POST') {
    await host.pipeRequest(req, res);
    return;
  }
  if (p === '/api/host/state' && req.method === 'GET') {
    host.touch();
    json(res, 200, host.snapshot());
    return;
  }
  if (p === '/api/host/restart' && req.method === 'POST') {
    await host.restart();
    json(res, 200, { ok: true });
    return;
  }
  if (p === '/api/host/diagnostics' && req.method === 'GET') {
    json(res, 200, {
      state: host.state,
      hello: host.hello,
      binary: HOST_BIN,
      resources: ENGINE_DIR,
      stderr: host.stderrTail,
      restarts: host.restarts.length,
      version: VERSION,
    });
    return;
  }
  if (p === '/api/host/events' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`event: state\ndata: ${JSON.stringify(host.snapshot())}\n\n`);
    host.touch();
    host.sse.add(res);
    const timer = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(timer);
        host.sse.delete(res);
      }
    }, 20_000);
    req.on('close', () => {
      clearInterval(timer);
      host.sse.delete(res);
      // The last window is gone. Give a reload a grace period, then let the
      // engine go so a closed tab stops holding a decoded frame.
      if (host.sse.size === 0) host.armIdle();
    });
    return;
  }

  if (p === '/api/app-paths' && req.method === 'GET') {
    json(res, 200, {
      appData: VAR_DIR,
      sidecars: sidecarsDir,
      logs: VAR_DIR,
      home: HOME_DIR,
      pictures: accessible[0] || HOME_DIR,
      os: 'linux',
      version: VERSION,
    });
    return;
  }

  if (p === '/api/fs/roots' && req.method === 'GET') {
    json(res, 200, { roots });
    return;
  }

  if (p === '/api/fs/list' && req.method === 'GET') {
    const dir = safePath(q.get('dir') || roots[0]?.path || VAR_DIR, { mustExist: true });
    const entries = await listDir(dir);
    const parent = roots.some((r) => isWithin(r.path, path.dirname(dir)) && dir !== r.path) ? path.dirname(dir) : null;
    json(res, 200, { dir, parent, entries });
    return;
  }

  if (p === '/api/fs/expand' && req.method === 'POST') {
    const body = await readJsonBody(req);
    json(res, 200, { entries: await expand(body.paths) });
    return;
  }

  if (p === '/api/fs/exists' && req.method === 'GET') {
    let exists = false;
    try {
      exists = fs.existsSync(safePath(q.get('path') || '', {}));
    } catch {
      exists = false;
    }
    json(res, 200, { exists });
    return;
  }

  if (p === '/api/fs/mkdir' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const dir = safePath(body.path || '', {});
    await fsp.mkdir(dir, { recursive: true });
    json(res, 200, { ok: true, path: dir });
    return;
  }

  if (p === '/api/upload' && req.method === 'POST') {
    const rawName = path.basename(String(q.get('name') || 'upload.bin')).replace(/[^\w.\- ()\[\]]+/g, '_').slice(0, 180);
    const dir = path.join(uploadsDir, user);
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${Date.now()}-${rawName || 'upload.bin'}`);
    const out = createWriteStream(target, { flags: 'wx' });
    await new Promise((resolve, reject) => {
      req.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      req.on('error', reject);
    });
    json(res, 200, { ok: true, entry: entryFor(target) });
    return;
  }

  if (p === '/api/download' && req.method === 'GET') {
    const file = safePath(q.get('path') || '', { mustExist: true });
    const st = fs.statSync(file);
    if (!st.isFile()) throw httpError(400, 'not a file');
    res.writeHead(200, {
      'content-type': mimeFor(file),
      'content-length': st.size,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
    });
    createReadStream(file).pipe(res);
    return;
  }

  if (p === '/api/sidecar' && req.method === 'GET') {
    const image = safePath(q.get('image') || '', {});
    const v = await sidecarLoad(image, user);
    if (!v) {
      json(res, 404, { ok: false });
      return;
    }
    json(res, 200, v);
    return;
  }
  if (p === '/api/sidecar' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const image = safePath(body.image || '', {});
    const target = await sidecarSave(image, body.sidecar || {}, user);
    json(res, 200, { path: target });
    return;
  }
  if (p === '/api/sidecar/path' && req.method === 'GET') {
    const image = safePath(q.get('image') || '', {});
    json(res, 200, { path: await sidecarPath(image, user) });
    return;
  }

  if (p === '/api/store' && req.method === 'GET') {
    const area = String(q.get('area') || '');
    const name = String(q.get('name') || '');
    const file = storeFile(user, area, name);
    if (!fs.existsSync(file)) {
      json(res, 404, { ok: false });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
    return;
  }
  if (p === '/api/store' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const file = storeFile(user, String(body.area || ''), String(body.name || ''));
    await writeAtomic(file, JSON.stringify(body.value ?? null, null, 2));
    json(res, 200, { ok: true });
    return;
  }

  json(res, 404, { ok: false, error: 'unknown endpoint' });
}

function storeFile(user, area, name) {
  const ok = (s) => s.length > 0 && s.length <= 128 && /^[A-Za-z0-9._-]+$/.test(s) && !s.startsWith('.');
  if (!ok(area) || !ok(name)) throw httpError(400, 'bad store name');
  return path.join(storeDir, user, area, name);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  // A gateway entry may arrive without the trailing slash; relative asset
  // URLs only resolve correctly with it.
  if (pathname === PREFIX) {
    redirect(res, PREFIX + '/' + url.search);
    return;
  }
  if (pathname.startsWith(PREFIX + '/api/') || pathname.startsWith('/api/')) {
    void handleApi(req, res, url).catch((e) => {
      const status = e.status || 500;
      if (!res.headersSent) json(res, status, { ok: false, error: e.message });
      else res.destroy();
      if (status >= 500) logError('api', pathname, e.stack || e.message);
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('method not allowed');
    return;
  }
  serveStatic(req, res, pathname);
});

// Long renders and large exports: no request timeout, no idle socket timeout
// while a render is in flight.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 120_000;

function shutdown(signal) {
  log('shutting down', signal);
  void host.stop().finally(() => {
    server.close(() => process.exit(0));
    try {
      fs.rmSync(SOCKET_PATH, { force: true });
    } catch {
      /* gone */
    }
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => logError('uncaught', e.stack || e.message));
process.on('unhandledRejection', (e) => logError('unhandled', e?.stack || String(e)));

host.start();

if (TCP_PORT) {
  server.listen(TCP_PORT, '127.0.0.1', () => {
    log(`SpektraLab on http://127.0.0.1:${TCP_PORT}${PREFIX}/`);
  });
} else {
  try {
    fs.rmSync(SOCKET_PATH, { force: true });
  } catch {
    /* gone */
  }
  server.listen(SOCKET_PATH, () => {
    try {
      fs.chmodSync(SOCKET_PATH, 0o666);
    } catch {
      /* the gateway runs as root and can connect regardless */
    }
    log(`SpektraLab listening on ${SOCKET_PATH}`);
  });
}
