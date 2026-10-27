// Registry of session sources, in discovery order.
import * as claude from './claude.mjs';
import * as codex from './codex.mjs';
import * as cursor from './cursor.mjs';
import * as vscode from './vscode.mjs';
import * as opencode from './opencode.mjs';
import * as gemini from './gemini.mjs';
import * as aider from './aider.mjs';
import * as manual from './manual.mjs';

export const SOURCES = [claude, codex, cursor, vscode, opencode, gemini, aider, manual];
export { detectUnsupported } from './unsupported.mjs';
