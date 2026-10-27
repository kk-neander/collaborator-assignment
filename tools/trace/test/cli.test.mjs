import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { readTar } from '../lib/tar.mjs';
import { TEMPLATE_MARKER } from '../lib/version.mjs';
import { buildFakeHome, git, hasCmd, makeProject, mkTmp, runCli, runCliAsync, SECRETS, write } from './helpers.mjs';

function project() {
  const base = mkTmp('sbt-cli-');
  const root = makeProject(base);
  const home = path.join(base, 'home');
  buildFakeHome(home, root);
  return { base, root: fs.realpathSync(root), home };
}

function readArchive(file) {
  const items = readTar(zlib.gunzipSync(fs.readFileSync(file)));
  return new Map(items.filter((i) => i.type === 'file').map((i) => [i.name, i.data]));
}

test('help and unknown command', () => {
  const h = runCli(['--help']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /Usage: node tools\/trace\/cli.mjs/);
  const u = runCli(['frobnicate']);
  assert.equal(u.status, 2);
  assert.match(u.stderr, /unknown command/);
  const bad = runCli(['trace', '--no-such-flag']);
  assert.equal(bad.status, 2);
});

test('init writes started.json once', () => {
  const { root, home } = project();
  const r1 = runCli(['init'], { cwd: path.join(root), env: { SB_TRACE_HOME: home } });
  assert.equal(r1.status, 0, r1.stderr);
  const marker = JSON.parse(fs.readFileSync(path.join(root, '.split-brain', 'started.json'), 'utf8'));
  for (const k of ['startedAt', 'gitHead', 'platform', 'toolVersion']) assert.ok(marker[k], k);
  assert.equal(marker.gitHead, git(root, 'rev-parse', 'HEAD'));
  const r2 = runCli(['init'], { cwd: root, env: { SB_TRACE_HOME: home } });
  assert.match(r2.stdout, /Already initialised/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.split-brain', 'started.json'), 'utf8')).startedAt, marker.startedAt);
});

test('trace --dry-run --json from a subdirectory: git toplevel, no writes, no titles', () => {
  const { root, home } = project();
  fs.mkdirSync(path.join(root, 'apps', 'web'), { recursive: true });
  const r = runCli(['trace', '--dry-run', '--json'], { cwd: path.join(root, 'apps', 'web'), env: { SB_TRACE_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.projectRoot, root);
  assert.equal(j.dryRun, true);
  assert.equal(j.window.origin, 'default-21d');
  assert.ok(j.sessions.length >= 8);
  assert.ok(j.sessions.every((s) => !('title' in s)));
  assert.ok(!r.stdout.includes('Fix the flaky sync bug'));
  assert.equal(fs.existsSync(path.join(root, '.split-brain')), false);
  for (const v of Object.values(SECRETS)) assert.ok(!r.stdout.includes(v) && !r.stderr.includes(v));
  const table = runCli(['trace', '--dry-run'], { cwd: root, env: { SB_TRACE_HOME: home } });
  assert.equal(table.status, 0);
  assert.match(table.stdout, /SESSION ID \(source:id\)/);
  assert.match(table.stdout, /^claude-code:11111111-1111-4111-8111-111111111111\s/m); // exact id to paste into trace-exclude.txt
  assert.match(table.stdout, /skipped: started outside the project folder \(1\)/);
  assert.match(table.stdout, /^ {2}claude-code:44444444-4444-4444-8444-444444444444\s/m);
  assert.match(table.stdout, /--include-parent/);
  assert.match(table.stderr, /defaulting to the last 21 days/);
});

test('submit refuses the template and runs without consent; SUBMISSION.md is optional', () => {
  const { root, home } = project();
  const env = { SB_TRACE_HOME: home, SB_EMAIL: 'test@example.com' };
  const missing = runCli(['submit'], { cwd: root, env });
  assert.equal(missing.status, 2);
  assert.doesNotMatch(missing.stderr, /SUBMISSION\.md is missing/);
  write(path.join(root, 'SUBMISSION.md'), `${TEMPLATE_MARKER}\n# Submission\n`);
  const tmpl = runCli(['submit', '--yes'], { cwd: root, env });
  assert.equal(tmpl.status, 1);
  assert.match(tmpl.stderr, /still the template/);
  write(path.join(root, 'SUBMISSION.md'), '# My submission\nFixed things.\n');
  const noTty = runCli(['submit'], { cwd: root, env });
  assert.equal(noTty.status, 2);
  assert.match(noTty.stderr, /needs your confirmation/);
  assert.equal(fs.existsSync(path.join(root, 'submission')), false);
});

test('submit --yes builds a complete archive', { skip: !hasCmd('git') && 'git missing' }, async () => {
  const { root, home, base } = project();
  write(path.join(root, 'SUBMISSION.md'), '# My submission\nFixed things.\n');
  git(root, 'add', 'SUBMISSION.md');
  git(root, 'commit', '-q', '-m', 'submission');
  write(path.join(root, '.split-brain', 'scorecard.json'), '{"score":1}\n');
  write(path.join(root, '.split-brain', 'score-history.jsonl'), '{"score":0}\n{"score":1}\n');
  runCli(['init'], { cwd: root, env: { SB_TRACE_HOME: home } });
  // started.json says "now": move it back so fixture sessions fall in the window
  write(path.join(root, '.split-brain', 'started.json'), JSON.stringify({ startedAt: new Date(Date.now() - 86400_000).toISOString(), gitHead: null, platform: 'x', toolVersion: '1' }));
  const outDir = path.join(base, 'out');
  const r = runCli(['submit', '--yes', '--handle', 'Ada Lovelace!', '--email', 'ada@example.com', '--out', outDir], { cwd: root, env: { SB_TRACE_HOME: home, SUBMIT_INSTRUCTIONS_URL: 'https://example.com/upload' } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /upload it at https:\/\/example\.com\/upload/i);
  assert.match(r.stdout, /archive:\s+[\d.]+ (B|KB|MB) compressed \(limit 300\.0 MB\)/);
  const files = fs.readdirSync(outDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^split-brain-ada-lovelace-\d{8}T\d{6}Z\.tar\.gz$/);
  const archive = path.join(outDir, files[0]);
  const entries = readArchive(archive);
  for (const k of ['repo.bundle', 'SUBMISSION.md', 'manifest.json', 'scorecard.json', 'score-history.jsonl', 'sessions/index.json']) assert.ok(entries.has(k), `missing ${k}`);
  assert.ok([...entries.keys()].some((k) => k.startsWith('sessions/claude-code/')));
  assert.ok(![...entries.keys()].some((k) => k.includes('started.json')));
  for (const [name, data] of entries) for (const v of Object.values(SECRETS)) assert.ok(!data.includes(v), `secret in ${name}`);

  const m = JSON.parse(entries.get('manifest.json').toString('utf8'));
  assert.equal(m.handle, 'ada-lovelace');
  assert.equal(m.email, 'ada@example.com');
  assert.equal(m.gitHead, git(root, 'rev-parse', 'HEAD'));
  assert.equal(m.node, process.version);
  assert.equal(m.consent.confirmedBy, '--yes');
  assert.equal(m.consent.includeParentFolderSessions, false);
  assert.equal(m.sessions.excluded, 0);
  assert.equal(m.sessions.skippedParentFolder, 1);
  assert.ok(![...entries.keys()].some((k) => k.includes('44444444')), 'parent-folder session must not be submitted');
  assert.equal(m.consent.skipSessions, false);
  assert.ok(m.sessions.total >= 8);
  assert.ok(m.sessions.countsBySource['claude-code'] >= 2);
  assert.ok(m.redactions.total > 0);
  assert.ok(m.platform.os && m.platform.arch);
  assert.ok(Array.isArray(m.unsupportedSources) && Array.isArray(m.missingSources));
  for (const f of m.files) {
    const data = entries.get(f.path);
    assert.ok(data, `manifest lists missing file ${f.path}`);
    assert.equal(data.length, f.bytes);
    assert.equal((await import('node:crypto')).createHash('sha256').update(data).digest('hex'), f.sha256);
  }

  // the bundle is a valid clone source
  const x = path.join(base, 'x');
  fs.mkdirSync(x);
  fs.writeFileSync(path.join(x, 'repo.bundle'), entries.get('repo.bundle'));
  const clone = spawnSync('git', ['clone', '-q', path.join(x, 'repo.bundle'), path.join(x, 'clone')], { encoding: 'utf8' });
  assert.equal(clone.status, 0, clone.stderr);
  assert.ok(fs.existsSync(path.join(x, 'clone', 'SUBMISSION.md')));

  if (hasCmd('tar')) {
    const t = spawnSync('tar', ['-xzf', archive, '-C', x], { encoding: 'utf8' });
    assert.equal(t.status, 0, t.stderr);
    assert.ok(fs.existsSync(path.join(x, 'sessions', 'index.json')));
  }
});

test('submit --skip-sessions excludes transcripts and records it', () => {
  const { root, home, base } = project();
  write(path.join(root, 'SUBMISSION.md'), '# notes\n');
  const outDir = path.join(base, 'out');
  const r = runCli(['submit', 'skip@example.com', '--yes', '--skip-sessions', '--out', outDir], { cwd: root, env: { SB_TRACE_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NOT included/);
  assert.match(r.stdout, /uncommitted changes/);
  const entries = readArchive(path.join(outDir, fs.readdirSync(outDir)[0]));
  assert.ok(![...entries.keys()].some((k) => k.startsWith('sessions/')));
  const m = JSON.parse(entries.get('manifest.json').toString('utf8'));
  assert.equal(m.consent.skipSessions, true);
  assert.equal(m.consent.sessionsIncluded, false);
  assert.equal(m.uncommittedChanges, true);
  assert.equal(m.handle, 'test-candidate');
  assert.equal(fs.existsSync(path.join(root, '.split-brain', 'sessions')), false);
});

test('submit uploads multipart to SUBMIT_URL', async () => {
  const { root, home, base } = project();
  write(path.join(root, 'SUBMISSION.md'), '# notes\n');
  let received = null;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
    const file = form.get('file');
    received = { method: req.method, handle: form.get('handle'), email: form.get('email'), fileName: file.name, size: (await file.arrayBuffer()).byteLength };
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ receiptId: 'sub_123abc', receivedAt: new Date().toISOString(), bytes: 1, sha256: 'x' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/submit`;
  try {
    const outDir = path.join(base, 'out');
    const r = await runCliAsync(['submit', '--yes', '--handle', 'grace', '--email', 'g@example.com', '--out', outDir], { cwd: root, env: { SB_TRACE_HOME: home, SUBMIT_URL: url } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Submitted\. Receipt: sub_123abc/);
    const record = JSON.parse(fs.readFileSync(path.join(root, '.split-brain', 'submissions.jsonl'), 'utf8').trim());
    assert.equal(record.receiptId, 'sub_123abc');
    assert.equal(received.method, 'POST');
    assert.equal(received.handle, 'grace');
    assert.equal(received.email, 'g@example.com');
    const archive = fs.readdirSync(outDir)[0];
    assert.equal(received.fileName, archive);
    assert.equal(received.size, fs.statSync(path.join(outDir, archive)).size);
  } finally {
    server.close();
  }
});

test('submit fails clearly when the compressed archive exceeds SB_TRACE_MAX_MB', () => {
  const { root, home, base } = project();
  write(path.join(root, 'SUBMISSION.md'), '# notes\n');
  const outDir = path.join(base, 'out');
  const r = runCli(['submit', '--yes', '--out', outDir], { cwd: root, env: { SB_TRACE_HOME: home, SB_TRACE_MAX_MB: '0.001', SB_EMAIL: 'test@example.com' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /over the 1\.0 KB limit \(SB_TRACE_MAX_MB\)/);
  assert.match(r.stderr, /Largest sessions/);
  assert.match(r.stderr, /claude-code:11111111-1111-4111-8111-111111111111/);
  assert.match(r.stderr, /trace-exclude\.txt/);
  assert.deepEqual(fs.readdirSync(outDir), [], 'no archive (or .partial) may be left behind');
});

test('submit honours trace-exclude.txt and records only the count', () => {
  const { root, home, base } = project();
  write(path.join(root, 'SUBMISSION.md'), '# notes\n');
  const excludedId = '019a0000-0000-7000-8000-000000000001';
  write(path.join(root, '.split-brain', 'trace-exclude.txt'), `codex:${excludedId}\n`);
  const outDir = path.join(base, 'out');
  const r = runCli(['submit', '--yes', '--out', outDir], { cwd: root, env: { SB_TRACE_HOME: home, SB_EMAIL: 'test@example.com' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /excluded:\s+1 session/);
  const entries = readArchive(path.join(outDir, fs.readdirSync(outDir)[0]));
  for (const [name, data] of entries) assert.ok(!name.includes(excludedId) && !data.includes(excludedId), `excluded id leaked via ${name}`);
  assert.ok(!entries.has('trace-exclude.txt'));
  assert.equal(JSON.parse(entries.get('manifest.json').toString('utf8')).sessions.excluded, 1);
});

test('submit requires an email and refuses to silently submit without sessions', () => {
  const { root, home } = project();
  write(path.join(root, 'SUBMISSION.md'), '# notes\n');
  const noEmail = runCli(['submit', '--yes'], { cwd: root, env: { SB_TRACE_HOME: home } });
  assert.equal(noEmail.status, 2);
  assert.match(noEmail.stderr, /email is required/);
  const badEmail = runCli(['submit', 'nope', '--yes'], { cwd: root, env: { SB_TRACE_HOME: home } });
  assert.notEqual(badEmail.status, 0);
  const bare = fs.realpathSync(makeProject(mkTmp('sbt-bare-')));
  write(path.join(bare, 'SUBMISSION.md'), '# notes\n');
  const none = runCli(['submit', 'x@example.com', '--yes'], { cwd: bare, env: { SB_TRACE_HOME: mkTmp() } });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /No AI-assistant sessions were found/);
  assert.match(none.stderr, /--skip-sessions/);
});
