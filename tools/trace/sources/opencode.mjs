// OpenCode (best effort; formats have changed across versions).
// File storage: <data>/opencode/storage/session/<projectID>/<sessionID>.json
// (field `directory`), messages in storage/message/<sessionID>/*.json, parts in
// storage/part/<messageID>/*.json. Older layouts nest them under
// storage/session/{info,message,part}/. Newer versions may use a SQLite DB with
// `session` / `message` / `part` tables — handled generically when node:sqlite exists.
import path from 'node:path';
import { isDir, readdirSafe, readJsonSafe, sha256, statSafe, TimeRange, walkFiles } from '../lib/fsutil.mjs';
import { columnNames, loadSqlite, openReadOnly, rowValueToString, tableNames } from '../lib/sqlite.mjs';
import { emptyResult, jsonText, overlapsWindow } from './common.mjs';

export const name = 'opencode';
export const label = 'OpenCode';

function jsonFiles(dir) {
  return readdirSafe(dir).filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => path.join(dir, e.name));
}

function summarize(session, messages) {
  const tr = new TimeRange();
  for (const v of [session?.time?.created, session?.time?.updated, session?.time_created, session?.time_updated, session?.created_at, session?.updated_at]) tr.add(v);
  const models = new Set();
  let tools = 0;
  for (const m of messages) {
    for (const v of [m.info?.time?.created, m.info?.time?.completed, m.info?.time_created, m.info?.created_at]) tr.add(v);
    const model = m.info?.modelID || m.info?.model?.modelID;
    if (model) models.add(model);
    for (const p of m.parts) if (p?.type === 'tool' || p?.type === 'tool-invocation') tools++;
  }
  return { startedAt: tr.min, endedAt: tr.max, messageCount: messages.length, toolCallCount: tools, models: [...models] };
}

function fileStorageSessions(storage) {
  const projects = new Map();
  for (const f of jsonFiles(path.join(storage, 'project'))) {
    const p = readJsonSafe(f);
    if (p?.id) projects.set(p.id, p.worktree || p.directory || null);
  }
  const sessions = [];
  const sessionRoot = path.join(storage, 'session');
  for (const f of walkFiles(sessionRoot, { maxDepth: 2, skipDirs: new Set(['message', 'part']), filter: (n) => n.endsWith('.json') })) {
    const s = readJsonSafe(f);
    if (!s?.id || typeof s.id !== 'string') continue;
    const directory = s.directory || projects.get(s.projectID) || null;
    sessions.push({ session: s, directory, file: f });
  }
  return sessions;
}

function fileStorageMessages(storage, sessionId) {
  const msgDirs = [path.join(storage, 'message', sessionId), path.join(storage, 'session', 'message', sessionId)];
  const files = [];
  const messages = [];
  for (const d of msgDirs) {
    for (const f of jsonFiles(d)) {
      const info = readJsonSafe(f);
      if (!info?.id) continue;
      files.push(f);
      const partDirs = [path.join(storage, 'part', info.id), path.join(storage, 'session', 'part', sessionId, info.id)];
      const parts = [];
      for (const pd of partDirs) for (const pf of jsonFiles(pd)) { const p = readJsonSafe(pf); if (p) { parts.push(p); files.push(pf); } }
      parts.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      messages.push({ info, parts });
    }
  }
  messages.sort((a, b) => (a.info?.time?.created ?? 0) - (b.info?.time?.created ?? 0) || String(a.info.id).localeCompare(String(b.info.id)));
  return { messages, files };
}

function filesFingerprint(files) {
  return sha256(files.map((f) => { const st = statSafe(f); return `${f}:${st?.size}:${Math.round(st?.mtimeMs ?? 0)}`; }).join('\n')).slice(0, 16);
}

