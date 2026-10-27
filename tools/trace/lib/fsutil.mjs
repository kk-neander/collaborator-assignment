// Small filesystem helpers (no external deps).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import zlib from 'node:zlib';

export function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}
export const isDir = (p) => statSafe(p)?.isDirectory() ?? false;
export const isFile = (p) => statSafe(p)?.isFile() ?? false;

export function readdirSafe(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
}

export function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

export function readJsonSafe(p) {
  const t = readTextSafe(p);
  if (t == null) return null;
  try { return JSON.parse(t.replace(/^﻿/, '')); } catch { return null; }
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export async function sha256File(p) {
  const h = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(p)) {
    h.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: h.digest('hex'), bytes };
}

export function writeFileAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * Recursively yield files under `dir`.
 * opts: maxDepth, skipDirs (Set of names), filter(name, fullPath) -> bool
 */
export function* walkFiles(dir, { maxDepth = 8, skipDirs = new Set(), filter = () => true } = {}, depth = 0) {
  for (const ent of readdirSafe(dir)) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (depth < maxDepth && !skipDirs.has(ent.name)) yield* walkFiles(full, { maxDepth, skipDirs, filter }, depth + 1);
    } else if ((ent.isFile() || ent.isSymbolicLink()) && filter(ent.name, full)) {
      yield full;
    }
  }
}

export const zstdAvailable = () => typeof zlib.zstdDecompressSync === 'function' && typeof zlib.createZstdDecompress === 'function';

function openInput(file) {
  const raw = fs.createReadStream(file);
  if (file.endsWith('.zst')) {
    const d = zlib.createZstdDecompress();
    raw.on('error', (e) => d.destroy(e));
    return raw.pipe(d);
  }
  return raw;
}

/** Stream a (possibly .zst-compressed) file line by line. */
export async function* readLines(file) {
  const input = openInput(file);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    input.destroy?.();
  }
}

// Over-cap sessions keep the first 20% and the last 80% of the cap (10 MB + 40 MB
// at the default 50 MB): the end of a session is usually the most informative.
export const HEAD_SHARE = 0.2;

export function capSplit(cap) {
  const head = Math.floor(cap * HEAD_SHARE);
  return { head, tail: cap - head };
}

/**
 * First <= max bytes of buf, ending on a newline when one exists. `partial`
 * means buf is itself a prefix of something larger, so always realign.
 */
export function cutHead(buf, max, partial = false) {
  const end = Math.min(buf.length, max);
  if (end === buf.length && !partial) return buf;
  const nl = buf.lastIndexOf(0x0a, end - 1);
  return buf.subarray(0, nl > 0 ? nl + 1 : end);
}

/** Last <= max bytes of buf, starting on a line boundary when one exists (see cutHead). */
export function cutTail(buf, max, partial = false) {
  if (buf.length <= max && !partial) return buf;
  const slice = buf.length > max ? buf.subarray(buf.length - max) : buf;
  const nl = slice.indexOf(0x0a);
  return nl >= 0 && nl < slice.length - 1 ? slice.subarray(nl + 1) : slice;
}

/** Split an in-memory buffer into head/tail when it exceeds the cap. */
export function splitBuffer(buf, cap) {
  if (buf.length <= cap) return { head: buf.toString('utf8'), tail: '', truncated: false, originalBytes: buf.length };
  const { head, tail } = capSplit(cap);
  return { head: cutHead(buf, head, true).toString('utf8'), tail: cutTail(buf, tail, true).toString('utf8'), truncated: true, originalBytes: buf.length };
}

/**
 * Read a (possibly .zst) file, keeping all of it when it fits in `cap`, else the
 * first and last parts. Returns { head, tail, truncated, originalBytes }.
 */
export async function readHeadTail(file, cap) {
  const { head: hb, tail: tb } = capSplit(cap);
  if (!file.endsWith('.zst')) {
    const st = fs.statSync(file);
    if (st.size <= cap) return { head: fs.readFileSync(file, 'utf8'), tail: '', truncated: false, originalBytes: st.size };
    const fd = fs.openSync(file, 'r');
    try {
      const h = Buffer.alloc(hb);
      const hn = fs.readSync(fd, h, 0, hb, 0);
      const t = Buffer.alloc(tb);
      const tn = fs.readSync(fd, t, 0, tb, st.size - tb);
      return { head: cutHead(h.subarray(0, hn), hb, true).toString('utf8'), tail: cutTail(t.subarray(0, tn), tb, true).toString('utf8'), truncated: true, originalBytes: st.size };
    } finally {
      fs.closeSync(fd);
    }
  }
  const head = [];
  let headLen = 0;
  const tail = [];
  let tailLen = 0;
  let dropped = false;
  let originalBytes = 0;
  for await (const chunk of openInput(file)) {
    originalBytes += chunk.length;
    let rest = chunk;
    if (headLen < cap) {
      // Keep up to `cap` bytes at the start so small files are returned whole.
      const take = rest.subarray(0, cap - headLen);
      head.push(take);
      headLen += take.length;
      rest = rest.subarray(take.length);
    }
    if (rest.length) {
      tail.push(rest);
      tailLen += rest.length;
      while (tail.length > 1 && tailLen - tail[0].length >= tb) { tailLen -= tail.shift().length; dropped = true; }
    }
  }
  const all = Buffer.concat(head);
  if (originalBytes <= cap) return { head: all.toString('utf8'), tail: '', truncated: false, originalBytes };
  // Tail = last tb bytes of the stream. The head overflow is only contiguous with
  // the kept tail chunks if none were dropped in between.
  const tailBuf = Buffer.concat(dropped ? tail : [all.subarray(hb), ...tail]);
  return { head: cutHead(all, hb, true).toString('utf8'), tail: cutTail(tailBuf, tb, true).toString('utf8'), truncated: true, originalBytes };
}

export function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function toIso(v) {
  if (v == null || v === '') return null;
  let d;
  if (typeof v === 'number') d = new Date(v < 1e12 ? v * 1000 : v);
  else if (typeof v === 'string' && /^\d+$/.test(v)) d = new Date(Number(v) < 1e12 ? Number(v) * 1000 : Number(v));
  else d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Tracks min/max ISO timestamps. */
export class TimeRange {
  constructor() { this.min = null; this.max = null; }
  add(v) {
    const iso = toIso(v);
    if (!iso) return;
    if (!this.min || iso < this.min) this.min = iso;
    if (!this.max || iso > this.max) this.max = iso;
  }
}

export function safeId(id) {
  let s = String(id ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_').replace(/\.+$/, '').slice(0, 180);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = `_${s}`; // Windows reserved names
  return s || 'session';
}
