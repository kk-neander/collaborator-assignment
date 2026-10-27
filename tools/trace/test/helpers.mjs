// Test helpers: synthetic fixtures for every source. No real transcripts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));

// Fake secrets are assembled at runtime so this file contains no token-shaped literals.
export const SECRETS = {
  openai: `sk-${'proj-'}${'A1b2C3d4'.repeat(5)}`,
  anthropic: `sk-${'ant-'}api03-${'Zz9Yy8Xx'.repeat(4)}`,
  github: `gh${'p_'}${'aB3dE5gH7j'.repeat(4)}`,
  aws: `AK${'IA'}${'QWERTYUIOP123456'}`,
  bearer: `tok${'en'}_${'9f8e7d6c5b4a'.repeat(2)}`,
  env: `s3cr3t-${'value'}-${'123456'}`,
};

export function mkTmp(prefix = 'sbt-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

export function jsonl(lines) {
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

export function hasSqlite() {
  try { return typeof process.getBuiltinModule === 'function' && Boolean(process.getBuiltinModule('node:sqlite')); } catch { return false; }
}
export const hasZstd = () => typeof zlib.zstdCompressSync === 'function';
export function hasCmd(cmd, args = ['--version']) {
  try { return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0; } catch { return false; }
}

export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(SB_TRACE_|SB_HANDLE|SB_EMAIL|SUBMIT_|CLAUDE_CONFIG_DIR|CODEX_HOME|XDG_DATA_HOME|APPDATA|LOCALAPPDATA|GIT_DIR|GIT_WORK_TREE)/.test(k)) delete env[k];
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: 'Test Candidate',
    GIT_AUTHOR_EMAIL: 'candidate@example.com',
    GIT_COMMITTER_NAME: 'Test Candidate',
    GIT_COMMITTER_EMAIL: 'candidate@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
    NODE_NO_WARNINGS: '1',
    ...extra,
  };
}

export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** A git repo (with a space in its name) and one commit. */
export function makeProject(base, { commit = true } = {}) {
  const root = path.join(base, 'split brain');
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test Candidate');
  git(root, 'config', 'user.email', 'candidate@example.com');
  write(path.join(root, 'README.md'), '# test project\n');
  write(path.join(root, '.gitignore'), '.split-brain/\nsubmission/\n.env\n');
  write(path.join(root, '.env'), `MY_SERVICE_TOKEN=${SECRETS.env}\nNODE_ENV=production\nPORT=3000\n`);
  if (commit) {
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
  }
  return root;
}

export function runCli(args, { cwd, env = {}, input } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env: cleanEnv(env), encoding: 'utf8', input, timeout: 120000 });
}

