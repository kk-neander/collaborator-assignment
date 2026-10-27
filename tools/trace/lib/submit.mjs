// The `submit` command: trace, then build
// submission/split-brain-<handle>-<UTC ts>.tar.gz with repo.bundle, sessions/,
// optional score files, SUBMISSION.md and manifest.json; ask for consent;
// optionally upload to $SUBMIT_URL.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_SUBMISSION_MAX_MB, TEMPLATE_MARKER, TOOL_VERSION } from './version.mjs';
import { git, gitHead, readMarker, resolveProjectRoot, stateDir } from './project.mjs';
import { platformInfo } from './env.mjs';
import { readJsonSafe, readTextSafe, sha256File, statSafe } from './fsutil.mjs';
import { UserError } from './errors.mjs';
import { runTrace, sessionsDirOf, summarize } from './trace.mjs';
import { writeTarGz } from './tar.mjs';
import { fmtBytes, renderWarnings } from './format.mjs';
import { askLine, askYesNo } from './prompt.mjs';

function safeUsername() {
  try { return os.userInfo().username; } catch { return null; }
}

export function sanitizeHandle(h) {
  const s = String(h || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40);
  return s || 'anonymous';
}

export function utcStamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function checkSubmissionDoc(projectRoot) {
  const file = path.join(projectRoot, 'SUBMISSION.md');
  const text = readTextSafe(file);
  // Optional: include it if the candidate wrote one.
  if (text == null) return null;
  if (text.includes(TEMPLATE_MARKER)) {
    throw new UserError(`SUBMISSION.md is still the template (it contains the line ${TEMPLATE_MARKER}).\nReplace it with your own write-up, delete that marker line, and run submit again.`);
  }
  if (!text.trim()) return null;
  return file;
}

