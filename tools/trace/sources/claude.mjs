// Claude Code: <config>/projects/<encoded-cwd>/<sessionId>.jsonl plus nested
// subagent transcripts (<sessionId>/subagents/agent-*.jsonl). Matched by the
// `cwd` recorded on each line, not by the lossy encoded folder name. A session
// whose cwd is an ancestor of the project (e.g. launched from $HOME) matches
// only if its transcript mentions the project path.
import path from 'node:path';
import { readdirSafe, readLines, statSafe, TimeRange, walkFiles } from '../lib/fsutil.mjs';
import { cwdMatcher, emptyResult, PARENT_MATCH, fileFingerprint, fileReader, modifiedInWindow, overlapsWindow } from './common.mjs';

export const name = 'claude-code';
export const label = 'Claude Code';

const SKIP_DIRS = new Set(['tool-results', 'memory']);

export function claudeDirs(envr) {
  return envr.dirsFor('claude', (h) => [path.join(h, '.claude'), path.join(h, '.config', 'claude')], [envr.envPath('CLAUDE_CONFIG_DIR')]);
}

function listFiles(base) {
  const files = [];
  const projects = path.join(base, 'projects');
  for (const p of readdirSafe(projects)) {
    if (!p.isDirectory()) continue;
    const pdir = path.join(projects, p.name);
    for (const ent of readdirSafe(pdir)) {
      const full = path.join(pdir, ent.name);
      if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        files.push({ file: full, id: ent.name.slice(0, -'.jsonl'.length), kind: 'transcript' });
      } else if (ent.isDirectory() && !SKIP_DIRS.has(ent.name)) {
        for (const f of walkFiles(full, { maxDepth: 4, skipDirs: SKIP_DIRS, filter: (n) => n.endsWith('.jsonl') })) {
          const rel = path.relative(full, f).replace(/\.jsonl$/, '').split(path.sep).filter((s) => s !== 'subagents').join('__');
          files.push({ file: f, id: `${ent.name}__${rel}`, kind: 'subagent', parentId: ent.name });
        }
      }
    }
  }
  return files;
}

export async function scanClaudeFile(file, ctx) {
  const lookup = cwdMatcher(ctx);
  const needles = ctx.matcher.mentionNeedles();
  let root = null;
  let ancestor = false;
  let mentioned = false;
  let firstCwd = null;
  let matchedCwd = null;
  let sessionId = null;
  let title = null;
  let customTitle = null;
  let userMsgs = 0;
  const assistantIds = new Set();
  const toolIds = new Set();
  const models = new Set();
  const tr = new TimeRange();
  for await (const line of readLines(file)) {
    if (!line || line.charCodeAt(0) !== 123) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (typeof j.cwd === 'string') {
      if (!firstCwd) firstCwd = j.cwd;
      if (!root) {
        const m = lookup(j.cwd);
        if (m?.root) { root = m.root; matchedCwd = j.cwd; } else if (m?.ancestor) ancestor = true;
      }
    }
    if (!root && ancestor && !mentioned && needles.some((n) => line.includes(n))) mentioned = true;
    if (j.sessionId && !sessionId) sessionId = j.sessionId;
    if (j.timestamp) tr.add(j.timestamp);
    switch (j.type) {
      case 'ai-title': if (typeof j.aiTitle === 'string') title = j.aiTitle; break;
      case 'summary': if (typeof j.summary === 'string' && !title) title = j.summary; break;
      case 'custom-title': if (typeof j.customTitle === 'string') customTitle = j.customTitle; break;
      case 'user': {
        if (j.isMeta) break;
        const c = j.message?.content;
        if (typeof c === 'string' || (Array.isArray(c) && c.some((b) => b?.type === 'text' || b?.type === 'image'))) userMsgs++;
        break;
      }
      case 'assistant': {
        const msg = j.message || {};
        assistantIds.add(msg.id || j.uuid);
        if (msg.model && msg.model !== '<synthetic>') models.add(msg.model);
        if (Array.isArray(msg.content)) for (const b of msg.content) if (b?.type === 'tool_use') toolIds.add(b.id || `${j.uuid}:${toolIds.size}`);
        break;
      }
      default:
    }
  }
  const matchedBy = root ? 'cwd' : mentioned ? PARENT_MATCH : null;
  return {
    matchedBy,
    cwd: matchedCwd || firstCwd,
    sessionId,
    title: customTitle || title,
    startedAt: tr.min,
    endedAt: tr.max,
    messageCount: userMsgs + assistantIds.size,
    toolCallCount: toolIds.size,
    models: [...models],
  };
}

export async function discover(ctx) {
  const { dirs, checked } = claudeDirs(ctx.envr);
  const res = emptyResult(checked);
  if (!dirs.length) return res;
  res.status = 'ok';
  const byId = new Map();
  for (const base of dirs) {
    for (const f of listFiles(base)) {
      const st = statSafe(f.file);
      if (!modifiedInWindow(ctx, st)) continue;
      const prev = byId.get(f.id);
      if (prev && prev.st.mtimeMs >= st.mtimeMs) continue;
      byId.set(f.id, { ...f, st });
    }
  }
  for (const f of byId.values()) {
    let meta;
    try { meta = await scanClaudeFile(f.file, ctx); } catch (e) { res.notes.push(`could not read a Claude Code session file (${e.code || e.name})`); continue; }
    if (!meta.matchedBy) continue;
    if (!overlapsWindow(ctx, { ...meta, mtimeMs: f.st.mtimeMs })) continue;
    res.candidates.push({
      source: name,
      id: f.id,
      ext: 'jsonl',
      kind: f.kind,
      parentId: f.parentId,
      title: meta.title,
      startedAt: meta.startedAt,
      endedAt: meta.endedAt,
      messageCount: meta.messageCount,
      toolCallCount: meta.toolCallCount,
      models: meta.models,
      cwd: meta.cwd,
      matchedBy: meta.matchedBy,
      originalPath: f.file,
      sourceBytes: f.st.size,
      fingerprint: fileFingerprint(f.file),
      read: fileReader(f.file),
    });
  }
  return res;
}
