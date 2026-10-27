// Secret redaction for every exported text file.
//
// Matches are replaced with "[REDACTED:<kind>]". The placeholder contains no
// quotes or backslashes, so JSON / JSONL documents stay valid after redaction.
import fs from 'node:fs';
import path from 'node:path';
import { readdirSafe, sha256 } from './fsutil.mjs';

const BUILTIN_RULES = [
  {
    kind: 'private-key',
    hints: ['PRIVATE KEY'],
    // Matches real newlines and JSON-escaped "\n" sequences alike.
    re: /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?)-----[\s\S]{0,20000}?-----END \1-----/g,
  },
  { kind: 'anthropic', hints: ['sk-ant-'], re: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openrouter', hints: ['sk-or-'], re: /(?<![A-Za-z0-9_-])sk-or-(?:v1-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai', hints: ['sk-'], re: /(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'stripe', hints: ['_live_'], re: /(?<![A-Za-z0-9])(?:sk|rk)_live_[A-Za-z0-9]{10,}/g },
  { kind: 'github', hints: ['github_pat_'], re: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,}/g },
  { kind: 'github', hints: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'], re: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{30,}/g },
  { kind: 'aws-access-key', hints: ['AKIA', 'ASIA'], re: /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g },
  {
    kind: 'aws-secret-key',
    hints: ['ecret_access_key', 'ECRET_ACCESS_KEY', 'ecretAccessKey'],
    re: /((?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|secretAccessKey)\\?["']?\s*[:=]\s*\\?["']?)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g,
    keepGroup: 1,
  },
  { kind: 'google', hints: ['AIza'], re: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}/g },
  { kind: 'slack', hints: ['xox'], re: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'jwt', hints: ['eyJ'], re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    kind: 'bearer',
    hints: ['earer', 'EARER'],
    re: /(authorization\\?["']?\s*[:=]\s*\\?["']?\s*bearer\s+)(?!\[REDACTED)[A-Za-z0-9._~+/=-]{8,}/gi,
    keepGroup: 1,
  },
];

const SECRETISH_KEY = /(SECRET|PASSW|PASSPHRASE|TOKEN|KEY|AUTH|CREDENTIAL|PRIVATE|SALT|DSN|COOKIE|SESSION|SIGNING)/i;

/** Decide whether a .env value is worth redacting. */
export function isRedactableEnvValue(key, value) {
  if (typeof value !== 'string' || value.length < 8) return false;
  if (/REDACTED/i.test(value)) return false;
  if (/^\d+(\.\d+)?$/.test(value)) return false; // ports, numbers
  if (/^(true|false|null|undefined|none)$/i.test(value)) return false;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?\/?$/i.test(value)) return false;
  // Plain dictionary words (NODE_ENV=production) are noise unless the key looks secret.
  if (/^[a-z]+$/i.test(value) && !SECRETISH_KEY.test(key)) return false;
  return true;
}

/** Parse KEY=VALUE pairs from dotenv-style text. Values are never logged. */
export function parseDotenv(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    let v = m[2];
    const q = v[0];
    if (q === '"' || q === "'" || q === '`') {
      let body = v.slice(1);
      // multi-line quoted values
      while (!body.includes(q) && i + 1 < lines.length) body += `\n${lines[++i]}`;
      const end = body.indexOf(q);
      v = end === -1 ? body : body.slice(0, end);
      if (q === '"') v = v.replace(/\\n/g, '\n');
    } else {
      v = v.replace(/\s+#.*$/, '').trim();
    }
    out.push({ key, value: v });
  }
  return out;
}

const ENV_SKIP_DIRS = new Set(['node_modules', '.git', '.split-brain', 'dist', 'build', 'coverage', '.next', '.cache', 'vendor', 'target', '.venv', 'venv', '__pycache__']);

/** Find .env* files (regular files only) in each root, up to `maxDepth` levels deep. */
export function findEnvFiles(roots, { maxDepth = 3, maxDirs = 3000 } = {}) {
  const found = new Set();
  let visited = 0;
  const visit = (dir, depth) => {
    if (visited++ > maxDirs) return;
    for (const ent of readdirSafe(dir)) {
      const full = path.join(dir, ent.name);
      if (ent.name.startsWith('.env')) {
        try { if (fs.statSync(full).isFile()) found.add(full); } catch { /* ignore */ }
        continue;
      }
      if (ent.isDirectory() && depth < maxDepth && !ENV_SKIP_DIRS.has(ent.name) && !ent.name.startsWith('.')) visit(full, depth + 1);
    }
  };
  for (const r of roots) visit(r, 0);
  return [...found];
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class Redactor {
  constructor({ literals = [] } = {}) {
    const lits = new Set();
    for (const v of literals) {
      if (typeof v !== 'string' || v.length < 8) continue;
      lits.add(v);
      const jsonEscaped = JSON.stringify(v).slice(1, -1);
      if (jsonEscaped !== v) lits.add(jsonEscaped);
    }
    const sorted = [...lits].sort((a, b) => b.length - a.length);
    this.literalCount = sorted.length;
    this.literalRe = sorted.length ? new RegExp(sorted.map(escapeRegExp).join('|'), 'g') : null;
    this.fingerprint = sha256(`v1\0${sorted.join('\0')}`).slice(0, 16);
  }

  /** Returns { text, counts } where counts = { kind: n }. */
  redact(text) {
    const counts = {};
    const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
    let out = text;
    for (const rule of BUILTIN_RULES) {
      if (!rule.hints.some((h) => out.includes(h))) continue;
      rule.re.lastIndex = 0;
      out = out.replace(rule.re, (...m) => {
        bump(rule.kind);
        return rule.keepGroup ? `${m[rule.keepGroup]}[REDACTED:${rule.kind}]` : `[REDACTED:${rule.kind}]`;
      });
    }
    if (this.literalRe) {
      this.literalRe.lastIndex = 0;
      out = out.replace(this.literalRe, () => { bump('env'); return '[REDACTED:env]'; });
    }
    return { text: out, counts };
  }
}

export function mergeCounts(into, add) {
  for (const [k, v] of Object.entries(add || {})) into[k] = (into[k] || 0) + v;
  return into;
}

/** Build a Redactor from the .env* files found in the given (existing) roots. */
export function buildRedactor(roots) {
  const files = findEnvFiles(roots);
  const literals = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const { key, value } of parseDotenv(text)) if (isRedactableEnvValue(key, value)) literals.push(value);
  }
  const r = new Redactor({ literals });
  r.envFiles = files;
  return r;
}
