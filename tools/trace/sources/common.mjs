// Shared helpers for source modules.
//
// A source module exports { name, label, discover(ctx) }. discover() returns
//   { status: 'ok'|'not-found'|'needs-node'|'error', detail?, checked: [dirs],
//     candidates: [Candidate], notes: [string] }
// A Candidate describes one exportable session:
//   { source, id, ext, kind, parentId?, title, startedAt, endedAt, messageCount,
//     toolCallCount, models[], cwd, matchedBy, originalPath, sourceBytes,
//     fingerprint, read(capBytes) -> { head, tail, truncated, originalBytes } | { buffer, binary } }
// Candidates never carry transcript text until read() is called by trace.
import { readHeadTail, sha256, splitBuffer, statSafe } from '../lib/fsutil.mjs';

/** matchedBy for sessions started in a parent folder that mention the project path. */
export const PARENT_MATCH = 'parent-folder+mentions-project';

export function emptyResult(checked = []) {
  return { status: 'not-found', checked, candidates: [], notes: [] };
}

/** True if a session ending at endIso (fallbacks: startIso, mtime) overlaps the window. */
export function overlapsWindow(ctx, { endedAt, startedAt, mtimeMs }) {
  const end = endedAt || startedAt || (mtimeMs ? new Date(mtimeMs).toISOString() : null);
  if (!end) return true;
  return end >= ctx.window.since;
}

/** mtime-based prefilter: a file last written before the window cannot overlap it. */
export function modifiedInWindow(ctx, st) {
  return st && st.mtimeMs >= ctx.window.sinceMs;
}

export function fileFingerprint(files) {
  const parts = [];
  for (const f of [].concat(files)) {
    const st = statSafe(f);
    parts.push(st ? `${st.size}:${Math.round(st.mtimeMs)}` : 'missing');
  }
  return parts.join('|');
}

export function fileReader(file) {
  return (cap) => readHeadTail(file, cap);
}

/** Serialise a JSON export; over the cap it is split into head/tail (trace re-wraps it as valid JSON). */
export function jsonText(obj, cap) {
  return splitBuffer(Buffer.from(`${JSON.stringify(obj, null, 2)}\n`, 'utf8'), cap);
}

export function hash8(s) {
  return sha256(String(s)).slice(0, 8);
}

/** Cached matcher lookups for recorded cwd strings. */
export function cwdMatcher(ctx) {
  if (!ctx.cwdCache) ctx.cwdCache = new Map();
  return (cwd) => {
    if (typeof cwd !== 'string' || !cwd) return null;
    if (!ctx.cwdCache.has(cwd)) {
      const root = ctx.matcher.match(cwd);
      ctx.cwdCache.set(cwd, { root, ancestor: !root && ctx.matcher.isAncestorOfRoot(cwd) });
    }
    return ctx.cwdCache.get(cwd);
  };
}
