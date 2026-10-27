interface CardInput {
  at: string;
  gitHead: string;
  tracks: Record<string, { scenarios: number; score: number }>;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function renderCard(card: CardInput): string {
  const tracks = Object.entries(card.tracks);
  const overall = tracks.length ? tracks.reduce((a, [, t]) => a + t.score, 0) / tracks.length : 0;
  const pct = Math.round(overall * 100);
  const verdict = pct === 100 ? "Brain fully healed" : pct >= 75 ? "Mostly one brain" : pct >= 40 ? "Still split" : "Full split brain";
  const accent = pct >= 75 ? "#30a46c" : pct >= 40 ? "#f5a524" : "#e5484d";
  const rows = tracks
    .map(([name, t], i) => {
      const y = 190 + i * 34;
      const w = Math.round(t.score * 360);
      return `<text x="48" y="${y}" class="t">${esc(name)}</text>
  <rect x="200" y="${y - 14}" width="360" height="16" rx="8" fill="#26262b"/>
  <rect x="200" y="${y - 14}" width="${w}" height="16" rx="8" fill="${accent}"/>
  <text x="580" y="${y}" class="t">${Math.round(t.score * 100)}%</text>`;
    })
    .join("\n  ");
  const height = 230 + tracks.length * 34;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${height}" viewBox="0 0 640 ${height}">
  <style>.t{font:600 16px ui-sans-serif,system-ui,sans-serif;fill:#ececf1}.s{font:14px ui-monospace,monospace;fill:#8b8d98}</style>
  <rect width="640" height="${height}" rx="20" fill="#111113"/>
  <text x="48" y="64" style="font:800 30px ui-sans-serif,system-ui,sans-serif;fill:#ececf1">Split Brain</text>
  <text x="48" y="92" class="s">3 humans. 1 AI. 4 versions of the same file.</text>
  <text x="48" y="146" style="font:800 40px ui-sans-serif,system-ui,sans-serif;fill:${accent}">${pct}% · ${esc(verdict)}</text>
  ${rows}
  <text x="48" y="${height - 24}" class="s">commit ${esc(card.gitHead)} · ${esc(card.at.slice(0, 10))} · #SplitBrainChallenge</text>
</svg>
`;
}
