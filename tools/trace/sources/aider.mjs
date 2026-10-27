// Aider: .aider.chat.history.md, .aider.input.history, .aider.llm.history in
// each local project root (or SB_TRACE_AIDER_DIR / --aider-dir overrides).
// These files live inside the project, so the whole file is exported.
import path from 'node:path';
import { readLines, statSafe, TimeRange } from '../lib/fsutil.mjs';
import { emptyResult, fileFingerprint, fileReader, hash8, overlapsWindow } from './common.mjs';

export const name = 'aider';
export const label = 'Aider';

const FILES = [
  { file: '.aider.chat.history.md', kind: 'chat-history', ext: 'md' },
  { file: '.aider.input.history', kind: 'input-history', ext: 'txt' },
  { file: '.aider.llm.history', kind: 'llm-history', ext: 'txt' },
];

// Aider writes local wall-clock times without a zone.
function localTime(s) {
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function scan(file, kind) {
  const tr = new TimeRange();
  const models = new Set();
  let messages = 0;
  for await (const line of readLines(file)) {
    if (kind === 'chat-history') {
      if (line.startsWith('# aider chat started at ')) tr.add(localTime(line));
      else if (line.startsWith('#### ')) messages++;
      const mm = /^> (?:Main )?[Mm]odel: (\S+)/.exec(line);
      if (mm) models.add(mm[1]);
    } else if (kind === 'input-history') {
      if (/^# \d{4}-\d{2}-\d{2} /.test(line)) { tr.add(localTime(line)); messages++; }
    } else if (/^(TO LLM|LLM RESPONSE) \d{4}-/.test(line)) {
      tr.add(localTime(line));
      messages++;
    }
  }
  return { startedAt: tr.min, endedAt: tr.max, messageCount: messages, toolCallCount: 0, models: [...models] };
}

export async function discover(ctx) {
  const ov = ctx.envr.override('aider');
  const dirs = ov || ctx.roots.filter((r) => r.exists && r.kind !== 'host').map((r) => r.path);
  // Stable ids: the main checkout gets a plain id (same on host and in a container).
  const mainDir = path.resolve(ctx.projectRoot);
  const res = emptyResult(dirs);
  res.status = 'ok';
  let found = 0;
  for (const dir of [...new Set(dirs)]) {
    for (const spec of FILES) {
      const file = path.join(dir, spec.file);
      const st = statSafe(file);
      if (!st?.isFile()) continue;
      found++;
      const meta = await scan(file, spec.kind);
      if (!overlapsWindow(ctx, { endedAt: meta.endedAt || new Date(st.mtimeMs).toISOString(), mtimeMs: st.mtimeMs })) continue;
      res.candidates.push({
        source: name, id: `${spec.file.replace(/^\./, '').replace(/\.md$/, '')}${path.resolve(dir) === mainDir ? '' : `-${hash8(path.resolve(dir))}`}`, ext: spec.ext, kind: spec.kind,
        title: null, ...meta, endedAt: meta.endedAt || new Date(st.mtimeMs).toISOString(), cwd: dir, matchedBy: 'project-file',
        originalPath: file, sourceBytes: st.size, fingerprint: fileFingerprint(file), read: fileReader(file),
      });
    }
  }
  if (!found) res.status = 'not-found';
  return res;
}
