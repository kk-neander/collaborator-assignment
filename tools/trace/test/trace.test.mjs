import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PARENT_MATCH, runTrace } from '../lib/trace.mjs';
import { readHeadTail } from '../lib/fsutil.mjs';
import zlib from 'node:zlib';
import { buildCursorFixture, buildFakeHome, buildOpencodeDbFixture, cleanEnv, hasSqlite, hasZstd, jsonl, makeProject, mkTmp, readAllFiles, SECRETS, write } from './helpers.mjs';

const since = new Date(Date.now() - 7 * 86400_000).toISOString();

async function setup() {
  const base = mkTmp('sbt-trace-');
  const root = makeProject(base);
  const home = path.join(base, 'home');
  // tools record the unresolved path (/var/... on macOS) while git reports /private/var/...
  const ids = buildFakeHome(home, root, { recordedRoot: root });
  let cursor = null;
  if (hasSqlite()) cursor = await buildCursorFixture(home, root);
  else write(path.join(home, '.config', 'Cursor', 'User', 'workspaceStorage', 'w', 'workspace.json'), '{}'); // exercise the needs-node path
  const projectRoot = fs.realpathSync(root);
  const env = cleanEnv({ SB_TRACE_HOME: home });
  return { base, root, projectRoot, home, ids, cursor, env };
}

const bySource = (sessions) => sessions.reduce((m, s) => ((m[s.source] ||= []).push(s), m), {});

test('dry run discovers every source, applies matching rules, writes nothing', async () => {
  const { projectRoot, ids, cursor, env } = await setup();
  const res = await runTrace({ projectRoot, since, dryRun: true, include: [] }, env);
  assert.equal(fs.existsSync(path.join(projectRoot, '.split-brain')), false, 'dry run must not write');
  const g = bySource(res.sessions);
  const claudeIds = (g['claude-code'] || []).map((s) => s.id).sort();
  assert.deepEqual(claudeIds, [ids.claude, `${ids.claude}__agent-abc123`].sort());
  // started in the parent folder and only mentions the project: skipped by default
  assert.deepEqual(res.skipped.map((x) => x.key), [`claude-code:${ids.claudeAncestor}`]);
  assert.equal(res.skipped[0].reason, 'started outside the project folder');
  assert.equal(res.totals.skippedParentFolder, 1);
  const main = g['claude-code'].find((s) => s.id === ids.claude);
  assert.equal(main.messageCount, 3); // 1 user prompt + 2 assistant messages (m1, m2)
  assert.equal(main.toolCallCount, 2);
  assert.deepEqual(main.models.sort(), ['model-alpha', 'model-beta']);
  assert.equal(main.title, 'Fix the flaky sync bug');
  assert.equal(main.matchedBy, 'cwd');
  const withParent = await runTrace({ projectRoot, since, dryRun: true, includeParent: true }, env);
  assert.equal(withParent.skipped.length, 0);
  assert.equal(withParent.sessions.find((s) => s.id === ids.claudeAncestor).matchedBy, PARENT_MATCH);
  assert.equal(g['claude-code'].find((s) => s.id.includes('agent')).kind, 'subagent');

  if (!hasZstd()) assert.equal(res.sources.codex.status, 'partial');
  const codex = (g.codex || []).map((s) => s.id).sort();
  assert.deepEqual(codex, [ids.codex, ...(hasZstd() ? [ids.codexZst] : [])].sort());
  const cx = g.codex.find((s) => s.id === ids.codex);
  assert.equal(cx.messageCount, 2);
  assert.equal(cx.toolCallCount, 2);
  assert.deepEqual(cx.models, ['model-codex']);
  assert.equal(cx.title, 'Codex thread');

  const vs = g['vscode-copilot'].map((s) => s.id).sort();
  assert.deepEqual(vs, [ids.vscodeJson, `${ids.vscodeJson}.editing`, ids.vscodeJsonl].sort());
  const legacy = g['vscode-copilot'].find((s) => s.id === ids.vscodeJson);
  assert.equal(legacy.messageCount, 2);
  assert.equal(legacy.toolCallCount, 1);
  const log = g['vscode-copilot'].find((s) => s.id === ids.vscodeJsonl);
  assert.equal(log.messageCount, 2);
  assert.deepEqual(log.models, ['copilot/model-y']);

  assert.deepEqual(g.opencode.map((s) => s.id), [ids.opencode]);
  assert.equal(g.opencode[0].toolCallCount, 1);
  assert.deepEqual(g.opencode[0].models, ['oc-model']);

  const gem = g['gemini-cli'].map((s) => s.kind).sort();
  assert.deepEqual(gem, ['chat', 'prompt-log']);
  assert.equal(g['gemini-cli'].find((s) => s.kind === 'chat').toolCallCount, 2);

  assert.equal(g.aider.length, 1);
  assert.deepEqual(g.aider[0].models, ['aider-model']);

  if (cursor) {
    assert.deepEqual(g.cursor.map((s) => s.id).sort(), [...cursor.ids].sort());
    const c1 = g.cursor.find((s) => s.id === 'comp-1');
    assert.equal(c1.messageCount, 2);
    assert.equal(c1.toolCallCount, 1);
    assert.deepEqual(c1.models, ['cursor-model']);
  } else {
    assert.equal(res.sources.cursor.status, 'needs-node');
  }
  // excluded: sibling prefix, outside window, other projects
  const all = res.sessions.map((s) => s.id).join(' ');
  for (const bad of [ids.claudeSibling, ids.claudeOld, ids.claudeAncestorNoMention, ids.codexOther, 'not-mine', 'ses_other', 'comp-2', 'session-other']) {
    assert.ok(!all.includes(bad), `should not include ${bad}`);
  }
});