function createBundle(projectRoot, dest) {
  try {
    execFileSync('git', ['-c', 'safe.directory=*', 'bundle', 'create', dest, '--all'], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    const err = String(e.stderr || '').trim().split('\n').slice(-2).join(' ');
    throw new UserError(`git bundle create failed${err ? `: ${err}` : ''}. Is git installed and does the repository have commits?`);
  }
}

const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,252}\.[^\s@<>"']{2,}$/;

/** KEY=VALUE pairs from the project's .env (no expansion, no quotes needed). */
function readDotEnv(projectRoot) {
  const text = readTextSafe(path.join(projectRoot, '.env'));
  const out = {};
  for (const line of (text || '').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

async function upload(url, file, { handle, email }) {
  const form = new FormData();
  form.append('handle', handle);
  form.append('email', email || '');
  const blob = typeof fs.openAsBlob === 'function'
    ? await fs.openAsBlob(file, { type: 'application/gzip' })
    : new Blob([fs.readFileSync(file)], { type: 'application/gzip' });
  form.append('file', blob, path.basename(file));
  let res;
  try {
    res = await fetch(url, { method: 'POST', body: form });
  } catch (e) {
    throw new UserError(`upload to SUBMIT_URL failed (${e.cause?.code || e.name}). Your bundle is still at ${file}`);
  }
  const body = await res.text();
  return { ok: res.ok, status: res.status, body: body.length > 4000 ? `${body.slice(0, 4000)}…` : body };
}

function maxSubmissionBytes(env) {
  const mb = Number(env.SB_TRACE_MAX_MB);
  return Math.round((mb > 0 ? mb : DEFAULT_SUBMISSION_MAX_MB) * 1048576);
}

function tooLargeMessage(size, limit, bundleBytes, sessions) {
  const lines = [`the submission is ${fmtBytes(size)} compressed, over the ${fmtBytes(limit)} limit (SB_TRACE_MAX_MB).`];
  const largest = [...sessions].sort((a, b) => (b.bytes || 0) - (a.bytes || 0)).slice(0, 10);
  if (largest.length) {
    lines.push('Largest sessions (uncompressed):');
    for (const s of largest) lines.push(`  ${fmtBytes(s.bytes).padStart(9)}  ${s.source}:${s.id}`);
    lines.push('Leave sessions out by adding their id to .split-brain/trace-exclude.txt (one per line) or with --exclude <id>,');
    lines.push('or lower the per-session cap with --max-session-mb N; then run submit again.');
  }
  lines.push(`repo.bundle is ${fmtBytes(bundleBytes)}.${bundleBytes > limit / 2 ? ' Remove large generated or binary files from your git history.' : ''}`);
  return lines.join('\n');
}

export async function runSubmit(opts, env = process.env, io = { out: process.stdout, err: process.stderr, stdin: process.stdin }) {
  const say = (s = '') => io.out.write(`${s}\n`);
  const warnings = [];
  const projectRoot = resolveProjectRoot(opts, warnings);
  const dotenv = readDotEnv(projectRoot);
  // Each candidate gets a personal link by email; it is never stored in the repo.
  let submitUrl = env.SUBMIT_URL || dotenv.SUBMIT_URL || '';
  const instructionsUrl = env.SUBMIT_INSTRUCTIONS_URL || dotenv.SUBMIT_INSTRUCTIONS_URL || '';
  // Your email ties the submission to you, so it is always asked for explicitly.
  let email = String(opts.email || env.SB_EMAIL || '').trim();
  if (!email && io.stdin.isTTY && !opts.yes) {
    const suggestion = git(['config', 'user.email'], projectRoot) || '';
    email = await askLine(`Email for this submission${suggestion ? ` [${suggestion}]` : ''}: `, suggestion, io);
  }
  if (!email) throw new UserError('an email is required: ./sb submit you@example.com', 2);
  if (!EMAIL.test(email)) throw new UserError(`"${email}" does not look like an email address`, 2);
  if (!submitUrl && io.stdin.isTTY && !opts.yes) {
    submitUrl = await askLine('Paste your personal submission link (from your invitation email), or press Enter to only build the bundle: ', '', io);
    if (submitUrl && !/^https?:\/\/\S+$/.test(submitUrl)) throw new UserError('that does not look like a link (it should start with https://)', 2);
    if (submitUrl) {
      // Remember it in .env (git-ignored) so resubmitting doesn't ask again.
      fs.appendFileSync(path.join(projectRoot, '.env'), `${fs.existsSync(path.join(projectRoot, '.env')) ? '\n' : ''}SUBMIT_URL=${submitUrl}\n`);
    }
  }
  const submissionDoc = checkSubmissionDoc(projectRoot);
  const head = gitHead(projectRoot);
  if (!head) throw new UserError('the repository has no commits (or git is unavailable) — commit your work, then run submit again.');
  if (!opts.yes && !io.stdin.isTTY) throw new UserError('submit needs your confirmation: run it in an interactive terminal, or pass --yes to confirm non-interactively.', 2);

  let trace = null;
  if (!opts.skipSessions) {
    trace = await runTrace({ ...opts, projectRoot, dryRun: false }, env);
    warnings.push(...trace.warnings);
  }
  const dirty = git(['status', '--porcelain'], projectRoot);
  if (dirty) warnings.push('you have uncommitted changes; they are NOT in repo.bundle (commit them first if they are part of your submission)');

  const handle = sanitizeHandle(opts.handle || env.SB_HANDLE || git(['config', 'user.name'], projectRoot) || safeUsername());
  const outDir = path.resolve(opts.out || path.join(projectRoot, 'submission'));
  const archiveName = `split-brain-${handle}-${utcStamp()}.tar.gz`;
  const limit = maxSubmissionBytes(env);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-submit-'));
  let partial = null;
  try {
    const bundlePath = path.join(tmp, 'repo.bundle');
    createBundle(projectRoot, bundlePath);
    const files = [{ name: 'repo.bundle', path: bundlePath }];
    const sessionsDir = sessionsDirOf(projectRoot);
    const sessionIndex = opts.skipSessions ? null : readJsonSafe(path.join(sessionsDir, 'index.json'));
    if (sessionIndex) {
      // Only the index and the files it lists: never stray or excluded files.
      files.push({ name: 'sessions/index.json', path: path.join(sessionsDir, 'index.json') });
      for (const s of sessionIndex.sessions || []) {
        const f = path.join(sessionsDir, ...String(s.file || '').split('/'));
        if (s.file && statSafe(f)?.isFile()) files.push({ name: `sessions/${s.file}`, path: f });
      }
    }
    for (const extra of ['score-history.jsonl', 'scorecard.json']) {
      const p = path.join(stateDir(projectRoot), extra);
      if (statSafe(p)?.isFile()) files.push({ name: extra, path: p });
    }
    if (submissionDoc) files.push({ name: 'SUBMISSION.md', path: submissionDoc });

    const fileRecords = [];
    for (const f of files) {
      const { sha256, bytes } = await sha256File(f.path);
      const st = fs.statSync(f.path);
      f.size = bytes;
      f.mtime = st.mtimeMs;
      fileRecords.push({ path: f.name, bytes, sha256 });
    }

    const sessions = sessionIndex?.sessions || [];
    const totals = summarize(sessions);
    let confirmedNoSessions = false;
    if (!opts.skipSessions && !totals.sessions) {
      const why = 'No AI-assistant sessions were found for this project.';
      const how = 'If you used a tool the collector does not support, attach an export with --include FILE; to submit without sessions, add --skip-sessions.';
      if (!io.stdin.isTTY || opts.yes) throw new UserError(`${why}\n${how}`, 2);
      say(why);
      say(how);
      if (!(await askYesNo('Continue without session tracing? [y/N] ', io))) {
        say('Aborted. Nothing was submitted.');
        return { aborted: true };
      }
      confirmedNoSessions = true;
    }
    const sourceStatus = trace?.sources || {};
    const unsupported = Object.entries(sourceStatus).filter(([, s]) => s.status === 'unsupported').map(([id, s]) => ({ source: id, detail: s.detail }));
    const missing = Object.entries(sourceStatus).filter(([, s]) => ['not-found', 'needs-node', 'error', 'partial'].includes(s.status)).map(([id, s]) => ({ source: id, status: s.status, detail: s.detail }));
    const skippedParent = trace ? trace.totals.skippedParentFolder : null;
    const excludedCount = trace ? trace.totals.excluded : null;
    const p = platformInfo(env);
    const manifest = {
      schema: 1,
      tool: 'split-brain-trace',
      toolVersion: TOOL_VERSION,
      createdAt: new Date().toISOString(),
      platform: { os: p.os, arch: p.arch, release: p.release, wsl: p.wsl, docker: p.docker },
      node: process.version,
      handle,
      email,
      gitHead: head,
      gitBranch: git(['rev-parse', '--abbrev-ref', 'HEAD'], projectRoot),
      uncommittedChanges: Boolean(dirty),
      started: readMarker(projectRoot),
      window: trace?.window || null,
      files: fileRecords,
      sessions: {
        total: totals.sessions,
        bytes: totals.bytes,
        countsBySource: Object.fromEntries(Object.entries(totals.bySource).map(([k, v]) => [k, v.sessions])),
        // Counts only: ids of excluded / skipped sessions never leave the machine.
        excluded: excludedCount,
        skippedParentFolder: skippedParent,
        truncated: sessions.filter((s) => s.truncated).length,
      },
      redactions: { total: totals.redactionTotal, byKind: totals.redactions },
      sources: Object.fromEntries(Object.entries(sourceStatus).map(([id, s]) => [id, { status: s.status, sessions: s.sessions, detail: s.detail || null }])),
      unsupportedSources: unsupported,
      missingSources: missing,
      // The archive is only kept after this confirmation (prompt answered "y" or --yes).
      consent: {
        skipSessions: Boolean(opts.skipSessions),
        sessionsIncluded: !opts.skipSessions,
        includeParentFolderSessions: Boolean(opts.includeParent),
        confirmedBy: opts.yes ? '--yes' : 'interactive-prompt',
        confirmedNoSessions,
      },
      limits: { maxSubmissionBytes: limit, maxSessionBytes: trace ? Math.round((Number(opts.maxSessionMb) > 0 ? Number(opts.maxSessionMb) : 50) * 1048576) : null },
      warnings,
    };

    // Build first so the summary can show the real compressed size.
    const manifestBuf = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const entries = files.map((f) => ({ name: f.name, type: 'file', path: f.path, size: f.size, mtime: f.mtime, mode: 0o644 }));
    entries.push({ name: 'manifest.json', type: 'file', data: manifestBuf, size: manifestBuf.length, mtime: Date.now(), mode: 0o644 });
    fs.mkdirSync(outDir, { recursive: true });
    const archive = path.join(outDir, archiveName);
    partial = `${archive}.partial`;
    await writeTarGz(partial, entries);
    const size = fs.statSync(partial).size;
    if (size > limit) throw new UserError(tooLargeMessage(size, limit, files[0].size, sessions));

    say('Split Brain submission');
    say(`  project:     ${projectRoot}`);
    say(`  handle:      ${handle}${email ? `   email: ${email}` : ''}`);
    say(`  git HEAD:    ${head.slice(0, 12)} (${manifest.gitBranch || 'detached'})${dirty ? '  [uncommitted changes NOT included]' : ''}`);
    say(`  repo.bundle: ${fmtBytes(files[0].size)}`);
    if (opts.skipSessions) {
      say('  sessions:    NOT included (--skip-sessions)');
    } else {
      const per = Object.entries(totals.bySource).map(([k, v]) => `${k} ${v.sessions}`).join(', ');
      say(`  sessions:    ${totals.sessions}${per ? ` (${per})` : ''}, ${fmtBytes(totals.bytes)}, ${totals.redactionTotal} secret(s) redacted`);
      if (excludedCount) say(`  excluded:    ${excludedCount} session(s) you excluded (only the count is recorded)`);
      if (skippedParent) say(`  skipped:     ${skippedParent} session(s) started outside the project folder (add --include-parent to collect them)`);
      if (unsupported.length) say(`  not collected (unsupported): ${unsupported.map((u) => u.source).join(', ')} — attach exports with --include`);
      for (const m of missing.filter((x) => ['needs-node', 'partial', 'error'].includes(x.status))) say(`  not collected: ${m.source} — ${m.detail || m.status}`);
    }
    say(`  also:        ${[...['SUBMISSION.md', 'scorecard.json', 'score-history.jsonl'].filter((n) => files.some((f) => f.name === n)), 'manifest.json'].join(', ')}`);
    say(`  archive:     ${fmtBytes(size)} compressed (limit ${fmtBytes(limit)})`);
    if (!opts.skipSessions) say('  The archive includes your AI-assistant session transcripts for this project only (secrets redacted). Review them under .split-brain/sessions/ first if you like.');
    if (warnings.length) say(renderWarnings(warnings));

    if (!opts.yes) {
      const ok = await askYesNo(`Create the submission archive${submitUrl ? ' and upload it' : ''}? [y/N] `, io);
      if (!ok) { say('Aborted. Nothing was submitted.'); return { aborted: true }; }
    }
    fs.renameSync(partial, archive);
    partial = null;
    say(`Wrote ${archive} (${fmtBytes(size)})`);

    let uploaded = null;
    if (submitUrl) {
      say(`Uploading to ${submitUrl} ...`);
      uploaded = await upload(submitUrl, archive, { handle, email });
      let reply = null;
      try {
        reply = JSON.parse(uploaded.body);
      } catch {
        reply = null;
      }
      if (!uploaded.ok) {
        throw new UserError(`upload failed (HTTP ${uploaded.status})${reply?.message ? `: ${String(reply.message).replace(/[.\s]+$/, '')}` : ''}. Your bundle is still at ${archive}`);
      }
      uploaded.receipt = reply?.receiptId || null;
      // Keep your own record of what was submitted and when.
      fs.mkdirSync(stateDir(projectRoot), { recursive: true });
      fs.appendFileSync(
        path.join(stateDir(projectRoot), 'submissions.jsonl'),
        `${JSON.stringify({ at: new Date().toISOString(), receiptId: reply?.receiptId || null, sha256: reply?.sha256 || null, bytes: size, email, url: submitUrl, archive })}\n`,
      );
      say(`Submitted. Receipt: ${reply?.receiptId || '(none returned)'}`);
      say('Keep the receipt; you can submit again until the deadline (the latest one counts).');
    } else if (instructionsUrl) {
      say(`Upload it at ${instructionsUrl}`);
    } else {
      say('Upload this file using the submission link from your challenge instructions.');
    }
    return { archive, manifest, uploaded, size };
  } finally {
    if (partial) fs.rmSync(partial, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
