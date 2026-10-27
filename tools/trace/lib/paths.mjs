// Path normalisation and project matching.
//
// Session stores record project locations in many shapes: POSIX paths, Windows
// paths (C:\x, c:/x, \\?\C:\x), WSL mounts (/mnt/c/x), WSL UNC shares
// (\\wsl$\Distro\home\x), file:// and vscode-remote:// URIs with
// percent-encoding, and macOS /private/var aliases. normalizePath() maps all of
// them onto one comparable form: forward slashes, lower-case drive letter
// ("c:/users/x"), no trailing slash, /private/{var,tmp,etc} folded to /{var,tmp,etc}.
import fs from 'node:fs';
import path from 'node:path';

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Convert a file:// URI to a path string (not yet normalised). */
export function fileUriToPathString(uri) {
  let rest = uri.replace(/^file:/i, '');
  let host = '';
  if (rest.startsWith('//')) {
    rest = rest.slice(2);
    const i = rest.indexOf('/');
    host = i === -1 ? rest : rest.slice(0, i);
    rest = i === -1 ? '/' : rest.slice(i);
  }
  rest = rest.replace(/[?#].*$/, '');
  let p = safeDecode(rest);
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  if (host && host.toLowerCase() !== 'localhost') p = `//${safeDecode(host)}${p}`;
  return p;
}

/** Normalise any path-like string to the canonical comparable form, or null. */
export function normalizePath(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  if (/^file:/i.test(s)) {
    s = fileUriToPathString(s);
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^[a-zA-Z]:/.test(s)) {
    // vscode-remote://wsl+Ubuntu/home/u/x, vscode-remote://dev-container+.../workspaces/x ...
    const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/[^?#]*)?/i.exec(s);
    s = safeDecode(m?.[1] || '/');
    if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1);
  }
  s = s.replace(/\\/g, '/');
  // Win32 namespace prefixes: //?/C:/x, //./C:/x, //?/UNC/server/share
  s = s.replace(/^\/\/[?.]\/UNC\//i, '//').replace(/^\/\/[?.]\/(?=[a-zA-Z]:)/, '');
  // WSL shares seen from Windows: //wsl$/Ubuntu/home/u, //wsl.localhost/Ubuntu/home/u
  const wslShare = /^\/\/(?:wsl\$|wsl\.localhost)\/[^/]+(\/.*)?$/i.exec(s);
  if (wslShare) s = wslShare[1] || '/';
  // WSL view of Windows drives: /mnt/c/x -> c:/x
  const mnt = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(s);
  if (mnt) s = `${mnt[1]}:${mnt[2] || '/'}`;
  let prefix = '';
  const drive = /^([a-zA-Z]):(.*)$/.exec(s);
  if (drive) {
    prefix = `${drive[1].toLowerCase()}:`;
    s = drive[2] || '/';
    if (!s.startsWith('/')) s = `/${s}`;
  } else if (/^\/\/[^/]/.test(s)) {
    prefix = '/'; // UNC: keep the double slash
  } else if (!s.startsWith('/')) {
    return s.replace(/\/+$/, '') || s; // relative: cannot be matched, return as-is
  }
  s = path.posix.normalize(s);
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (!prefix) s = s.replace(/^\/private\/(var|tmp|etc)(?=\/|$)/, '/$1');
  return prefix + s;
}

export function isDrivePath(normalized) {
  return typeof normalized === 'string' && /^[a-z]:\//.test(normalized);
}

/** True when `child` equals `root` or is inside it (both already normalised). */
export function isInside(child, root, caseInsensitive = false) {
  if (!child || !root) return false;
  let a = child;
  let b = root;
  if (caseInsensitive || isDrivePath(a) || isDrivePath(b)) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  if (a === b) return true;
  const base = b.endsWith('/') ? b : `${b}/`;
  return a.startsWith(base);
}

const realpathCache = new Map();
/** Best-effort realpath; returns null when the path does not exist locally. */
export function realpathSafe(p) {
  if (realpathCache.has(p)) return realpathCache.get(p);
  let r = null;
  try { r = fs.realpathSync.native(p); } catch { r = null; }
  realpathCache.set(p, r);
  return r;
}

/** Variants of a native path for substring "mention" searches inside raw transcripts. */
export function mentionVariants(nativePath) {
  const out = new Set();
  if (!nativePath) return [];
  out.add(nativePath);
  const fwd = nativePath.replace(/\\/g, '/');
  out.add(fwd);
  if (nativePath.includes('\\')) out.add(nativePath.replace(/\\/g, '\\\\')); // JSON-escaped
  return [...out].filter((v) => v.length >= 4);
}

/**
 * Matches arbitrary recorded paths against the project roots.
 * roots: [{ path, kind, caseInsensitive }]
 */
export class ProjectMatcher {
  constructor(roots, { defaultCaseInsensitive = process.platform === 'darwin' || process.platform === 'win32' } = {}) {
    this.defaultCi = defaultCaseInsensitive;
    this.roots = [];
    const seen = new Set();
    for (const r of roots) {
      const variants = [r.path];
      const real = realpathSafe(r.path);
      if (real) variants.push(real);
      for (const v of variants) {
        const n = normalizePath(v);
        if (!n || !(n.startsWith('/') || isDrivePath(n))) continue;
        const ci = r.caseInsensitive ?? this.defaultCi;
        const key = `${ci ? n.toLowerCase() : n}`;
        if (seen.has(key)) continue;
        seen.add(key);
        this.roots.push({ ...r, normalized: n, caseInsensitive: ci });
      }
    }
  }

  /** Returns the matching root (or null) for a recorded path. */
  match(recorded) {
    const n = normalizePath(recorded);
    if (!n) return null;
    const hit = this.#matchNormalized(n);
    if (hit) return hit;
    // The recorded path may be a symlink to (or alias of) a root on this machine.
    if (typeof recorded === 'string' && (n.startsWith('/') || isDrivePath(n))) {
      const real = realpathSafe(recorded.startsWith('file:') ? n : recorded);
      if (real) {
        const rn = normalizePath(real);
        if (rn && rn !== n) return this.#matchNormalized(rn);
      }
    }
    return null;
  }

  #matchNormalized(n) {
    for (const r of this.roots) if (isInside(n, r.normalized, r.caseInsensitive)) return r;
    return null;
  }

  /** True when `recorded` is a strict ancestor of some root (e.g. the home dir). */
  isAncestorOfRoot(recorded) {
    const n = normalizePath(recorded);
    if (!n || !(n.startsWith('/') || isDrivePath(n))) return false;
    for (const r of this.roots) {
      if (isInside(r.normalized, n, r.caseInsensitive) && !isInside(n, r.normalized, r.caseInsensitive)) {
        // Do not treat the filesystem root as an ancestor worth searching.
        if (n === '/' || /^[a-z]:\/$/.test(n)) continue;
        return true;
      }
    }
    return false;
  }

  /** Raw string variants of every root, for substring mention checks. */
  mentionNeedles() {
    const out = new Set();
    for (const r of this.roots) {
      for (const v of mentionVariants(r.path)) out.add(v);
      out.add(r.normalized);
    }
    // Avoid absurdly short needles that would match everything.
    return [...out].filter((v) => v.length >= 6 && v !== '/');
  }
}