test('trace exports redacted snapshots, is idempotent, and retains pruned sessions', async () => {
  const { projectRoot, ids, cursor, env, base } = await setup();
  const manual = write(path.join(base, 'export-from-other-tool.md'), `notes with ${SECRETS.aws}\n`);
  const r1 = await runTrace({ projectRoot, since, include: [manual] }, env);
  const sessDir = path.join(projectRoot, '.split-brain', 'sessions');
  const index = JSON.parse(fs.readFileSync(path.join(sessDir, 'index.json'), 'utf8'));
  assert.equal(index.sessions.length, r1.sessions.length);
  assert.ok(r1.sessions.every((s) => s.status === 'new'));

  // every file is redacted
  const files = readAllFiles(sessDir);
  for (const f of files) for (const [k, v] of Object.entries(SECRETS)) assert.ok(!f.text.includes(v), `${k} secret leaked into ${path.basename(f.path)}`);
  assert.ok(!files.some((f) => /\.(vscdb|db|sqlite)$/.test(f.path)), 'no database files may be copied');
  assert.ok(!files.some((f) => f.text.includes('NOT-THIS-PROJECT')), 'other workspaces must not be extracted');

  // JSON / JSONL exports remain parseable after redaction
  for (const f of files) {
    if (f.path.endsWith('.json')) assert.doesNotThrow(() => JSON.parse(f.text), f.path);
    if (f.path.endsWith('.jsonl')) for (const l of f.text.split('\n').filter(Boolean)) assert.doesNotThrow(() => JSON.parse(l), f.path);
  }
  const claude = index.sessions.find((s) => s.id === ids.claude);
  assert.equal(claude.file, `claude-code/${ids.claude}.jsonl`);
  assert.deepEqual(claude.redactions, { openai: 1, bearer: 1, env: 1 });
  assert.match(claude.sha256, /^[0-9a-f]{64}$/);
  assert.equal(claude.bytes, fs.statSync(path.join(sessDir, claude.file)).size);
  for (const key of ['source', 'id', 'title', 'startedAt', 'endedAt', 'messageCount', 'toolCallCount', 'models', 'cwd', 'originalPath', 'bytes', 'sha256', 'redactions']) {
    assert.ok(key in claude, `index entry missing ${key}`);
  }
  const manualEntry = index.sessions.find((s) => s.source === 'manual');
  assert.equal(manualEntry.file, 'manual/export-from-other-tool.md');
  assert.deepEqual(manualEntry.redactions, { 'aws-access-key': 1 });
  if (cursor) {
    const c = JSON.parse(fs.readFileSync(path.join(sessDir, 'cursor', 'comp-1.json'), 'utf8'));
    assert.equal(c.bubbles.length, 2);
    assert.match(c.bubbles[0].text, /\[REDACTED:openai\]/);
  }
  if (hasZstd()) {
    const z = fs.readFileSync(path.join(sessDir, 'codex', `${ids.codexZst}.jsonl`), 'utf8');
    assert.match(z, /\[REDACTED:aws-access-key\]/);
  }

  // second run: nothing changes
  const mtimes = new Map(files.map((f) => [f.path, fs.statSync(f.path).mtimeMs]));
  const r2 = await runTrace({ projectRoot, since, include: [manual] }, env);
  assert.deepEqual([...new Set(r2.sessions.map((s) => s.status))], ['unchanged']);
  for (const f of files) if (!f.path.endsWith('index.json')) assert.equal(fs.statSync(f.path).mtimeMs, mtimes.get(f.path), `rewrote ${f.path}`);

  // source grows -> re-exported; source pruned -> snapshot retained
  const claudeSrc = claude.originalPath;
  fs.appendFileSync(claudeSrc, jsonl([{ type: 'user', sessionId: ids.claude, cwd: projectRoot, timestamp: new Date().toISOString(), message: { role: 'user', content: 'one more' } }]));
  const codexEntry = index.sessions.find((s) => s.id === ids.codex);
  fs.rmSync(codexEntry.originalPath);
  const r3 = await runTrace({ projectRoot, since }, env);
  const st = Object.fromEntries(r3.sessions.map((s) => [s.id, s.status]));
  assert.equal(st[ids.claude], 'changed');
  assert.equal(st[ids.codex], 'retained');
  assert.equal(st['export-from-other-tool'], 'retained');
  assert.ok(fs.existsSync(path.join(sessDir, codexEntry.file)), 'pruned session snapshot must be kept');
  const index3 = JSON.parse(fs.readFileSync(path.join(sessDir, 'index.json'), 'utf8'));
  assert.equal(index3.sessions.length, index.sessions.length);
  assert.equal(index3.sessions.find((s) => s.id === ids.codex).seenInLastRun, false);
  assert.equal(index3.sessions.find((s) => s.id === ids.claude).messageCount, 4);
});

