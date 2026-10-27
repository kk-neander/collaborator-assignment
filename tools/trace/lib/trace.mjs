// The `trace` command: discover this project's sessions, redact, snapshot.
//
// Snapshots are cumulative: sessions previously copied into
// .split-brain/sessions/ are never deleted, even when the tool that produced
// them has since pruned the original — unless the user excludes them
// (--exclude / .split-brain/trace-exclude.txt), which removes them for good.
// Sessions started in a parent folder that merely mention the project are
// skipped unless --include-parent is given.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MAX_SESSION_MB, TOOL_VERSION, TOTAL_SIZE_WARN_MB } from './version.mjs';
import { collectRoots, resolveProjectRoot, resolveWindow, stateDir } from './project.mjs';
import { Environment } from './env.mjs';
import { ProjectMatcher } from './paths.mjs';
import { buildRedactor, mergeCounts } from './redact.mjs';
import { capSplit, cutHead, cutTail, readJsonSafe, readTextSafe, safeId, sha256, splitBuffer, statSafe, writeFileAtomic } from './fsutil.mjs';
import { safeErrorLabel } from './errors.mjs';
import { SOURCES, detectUnsupported } from '../sources/index.mjs';
import { PARENT_MATCH } from '../sources/common.mjs';

export { PARENT_MATCH };

export const INDEX_FILE = 'index.json';
export const EXCLUDE_FILE = 'trace-exclude.txt';
const SOURCE_NAMES = new Set(SOURCES.map((s) => s.name));

