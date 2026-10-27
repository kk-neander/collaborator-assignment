import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { paxRecord, readTar, splitUstarPath, writeTarGz } from '../lib/tar.mjs';
import { hasCmd, mkTmp, write } from './helpers.mjs';

test('splitUstarPath uses the prefix field when possible', () => {
  assert.deepEqual(splitUstarPath('a/b.txt'), { prefix: '', name: 'a/b.txt' });
  const p = `${'d'.repeat(120)}/${'f'.repeat(90)}`;
  assert.deepEqual(splitUstarPath(p), { prefix: 'd'.repeat(120), name: 'f'.repeat(90) });
  assert.equal(splitUstarPath(`${'d'.repeat(200)}/x`), null);
  assert.equal(splitUstarPath('ünïcode.txt'), null);
});

test('paxRecord length includes itself', () => {
  for (const v of ['x', 'y'.repeat(5), 'z'.repeat(95), 'w'.repeat(994)]) {
    const rec = paxRecord('path', v);
    assert.equal(Number(rec.split(' ')[0]), Buffer.byteLength(rec));
  }
});

function fixtureEntries(dir) {
  const big = write(path.join(dir, 'src', 'big.bin'), Buffer.alloc(70000, 7));
  const longDir = `sessions/claude-code/${'nested-folder-name/'.repeat(6)}`;
  const veryLong = `sessions/${'x'.repeat(180)}/${'y'.repeat(120)}.jsonl`;
  return [
    { name: 'repo.bundle', type: 'file', path: big, size: 70000, mtime: Date.parse('2026-10-20T10:00:00Z'), mode: 0o644 },
    { name: 'SUBMISSION.md', type: 'file', data: Buffer.from('# hello\n'), size: 8, mtime: Date.now(), mode: 0o644 },
    { name: 'sessions/empty.json', type: 'file', data: Buffer.alloc(0), size: 0, mtime: Date.now(), mode: 0o644 },
    { name: `${longDir}session.jsonl`, type: 'file', data: Buffer.from('{"a":1}\n'), size: 8, mtime: Date.now(), mode: 0o644 },
    { name: veryLong, type: 'file', data: Buffer.from('long\n'), size: 5, mtime: Date.now(), mode: 0o644 },
    { name: 'sessions/manual/ünïcødé notes.md', type: 'file', data: Buffer.from('ü\n'), size: Buffer.byteLength('ü\n'), mtime: Date.now(), mode: 0o644 },
  ];
}

test('writeTarGz round-trips through the built-in reader', async () => {
  const dir = mkTmp('sbt-tar-');
  const entries = fixtureEntries(dir);
  const out = path.join(dir, 'out.tar.gz');
  await writeTarGz(out, entries);
  const items = readTar(zlib.gunzipSync(fs.readFileSync(out)));
  const files = new Map(items.filter((i) => i.type === 'file').map((i) => [i.name, i.data]));
  for (const e of entries) {
    const want = e.data ?? fs.readFileSync(e.path);
    assert.ok(files.has(e.name), `missing ${e.name}`);
    assert.ok(files.get(e.name).equals(want), `content mismatch ${e.name}`);
  }
  const dirs = items.filter((i) => i.type === 'dir').map((i) => i.name);
  assert.ok(dirs.includes('sessions/'));
  assert.ok(dirs.includes('sessions/claude-code/'));
});

test('system tar extracts the archive identically', { skip: !hasCmd('tar') && 'tar not installed' }, async () => {
  const dir = mkTmp('sbt-tar-sys-');
  const entries = fixtureEntries(dir);
  const out = path.join(dir, 'out.tar.gz');
  await writeTarGz(out, entries);
  const list = spawnSync('tar', ['-tzf', out], { encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);
  assert.ok(list.stdout.includes('repo.bundle'));
  const x = path.join(dir, 'x');
  fs.mkdirSync(x);
  const ex = spawnSync('tar', ['-xzf', out, '-C', x], { encoding: 'utf8' });
  assert.equal(ex.status, 0, ex.stderr);
  for (const e of entries) {
    const want = e.data ?? fs.readFileSync(e.path);
    const got = fs.readFileSync(path.join(x, ...e.name.split('/')));
    assert.ok(got.equals(want), `content mismatch ${e.name}`);
  }
  const st = fs.statSync(path.join(x, 'repo.bundle'));
  assert.equal(Math.floor(st.mtimeMs / 1000), Date.parse('2026-10-20T10:00:00Z') / 1000);
});

test('writeTarGz rejects files that change size while archiving', async () => {
  const dir = mkTmp('sbt-tar-bad-');
  const f = write(path.join(dir, 'f.txt'), 'abc');
  await assert.rejects(writeTarGz(path.join(dir, 'o.tar.gz'), [{ name: 'f.txt', type: 'file', path: f, size: 10, mtime: Date.now() }]));
});
