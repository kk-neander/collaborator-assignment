// Manual: files passed with --include are copied (redacted if text) under
// sessions/manual/. Use this for exports from unsupported tools.
import fs from 'node:fs';
import path from 'node:path';
import { isProbablyBinary, safeId, splitBuffer, statSafe } from '../lib/fsutil.mjs';
import { fileFingerprint, hash8 } from './common.mjs';

export const name = 'manual';
export const label = 'Manual (--include)';

export async function discover(ctx) {
  const includes = ctx.opts.include || [];
  const res = { status: includes.length ? 'ok' : 'not-found', checked: [], candidates: [], notes: [] };
  const used = new Set();
  for (const inc of includes) {
    const file = path.resolve(inc);
    const st = statSafe(file);
    if (!st?.isFile()) { res.notes.push(`--include: not a file: ${inc}`); res.status = 'partial'; continue; }
    const base = path.basename(file);
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 ? base.slice(dot + 1).replace(/[^A-Za-z0-9]/g, '') || 'txt' : 'txt';
    let id = safeId(dot > 0 ? base.slice(0, dot) : base);
    if (used.has(`${id}.${ext}`)) id = `${id}-${hash8(file)}`;
    used.add(`${id}.${ext}`);
    res.candidates.push({
      source: name, id, ext, kind: 'manual', title: null,
      startedAt: null, endedAt: new Date(st.mtimeMs).toISOString(), messageCount: null, toolCallCount: null, models: [],
      cwd: null, matchedBy: 'manual', originalPath: file, sourceBytes: st.size, fingerprint: fileFingerprint(file),
      read: async (cap) => {
        const buf = fs.readFileSync(file);
        if (isProbablyBinary(buf)) return { buffer: buf, binary: true, truncated: false, originalBytes: buf.length };
        return splitBuffer(buf, cap);
      },
    });
  }
  return res;
}