export function runCliAsync(args, { cwd, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const HOUR = 3600_000;

/**
 * Build a fake home with sessions for every source. `root` is the project root
 * (as git reports it); `recordedRoot` is how tools recorded it (e.g. /var vs /private/var).
 */
export function buildFakeHome(home, root, { recordedRoot = root } = {}) {
  const ids = {};
  const realRoot = fs.realpathSync(root);
  const parent = path.dirname(recordedRoot);

  // ---- Claude Code
  const cproj = path.join(home, '.claude', 'projects', recordedRoot.replace(/[^A-Za-z0-9]/g, '-'));
  ids.claude = '11111111-1111-4111-8111-111111111111';
  const cl = (o) => ({ sessionId: ids.claude, cwd: recordedRoot, timestamp: iso(2 * HOUR), ...o });
  write(path.join(cproj, `${ids.claude}.jsonl`), jsonl([
    { type: 'permission-mode', permissionMode: 'default', sessionId: ids.claude },
    cl({ type: 'user', uuid: 'u1', message: { role: 'user', content: `please fix the bug; key ${SECRETS.openai}` } }),
    cl({ type: 'assistant', uuid: 'a1', timestamp: iso(HOUR + 59 * 60000), message: { id: 'm1', model: 'model-alpha', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
    cl({ type: 'assistant', uuid: 'a2', timestamp: iso(HOUR + 58 * 60000), message: { id: 'm1', model: 'model-alpha', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `curl -H "Authorization: Bearer ${SECRETS.bearer}" x` } }] } }),
    cl({ type: 'user', uuid: 'u2', timestamp: iso(HOUR + 57 * 60000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `env has ${SECRETS.env}` }] } }),
    cl({ type: 'assistant', uuid: 'a3', timestamp: iso(HOUR), message: { id: 'm2', model: 'model-beta', role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: {} }] } }),
    { type: 'ai-title', aiTitle: 'Fix the flaky sync bug', sessionId: ids.claude },
  ]));
  // subagent transcript in a subfolder of the project
  write(path.join(cproj, ids.claude, 'subagents', 'agent-abc123.jsonl'), jsonl([
    cl({ type: 'user', uuid: 's1', cwd: path.join(recordedRoot, 'apps', 'web'), message: { role: 'user', content: 'explore' } }),
    cl({ type: 'assistant', uuid: 's2', cwd: path.join(recordedRoot, 'apps', 'web'), message: { id: 'sm1', model: 'model-gamma', content: [{ type: 'text', text: 'done' }] } }),
  ]));
  // sibling folder with the project name as a prefix: must NOT match
  ids.claudeSibling = '22222222-2222-4222-8222-222222222222';
  write(path.join(home, '.claude', 'projects', 'sibling', `${ids.claudeSibling}.jsonl`), jsonl([
    { type: 'user', sessionId: ids.claudeSibling, cwd: `${recordedRoot}-other`, timestamp: iso(HOUR), message: { role: 'user', content: 'other project' } },
  ]));
  // old session (outside window)
  ids.claudeOld = '33333333-3333-4333-8333-333333333333';
  const oldFile = write(path.join(cproj, `${ids.claudeOld}.jsonl`), jsonl([
    { type: 'user', sessionId: ids.claudeOld, cwd: recordedRoot, timestamp: '2020-01-01T00:00:00.000Z', message: { role: 'user', content: 'old' } },
  ]));
  fs.utimesSync(oldFile, new Date('2020-01-02'), new Date('2020-01-02'));
  // launched from the parent dir, mentions the project path -> matches
  ids.claudeAncestor = '44444444-4444-4444-8444-444444444444';
  write(path.join(home, '.claude', 'projects', 'parent', `${ids.claudeAncestor}.jsonl`), jsonl([
    { type: 'user', sessionId: ids.claudeAncestor, cwd: parent, timestamp: iso(HOUR), message: { role: 'user', content: `work in ${recordedRoot}/src please` } },
  ]));
  // launched from the parent dir, never mentions the project -> no match
  ids.claudeAncestorNoMention = '55555555-5555-4555-8555-555555555555';
  write(path.join(home, '.claude', 'projects', 'parent', `${ids.claudeAncestorNoMention}.jsonl`), jsonl([
    { type: 'user', sessionId: ids.claudeAncestorNoMention, cwd: parent, timestamp: iso(HOUR), message: { role: 'user', content: 'unrelated work' } },
  ]));

  // ---- Codex
  ids.codex = '019a0000-0000-7000-8000-000000000001';
  const cx = (type, payload, t = iso(3 * HOUR)) => ({ timestamp: t, type, payload });
  const codexLines = [
    cx('session_meta', { id: ids.codex, cwd: recordedRoot, timestamp: iso(3 * HOUR), cli_version: '0.1' }),
    cx('turn_context', { cwd: recordedRoot, model: 'model-codex' }),
    cx('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] }),
    cx('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `use token ${SECRETS.github}` }] }),
    cx('response_item', { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' }),
    cx('response_item', { type: 'custom_tool_call', name: 'apply_patch', input: '', call_id: 'c2' }),
    cx('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }, iso(2 * HOUR)),
  ];
  write(path.join(home, '.codex', 'sessions', '2026', '10', '20', `rollout-2026-10-20T10-00-00-${ids.codex}.jsonl`), jsonl(codexLines));
  write(path.join(home, '.codex', 'session_index.jsonl'), jsonl([{ id: ids.codex, thread_name: 'Codex thread', updated_at: iso(HOUR) }]));
  ids.codexOther = '019a0000-0000-7000-8000-000000000002';
  write(path.join(home, '.codex', 'sessions', '2026', '10', '20', `rollout-2026-10-20T11-00-00-${ids.codexOther}.jsonl`), jsonl([
    cx('session_meta', { id: ids.codexOther, cwd: path.join(parent, 'unrelated'), timestamp: iso(HOUR) }),
  ]));
  if (hasZstd()) {
    ids.codexZst = '019a0000-0000-7000-8000-000000000003';
    const z = jsonl([
      cx('session_meta', { id: ids.codexZst, cwd: path.join(recordedRoot, 'apps'), timestamp: iso(5 * HOUR) }, iso(5 * HOUR)),
      cx('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `aws ${SECRETS.aws}` }] }, iso(5 * HOUR)),
    ]);
    write(path.join(home, '.codex', 'archived_sessions', `rollout-2026-10-20T09-00-00-${ids.codexZst}.jsonl.zst`), zlib.zstdCompressSync(Buffer.from(z)));
  } else {
    // Node without zstd: the collector must report these as skipped, not crash.
    write(path.join(home, '.codex', 'archived_sessions', 'rollout-2026-10-20T09-00-00-019a0000-0000-7000-8000-00000000000f.jsonl.zst'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
  }

  // ---- VS Code Copilot Chat (Linux layout; every layout is probed on every OS)
  const vsUser = path.join(home, '.config', 'Code', 'User');
  const vsWs = path.join(vsUser, 'workspaceStorage', 'aaaa1111');
  write(path.join(vsWs, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(recordedRoot).href }));
  ids.vscodeJson = 'chat-legacy-1';
  write(path.join(vsWs, 'chatSessions', `${ids.vscodeJson}.json`), JSON.stringify({
    version: 3, sessionId: ids.vscodeJson, customTitle: 'Copilot chat', creationDate: Date.now() - 4 * HOUR, lastMessageDate: Date.now() - 3 * HOUR,
    requests: [{ message: { text: `hello ${SECRETS.anthropic}` }, timestamp: Date.now() - 4 * HOUR, modelId: 'copilot/model-x', response: [{ kind: 'markdownContent', value: 'hi' }, { kind: 'toolInvocationSerialized' }] }],
  }));
  ids.vscodeJsonl = 'chat-log-2';
  write(path.join(vsWs, 'chatSessions', `${ids.vscodeJsonl}.jsonl`), jsonl([
    { kind: 0, v: { version: 3, sessionId: ids.vscodeJsonl, creationDate: Date.now() - 2 * HOUR, requests: [] } },
    { kind: 2, k: ['requests'], v: [{ message: { text: 'q' }, timestamp: Date.now() - 2 * HOUR, modelId: 'copilot/model-y', response: [] }] },
    { kind: 1, k: ['requests', 0, 'response'], v: [{ kind: 'markdownContent', value: 'a' }] },
  ]));
  write(path.join(vsWs, 'chatEditingSessions', ids.vscodeJson, 'state.json'), JSON.stringify({ version: 1, timeline: [] }));
  const vsOther = path.join(vsUser, 'workspaceStorage', 'bbbb2222');
  write(path.join(vsOther, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(path.join(parent, 'unrelated')).href }));
  write(path.join(vsOther, 'chatSessions', 'not-mine.json'), JSON.stringify({ sessionId: 'not-mine', creationDate: Date.now(), requests: [] }));

  // ---- OpenCode (file storage)
  const oc = path.join(home, '.local', 'share', 'opencode', 'storage');
  ids.opencode = 'ses_test1';
  write(path.join(oc, 'session', 'proj1', `${ids.opencode}.json`), JSON.stringify({ id: ids.opencode, projectID: 'proj1', directory: recordedRoot, title: 'OC session', time: { created: Date.now() - 3 * HOUR, updated: Date.now() - 2 * HOUR } }));
  write(path.join(oc, 'message', ids.opencode, 'msg_1.json'), JSON.stringify({ id: 'msg_1', sessionID: ids.opencode, role: 'user', time: { created: Date.now() - 3 * HOUR } }));
  write(path.join(oc, 'message', ids.opencode, 'msg_2.json'), JSON.stringify({ id: 'msg_2', sessionID: ids.opencode, role: 'assistant', modelID: 'oc-model', time: { created: Date.now() - 2 * HOUR } }));
  write(path.join(oc, 'part', 'msg_1', 'prt_1.json'), JSON.stringify({ id: 'prt_1', messageID: 'msg_1', type: 'text', text: `key ${SECRETS.openai}` }));
  write(path.join(oc, 'part', 'msg_2', 'prt_2.json'), JSON.stringify({ id: 'prt_2', messageID: 'msg_2', type: 'tool', tool: 'bash' }));
  write(path.join(oc, 'session', 'proj2', 'ses_other.json'), JSON.stringify({ id: 'ses_other', directory: path.join(parent, 'unrelated'), time: { created: Date.now() } }));

  // ---- Gemini CLI (dir name = sha256 of the project root as process.cwd() reports it)
  const gHash = crypto.createHash('sha256').update(realRoot).digest('hex');
  const gDir = path.join(home, '.gemini', 'tmp', gHash);
  ids.gemini = 'session-2026-10-20T10-00-abcd1234';
  write(path.join(gDir, 'chats', `${ids.gemini}.json`), JSON.stringify({
    sessionId: 'g-1', projectHash: gHash, startTime: iso(4 * HOUR), lastUpdated: iso(3 * HOUR),
    messages: [
      { id: '1', type: 'user', content: `slack xox${'b'}-1234567890-abcdefghij`, timestamp: iso(4 * HOUR) },
      { id: '2', type: 'gemini', content: 'ok', model: 'gemini-model', toolCalls: [{ name: 'read_file' }, { name: 'edit' }], timestamp: iso(3 * HOUR) },
    ],
  }));
  write(path.join(gDir, 'logs.json'), JSON.stringify([{ sessionId: 'g-1', messageId: 0, type: 'user', message: 'hi', timestamp: iso(4 * HOUR) }]));
  write(path.join(home, '.gemini', 'tmp', 'f'.repeat(64), 'chats', 'session-other.json'), JSON.stringify({ sessionId: 'x', messages: [], startTime: iso(HOUR) }));

  // ---- Aider (inside the project)
  const now = new Date(Date.now() - HOUR);
  const pad = (n) => String(n).padStart(2, '0');
  const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  write(path.join(root, '.aider.chat.history.md'), `\n# aider chat started at ${local}\n\n> Model: aider-model with diff edit format\n\n#### fix the sync bug with ${SECRETS.github}\n\nSure.\n`);

  return ids;
}

/** Cursor fixture (needs node:sqlite). */
export async function buildCursorFixture(home, recordedRoot) {
  const { DatabaseSync } = await import('node:sqlite');
  const user = path.join(home, '.config', 'Cursor', 'User');
  const mk = (file, ddl) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const db = new DatabaseSync(file); db.exec(ddl); return db; };
  const ws1 = path.join(user, 'workspaceStorage', 'cursorws1');
  write(path.join(ws1, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(recordedRoot).href }));
  const w1 = mk(path.join(ws1, 'state.vscdb'), 'create table ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  w1.prepare('insert into ItemTable values (?, ?)').run('composer.composerData', JSON.stringify({ allComposers: [{ composerId: 'comp-1' }] }));
  w1.close();
  const ws2 = path.join(user, 'workspaceStorage', 'cursorws2');
  write(path.join(ws2, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(path.join(path.dirname(recordedRoot), 'unrelated')).href }));
  const w2 = mk(path.join(ws2, 'state.vscdb'), 'create table ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  w2.prepare('insert into ItemTable values (?, ?)').run('composer.composerData', JSON.stringify({ allComposers: [{ composerId: 'comp-2' }] }));
  w2.close();
  const g = mk(path.join(user, 'globalStorage', 'state.vscdb'), `
    create table ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    create table cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    create table composerHeaders (composerId TEXT, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, value TEXT);`);
  const put = g.prepare('insert into cursorDiskKV values (?, ?)');
  const t = Date.now() - 2 * HOUR;
  put.run('composerData:comp-1', JSON.stringify({ composerId: 'comp-1', name: 'Cursor agent', createdAt: t, lastUpdatedAt: t + 60000, modelConfig: { modelName: 'cursor-model' }, fullConversationHeadersOnly: [{ bubbleId: 'b1', type: 1 }, { bubbleId: 'b2', type: 2 }], subComposerIds: ['comp-sub'] }));
  put.run('bubbleId:comp-1:b1', JSON.stringify({ type: 1, text: `my key ${SECRETS.openai}`, createdAt: new Date(t).toISOString() }));
  put.run('bubbleId:comp-1:b2', JSON.stringify({ type: 2, text: 'editing', toolFormerData: { tool: 7, name: 'edit_file' }, modelInfo: { modelName: 'cursor-model' } }));
  put.run('composerData:comp-sub', JSON.stringify({ composerId: 'comp-sub', createdAt: t, lastUpdatedAt: t, conversation: [{ type: 1, text: 'sub task' }] }));
  put.run('composerData:comp-2', JSON.stringify({ composerId: 'comp-2', createdAt: t, lastUpdatedAt: t, fullConversationHeadersOnly: [{ bubbleId: 'x', type: 1 }] }));
  put.run('bubbleId:comp-2:x', JSON.stringify({ type: 1, text: 'NOT-THIS-PROJECT' }));
  put.run('composerData:comp-3', JSON.stringify({ composerId: 'comp-3', createdAt: t, lastUpdatedAt: t, fullConversationHeadersOnly: [] }));
  g.prepare('insert into composerHeaders values (?, ?, ?, ?, ?)').run('comp-3', 'cursorws1', t, t, '{}');
  g.close();
  return { ids: ['comp-1', 'comp-sub', 'comp-3'], excluded: ['comp-2'] };
}

/** All file contents under a dir, concatenated (for "no secret leaked" checks). */
export function readAllFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push({ path: p, text: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(dir);
  return out;
}

/** OpenCode SQLite-variant fixture (shape is a guess at newer versions; best effort). */
export async function buildOpencodeDbFixture(home, recordedRoot) {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = path.join(home, '.local', 'share', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'opencode.db'));
  db.exec(`create table session (id text primary key, directory text, title text, time_created integer, time_updated integer);
    create table message (id text primary key, session_id text, time_created integer, data text);
    create table part (id text primary key, message_id text, session_id text, data text);`);
  const t = Date.now() - 2 * HOUR;
  db.prepare('insert into session values (?, ?, ?, ?, ?)').run('ses_db1', recordedRoot, 'DB session', t, t + 1000);
  db.prepare('insert into session values (?, ?, ?, ?, ?)').run('ses_db_other', path.join(path.dirname(recordedRoot), 'elsewhere'), 'x', t, t);
  db.prepare('insert into message values (?, ?, ?, ?)').run('m1', 'ses_db1', t, JSON.stringify({ role: 'user' }));
  db.prepare('insert into message values (?, ?, ?, ?)').run('m2', 'ses_db1', t + 500, JSON.stringify({ role: 'assistant', modelID: 'oc-db-model' }));
  db.prepare('insert into part values (?, ?, ?, ?)').run('p1', 'm1', 'ses_db1', JSON.stringify({ type: 'text', text: `key ${SECRETS.openai}` }));
  db.prepare('insert into part values (?, ?, ?, ?)').run('p2', 'm2', 'ses_db1', JSON.stringify({ type: 'tool', tool: 'bash' }));
  db.close();
}
