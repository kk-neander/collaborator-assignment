// VS Code-family workspaceStorage helpers (Cursor, VS Code, Insiders, VSCodium).
// workspace.json holds either { folder: "file:///..." } or
// { workspace: "file:///.../x.code-workspace" } (multi-root).
import path from 'node:path';
import { fileUriToPathString, normalizePath } from '../lib/paths.mjs';
import { readdirSafe, readJsonSafe, readTextSafe } from '../lib/fsutil.mjs';

function workspaceFileFolders(wsUri) {
  const file = /^file:/i.test(wsUri) ? fileUriToPathString(wsUri) : wsUri;
  const text = readTextSafe(file);
  if (!text) return [];
  let j;
  try {
    // .code-workspace is JSONC: strip line comments and trailing commas (best effort).
    j = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1'));
  } catch { return []; }
  const dir = path.dirname(file);
  return (j.folders || []).map((f) => {
    if (f.uri) return f.uri;
    if (!f.path) return null;
    const n = normalizePath(f.path);
    return n && (n.startsWith('/') || /^[a-z]:\//.test(n)) ? f.path : path.resolve(dir, f.path);
  }).filter(Boolean);
}

/** Yield { hash, dir, folders[] , root } for workspaces matching the project. */
export function matchingWorkspaces(userDir, matcher) {
  const out = [];
  const base = path.join(userDir, 'workspaceStorage');
  for (const ent of readdirSafe(base)) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(base, ent.name);
    const wj = readJsonSafe(path.join(dir, 'workspace.json'));
    if (!wj) continue;
    const folders = [];
    if (typeof wj.folder === 'string') folders.push(wj.folder);
    if (typeof wj.workspace === 'string') {
      folders.push(...workspaceFileFolders(wj.workspace));
      folders.push(wj.workspace); // a .code-workspace file stored inside the project
    }
    let root = null;
    let folder = null;
    for (const f of folders) {
      root = matcher.match(f);
      if (root) { folder = f; break; }
    }
    if (root) out.push({ hash: ent.name, dir, folder, root });
  }
  return out;
}
