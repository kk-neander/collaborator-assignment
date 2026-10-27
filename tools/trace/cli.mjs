#!/usr/bin/env node
// split-brain trace — collect this project's AI coding-session transcripts
// (redacted, with consent) and build a submission archive.
// Zero dependencies; Node >= 20. See tools/trace/README.md.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { TOOL_VERSION } from './lib/version.mjs';
import { SOURCE_DIR_OPTIONS } from './lib/env.mjs';
import { initMarker, resolveProjectRoot } from './lib/project.mjs';
import { runTrace } from './lib/trace.mjs';
import { runSubmit } from './lib/submit.mjs';
import { renderTrace, renderWarnings, stripTitles } from './lib/format.mjs';
import { UsageError, UserError, safeErrorLabel } from './lib/errors.mjs';
import { installWarningFilter, loadSqlite, sqliteNeedsFlag } from './lib/sqlite.mjs';

const HELP = `split-brain trace ${TOOL_VERSION}

Usage: node tools/trace/cli.mjs <command> [options]

Commands
  init                 Record the challenge start time in .split-brain/started.json
  trace                Snapshot this project's AI session transcripts (redacted)
                       into .split-brain/sessions/
  submit <email>       Trace, build submission/split-brain-<handle>-<ts>.tar.gz and upload it

Common options
  --project-root DIR        Project root (default: git toplevel of the cwd)
  --extra-root DIR          Another folder that counts as this project (repeatable)
  --host-project-root PATH  Project path as recorded on the host, when running in
                            a container (repeatable)
  --since ISO               Window start (default: started.json - 1h, else 21 days)
  --home DIR                Home dir used to find tool data (env SB_TRACE_HOME)
  --<tool>-dir DIR          Override a source root (repeatable; env SB_TRACE_<TOOL>_DIR)
                            tools: ${SOURCE_DIR_OPTIONS.join(', ')}
  --max-session-mb N        Per-session size cap (default 50; keeps first 20% + last 80%)
  --exclude SOURCE:ID       Leave a session out (repeatable; also read from
                            .split-brain/trace-exclude.txt). Removes its snapshot.
  --include-parent          Also collect sessions started in a parent folder (e.g. ~)
                            that mention this project (skipped by default)

trace options
  --dry-run                 Show what would be collected; write nothing
  --include FILE            Add a file (e.g. an export from another tool) (repeatable)
  --json                    Print JSON instead of a table
  --show-titles             Include session titles in the output

submit options
  --yes                     Confirm without the interactive prompt
  --skip-sessions           Do not include any session transcripts
  --handle NAME             Your handle (default: git user.name)
  --email EMAIL             Your email (required; or pass it as: submit you@example.com)
  --out DIR                 Output directory (default: <project>/submission)

Environment (or .env): SUBMIT_URL (your personal submission link; asked for if missing),
SB_TRACE_MAX_MB (compressed submission limit, default 300).
No Node 20+? Run: bash tools/trace/docker-run.sh <command> [options]
`;

function parse(argv) {
  const options = {
    'project-root': { type: 'string' },
    'extra-root': { type: 'string', multiple: true },
    'host-project-root': { type: 'string', multiple: true },
    since: { type: 'string' },
    home: { type: 'string' },
    'max-session-mb': { type: 'string' },
    'dry-run': { type: 'boolean' },
    include: { type: 'string', multiple: true },
    exclude: { type: 'string', multiple: true },
    'include-parent': { type: 'boolean' },
    json: { type: 'boolean' },
    'show-titles': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    'skip-sessions': { type: 'boolean' },
    handle: { type: 'string' },
    email: { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  };
  for (const s of SOURCE_DIR_OPTIONS) options[`${s}-dir`] = { type: 'string', multiple: true };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(`${e.message}\nRun with --help for usage.`);
  }
  const opts = {};
  for (const [k, v] of Object.entries(parsed.values)) opts[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  return { command: parsed.positionals[0], rest: parsed.positionals.slice(1), opts };
}

/** Node 22.5-22.12 / 23.0-23.3 ship node:sqlite behind a flag: re-run once with it. */
async function maybeRespawnForSqlite(argv) {
  if (await loadSqlite()) return null;
  if (!sqliteNeedsFlag() || process.env.SB_TRACE_RESPAWNED) return null;
  const self = fileURLToPath(import.meta.url);
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings=ExperimentalWarning', ...process.execArgv, self, ...argv], {
    stdio: 'inherit',
    env: { ...process.env, SB_TRACE_RESPAWNED: '1' },
  });
  return r.status ?? 1;
}

async function main(argv) {
  installWarningFilter();
  const { command, rest, opts } = parse(argv);
  if (opts.version) { process.stdout.write(`${TOOL_VERSION}\n`); return 0; }
  if (opts.help || !command || command === 'help') { process.stdout.write(HELP); return command || opts.help ? 0 : 2; }
  if (command === 'submit' && rest.length === 1 && rest[0].includes('@') && !opts.email) opts.email = rest.shift();
  if (rest.length) throw new UsageError(`unexpected argument: ${rest[0]}`);

  if (command === 'trace' || command === 'submit') {
    const code = await maybeRespawnForSqlite(argv);
    if (code !== null) return code;
  }

  switch (command) {
    case 'init': {
      const warnings = [];
      const root = resolveProjectRoot(opts, warnings);
      if (warnings.length) process.stderr.write(`${renderWarnings(warnings)}\n`);
      const r = initMarker(root);
      process.stdout.write(r.created ? `Started: ${r.marker.startedAt}\nWrote ${path.relative(process.cwd(), r.file) || r.file}\n` : `Already initialised (started ${r.marker.startedAt}): ${r.file}\n`);
      return 0;
    }
    case 'trace': {
      const result = await runTrace(opts);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(stripTitles(result, opts.showTitles), null, 2)}\n`);
      } else {
        process.stdout.write(`${renderTrace(result, { showTitles: opts.showTitles })}\n`);
        if (result.warnings.length) process.stderr.write(`${renderWarnings(result.warnings)}\n`);
      }
      return 0;
    }
    case 'submit': {
      const r = await runSubmit(opts);
      return r.aborted ? 1 : 0;
    }
    default:
      throw new UsageError(`unknown command: ${command}\nRun with --help for usage.`);
  }
}

// This file is only ever executed as the entry point (tests spawn it), so run
// unconditionally — an argv[1] === import.meta.url check breaks with symlinks
// and Windows drive-letter casing.
main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e) => {
    if (e instanceof UserError) {
      process.stderr.write(`error: ${e.message}\n`);
      process.exitCode = e.exitCode;
    } else {
      // Unexpected: do not echo e.message (it may quote transcript content).
      process.stderr.write(`error: unexpected failure (${safeErrorLabel(e)}). Re-run with SB_TRACE_DEBUG=1 for a stack trace.\n`);
      if (process.env.SB_TRACE_DEBUG) process.stderr.write(`${(e?.stack || '').split('\n').slice(1).join('\n')}\n`);
      process.exitCode = 1;
    }
  },
);
