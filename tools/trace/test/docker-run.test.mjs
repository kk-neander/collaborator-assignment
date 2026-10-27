// docker-run.sh with a stub `docker` that records its arguments (no Docker needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp, write } from './helpers.mjs';

const SCRIPT = fileURLToPath(new URL('../docker-run.sh', import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), '..', '..');
// Prefer macOS's bash 3.2 to prove compatibility; fall back to whatever bash exists.
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const hasBash = process.platform !== 'win32' && spawnSync(BASH, ['-c', 'exit 0']).status === 0;

function stub(dir) {
  const log = path.join(dir, 'docker.log');
  const bin = write(path.join(dir, 'docker'), `#!/bin/sh
for a in "$@"; do printf '%s\\037' "$a"; done >> "${log}"
printf '\\n' >> "${log}"
if [ "$1" = image ] && [ -n "$STUB_NO_IMAGE" ] && [ ! -f "${log}.built" ]; then exit 1; fi
if [ "$1" = compose ]; then : > "${log}.built"; fi
exit 0
`);
  fs.chmodSync(bin, 0o755);
  return { bin, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split('\x1f').filter((x, i, a) => i < a.length - 1 || x)) };
}

function run(home, extraEnv = {}) {
  const dir = mkTmp('sbt-dr-');
  const s = stub(dir);
  const env = { PATH: process.env.PATH, HOME: home, TZ: 'Europe/Berlin', SB_TRACE_DOCKER: s.bin, SB_HANDLE: 'ada', ...extraEnv };
  const r = spawnSync(BASH, [SCRIPT, 'trace', '--dry-run'], { cwd: REPO_ROOT, env, encoding: 'utf8' });
  return { ...r, calls: s.calls() };
}

function fakeHome() {
  const home = mkTmp('sbt-drhome-');
  for (const d of ['.claude/projects', '.config/claude/projects', 'Library/Application Support/Cursor/User/workspaceStorage', '.config/Code - Insiders/User/workspaceStorage', 'AppData/Roaming/Code/User', '.gemini/tmp', '.local/share/opencode/storage']) {
    fs.mkdirSync(path.join(home, d), { recursive: true });
  }
  return home;
}

test('docker-run.sh mounts every existing tool dir read-only and passes flags', { skip: !hasBash && 'bash unavailable' }, () => {
  const home = fakeHome();
  const r = run(home);
  assert.equal(r.status, 0, r.stderr);
  const runCall = r.calls.find((c) => c[0] === 'run');
  assert.ok(runCall, 'docker run was invoked');
  const joined = runCall.join('\n');
  const mounts = runCall.filter((_, i) => runCall[i - 1] === '-v');
  assert.ok(mounts.includes(`${REPO_ROOT}:/app`), 'repo mounted read-write at /app');
  const expect = [
    ['claude', path.join(home, '.claude')],
    ['claude', path.join(home, '.config', 'claude')],
    ['cursor', path.join(home, 'Library', 'Application Support', 'Cursor', 'User')],
    ['vscode', path.join(home, '.config', 'Code - Insiders', 'User')],
    ['vscode', path.join(home, 'AppData', 'Roaming', 'Code', 'User')],
    ['gemini', path.join(home, '.gemini')],
    ['opencode', path.join(home, '.local', 'share', 'opencode')],
  ];
  for (const [tool, dir] of expect) {
    const m = mounts.find((x) => x.startsWith(`${dir}:`));
    assert.ok(m, `missing mount for ${dir}`);
    assert.ok(m.endsWith(':ro'), `${dir} must be read-only`);
    const target = m.slice(dir.length + 1, -3);
    const i = runCall.indexOf(target);
    assert.equal(runCall[i - 1], `--${tool}-dir`, `${dir} passed as --${tool}-dir`);
  }
  assert.ok(!joined.includes('--codex-dir'), 'no codex dir on this fake machine');
  assert.ok(runCall.includes('TZ=Europe/Berlin'));
  assert.ok(runCall.includes('SB_HANDLE=ada'));
  assert.ok(runCall.includes('split-brain-app:local'));
  const cli = runCall.indexOf('tools/trace/cli.mjs');
  assert.deepEqual(runCall.slice(cli, cli + 3), ['tools/trace/cli.mjs', 'trace', '--dry-run']);
  assert.equal(runCall[runCall.indexOf('--host-project-root') + 1], REPO_ROOT);
  assert.equal(runCall[runCall.indexOf('--project-root') + 1], '/app');
  assert.ok(!r.calls.some((c) => c[0] === 'compose'), 'no build when the image exists');
});

test('docker-run.sh builds the image with docker compose when missing', { skip: !hasBash && 'bash unavailable' }, () => {
  const r = run(fakeHome(), { STUB_NO_IMAGE: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.find((c) => c[0] === 'compose'), ['compose', 'build', 'relay']);
  assert.ok(r.calls.some((c) => c[0] === 'run'));
  assert.match(r.stderr, /building it with: docker compose build relay/);
});

test('docker-run.sh with no tool data still runs and says so', { skip: !hasBash && 'bash unavailable' }, () => {
  const r = run(mkTmp('sbt-emptyhome-'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no AI-tool data folders found/);
  assert.ok(!r.calls.find((c) => c[0] === 'run').some((a) => /^--(claude|codex|cursor|vscode|opencode|gemini)-dir$/.test(a)));
});
