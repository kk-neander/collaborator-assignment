// Compatibility shim for `node --test tools/trace/test/`.
//
// Node 20 and >= 25 expand a directory argument into its test files. Node 22-24
// treat positional --test arguments as globs, so a bare directory is executed as
// a module instead; package.json "main" points here, and we import every
// *.test.mjs file. When this file is itself picked up as a test file (directory
// expansion), it does nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
let runAsDirectory = false;
try { runAsDirectory = fs.statSync(entry).isDirectory(); } catch { /* not a dir */ }

if (runAsDirectory) {
  for (const f of fs.readdirSync(here).filter((n) => n.endsWith('.test.mjs')).sort()) {
    await import(pathToFileURL(path.join(here, f)).href);
  }
}
