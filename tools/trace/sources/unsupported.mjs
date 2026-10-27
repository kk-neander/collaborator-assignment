// Tools we can detect but do not parse. Only their presence is reported; no
// file under these directories is read.
import path from 'node:path';
import { isDir } from '../lib/fsutil.mjs';

const editorLayouts = (h, app) => [
  path.join(h, 'Library', 'Application Support', app, 'User'),
  path.join(h, '.config', app, 'User'),
  path.join(h, 'AppData', 'Roaming', app, 'User'),
];

const EXTENSIONS = [
  ['cline', 'Cline', 'saoudrizwan.claude-dev'],
  ['roo-code', 'Roo Code', 'rooveterinaryinc.roo-cline'],
  ['kilo-code', 'Kilo Code', 'kilocode.kilo-code'],
  ['augment', 'Augment', 'augment.vscode-augment'],
];

const TOOLS = [
  ['windsurf', 'Windsurf', (h) => [path.join(h, '.codeium', 'windsurf'), ...editorLayouts(h, 'Windsurf')]],
  ['zed', 'Zed', (h) => [path.join(h, '.local', 'share', 'zed', 'threads'), path.join(h, 'Library', 'Application Support', 'Zed', 'threads')]],
  ['continue', 'Continue', (h) => [path.join(h, '.continue', 'sessions')]],
  ['copilot-cli', 'GitHub Copilot CLI', (h) => [path.join(h, '.copilot', 'session-state'), path.join(h, '.copilot', 'history-session-state')]],
  ['goose', 'Goose', (h) => [path.join(h, '.local', 'share', 'goose', 'sessions')]],
  ['qwen-code', 'Qwen Code', (h) => [path.join(h, '.qwen', 'tmp')]],
  ['kiro', 'Kiro', (h) => editorLayouts(h, 'Kiro')],
  ['trae', 'Trae', (h) => editorLayouts(h, 'Trae')],
  ['amp', 'Amp', (h) => [path.join(h, '.local', 'share', 'amp'), path.join(h, '.config', 'amp')]],
];

export function detectUnsupported(envr, projectRoots = []) {
  const out = [];
  for (const [id, label, dirsFn] of TOOLS) {
    if (envr.homes.some((h) => dirsFn(h).some(isDir))) out.push({ source: id, label, status: 'unsupported', detail: 'detected but not supported — attach an export with --include FILE' });
  }
  const editorUsers = envr.homes.flatMap((h) => ['Code', 'Code - Insiders', 'Cursor', 'VSCodium', 'Windsurf'].flatMap((a) => editorLayouts(h, a)));
  for (const [id, label, ext] of EXTENSIONS) {
    if (editorUsers.some((u) => isDir(path.join(u, 'globalStorage', ext)))) out.push({ source: id, label, status: 'unsupported', detail: 'detected but not supported — attach an export with --include FILE' });
  }
  for (const r of projectRoots) {
    if (r.exists && isDir(path.join(r.path, '.crush'))) { out.push({ source: 'crush', label: 'Crush', status: 'unsupported', detail: 'detected (.crush/ in project) but not supported — attach an export with --include FILE' }); break; }
  }
  return out;
}