function rowObject(row) {
  const o = {};
  for (const [k, v] of Object.entries(row)) {
    const s = typeof v === 'string' || v instanceof Uint8Array ? rowValueToString(v) : v;
    if (typeof s === 'string' && /^[[{]/.test(s)) { try { o[k] = JSON.parse(s); continue; } catch { /* keep string */ } }
    o[k] = s;
  }
  // drizzle-style rows keep the document in a `data` column
  if (o.data && typeof o.data === 'object' && !Array.isArray(o.data)) return { ...o.data, ...o, data: undefined };
  return o;
}

async function sqliteSessions(dbFile, ctx, res) {
  const sqlite = await loadSqlite();
  if (!sqlite) { res.notes.push('an OpenCode SQLite database was found but node:sqlite is unavailable (needs Node >= 22.5)'); return []; }
  let h;
  try { h = openReadOnly(sqlite, dbFile); } catch (e) { res.notes.push(`could not open an OpenCode DB (${e.code || e.name})`); return []; }
  const out = [];
  try {
    const tables = tableNames(h.db);
    if (!tables.has('session')) return [];
    const sessCols = columnNames(h.db, 'session');
    const msgCols = tables.has('message') ? columnNames(h.db, 'message') : new Set();
    const partCols = tables.has('part') ? columnNames(h.db, 'part') : new Set();
    const msgFk = ['session_id', 'sessionID', 'sessionId'].find((c) => msgCols.has(c));
    const partMsgFk = ['message_id', 'messageID', 'messageId'].find((c) => partCols.has(c));
    for (const row of h.db.prepare('select * from session').all()) {
      const s = rowObject(row);
      const directory = s.directory || s.cwd || s.path || null;
      if (!directory || !ctx.matcher.match(directory)) continue;
      const messages = [];
      if (msgFk) {
        for (const mr of h.db.prepare(`select * from message where "${msgFk}" = ?`).all(s.id)) {
          const info = rowObject(mr);
          const parts = partMsgFk ? h.db.prepare(`select * from part where "${partMsgFk}" = ?`).all(info.id).map(rowObject) : [];
          messages.push({ info, parts });
        }
      }
      out.push({ session: s, directory, messages, dbFile, sessCols: [...sessCols].length });
    }
  } catch (e) {
    res.notes.push(`OpenCode DB schema not recognised (${e.code || e.name})`);
  } finally { h.close(); }
  return out;
}

export async function discover(ctx) {
  const envr = ctx.envr;
  const xdg = envr.envPath('XDG_DATA_HOME');
  const local = envr.homeOverridden ? null : envr.env.LOCALAPPDATA;
  const { dirs, checked } = envr.dirsFor(
    'opencode',
    (h) => [path.join(h, '.local', 'share', 'opencode'), path.join(h, 'Library', 'Application Support', 'opencode')],
    [xdg && path.join(xdg, 'opencode'), local && path.join(local, 'opencode')],
  );
  const res = emptyResult(checked);
  if (!dirs.length) return res;
  res.status = 'ok';
  const seen = new Set();
  for (const base of dirs) {
    const storage = path.join(base, 'storage');
    if (isDir(storage)) {
      for (const { session, directory, file } of fileStorageSessions(storage)) {
        if (seen.has(session.id) || !directory) continue;
        const root = ctx.matcher.match(directory);
        if (!root) continue;
        const { messages, files } = fileStorageMessages(storage, session.id);
        const meta = summarize(session, messages);
        if (!overlapsWindow(ctx, { ...meta, mtimeMs: statSafe(file)?.mtimeMs })) continue;
        seen.add(session.id);
        const allFiles = [file, ...files];
        const body = { format: 'split-brain/opencode-v1', session, messages };
        res.candidates.push({
          source: name, id: session.id, ext: 'json', kind: session.parentID ? 'subagent' : 'transcript', parentId: session.parentID,
          title: session.title || null, ...meta, cwd: directory, matchedBy: 'directory', originalPath: file,
          sourceBytes: allFiles.reduce((n, f) => n + (statSafe(f)?.size || 0), 0),
          fingerprint: filesFingerprint(allFiles),
          read: async (cap) => jsonText(body, cap),
        });
      }
    }
    for (const dbFile of walkFiles(base, { maxDepth: 1, skipDirs: new Set(['storage', 'log', 'bin', 'snapshot']), filter: (n) => /\.(db|sqlite)$/.test(n) })) {
      for (const s of await sqliteSessions(dbFile, ctx, res)) {
        if (seen.has(s.session.id)) continue;
        const meta = summarize(s.session, s.messages);
        if (!overlapsWindow(ctx, meta)) continue;
        seen.add(s.session.id);
        const body = { format: 'split-brain/opencode-db-v1', session: s.session, messages: s.messages };
        const text = JSON.stringify(body);
        res.candidates.push({
          source: name, id: String(s.session.id), ext: 'json', kind: 'transcript',
          title: s.session.title || null, ...meta, cwd: s.directory, matchedBy: 'directory',
          originalPath: `${dbFile}#session/${s.session.id}`, sourceBytes: Buffer.byteLength(text),
          fingerprint: sha256(text).slice(0, 16),
          read: async (cap) => jsonText(body, cap),
        });
      }
    }
  }
  return res;
}
