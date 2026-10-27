// Codex CLI / app: <CODEX_HOME>/sessions/**/rollout-*.jsonl[.zst] and
// archived_sessions/. The session_meta line's payload carries id + cwd;
// turn_context lines carry cwd + model. Newer Codex compresses older rollouts
// with zstd (.jsonl.zst) — those are exported decompressed and need
// zlib.zstdDecompress (Node >= 22.15).
import path from 'node:path';
import { readLines, readTextSafe, statSafe, TimeRange, walkFiles, zstdAvailable } from '../lib/fsutil.mjs';
import { cwdMatcher, emptyResult, PARENT_MATCH, fileFingerprint, fileReader, modifiedInWindow, overlapsWindow } from './common.mjs';

export const name = 'codex';
export const label = 'Codex';

const ROLLOUT = /^rollout-.*\.jsonl(\.zst)?$/;
const INJECTED = /^\s*(<(environment_context|user_instructions|permissions|collaboration_mode|turn_aborted)|# AGENTS\.md instructions)/;

function readTitles(base) {
  const titles = new Map();
  const t = readTextSafe(path.join(base, 'session_index.jsonl'));
  if (!t) return titles;
  for (const line of t.split('\n')) {
    try {
      const j = JSON.parse(line);
      if (j.id && j.thread_name) titles.set(j.id, j.thread_name);
    } catch { /* ignore */ }
  }
  return titles;
}

export async function scanCodexFile(file, ctx) {
  const lookup = cwdMatcher(ctx);
  const needles = ctx.matcher.mentionNeedles();
  let id = null;
  let parentId = null;
  let root = null;
  let ancestor = false;
  let mentioned = false;
  let firstCwd = null;
  let matchedCwd = null;
  let msgs = 0;
  let tools = 0;
  const models = new Set();
  const tr = new TimeRange();
  const seeCwd = (cwd) => {
    if (typeof cwd !== 'string') return;
    if (!firstCwd) firstCwd = cwd;
    if (root) return;
    const m = lookup(cwd);
    if (m?.root) { root = m.root; matchedCwd = cwd; } else if (m?.ancestor) ancestor = true;
  };
  for await (const line of readLines(file)) {
    if (!line || line.charCodeAt(0) !== 123) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.timestamp) tr.add(j.timestamp);
    const p = j.payload || {};
    if (j.type === 'session_meta') {
      if (!id) id = p.id || p.session_id || null;
      if (!parentId && p.parent_thread_id) parentId = p.parent_thread_id;
      seeCwd(p.cwd);
      if (p.timestamp) tr.add(p.timestamp);
    } else if (j.type === 'turn_context') {
      seeCwd(p.cwd);
      if (p.model) models.add(p.model);
    } else if (j.type === 'response_item') {
      if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
        const first = Array.isArray(p.content) ? p.content.find((c) => typeof c?.text === 'string')?.text : null;
        if (!(p.role === 'user' && first && INJECTED.test(first))) msgs++;
      } else if (typeof p.type === 'string' && p.type.endsWith('_call')) {
        tools++;
      }
    }
    if (!root && ancestor && !mentioned && needles.some((n) => line.includes(n))) mentioned = true;
  }
  return {
    id,
    parentId,
    matchedBy: root ? 'cwd' : mentioned ? PARENT_MATCH : null,
    cwd: matchedCwd || firstCwd,
    startedAt: tr.min,
    endedAt: tr.max,
    messageCount: msgs,
    toolCallCount: tools,
    models: [...models],
  };
}

export async function discover(ctx) {
  const envr = ctx.envr;
  const { dirs, checked } = envr.dirsFor('codex', (h) => [path.join(h, '.codex')], [envr.envPath('CODEX_HOME')]);
  const res = emptyResult(checked);
  if (!dirs.length) return res;
  res.status = 'ok';
  const canZstd = zstdAvailable();
  let skippedZst = 0;
  const byId = new Map();
  for (const base of dirs) {
    const titles = readTitles(base);
    const files = [];
    for (const sub of ['sessions', 'archived_sessions']) {
      for (const f of walkFiles(path.join(base, sub), { maxDepth: 6, filter: (n) => ROLLOUT.test(n) })) files.push(f);
    }
    for (const file of files) {
      if (file.endsWith('.zst') && !canZstd) { skippedZst++; continue; }
      const st = statSafe(file);
      if (!modifiedInWindow(ctx, st)) continue;
      let meta;
      try { meta = await scanCodexFile(file, ctx); } catch (e) { res.notes.push(`could not read a Codex rollout (${e.code || e.name})`); continue; }
      if (!meta.matchedBy) continue;
      if (!overlapsWindow(ctx, { ...meta, mtimeMs: st.mtimeMs })) continue;
      const fallbackId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/i.exec(path.basename(file))?.[1];
      const id = meta.id || fallbackId || path.basename(file).replace(/\.jsonl(\.zst)?$/, '');
      const prev = byId.get(id);
      if (prev && prev.mtimeMs >= st.mtimeMs) continue;
      byId.set(id, {
        mtimeMs: st.mtimeMs,
        candidate: {
          source: name,
          id,
          ext: 'jsonl',
          kind: meta.parentId ? 'subagent' : 'transcript',
          parentId: meta.parentId || undefined,
          title: titles.get(id) || null,
          startedAt: meta.startedAt,
          endedAt: meta.endedAt,
          messageCount: meta.messageCount,
          toolCallCount: meta.toolCallCount,
          models: meta.models,
          cwd: meta.cwd,
          matchedBy: meta.matchedBy,
          originalPath: file,
          sourceBytes: st.size,
          compressed: file.endsWith('.zst') ? 'zstd' : undefined,
          fingerprint: fileFingerprint(file),
          read: fileReader(file),
        },
      });
    }
  }
  res.candidates = [...byId.values()].map((v) => v.candidate);
  if (skippedZst) {
    res.status = 'partial';
    res.detail = `${skippedZst} compressed rollout(s) (.jsonl.zst) skipped: needs Node >= 22.15 for zstd (or run via Docker node:24-slim)`;
  }
  return res;
}
