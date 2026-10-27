// Minimal POSIX ustar writer (+ PAX extended headers) streamed through gzip.
// Supports regular files and directories. Paths longer than 100 bytes use the
// ustar prefix field when possible, otherwise a PAX "x" header; non-ASCII
// names and sizes >= 8 GiB also use PAX records.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BLOCK = 512;
const MAX_OCTAL_11 = 0o77777777777; // 8 GiB - 1

function writeString(buf, offset, length, value) {
  const b = Buffer.from(value, 'utf8');
  b.copy(buf, offset, 0, Math.min(b.length, length));
}

function writeOctal(buf, offset, length, value) {
  const s = Math.floor(value).toString(8).padStart(length - 1, '0');
  if (s.length > length - 1) throw new Error(`tar: value too large for ${length}-byte octal field`);
  buf.write(`${s}\0`, offset, length, 'latin1');
}

function header({ name, prefix = '', size, mode, mtime, typeflag }) {
  const b = Buffer.alloc(BLOCK);
  writeString(b, 0, 100, name);
  writeOctal(b, 100, 8, mode);
  writeOctal(b, 108, 8, 0); // uid
  writeOctal(b, 116, 8, 0); // gid
  writeOctal(b, 124, 12, size);
  writeOctal(b, 136, 12, mtime);
  b.fill(0x20, 148, 156); // checksum placeholder
  b.write(typeflag, 156, 1, 'latin1');
  b.write('ustar\0', 257, 6, 'latin1');
  b.write('00', 263, 2, 'latin1');
  writeString(b, 265, 32, 'split-brain');
  writeString(b, 297, 32, 'split-brain');
  writeString(b, 345, 155, prefix);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += b[i];
  b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return b;
}

/** Split a path into ustar (prefix, name), or null if it does not fit. */
export function splitUstarPath(p) {
  if (!/^[\x20-\x7e]*$/.test(p)) return null; // non-ASCII -> PAX
  if (p.length <= 100) return { prefix: '', name: p };
  for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) {
    const prefix = p.slice(0, i);
    const name = p.slice(i + 1);
    if (prefix.length <= 155 && name.length <= 100 && name.length > 0) return { prefix, name };
  }
  return null;
}

export function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  const bl = Buffer.byteLength(body);
  let len = bl + String(bl).length;
  if (String(len).length !== String(len - bl).length) len = bl + String(len).length;
  return `${len}${body}`;
}

function pad(size) {
  const r = size % BLOCK;
  return r ? Buffer.alloc(BLOCK - r) : null;
}

/** Headers (PAX + ustar) for one entry. */
export function entryHeaders(entry) {
  const isDirEntry = entry.type === 'dir';
  const fullName = isDirEntry && !entry.name.endsWith('/') ? `${entry.name}/` : entry.name;
  const size = isDirEntry ? 0 : entry.size;
  const mtime = Math.floor((entry.mtime ?? Date.now()) / 1000);
  const mode = entry.mode ?? (isDirEntry ? 0o755 : 0o644);
  const typeflag = isDirEntry ? '5' : '0';
  const split = splitUstarPath(fullName);
  const pax = [];
  if (!split) pax.push(paxRecord('path', fullName));
  if (size > MAX_OCTAL_11) pax.push(paxRecord('size', String(size)));
  const out = [];
  if (pax.length) {
    const data = Buffer.from(pax.join(''), 'utf8');
    const short = fullName.replace(/[^\x20-\x7e]/g, '_').slice(-90);
    out.push(header({ name: `PaxHeader/${short}`.slice(0, 100), size: data.length, mode: 0o644, mtime, typeflag: 'x' }));
    out.push(data);
    const p = pad(data.length);
    if (p) out.push(p);
  }
  const fallback = split || { prefix: '', name: fullName.replace(/[^\x20-\x7e]/g, '_').slice(0, 100) };
  out.push(header({ name: fallback.name, prefix: fallback.prefix, size: size > MAX_OCTAL_11 ? 0 : size, mode, mtime, typeflag }));
  return Buffer.concat(out);
}

async function* tarChunks(entries) {
  for (const e of entries) {
    yield entryHeaders(e);
    if (e.type === 'dir') continue;
    let written = 0;
    if (e.data != null) {
      const d = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
      written = d.length;
      yield d;
    } else {
      for await (const chunk of fs.createReadStream(e.path)) {
        written += chunk.length;
        if (written > e.size) throw new Error(`tar: ${e.name} grew while archiving`);
        yield chunk;
      }
    }
    if (written !== e.size) throw new Error(`tar: ${e.name} changed size while archiving`);
    const p = pad(e.size);
    if (p) yield p;
  }
  yield Buffer.alloc(BLOCK * 2);
}

/**
 * Write entries to a .tar.gz. entries: [{ name, type: 'file'|'dir', path?, data?, size, mtime(ms), mode }]
 * Parent directories are added automatically.
 */
export async function writeTarGz(outPath, entries) {
  const dirs = new Map();
  for (const e of entries) {
    const parts = e.name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = `${parts.slice(0, i).join('/')}/`;
      if (!dirs.has(d)) dirs.set(d, { name: d, type: 'dir', mtime: e.mtime, mode: 0o755 });
    }
  }
  const explicitDirs = new Set(entries.filter((e) => e.type === 'dir').map((e) => (e.name.endsWith('/') ? e.name : `${e.name}/`)));
  const all = [...[...dirs.values()].filter((d) => !explicitDirs.has(d.name)), ...entries];
  all.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
  await pipeline(Readable.from(tarChunks(all)), zlib.createGzip({ level: 9 }), fs.createWriteStream(outPath));
}

/** Minimal reader (used by tests and self-checks): returns [{ name, type, size, data }]. */
export function readTar(buf) {
  const out = [];
  let off = 0;
  let paxPath = null;
  const str = (b, o, l) => b.subarray(o, o + l).toString('utf8').replace(/\0.*$/s, '');
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((x) => x === 0)) break;
    const name = str(h, 0, 100);
    const size = parseInt(str(h, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = h.subarray(257, 262).toString('latin1') === 'ustar' ? str(h, 345, 155) : '';
    const chk = parseInt(str(h, 148, 8).trim(), 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== chk) throw new Error(`tar: bad checksum at offset ${off}`);
    off += BLOCK;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      for (const rec of data.toString('utf8').split('\n')) {
        const m = /^\d+ path=(.*)$/s.exec(rec);
        if (m) paxPath = m[1];
      }
      continue;
    }
    const full = paxPath ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = null;
    out.push({ name: full, type: type === '5' ? 'dir' : 'file', size, data: type === '5' ? null : Buffer.from(data) });
  }
  return out;
}
