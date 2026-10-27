// Gemini CLI (best effort): ~/.gemini/tmp/<id>/chats/*.json and logs.json,
// where <id> is sha256(project root path) in most versions. Newer versions may
// use a readable slug registered in ~/.gemini/projects.json or a .project_root
// file; both are honoured, as is any cwd/path recorded inside a chat file.
import crypto from 'node:crypto';
import path from 'node:path';
import { readdirSafe, readJsonSafe, readTextSafe, statSafe, TimeRange } from '../lib/fsutil.mjs';
import { realpathSafe } from '../lib/paths.mjs';
import { emptyResult, fileFingerprint, fileReader, hash8, overlapsWindow } from './common.mjs';

export const name = 'gemini-cli';
export const label = 'Gemini CLI';

/** Every plausible spelling of a root as Gemini's process.cwd() would see it. */
export function rootHashes(roots) {
  const variants = new Set();
  for (const r of roots) {
    const list = [r.path, realpathSafe(r.path)].filter(Boolean);
    for (const p of list) {
      variants.add(p);
      variants.add(p.replace(/[\\/]+$/, ''));
      if (/^\/(var|tmp)(\/|$)/.test(p)) variants.add(`/private${p}`);
      if (/^\/private\/(var|tmp)(\/|$)/.test(p)) variants.add(p.slice('/private'.length));
      const drive = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
      const mnt = /^\/mnt\/([a-z])\/(.*)$/.exec(p);
      const win = drive ? [drive[1], drive[2]] : mnt ? [mnt[1], mnt[2]] : null;
      if (win) {
        const rest = win[1].replace(/\//g, '\\');
        variants.add(`${win[0].toUpperCase()}:\\${rest}`);
        variants.add(`${win[0].toLowerCase()}:\\${rest}`);
      }
    }
  }
  return new Map([...variants].map((v) => [crypto.createHash('sha256').update(v).digest('hex'), v]));
}

function chatMeta(j) {
  const tr = new TimeRange();
  tr.add(j?.startTime);
  tr.add(j?.lastUpdated);
  const models = new Set();
  let messages = 0;
  let tools = 0;
  for (const m of Array.isArray(j?.messages) ? j.messages : []) {
    tr.add(m?.timestamp);
    if (m?.type === 'user' || m?.type === 'gemini' || m?.role) messages++;
    if (Array.isArray(m?.toolCalls)) tools += m.toolCalls.length;
    if (typeof m?.model === 'string') models.add(m.model);
  }
  return { startedAt: tr.min, endedAt: tr.max, messageCount: messages, toolCallCount: tools, models: [...models], sessionId: j?.sessionId || null };
}

function recordedPaths(j) {
  const out = [];
  for (const k of ['cwd', 'directory', 'projectRoot', 'workingDirectory', 'projectPath']) if (typeof j?.[k] === 'string') out.push(j[k]);
  return out;
}

export async function discover(ctx) {
  const { dirs, checked } = ctx.envr.dirsFor('gemini', (h) => [path.join(h, '.gemini')]);
  const res = emptyResult(checked);
  if (!dirs.length) return res;
  res.status = 'ok';
  const hashes = rootHashes(ctx.roots);
  for (const base of dirs) {
    const slugs = new Set();
    const reg = readJsonSafe(path.join(base, 'projects.json'));
    const regMap = reg?.projects && typeof reg.projects === 'object' ? reg.projects : reg && typeof reg === 'object' ? reg : {};
    for (const [k, v] of Object.entries(regMap)) {
      if (typeof v === 'string' && ctx.matcher.match(k)) slugs.add(v);
      else if (v && typeof v === 'object' && typeof v.path === 'string' && ctx.matcher.match(v.path)) slugs.add(k);
    }
    const tmp = path.join(base, 'tmp');
    for (const ent of readdirSafe(tmp)) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(tmp, ent.name);
      const projectRootFile = readTextSafe(path.join(dir, '.project_root'))?.trim();
      let matchedBy = hashes.has(ent.name) ? 'project-hash' : slugs.has(ent.name) ? 'project-registry' : projectRootFile && ctx.matcher.match(projectRootFile) ? 'project-root-file' : null;
      const files = readdirSafe(path.join(dir, 'chats')).filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => ({ file: path.join(dir, 'chats', e.name), kind: 'chat' }));
      for (const e of readdirSafe(dir)) if (e.isFile() && /^checkpoint-.*\.json$/.test(e.name)) files.push({ file: path.join(dir, e.name), kind: 'checkpoint' });
      const logs = path.join(dir, 'logs.json');
      if (statSafe(logs)?.isFile()) files.push({ file: logs, kind: 'prompt-log' });
      for (const f of files) {
        const st = statSafe(f.file);
        const j = readJsonSafe(f.file);
        let by = matchedBy;
        if (!by && j && recordedPaths(j).some((p) => ctx.matcher.match(p))) by = 'recorded-path';
        if (!by) continue;
        let meta;
        if (f.kind === 'prompt-log') {
          const tr = new TimeRange();
          const arr = Array.isArray(j) ? j : [];
          for (const x of arr) tr.add(x?.timestamp);
          meta = { startedAt: tr.min, endedAt: tr.max, messageCount: arr.length, toolCallCount: 0, models: [] };
        } else {
          meta = chatMeta(j);
        }
        if (!overlapsWindow(ctx, { ...meta, mtimeMs: st?.mtimeMs })) continue;
        const stem = path.basename(f.file, '.json');
        const id = f.kind === 'chat' ? stem : `${stem}-${ent.name.length >= 8 ? ent.name.slice(0, 8) : hash8(ent.name)}`;
        res.candidates.push({
          source: name, id, ext: 'json', kind: f.kind, title: null,
          startedAt: meta.startedAt, endedAt: meta.endedAt || (st ? new Date(st.mtimeMs).toISOString() : null),
          messageCount: meta.messageCount, toolCallCount: meta.toolCallCount, models: meta.models,
          cwd: hashes.get(ent.name) || projectRootFile || null, matchedBy: by, originalPath: f.file,
          sourceBytes: st?.size ?? 0, fingerprint: fileFingerprint(f.file), read: fileReader(f.file),
        });
      }
    }
  }
  return res;
}
