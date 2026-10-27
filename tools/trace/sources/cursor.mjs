// Cursor: workspaceStorage/<hash>/workspace.json identifies the project; the
// composer (Chat/Agent) conversations live in globalStorage/state.vscdb, table
// cursorDiskKV, keys composerData:<id> and bubbleId:<composerId>:<bubbleId>.
// Only composers referenced by a matching workspace are extracted (to JSON) —
// the global DB itself is never copied.
import path from 'node:path';
import { isFile, sha256, statSafe, TimeRange } from '../lib/fsutil.mjs';
import { columnNames, loadSqlite, openReadOnly, rowValueToString, SQLITE_UNAVAILABLE, tableNames } from '../lib/sqlite.mjs';
import { emptyResult, jsonText, overlapsWindow } from './common.mjs';
import { matchingWorkspaces } from './workspaces.mjs';

export const name = 'cursor';
export const label = 'Cursor';

const LEGACY_WORKSPACE_KEYS = ['workbench.panel.aichat.view.aichat.chatdata', 'aiService.prompts', 'aiService.generations', 'composer.composerData'];

function parseJson(v) {
  const s = rowValueToString(v);
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function itemTable(db, key) {
  try { return parseJson(db.prepare('select value from ItemTable where key = ?').get(key)?.value); } catch { return null; }
}

function kv(db, key) {
  try { return parseJson(db.prepare('select value from cursorDiskKV where key = ?').get(key)?.value); } catch { return null; }
}

/** All bubbles of a composer via an index-friendly key range. */
function bubbles(db, composerId) {
  const lo = `bubbleId:${composerId}:`;
  const hi = `bubbleId:${composerId};`;
  try {
    return db.prepare('select key, value from cursorDiskKV where key >= ? and key < ?').all(lo, hi)
      .map((r) => ({ key: r.key, value: parseJson(r.value) }))
      .filter((b) => b.value);
  } catch { return []; }
}

function orderBubbles(composer, list) {
  const order = (composer?.fullConversationHeadersOnly || []).map((h) => h.bubbleId);
  if (!order.length) return list.map((b) => b.value);
  const byId = new Map(list.map((b) => [b.key.split(':').pop(), b.value]));
  const out = [];
  for (const id of order) if (byId.has(id)) { out.push(byId.get(id)); byId.delete(id); }
  return out.concat([...byId.values()]);
}

function composerMeta(composer, bubbleList) {
  const tr = new TimeRange();
  tr.add(composer?.createdAt);
  tr.add(composer?.lastUpdatedAt);
  const models = new Set();
  if (composer?.modelConfig?.modelName && composer.modelConfig.modelName !== 'default') models.add(composer.modelConfig.modelName);
  let messages = 0;
  let tools = 0;
  for (const b of bubbleList) {
    tr.add(b.createdAt || b.timingInfo?.clientStartTime);
    if (b.type === 1 || b.type === 2) messages++;
    if (b.toolFormerData && (b.toolFormerData.tool != null || b.toolFormerData.name)) tools++;
    const m = b.modelInfo?.modelName || b.model;
    if (typeof m === 'string' && m) models.add(m);
  }
  return { startedAt: tr.min, endedAt: tr.max, messageCount: messages, toolCallCount: tools, models: [...models] };
}

function extractComposer(globalDb, composerId) {
  const composer = kv(globalDb, `composerData:${composerId}`);
  if (!composer) return null;
  let list;
  if (Array.isArray(composer.conversation) && composer.conversation.length) list = composer.conversation; // older inline format
  else list = orderBubbles(composer, bubbles(globalDb, composerId));
  return { composer, bubbles: list };
}

export async function discover(ctx) {
  const envr = ctx.envr;
  const { dirs, checked } = envr.dirsFor('cursor', (h) => envr.editorUserDirs(h, ['Cursor']), envr.appDataDirs(['Cursor']));
  const res = emptyResult(checked);
  if (!dirs.length) return res;
  const sqlite = await loadSqlite();
  if (!sqlite) return { ...res, status: 'needs-node', detail: SQLITE_UNAVAILABLE };
  res.status = 'ok';
  for (const userDir of dirs) {
    const workspaces = matchingWorkspaces(userDir, ctx.matcher);
    if (!workspaces.length) continue;
    const globalPath = path.join(userDir, 'globalStorage', 'state.vscdb');
    let global = null;
    if (isFile(globalPath)) {
      try { global = openReadOnly(sqlite, globalPath); } catch (e) { res.notes.push(`could not open Cursor global state DB (${e.code || e.name})`); }
    }
    try {
      const gTables = global ? tableNames(global.db) : new Set();
      for (const ws of workspaces) {
        const wsDbPath = path.join(ws.dir, 'state.vscdb');
        const ids = new Set();
        let legacy = null;
        if (isFile(wsDbPath)) {
          let w = null;
          try {
            w = openReadOnly(sqlite, wsDbPath);
            const cd = itemTable(w.db, 'composer.composerData');
            for (const c of cd?.allComposers || []) if (c?.composerId) ids.add(c.composerId);
            const items = {};
            for (const k of LEGACY_WORKSPACE_KEYS) {
              if (k === 'composer.composerData') continue;
              const v = itemTable(w.db, k);
              if (v && (!Array.isArray(v) || v.length)) items[k] = v;
            }
            if (Object.keys(items).length) legacy = items;
          } catch (e) {
            res.notes.push(`could not read a Cursor workspace DB (${e.code || e.name})`);
          } finally { w?.close(); }
        }
        if (global && gTables.has('composerHeaders') && columnNames(global.db, 'composerHeaders').has('workspaceId')) {
          try {
            for (const r of global.db.prepare('select composerId from composerHeaders where workspaceId = ?').all(ws.hash)) ids.add(r.composerId);
          } catch { /* schema drift */ }
        }
        // Follow sub-composers / subagents referenced by matched composers.
        const queue = [...ids];
        const metaById = new Map();
        while (global && gTables.has('cursorDiskKV') && queue.length) {
          const id = queue.shift();
          if (metaById.has(id)) continue;
          const ex = extractComposer(global.db, id);
          if (!ex) { metaById.set(id, null); continue; }
          const subs = [...(ex.composer.subComposerIds || []), ...(ex.composer.subagentComposerIds || [])];
          for (const s of subs) if (typeof s === 'string' && !metaById.has(s)) queue.push(s);
          const meta = composerMeta(ex.composer, ex.bubbles);
          const size = Buffer.byteLength(JSON.stringify(ex));
          metaById.set(id, { meta, size, title: ex.composer.name || null, lastUpdatedAt: ex.composer.lastUpdatedAt, count: ex.bubbles.length });
        }
        for (const [id, info] of metaById) {
          if (!info) continue;
          if (!overlapsWindow(ctx, info.meta)) continue;
          res.candidates.push({
            source: name,
            id,
            ext: 'json',
            kind: 'composer',
            title: info.title,
            ...info.meta,
            cwd: ws.folder,
            matchedBy: 'workspace',
            originalPath: `${globalPath}#cursorDiskKV/composerData:${id}`,
            sourceBytes: info.size,
            fingerprint: `${info.lastUpdatedAt || ''}:${info.count}:${info.size}`,
            read: async (cap) => {
              const g = openReadOnly(sqlite, globalPath);
              try {
                const ex = extractComposer(g.db, id) || { composer: null, bubbles: [] };
                return jsonText({ format: 'split-brain/cursor-composer-v1', workspace: { id: ws.hash, folder: ws.folder }, composerId: id, composer: ex.composer, bubbles: ex.bubbles }, cap);
              } finally { g.close(); }
            },
          });
        }
        if (legacy) {
          const tr = new TimeRange();
          for (const g of Array.isArray(legacy['aiService.generations']) ? legacy['aiService.generations'] : []) tr.add(g?.unixMs);
          const st = statSafe(wsDbPath);
          const meta = { startedAt: tr.min, endedAt: tr.max, mtimeMs: st?.mtimeMs };
          if (overlapsWindow(ctx, meta)) {
            const body = { format: 'split-brain/cursor-workspace-chat-v1', workspace: { id: ws.hash, folder: ws.folder }, items: legacy };
            const bodyText = JSON.stringify(body);
            const size = Buffer.byteLength(bodyText);
            const prompts = Array.isArray(legacy['aiService.prompts']) ? legacy['aiService.prompts'].length : 0;
            res.candidates.push({
              source: name,
              id: `workspace-${ws.hash}`,
              ext: 'json',
              kind: 'workspace-chat',
              title: null,
              startedAt: meta.startedAt,
              endedAt: meta.endedAt || (st ? new Date(st.mtimeMs).toISOString() : null),
              messageCount: prompts,
              toolCallCount: 0,
              models: [],
              cwd: ws.folder,
              matchedBy: 'workspace',
              originalPath: `${wsDbPath}#ItemTable`,
              sourceBytes: size,
              fingerprint: sha256(bodyText).slice(0, 16),
              read: async (cap) => jsonText(body, cap),
            });
          }
        }
      }
    } finally {
      global?.close();
    }
  }
  return res;
}

