// Human-readable output. Never prints transcript text; titles only with --show-titles.

export function fmtBytes(n) {
  if (n == null) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

function fmtTime(iso) {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '-';
}

function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

export function stripTitles(result, showTitles) {
  if (showTitles) return result;
  return { ...result, sessions: result.sessions.map(({ title, ...s }) => ({ ...s, hasTitle: Boolean(title) })) };
}

export function renderSources(sources) {
  const lines = [];
  for (const [id, s] of Object.entries(sources)) {
    let line = `  ${id.padEnd(15)} ${s.status}`;
    if (s.status === 'ok' || s.status === 'partial') line += ` (${s.sessions} session${s.sessions === 1 ? '' : 's'}${s.skippedParentFolder ? `, ${s.skippedParentFolder} skipped` : ''})`;
    if (s.detail) line += ` — ${s.detail}`;
    lines.push(line);
    for (const n of s.notes || []) lines.push(`      note: ${n}`);
  }
  return lines.join('\n');
}

export function renderTrace(result, { showTitles = false } = {}) {
  const out = [];
  out.push(`split-brain trace ${result.dryRun ? '(dry run — nothing written)' : ''}`.trim());
  out.push(`  project:  ${result.projectRoot}`);
  const extra = result.projectRoots.filter((r) => r.kind !== 'main');
  for (const r of extra) out.push(`  ${`+${r.kind}:`.padEnd(9)} ${r.path}${r.exists ? '' : ' (not on this machine)'}`);
  out.push(`  window:   since ${result.window.since} (${result.window.origin})`);
  out.push('');
  // The first column is the exact id accepted by --exclude / .split-brain/trace-exclude.txt.
  const rows = result.sessions.map((s) => {
    const r = [`${s.source}:${s.id}`, fmtTime(s.startedAt), fmtTime(s.endedAt), s.messageCount ?? '-', s.toolCallCount ?? '-', fmtBytes(s.bytes ?? s.sourceBytes), s.status];
    if (showTitles) r.push(s.title || '');
    return r;
  });
  const headers = ['SESSION ID (source:id)', 'STARTED (UTC)', 'ENDED (UTC)', 'MSGS', 'TOOLS', 'SIZE', 'STATUS'];
  if (showTitles) headers.push('TITLE');
  out.push(rows.length ? table(rows, headers) : '  (no sessions found for this project in the window)');
  if (result.skipped?.length) {
    out.push('');
    out.push(`skipped: started outside the project folder (${result.skipped.length}) — these began in a parent folder (e.g. your home) and only mention this project; they may contain other work. Add --include-parent to collect them.`);
    for (const s of result.skipped) out.push(`  ${s.key}  ${fmtTime(s.startedAt)}  ${fmtBytes(s.sourceBytes)}`);
  }
  if (result.excluded?.length) {
    out.push('');
    out.push(`excluded (${result.excluded.length}):`);
    for (const e of result.excluded) {
      const what = e.snapshotted ? (result.dryRun ? 'snapshot will be removed' : e.removed ? 'snapshot removed' : 'removed from index') : 'not collected';
      out.push(`  ${e.key}  (${what})`);
    }
  }
  out.push('');
  out.push('sources:');
  out.push(renderSources(result.sources));
  const t = result.totals;
  out.push('');
  out.push(`total: ${t.sessions} session(s), ${fmtBytes(t.bytes)}${result.dryRun ? ' (sizes are source sizes; redaction runs on export)' : `, ${t.redactionTotal} redaction(s)`}`);
  if (!result.dryRun && t.redactionTotal) out.push(`  redactions by kind: ${Object.entries(t.redactions).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (result.indexPath) out.push(`index: ${result.indexPath}`);
  if (rows.length) out.push('To leave a session out, add its SESSION ID to .split-brain/trace-exclude.txt (one per line) or pass --exclude <id>.');
  return out.join('\n');
}

export function renderWarnings(warnings) {
  return warnings.map((w) => `warning: ${w}`).join('\n');
}