test('per-session cap keeps the first 20% and last 80%, with a note, as valid JSONL', async () => {
  const { projectRoot, ids, env, home } = await setup();
  const file = fs.readdirSync(path.join(home, '.claude', 'projects')).map((d) => path.join(home, '.claude', 'projects', d, `${ids.claude}.jsonl`)).find((f) => fs.existsSync(f));
  const filler = Array.from({ length: 4000 }, (_, i) => ({ type: 'user', sessionId: ids.claude, cwd: projectRoot, timestamp: new Date().toISOString(), uuid: `f${i}`, message: { role: 'user', content: `${i} ${'x'.repeat(300)}` } }));
  fs.appendFileSync(file, jsonl(filler));
  fs.appendFileSync(file, jsonl([{ type: 'user', sessionId: ids.claude, cwd: projectRoot, timestamp: new Date().toISOString(), uuid: 'last', message: { role: 'user', content: `final words ${SECRETS.openai}` } }]));
  const res = await runTrace({ projectRoot, since, maxSessionMb: '0.5' }, env);
  const s = res.sessions.find((x) => x.id === ids.claude);
  assert.equal(s.truncated, true);
  assert.ok(s.bytes <= 0.5 * 1048576 + 1024);
  const text = fs.readFileSync(path.join(projectRoot, '.split-brain', 'sessions', s.file), 'utf8');
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  const noteAt = lines.findIndex((l) => l.type === 'split-brain-truncated');
  assert.ok(noteAt > 0 && noteAt < lines.length - 1, 'note sits between head and tail');
  assert.equal(lines[0].type, 'permission-mode'); // head starts at the beginning
  assert.equal(lines.at(-1).uuid, 'last'); // tail reaches the end
  assert.match(lines.at(-1).message.content, /\[REDACTED:openai\]/);
  const headBytes = Buffer.byteLength(lines.slice(0, noteAt).map((l) => JSON.stringify(l)).join('\n'));
  assert.ok(headBytes <= 0.1 * 1048576 + 512, `head ${headBytes}`);
  assert.ok(!lines.some((l) => l.uuid === 'f600'), 'middle omitted');
  assert.ok(res.warnings.some((w) => w.includes('kept its first and last parts')));
});

