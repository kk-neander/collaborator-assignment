// VS Code Copilot Chat (Code, Code - Insiders, VSCodium, Code - OSS, remote
// server dirs): workspaceStorage/<hash>/chatSessions/*.json (legacy whole
// document) or *.jsonl (newer append-only mutation log), plus
// chatEditingSessions/<id>/state.json. Matched via workspace.json.
import path from 'node:path';
import { readdirSafe, readLines, readJsonSafe, statSafe, TimeRange } from '../lib/fsutil.mjs';
import { emptyResult, fileFingerprint, fileReader, overlapsWindow } from './common.mjs';
import { matchingWorkspaces } from './workspaces.mjs';

export const name = 'vscode-copilot';
export const label = 'VS Code Copilot Chat';

const APPS = ['Code', 'Code - Insiders', 'VSCodium', 'Code - OSS'];

/** Apply one mutation-log entry (kind 0=init, 1=set, 2=push/splice, 3=delete). */
export function applyChatMutation(state, entry) {
  if (!entry || typeof entry !== 'object') return state;
  if (entry.kind === 0) return entry.v;
  const keys = Array.isArray(entry.k) ? entry.k : [];
  if (!keys.length) return entry.kind === 1 ? entry.v : state;
  let obj = state;
  for (let i = 0; i < keys.length - 1; i++) {
    if (obj == null || typeof obj !== 'object') return state;
    if (obj[keys[i]] == null) obj[keys[i]] = typeof keys[i + 1] === 'number' ? [] : {};
    obj = obj[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (obj == null || typeof obj !== 'object') return state;
  if (entry.kind === 1) obj[last] = entry.v;
  else if (entry.kind === 2) {
    if (!Array.isArray(obj[last])) obj[last] = [];
    const items = Array.isArray(entry.v) ? entry.v : [entry.v];
    if (typeof entry.i === 'number') obj[last].splice(entry.i, obj[last].length - entry.i, ...items);
    else obj[last].push(...items);
  } else if (entry.kind === 3) {
    if (Array.isArray(obj)) obj.splice(last, 1); else delete obj[last];
  }
  return state;
}

export function chatMeta(session) {
  const tr = new TimeRange();
  const models = new Set();
  let messages = 0;
  let tools = 0;
  if (!session || typeof session !== 'object') return { startedAt: null, endedAt: null, messageCount: 0, toolCallCount: 0, models: [], title: null };
  tr.add(session.creationDate);
  tr.add(session.lastMessageDate);
  for (const r of Array.isArray(session.requests) ? session.requests : []) {
    if (!r) continue;
    messages++;
    tr.add(r.timestamp);
    if (r.modelId) models.add(r.modelId);
    const resp = Array.isArray(r.response) ? r.response : Array.isArray(r.response?.value) ? r.response.value : [];
    if (resp.length) messages++;
    for (const part of resp) if (part && /toolInvocation/i.test(part.kind || '')) tools++;
  }
  return { startedAt: tr.min, endedAt: tr.max, messageCount: messages, toolCallCount: tools, models: [...models], title: session.customTitle || null };
}

async function loadChat(file) {
  if (file.endsWith('.json')) return readJsonSafe(file);
  let state = null;
  for await (const line of readLines(file)) {
    if (!line.trim()) continue;
    try { state = applyChatMutation(state, JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return state;
}

export async function discover(ctx) {
  const envr = ctx.envr;
  const { dirs, checked } = envr.dirsFor(
    'vscode',
    (h) => [...envr.editorUserDirs(h, APPS), path.join(h, '.vscode-server', 'data', 'User'), path.join(h, '.vscode-server-insiders', 'data', 'User')],
    envr.appDataDirs(APPS),
  );
  const res = emptyResult(checked);
  if (!dirs.length) return res;
  res.status = 'ok';
  const seen = new Set();
  for (const userDir of dirs) {
    for (const ws of matchingWorkspaces(userDir, ctx.matcher)) {
      const chatDir = path.join(ws.dir, 'chatSessions');
      const sessionTimes = new Map();
      for (const ent of readdirSafe(chatDir)) {
        if (!ent.isFile() || !/\.jsonl?$/.test(ent.name)) continue;
        const file = path.join(chatDir, ent.name);
        const id = ent.name.replace(/\.jsonl?$/, '');
        const st = statSafe(file);
        let meta;
        try { meta = chatMeta(await loadChat(file)); } catch { meta = chatMeta(null); }
        sessionTimes.set(id, meta);
        if (!overlapsWindow(ctx, { ...meta, mtimeMs: st?.mtimeMs })) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        res.candidates.push({
          source: name,
          id,
          ext: ent.name.endsWith('.jsonl') ? 'jsonl' : 'json',
          kind: 'chat',
          title: meta.title,
          startedAt: meta.startedAt,
          endedAt: meta.endedAt || (st ? new Date(st.mtimeMs).toISOString() : null),
          messageCount: meta.messageCount,
          toolCallCount: meta.toolCallCount,
          models: meta.models,
          cwd: ws.folder,
          matchedBy: 'workspace',
          originalPath: file,
          sourceBytes: st?.size ?? 0,
          fingerprint: fileFingerprint(file),
          read: fileReader(file),
        });
      }
      const editDir = path.join(ws.dir, 'chatEditingSessions');
      for (const ent of readdirSafe(editDir)) {
        if (!ent.isDirectory()) continue;
        const file = path.join(editDir, ent.name, 'state.json');
        const st = statSafe(file);
        if (!st?.isFile()) continue;
        const parent = sessionTimes.get(ent.name);
        const meta = { startedAt: parent?.startedAt || null, endedAt: parent?.endedAt || new Date(st.mtimeMs).toISOString() };
        if (!overlapsWindow(ctx, { ...meta, mtimeMs: st.mtimeMs })) continue;
        const id = `${ent.name}.editing`;
        if (seen.has(id)) continue;
        seen.add(id);
        res.candidates.push({
          source: name,
          id,
          ext: 'json',
          kind: 'editing-state',
          parentId: ent.name,
          title: null,
          ...meta,
          messageCount: 0,
          toolCallCount: 0,
          models: [],
          cwd: ws.folder,
          matchedBy: 'workspace',
          originalPath: file,
          sourceBytes: st.size,
          fingerprint: fileFingerprint(file),
          read: fileReader(file),
        });
      }
    }
  }
  return res;
}