/** Exclusion rules from --exclude and .split-brain/trace-exclude.txt. */
export function loadExclusions(projectRoot, opts) {
  const raw = [...(opts.exclude || [])];
  const text = readTextSafe(path.join(stateDir(projectRoot), EXCLUDE_FILE));
  if (text) for (const line of text.split(/\r?\n/)) raw.push(line.replace(/#.*$/, ''));
  const rules = [];
  for (const r of raw) {
    const v = r.trim();
    if (!v) continue;
    const i = v.indexOf(':');
    const src = i > 0 ? v.slice(0, i) : null;
    rules.push(src && SOURCE_NAMES.has(src) ? { source: src, id: v.slice(i + 1) } : { source: null, id: v });
  }
  return rules;
}

/** A rule matches the session itself or its children (subagents, editing state). */
export function isExcluded(rules, s) {
  return rules.some((r) => (r.source == null || r.source === s.source) && (r.id === s.id || (s.parentId && r.id === s.parentId)));
}

export const sessionKey = (s) => `${s.source}:${s.id}`;

export function sessionsDirOf(projectRoot) {
  return path.join(stateDir(projectRoot), 'sessions');
}

export function buildContext(opts, env = process.env) {
  const warnings = [];
  const projectRoot = resolveProjectRoot(opts, warnings);
  const roots = collectRoots(projectRoot, opts, warnings);
  const matcher = new ProjectMatcher(roots);
  const window = resolveWindow(projectRoot, opts, warnings);
  window.sinceMs = Date.parse(window.since);
  const envr = new Environment(opts, env);
  const mb = Number(opts.maxSessionMb) > 0 ? Number(opts.maxSessionMb) : DEFAULT_MAX_SESSION_MB;
  return { opts, env, envr, projectRoot, roots, matcher, window, warnings, capBytes: Math.round(mb * 1024 * 1024) };
}

export async function discoverAll(ctx) {
  const sources = {};
  const candidates = [];
  for (const src of SOURCES) {
    let r;
    try {
      r = await src.discover(ctx);
    } catch (e) {
      r = { status: 'error', detail: `discovery failed (${safeErrorLabel(e)})`, checked: [], candidates: [], notes: [] };
      if (ctx.env.SB_TRACE_DEBUG) process.stderr.write(`${e?.stack?.split('\n').slice(1).join('\n')}\n`);
    }
    sources[src.name] = { label: src.label, status: r.status, detail: r.detail || null, checked: r.checked || [], sessions: r.candidates.length, notes: r.notes || [] };
    candidates.push(...r.candidates);
  }
  for (const u of detectUnsupported(ctx.envr, ctx.roots)) {
    sources[u.source] = { label: u.label, status: u.status, detail: u.detail, checked: [], sessions: 0, notes: [] };
  }
  return { sources, candidates };
}

function joinTruncated(ext, head, tail, originalBytes, cap) {
  const { head: hb, tail: tb } = capSplit(cap);
  const note = `split-brain trace kept the first ${(hb / 1048576).toFixed(1)} MB and the last ${(tb / 1048576).toFixed(1)} MB of this ${(originalBytes / 1048576).toFixed(1)} MB session; the middle was omitted`;
  if (ext === 'json') return `${JSON.stringify({ splitBrainTruncated: true, note, originalBytes, capBytes: cap, head, tail })}\n`;
  if (ext === 'jsonl') {
    const h = head && !head.endsWith('\n') ? `${head}\n` : head;
    return `${h}${JSON.stringify({ type: 'split-brain-truncated', note, originalBytes, capBytes: cap })}\n${tail}`;
  }
  return `${head}\n\n[split-brain: ${note}]\n\n${tail}`;
}

/** Export one candidate (read, redact, cap) and return its index fields. */
async function exportCandidate(c, ctx, redactor, dest, prev) {
  const r = await c.read(ctx.capBytes);
  let out;
  let counts = {};
  let truncated = Boolean(r.truncated);
  let binary = false;
  if (r.binary) {
    out = r.buffer;
    binary = true;
  } else {
    const rh = redactor.redact(r.head);
    const rt = redactor.redact(r.tail || '');
    counts = mergeCounts({ ...rh.counts }, rt.counts);
    let head = rh.text;
    let tail = rt.text;
    if (!truncated && Buffer.byteLength(head) > ctx.capBytes) {
      // Redaction grew a file that was just under the cap.
      ({ head, tail } = splitBuffer(Buffer.from(head, 'utf8'), ctx.capBytes));
      truncated = true;
    }
    if (truncated) {
      const { head: hb, tail: tb } = capSplit(ctx.capBytes);
      head = cutHead(Buffer.from(head, 'utf8'), hb).toString('utf8');
      tail = cutTail(Buffer.from(tail, 'utf8'), tb).toString('utf8');
      out = Buffer.from(joinTruncated(c.ext, head, tail, r.originalBytes, ctx.capBytes), 'utf8');
    } else {
      out = Buffer.from(head, 'utf8');
    }
  }
  const digest = sha256(out);
  const st = statSafe(dest);
  const same = prev && prev.sha256 === digest && st?.isFile() && st.size === out.length;
  if (!same) writeFileAtomic(dest, out);
  return { bytes: out.length, sha256: digest, redactions: counts, truncated, binary, rewritten: !same };
}

function publicEntry(c) {
  return {
    source: c.source,
    id: c.id,
    kind: c.kind || 'transcript',
    parentId: c.parentId || undefined,
    title: c.title || null,
    startedAt: c.startedAt || null,
    endedAt: c.endedAt || null,
    messageCount: c.messageCount ?? null,
    toolCallCount: c.toolCallCount ?? null,
    models: c.models || [],
    cwd: c.cwd || null,
    matchedBy: c.matchedBy || null,
    originalPath: c.originalPath,
    sourceBytes: c.sourceBytes ?? null,
  };
}

function removeSnapshot(sessionsDir, rel) {
  if (!rel) return false;
  const f = path.join(sessionsDir, ...String(rel).split('/'));
  if (!statSafe(f)?.isFile()) return false;
  fs.rmSync(f, { force: true });
  return true;
}

/**
 * Run trace. opts.dryRun -> nothing is written. Returns a result object
 * (never containing transcript text). result.skipped / result.excluded carry
 * ids for the terminal only; index.json stores just their counts.
 */
export async function runTrace(opts, env = process.env) {
  const ctx = buildContext(opts, env);
  const { sources, candidates: discovered } = await discoverAll(ctx);
  const sessionsDir = sessionsDirOf(ctx.projectRoot);
  const indexPath = path.join(sessionsDir, INDEX_FILE);
  const prevIndex = readJsonSafe(indexPath);
  const prevByKey = new Map((prevIndex?.sessions || []).map((s) => [sessionKey(s), s]));
  const now = new Date().toISOString();
  const rules = loadExclusions(ctx.projectRoot, opts);

  // 1. exclusions (discovered or previously snapshotted), 2. parent-folder sessions.
  const excluded = new Map();
  const skipped = [];
  const candidates = [];
  for (const c of discovered) {
    const key = sessionKey(c);
    if (isExcluded(rules, c)) { excluded.set(key, { key, source: c.source, id: c.id }); continue; }
    if (c.matchedBy === PARENT_MATCH && !opts.includeParent && !prevByKey.has(key)) {
      skipped.push({ key, source: c.source, id: c.id, reason: 'started outside the project folder', startedAt: c.startedAt || null, endedAt: c.endedAt || null, sourceBytes: c.sourceBytes ?? null });
      continue;
    }
    candidates.push(c);
  }
  for (const [key, prev] of prevByKey) if (isExcluded(rules, prev) && !excluded.has(key)) excluded.set(key, { key, source: prev.source, id: prev.id });
  for (const e of excluded.values()) {
    const prev = prevByKey.get(e.key);
    e.snapshotted = Boolean(prev);
    if (prev && !opts.dryRun) e.removed = removeSnapshot(sessionsDir, prev.file);
    prevByKey.delete(e.key);
  }
  for (const [name, s] of Object.entries(sources)) {
    s.sessions = candidates.filter((c) => c.source === name).length;
    s.skippedParentFolder = skipped.filter((c) => c.source === name).length || undefined;
  }

  const redactor = opts.dryRun ? null : buildRedactor(ctx.roots.filter((r) => r.exists).map((r) => r.path));
  const exportConfig = redactor ? `${TOOL_VERSION}|${redactor.fingerprint}|${ctx.capBytes}` : null;

  const rows = [];
  const seenKeys = new Set();
  // Seed with existing snapshot files so a new session can never overwrite a retained one.
  const usedFiles = new Set([...prevByKey.values()].map((s) => String(s.file || '').toLowerCase()));
  for (const c of candidates) {
    const key = sessionKey(c);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const prev = prevByKey.get(key);
    let rel = prev?.file || `${c.source}/${safeId(c.id)}.${c.ext}`;
    if (!prev && usedFiles.has(rel.toLowerCase())) rel = `${c.source}/${safeId(c.id)}-${sha256(key).slice(0, 6)}.${c.ext}`;
    usedFiles.add(rel.toLowerCase());
    const dest = path.join(sessionsDir, ...rel.split('/'));
    const destExists = Boolean(statSafe(dest)?.isFile());
    let status;
    if (!prev || !destExists) status = 'new';
    else if (prev.sourceFingerprint === c.fingerprint && (opts.dryRun || prev.exportConfig === exportConfig)) status = 'unchanged';
    else status = 'changed';
    const entry = { ...publicEntry(c), file: rel };
    if (opts.dryRun) {
      rows.push({ ...entry, status, bytes: prev?.bytes ?? null });
      continue;
    }
    if (status === 'unchanged') {
      rows.push({ ...prev, ...entry, title: entry.title ? redactor.redact(entry.title).text : null, status, bytes: prev.bytes, sha256: prev.sha256, redactions: prev.redactions || {}, truncated: prev.truncated || false, sourceFingerprint: c.fingerprint, exportConfig, firstSnapshotAt: prev.firstSnapshotAt || now, lastSnapshotAt: prev.lastSnapshotAt || now, lastSeenAt: now, seenInLastRun: true });
      continue;
    }
    let ex;
    try {
      ex = await exportCandidate(c, ctx, redactor, dest, prev);
    } catch (e) {
      ctx.warnings.push(`${c.source}: could not export session ${c.id} (${safeErrorLabel(e)})`);
      if (prev) rows.push({ ...prev, status: 'error', seenInLastRun: true });
      continue;
    }
    if (ex.binary) ctx.warnings.push(`${c.source}: ${c.id} looks binary and was copied without redaction`);
    if (ex.truncated) ctx.warnings.push(`${key} exceeded ${Math.round(ctx.capBytes / 1048576)} MB; kept its first and last parts`);
    const title = entry.title ? redactor.redact(entry.title).text : null;
    rows.push({
      ...entry,
      title,
      status: ex.rewritten ? status : 'unchanged',
      bytes: ex.bytes,
      sha256: ex.sha256,
      redactions: ex.redactions,
      truncated: ex.truncated,
      binary: ex.binary || undefined,
      sourceFingerprint: c.fingerprint,
      exportConfig,
      firstSnapshotAt: prev?.firstSnapshotAt || now,
      lastSnapshotAt: ex.rewritten ? now : prev?.lastSnapshotAt || now,
      lastSeenAt: now,
      seenInLastRun: true,
    });
  }

  // Keep every previously snapshotted session (tools prune old transcripts).
  const retained = [];
  for (const [key, prev] of prevByKey) {
    if (seenKeys.has(key)) continue;
    retained.push({ ...prev, status: 'retained', seenInLastRun: false });
  }

  const all = [...rows, ...retained].sort((a, b) => a.source.localeCompare(b.source) || String(a.startedAt || '').localeCompare(String(b.startedAt || '')) || a.id.localeCompare(b.id));
  const totals = summarize(all.filter((s) => s.status !== 'error' || s.sha256));
  totals.skippedParentFolder = skipped.length;
  totals.excluded = excluded.size;
  if (totals.bytes > TOTAL_SIZE_WARN_MB * 1048576) ctx.warnings.push(`session snapshots total ${(totals.bytes / 1048576).toFixed(1)} MB (over ${TOTAL_SIZE_WARN_MB} MB) — the submission will be large`);

  const result = {
    toolVersion: TOOL_VERSION,
    generatedAt: now,
    dryRun: Boolean(opts.dryRun),
    includeParent: Boolean(opts.includeParent),
    projectRoot: ctx.projectRoot,
    projectRoots: ctx.roots.map((r) => ({ path: r.path, kind: r.kind, exists: r.exists })),
    window: { since: ctx.window.since, until: ctx.window.until, origin: ctx.window.origin },
    sources,
    totals,
    sessions: all,
    skipped,
    excluded: [...excluded.values()],
    warnings: ctx.warnings,
  };
  if (!opts.dryRun) {
    // Only counts of skipped/excluded sessions are persisted (and submitted), never their ids.
    const { skipped: _s, excluded: _e, dryRun: _d, ...rest } = result;
    const index = {
      ...rest,
      redaction: { envFiles: redactor.envFiles.length, envLiterals: redactor.literalCount },
      sessions: all.map(({ status, ...s }) => s),
    };
    writeFileAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    result.indexPath = indexPath;
  }
  return result;
}

export function summarize(sessions) {
  const bySource = {};
  const redactions = {};
  let bytes = 0;
  for (const s of sessions) {
    const n = s.bytes ?? s.sourceBytes ?? 0;
    const b = (bySource[s.source] ||= { sessions: 0, bytes: 0 });
    b.sessions++;
    b.bytes += n;
    bytes += n;
    mergeCounts(redactions, s.redactions);
  }
  const redactionTotal = Object.values(redactions).reduce((a, b) => a + b, 0);
  return { sessions: sessions.length, bytes, bySource, redactions, redactionTotal };
}