test('readHeadTail: plain and zstd files give identical head/tail on line boundaries', async () => {
  const dir = mkTmp('sbt-ht-');
  const text = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'y'.repeat(i % 97)}`).join('\n') + '\n';
  const plain = write(path.join(dir, 'a.jsonl'), text);
  const cap = 40000;
  const a = await readHeadTail(plain, cap);
  assert.equal(a.truncated, true);
  assert.ok(a.head.startsWith('line 0 ') && a.head.endsWith('\n') && Buffer.byteLength(a.head) <= cap * 0.2);
  assert.ok(a.tail.endsWith('line 4999 ' + 'y'.repeat(4999 % 97) + '\n') && /^line \d+ /.test(a.tail) && Buffer.byteLength(a.tail) <= cap * 0.8);
  const small = await readHeadTail(plain, 10_000_000);
  assert.equal(small.truncated, false);
  assert.equal(small.head, text);
  if (hasZstd()) {
    const z = write(path.join(dir, 'a.jsonl.zst'), zlib.zstdCompressSync(Buffer.from(text)));
    const b = await readHeadTail(z, cap);
    assert.deepEqual(b, a);
    assert.deepEqual(await readHeadTail(z, 10_000_000), small);
  }
});

test('exclusions: --exclude and trace-exclude.txt remove snapshots and are never re-added; only counts persist', async () => {
  const { projectRoot, ids, env } = await setup();
  await runTrace({ projectRoot, since }, env);
  const sessDir = path.join(projectRoot, '.split-brain', 'sessions');
  const claudeFile = path.join(sessDir, 'claude-code', `${ids.claude}.jsonl`);
  const codexFile = path.join(sessDir, 'codex', `${ids.codex}.jsonl`);
  assert.ok(fs.existsSync(claudeFile) && fs.existsSync(codexFile));

  write(path.join(projectRoot, '.split-brain', 'trace-exclude.txt'), `# sessions I do not want to share\nclaude-code:${ids.claude}   # personal\n\n`);
  const dry = await runTrace({ projectRoot, since, dryRun: true, exclude: [`codex:${ids.codex}`] }, env);
  assert.deepEqual(dry.excluded.map((e) => e.key).sort(), [`claude-code:${ids.claude}`, `claude-code:${ids.claude}__agent-abc123`, `codex:${ids.codex}`].sort());
  assert.ok(fs.existsSync(claudeFile), 'dry run removes nothing');

  const res = await runTrace({ projectRoot, since, exclude: [`codex:${ids.codex}`] }, env);
  assert.equal(res.totals.excluded, 3); // the session, its subagent, and the codex session
  assert.ok(!fs.existsSync(claudeFile) && !fs.existsSync(codexFile));
  assert.ok(!fs.existsSync(path.join(sessDir, 'claude-code', `${ids.claude}__agent-abc123.jsonl`)));
  const indexText = fs.readFileSync(path.join(sessDir, 'index.json'), 'utf8');
  for (const id of [ids.claude, ids.codex]) assert.ok(!indexText.includes(id), 'excluded ids must not appear in index.json');
  assert.equal(JSON.parse(indexText).totals.excluded, 3);

  // file-only exclusion still applies on later runs; the codex one (flag only) comes back
  const again = await runTrace({ projectRoot, since }, env);
  assert.ok(!fs.existsSync(claudeFile));
  assert.ok(!again.sessions.some((s) => s.id === ids.claude));
  assert.ok(again.sessions.some((s) => s.id === ids.codex));
});

