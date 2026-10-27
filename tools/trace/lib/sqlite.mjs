// Optional node:sqlite access (Node >= 22.5). Never copies a database into the
// submission: callers extract only this project's records to JSON.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let filterInstalled = false;
/** Hide ExperimentalWarning noise for sqlite/zstd only; other warnings still print. */
export function installWarningFilter() {
  if (filterInstalled) return;
  filterInstalled = true;
  const orig = process.emitWarning;
  process.emitWarning = function filtered(warning, ...rest) {
    const msg = typeof warning === 'string' ? warning : warning?.message || '';
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type || warning?.name || '';
    if (/Experimental/i.test(type) && /sqlite|zstd/i.test(msg)) return undefined;
    return orig.call(process, warning, ...rest);
  };
}

let cached;
export async function loadSqlite() {
  if (cached !== undefined) return cached;
  installWarningFilter();
  try {
    cached = await import('node:sqlite');
    if (typeof cached.DatabaseSync !== 'function') cached = null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Node versions where node:sqlite exists but needs --experimental-sqlite. */
export function sqliteNeedsFlag(version = process.versions.node) {
  const [maj, min] = version.split('.').map(Number);
  return (maj === 22 && min >= 5 && min < 13) || (maj === 23 && min < 4);
}

export const SQLITE_UNAVAILABLE = 'needs Node >= 22.5 with node:sqlite (or run via Docker node:24-slim)';

function rowValueToString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString('utf8');
  return String(v);
}
export { rowValueToString };

/**
 * Open a SQLite file read-only. If that fails (e.g. WAL database on a read-only
 * mount), copy db + -wal + -shm to a private temp dir, read the copy, and delete
 * it on close. Returns { db, close() } or throws.
 */
export function openReadOnly(sqlite, file) {
  try {
    const db = new sqlite.DatabaseSync(file, { readOnly: true });
    db.prepare('select count(*) from sqlite_master').get();
    return { db, close: () => { try { db.close(); } catch { /* ignore */ } } };
  } catch {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-trace-db-'));
    try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
    const base = path.join(dir, 'copy.db');
    fs.copyFileSync(file, base);
    for (const sfx of ['-wal', '-shm']) {
      try { fs.copyFileSync(file + sfx, base + sfx); } catch { /* optional */ }
    }
    const db = new sqlite.DatabaseSync(base, { readOnly: false });
    return {
      db,
      close: () => {
        try { db.close(); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      },
    };
  }
}

export function tableNames(db) {
  return new Set(db.prepare("select name from sqlite_master where type in ('table','view')").all().map((r) => r.name));
}

export function columnNames(db, table) {
  return new Set(db.prepare(`pragma table_info("${table.replace(/"/g, '""')}")`).all().map((r) => r.name));
}
