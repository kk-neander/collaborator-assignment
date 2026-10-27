// Project root discovery, git helpers, the started marker and the time window.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { STATE_DIR, TOOL_VERSION, DEFAULT_WINDOW_DAYS } from './version.mjs';
import { readJsonSafe, writeFileAtomic } from './fsutil.mjs';
import { platformInfo } from './env.mjs';
import { UsageError } from './errors.mjs';

/** Run git; returns trimmed stdout or null. safe.directory=* avoids Docker ownership errors. */
export function git(args, cwd, { trim = true } = {}) {
  try {
    const out = execFileSync('git', ['-c', 'safe.directory=*', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return trim ? out.trim() : out;
  } catch {
    return null;
  }
}

export function resolveProjectRoot(opts, warnings) {
  if (opts.projectRoot) return path.resolve(opts.projectRoot);
  const top = git(['rev-parse', '--show-toplevel'], process.cwd());
  if (top) return path.resolve(top);
  warnings.push('not inside a git repository (or git is not installed); using the current directory as the project root');
  return process.cwd();
}

export function gitHead(root) {
  return git(['rev-parse', '--verify', '-q', 'HEAD'], root) || null;
}

/** Worktree paths, or null when git could not be run in a directory that has a .git entry. */
export function gitWorktrees(root) {
  const out = git(['worktree', 'list', '--porcelain'], root);
  if (out == null) return fs.existsSync(path.join(root, '.git')) ? null : [];
  return out.split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length).trim()).filter(Boolean);
}

/**
 * Collect every root a session may have been recorded under.
 * Host roots (--host-project-root) usually do not exist inside a container.
 */
export function collectRoots(projectRoot, opts, warnings = []) {
  const roots = [{ path: projectRoot, kind: 'main' }];
  const worktrees = gitWorktrees(projectRoot);
  if (worktrees == null) warnings.push('could not run "git worktree list" (git missing or blocked); sessions recorded in other worktrees may be missed — add them with --extra-root');
  for (const w of worktrees || []) roots.push({ path: w, kind: 'worktree' });
  for (const e of opts.extraRoot || []) roots.push({ path: path.resolve(e), kind: 'extra' });
  for (const h of opts.hostProjectRoot || []) roots.push({ path: h, kind: 'host', caseInsensitive: true });
  const seen = new Set();
  return roots.filter((r) => {
    const k = `${r.kind === 'host' ? 'h' : 'l'}:${r.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map((r) => ({ ...r, exists: fs.existsSync(r.path) }));
}

export function stateDir(projectRoot) {
  return path.join(projectRoot, STATE_DIR);
}

export function readMarker(projectRoot) {
  return readJsonSafe(path.join(stateDir(projectRoot), 'started.json'));
}

export function initMarker(projectRoot) {
  const file = path.join(stateDir(projectRoot), 'started.json');
  const existing = readJsonSafe(file);
  if (existing) return { created: false, file, marker: existing };
  const p = platformInfo();
  const marker = {
    startedAt: new Date().toISOString(),
    gitHead: gitHead(projectRoot),
    platform: `${p.os}-${p.arch}${p.wsl ? '-wsl' : ''}`,
    toolVersion: TOOL_VERSION,
    node: process.version,
  };
  writeFileAtomic(file, `${JSON.stringify(marker, null, 2)}\n`);
  return { created: true, file, marker };
}

export function resolveWindow(projectRoot, opts, warnings, now = new Date()) {
  if (opts.since) {
    const d = new Date(opts.since);
    if (Number.isNaN(d.getTime())) throw new UsageError(`--since: not a valid ISO date: ${opts.since}`);
    return { since: d.toISOString(), until: now.toISOString(), origin: '--since' };
  }
  const marker = readMarker(projectRoot);
  const started = marker?.startedAt ? new Date(marker.startedAt) : null;
  if (started && !Number.isNaN(started.getTime())) {
    return { since: new Date(started.getTime() - 3600_000).toISOString(), until: now.toISOString(), origin: 'started.json' };
  }
  warnings.push(`no ${STATE_DIR}/started.json marker and no --since: defaulting to the last ${DEFAULT_WINDOW_DAYS} days (run "node tools/trace/cli.mjs init" when you start)`);
  return { since: new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 86400_000).toISOString(), until: now.toISOString(), origin: `default-${DEFAULT_WINDOW_DAYS}d` };
}