test('started.json sets the window (startedAt - 1h)', async () => {
  const { projectRoot, env, ids } = await setup();
  write(path.join(projectRoot, '.split-brain', 'started.json'), JSON.stringify({ startedAt: new Date(Date.now() - 2.5 * 3600_000).toISOString() }));
  const res = await runTrace({ projectRoot, dryRun: true }, env);
  assert.equal(res.window.origin, 'started.json');
  const got = res.sessions.map((s) => s.id);
  assert.ok(got.includes(ids.claude)); // ended 1h ago
  assert.ok(!got.includes(ids.codexZst ?? 'none')); // ended 5h ago: before startedAt - 1h
});

test('host project root + per-source dir overrides (container scenario)', async () => {
  const base = mkTmp('sbt-host-');
  const containerRoot = makeProject(base);
  const hostRoot = 'C:\\Users\\Alice\\split brain';
  const mounted = path.join(base, 'mnt-claude');
  const sid = '99999999-9999-4999-8999-999999999999';
  write(path.join(mounted, 'projects', 'C--Users-Alice-split-brain', `${sid}.jsonl`), jsonl([
    { type: 'user', sessionId: sid, cwd: 'C:\\Users\\alice\\Split Brain\\apps', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } },
  ]));
  const vsMounted = path.join(base, 'mnt-code-user');
  write(path.join(vsMounted, 'workspaceStorage', 'w', 'workspace.json'), JSON.stringify({ folder: 'file:///c%3A/Users/Alice/split%20brain' }));
  write(path.join(vsMounted, 'workspaceStorage', 'w', 'chatSessions', 'win-chat.json'), JSON.stringify({ sessionId: 'win-chat', creationDate: Date.now(), requests: [] }));
  const env = cleanEnv({ SB_TRACE_HOME: path.join(base, 'empty-home'), SB_TRACE_CLAUDE_DIR: mounted });
  const res = await runTrace({ projectRoot: containerRoot, since, dryRun: true, hostProjectRoot: [hostRoot], vscodeDir: [vsMounted] }, env);
  assert.deepEqual(res.sessions.map((s) => s.id).sort(), [sid, 'win-chat']);
  assert.deepEqual(res.sources['claude-code'].checked, [path.resolve(mounted)]);
});

test('OpenCode SQLite storage (best effort)', { skip: !hasSqlite() && 'node:sqlite unavailable' }, async () => {
  const base = mkTmp('sbt-ocdb-');
  const root = makeProject(base);
  const home = path.join(base, 'home');
  await buildOpencodeDbFixture(home, root);
  const projectRoot = fs.realpathSync(root);
  const env = cleanEnv({ SB_TRACE_HOME: home });
  const res = await runTrace({ projectRoot, since }, env);
  const oc = res.sessions.filter((s) => s.source === 'opencode');
  assert.deepEqual(oc.map((s) => s.id), ['ses_db1']);
  assert.equal(oc[0].messageCount, 2);
  assert.equal(oc[0].toolCallCount, 1);
  assert.deepEqual(oc[0].models, ['oc-db-model']);
  const text = fs.readFileSync(path.join(projectRoot, '.split-brain', 'sessions', oc[0].file), 'utf8');
  assert.ok(!text.includes(SECRETS.openai));
  assert.ok(!text.includes('ses_db_other'));
});

test('over-cap JSON exports stay valid JSON with head and tail', async () => {
  const { projectRoot, env, base } = await setup();
  const big = write(path.join(base, 'export.json'), JSON.stringify({ items: Array.from({ length: 3000 }, (_, i) => ({ i, text: `item ${i} ${'z'.repeat(200)}` })) }, null, 2));
  const res = await runTrace({ projectRoot, since, include: [big], maxSessionMb: '0.1' }, env);
  const s = res.sessions.find((x) => x.source === 'manual');
  assert.equal(s.truncated, true);
  const j = JSON.parse(fs.readFileSync(path.join(projectRoot, '.split-brain', 'sessions', s.file), 'utf8'));
  assert.equal(j.splitBrainTruncated, true);
  assert.match(j.head, /^\{/);
  assert.match(j.tail, /item 2999 /);
});
