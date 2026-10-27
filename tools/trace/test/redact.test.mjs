import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildRedactor, isRedactableEnvValue, parseDotenv, Redactor } from '../lib/redact.mjs';
import { mkTmp, SECRETS, write } from './helpers.mjs';

const r = new Redactor();

const fake = {
  openai: `sk-${'A'.repeat(48)}`,
  openaiProj: `sk-proj-${'b1C2'.repeat(25)}`,
  anthropic: `sk-ant-api03-${'x'.repeat(40)}`,
  openrouter: `sk-or-v1-${'9'.repeat(64)}`,
  ghp: `ghp_${'a'.repeat(36)}`,
  gho: `gho_${'B'.repeat(36)}`,
  ghs: `ghs_${'c'.repeat(36)}`,
  pat: `github_pat_${'d'.repeat(22)}_${'E'.repeat(59)}`,
  akia: `AKIA${'Q'.repeat(16)}`,
  asia: `ASIA${'7'.repeat(16)}`,
  google: `AIza${'S'.repeat(35)}`,
  slack: `xoxb-${'1'.repeat(12)}-${'z'.repeat(24)}`,
  stripe: `sk_live_${'k'.repeat(24)}`,
  stripeR: `rk_live_${'k'.repeat(24)}`,
  jwt: `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${'s'.repeat(43)}`,
};

test('builtin patterns are redacted and counted by kind', () => {
  const text = Object.entries(fake).map(([k, v]) => `${k}=${v}`).join('\n');
  const out = r.redact(text);
  for (const v of Object.values(fake)) assert.ok(!out.text.includes(v), `leaked ${v.slice(0, 8)}`);
  assert.equal(out.counts.openai, 2);
  assert.equal(out.counts.anthropic, 1);
  assert.equal(out.counts.openrouter, 1);
  assert.equal(out.counts.github, 4);
  assert.equal(out.counts['aws-access-key'], 2);
  assert.equal(out.counts.google, 1);
  assert.equal(out.counts.slack, 1);
  assert.equal(out.counts.stripe, 2);
  assert.equal(out.counts.jwt, 1);
  assert.match(out.text, /anthropic=\[REDACTED:anthropic\]/);
});

test('PEM private keys: raw and JSON-escaped', () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEow${'A'.repeat(64)}\n${'B'.repeat(64)}\n-----END RSA PRIVATE KEY-----`;
  const raw = r.redact(`key:\n${pem}\nafter`);
  assert.equal(raw.text, 'key:\n[REDACTED:private-key]\nafter');
  const escaped = JSON.stringify({ content: pem });
  const out = r.redact(escaped);
  assert.deepEqual(JSON.parse(out.text), { content: '[REDACTED:private-key]' });
  assert.equal(out.counts['private-key'], 1);
  const openssh = r.redact(`-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n-----END OPENSSH PRIVATE KEY-----`);
  assert.equal(openssh.text, '[REDACTED:private-key]');
  // public keys / certificates are left alone
  const cert = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
  assert.equal(r.redact(cert).text, cert);
});

test('Authorization: Bearer tokens keep the header name', () => {
  const a = r.redact('curl -H "Authorization: Bearer abcdef123456.xyz" https://x');
  assert.equal(a.text, 'curl -H "Authorization: Bearer [REDACTED:bearer]" https://x');
  const j = JSON.stringify({ headers: { Authorization: 'Bearer zzzzzzzzzzzz' } });
  const b = r.redact(JSON.stringify({ cmd: j }));
  assert.ok(!b.text.includes('zzzzzzzzzzzz'));
  assert.doesNotThrow(() => JSON.parse(JSON.parse(b.text).cmd));
  assert.equal(b.counts.bearer, 1);
});

test('redaction keeps JSONL lines valid JSON', () => {
  const line = JSON.stringify({ message: { content: `token ${fake.ghp} and key ${fake.openaiProj} and ${fake.jwt}` } });
  const out = r.redact(line);
  const parsed = JSON.parse(out.text);
  assert.match(parsed.message.content, /\[REDACTED:github\].*\[REDACTED:openai\].*\[REDACTED:jwt\]/);
});

test('no false positives on ordinary text', () => {
  const text = 'task-management risk-assessment-framework-for-teams skeleton sk-short AKIA123 eyJ.notjwt Bearer and the authorization header was missing';
  const out = r.redact(text);
  assert.equal(out.text, text);
  assert.deepEqual(out.counts, {});
});

test('aws secret access key assignment', () => {
  const out = r.redact(`aws_secret_access_key = ${'a1B2'.repeat(10)}`);
  assert.equal(out.text, 'aws_secret_access_key = [REDACTED:aws-secret-key]');
});

test('dotenv parsing and literal redaction (incl. JSON-escaped values)', () => {
  const parsed = parseDotenv('# c\nexport A_TOKEN="quoted value 123"\nB=plain-value-xyz # comment\nC=\'single\\q\'\nMULTI="line1\nline2"\nNODE_ENV=production\n');
  assert.deepEqual(parsed.map((p) => p.key), ['A_TOKEN', 'B', 'C', 'MULTI', 'NODE_ENV']);
  assert.equal(parsed[0].value, 'quoted value 123');
  assert.equal(parsed[1].value, 'plain-value-xyz');
  assert.equal(parsed[2].value, 'single\\q');
  assert.equal(parsed[3].value, 'line1\nline2');
  const red = new Redactor({ literals: ['plain-value-xyz', 'quote"d\\value'] });
  const out = red.redact(`a plain-value-xyz b ${JSON.stringify({ v: 'quote"d\\value' })}`);
  assert.ok(!out.text.includes('plain-value-xyz'));
  assert.equal(JSON.parse(out.text.slice(out.text.indexOf('{'))).v, '[REDACTED:env]');
  assert.equal(out.counts.env, 2);
});

test('env value heuristics', () => {
  assert.equal(isRedactableEnvValue('NODE_ENV', 'production'), false);
  assert.equal(isRedactableEnvValue('DB_PASSWORD', 'postgrespassword'), true);
  assert.equal(isRedactableEnvValue('PORT', '30000000'), false);
  assert.equal(isRedactableEnvValue('API_URL', 'http://localhost:3000'), false);
  assert.equal(isRedactableEnvValue('DATABASE_URL', 'postgres://u:p@db:5432/x'), true);
  assert.equal(isRedactableEnvValue('X', 'short'), false);
  assert.equal(isRedactableEnvValue('X', 'REDACTED'), false);
});

test('buildRedactor reads .env* files in roots (not dirs named .env)', () => {
  const dir = mkTmp('sbt-env-');
  write(path.join(dir, '.env'), `MY_SERVICE_TOKEN=${SECRETS.env}\nNODE_ENV=production\n`);
  write(path.join(dir, 'apps', 'api', '.env.local'), 'API_SECRET=another-secret-999\n');
  write(path.join(dir, '.env.d', 'x'), 'not a dotenv file');
  write(path.join(dir, 'node_modules', 'pkg', '.env'), 'IGNORED=ignored-secret-000\n');
  const red = buildRedactor([dir]);
  assert.equal(red.envFiles.length, 2);
  const out = red.redact(`${SECRETS.env} another-secret-999 ignored-secret-000 production`);
  assert.equal(out.text, '[REDACTED:env] [REDACTED:env] ignored-secret-000 production');
});
