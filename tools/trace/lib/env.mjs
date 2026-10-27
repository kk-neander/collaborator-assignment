// Platform detection and per-source root directory resolution.
//
// Every source root can be overridden by a repeatable flag (--claude-dir ...)
// or an env var (SB_TRACE_CLAUDE_DIR, list separated by the platform path
// delimiter). An override replaces the defaults entirely. --home /
// SB_TRACE_HOME replaces the home directory used to build defaults, which lets a
// container read a host home directory mounted read-only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDir, readdirSafe } from './fsutil.mjs';

let wslCache;
export function isWsl(env = process.env) {
  if (process.platform !== 'linux') return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  if (wslCache !== undefined) return wslCache;
  try { wslCache = /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { wslCache = false; }
  return wslCache;
}

export function isDocker() {
  if (process.platform !== 'linux') return false;
  if (fs.existsSync('/.dockerenv')) return true;
  try { return /docker|containerd|kubepods/.test(fs.readFileSync('/proc/1/cgroup', 'utf8')); } catch { return false; }
}

export function platformInfo(env = process.env) {
  return { os: process.platform, arch: process.arch, release: os.release(), wsl: isWsl(env), docker: isDocker(), node: process.version };
}

/** Windows user profiles visible from inside WSL (/mnt/c/Users/<name>). */
export function windowsHomesFromWsl() {
  const base = '/mnt/c/Users';
  const skip = new Set(['public', 'default', 'default user', 'all users', 'defaultapppool', 'wdagutilityaccount']);
  return readdirSafe(base)
    .filter((e) => e.isDirectory() && !skip.has(e.name.toLowerCase()))
    .map((e) => path.join(base, e.name))
    .filter((h) => isDir(path.join(h, 'AppData')));
}

export const SOURCE_DIR_OPTIONS = ['claude', 'codex', 'cursor', 'vscode', 'opencode', 'gemini', 'aider'];

function splitList(v) {
  if (!v) return [];
  return v.split(path.delimiter).map((s) => s.trim()).filter(Boolean);
}

export class Environment {
  constructor(opts = {}, env = process.env) {
    this.env = env;
    this.opts = opts;
    this.homeOverridden = Boolean(opts.home || env.SB_TRACE_HOME);
    this.home = path.resolve(opts.home || env.SB_TRACE_HOME || os.homedir());
    this.wsl = isWsl(env);
    this.homes = [this.home];
    if (this.wsl && !this.homeOverridden) this.homes.push(...windowsHomesFromWsl());
  }

  /** Explicit override for a source, or null. */
  override(name) {
    const flag = this.opts[`${name}Dir`];
    if (flag && flag.length) return flag.map((p) => path.resolve(p));
    const fromEnv = splitList(this.env[`SB_TRACE_${name.toUpperCase()}_DIR`]);
    if (fromEnv.length) return fromEnv.map((p) => path.resolve(p));
    return null;
  }

  /**
   * Resolve root dirs for a source. defaults(home) returns candidate dirs for one
   * home; extra are env-derived candidates. Returns { dirs (existing), checked, overridden }.
   */
  dirsFor(name, defaults, extra = []) {
    const ov = this.override(name);
    const candidates = ov || [...extra, ...this.homes.flatMap((h) => defaults(h))];
    const seen = new Set();
    const checked = [];
    for (const c of candidates) {
      if (!c) continue;
      const k = path.resolve(c);
      if (seen.has(k)) continue;
      seen.add(k);
      checked.push(k);
    }
    return { dirs: checked.filter(isDir), checked, overridden: Boolean(ov) };
  }

  /** Editor "User" dirs (VS Code family) under every OS layout for one home. */
  editorUserDirs(home, appNames) {
    const out = [];
    for (const app of appNames) {
      out.push(path.join(home, 'Library', 'Application Support', app, 'User'));
      out.push(path.join(home, '.config', app, 'User'));
      out.push(path.join(home, 'AppData', 'Roaming', app, 'User'));
    }
    return out;
  }

  /** A tool's own env var (CLAUDE_CONFIG_DIR, CODEX_HOME...), ignored when --home is overridden. */
  envPath(varName) {
    if (this.homeOverridden) return null;
    const v = this.env[varName];
    return v ? path.resolve(v) : null;
  }

  appDataDirs(appNames) {
    const a = this.homeOverridden ? null : this.env.APPDATA;
    return a ? appNames.map((app) => path.join(a, app, 'User')) : [];
  }
}
