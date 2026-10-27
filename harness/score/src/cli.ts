import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { impl } from "@split-brain/contract/impl";
import { floorScenarios } from "./floor.ts";
import { REPO_ROOT, type Scenario, type Track } from "./scenario.ts";
import { trackScenarios } from "./tracks/index.ts";
import { renderCard } from "./card.ts";

interface Args {
  track: Track | "all";
  seed?: number;
  seeds?: number;
  seedBase: number;
  only?: string[];
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { track: "floor", json: false, seedBase: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--track") args.track = next() as Args["track"];
    else if (a === "--seed") args.seed = Number(next());
    else if (a === "--seeds") args.seeds = Number(next());
    else if (a === "--seed-base") args.seedBase = Number(next());
    else if (a === "--only") args.only = next().split(",");
    else if (a === "--json") args.json = true;
    else if (a === "-h" || a === "--help") {
      console.log("usage: ./sb score [--track floor|sync-core|ai-peer|files|runtime|hostile|all] [--seed N] [--seeds N] [--only id,id] [--json]");
      process.exit(0);
    } else throw new Error(`unknown option ${a}`);
  }
  return args;
}

export interface ScenarioResult {
  id: string;
  track: Track;
  title: string;
  expect: string;
  seeds: number;
  passed: number;
  score: number;
  skipped?: string;
  failure?: { seed: number; detail: string };
  ms: number;
}

const EXPLAIN = false;

const ALL: Scenario[] = [...floorScenarios, ...trackScenarios];
if (process.env.SB_EXTRA_SCENARIOS) {
  const extra = (await import(process.env.SB_EXTRA_SCENARIOS)) as { extraScenarios?: Scenario[] };
  ALL.push(...(extra.extraScenarios ?? []));
}

async function runScenario(sc: Scenario, args: Args): Promise<ScenarioResult> {
  const seeds = args.seed !== undefined ? [args.seed] : Array.from({ length: args.seeds ?? sc.seeds ?? 10 }, (_, i) => args.seedBase + i + 1);
  const started = performance.now();
  let passed = 0;
  let total = 0;
  let failure: ScenarioResult["failure"];
  for (const seed of seeds) {
    let outcome;
    try {
      outcome = await sc.run(seed, { impl });
    } catch (err) {
      outcome = { pass: false, detail: `threw: ${String((err as Error)?.message ?? err).slice(0, 200)}` };
    }
    if (typeof outcome.skip === "string") {
      return { id: sc.id, track: sc.track, title: sc.title, expect: sc.expect, seeds: 0, passed: 0, score: 0, skipped: outcome.skip, ms: 0 };
    }
    total += outcome.score ?? (outcome.pass ? 1 : 0);
    if (outcome.pass) passed++;
    else failure ??= { seed, detail: outcome.detail ?? "failed" };
  }
  return {
    id: sc.id,
    track: sc.track,
    title: sc.title,
    expect: sc.expect,
    seeds: seeds.length,
    passed,
    score: total / seeds.length,
    failure,
    ms: Math.round(performance.now() - started),
  };
}

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

function bar(fraction: number): string {
  const n = Math.round(fraction * 20);
  return `${"█".repeat(n)}${"░".repeat(20 - n)}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const chosen = ALL.filter(
    (sc) => (args.track === "all" || sc.track === args.track) && (!args.only || args.only.includes(sc.id)),
  );
  if (!chosen.length) throw new Error(`no scenarios for track "${args.track}"${args.only ? ` with ids ${args.only}` : ""}`);
  if (!args.json) console.log(paint(1, `\nSplit Brain score — ${args.track} — engine "${impl.name}"\n`));
  const results: ScenarioResult[] = [];
  for (const sc of chosen) {
    const r = await runScenario(sc, args);
    results.push(r);
    if (args.json) continue;
    const mark = r.skipped ? paint(90, "-") : r.passed === r.seeds ? paint(32, "✓") : r.passed === 0 ? paint(31, "✗") : paint(33, "~");
    const count = r.skipped ? paint(90, "skipped") : `${r.passed}/${r.seeds}`;
    console.log(` ${mark} ${(EXPLAIN ? r.title : r.id).padEnd(62)} ${count.padStart(7)}`);
    if (r.skipped) console.log(paint(90, `     ${r.skipped}`));
    else if (r.failure && EXPLAIN) console.log(paint(90, `     seed ${r.failure.seed}: ${r.failure.detail}\n     expected: ${r.expect}`));
    else if (r.failure) console.log(paint(90, `     first failing seed: ${r.failure.seed}`));
  }
  const byTrack = new Map<string, { score: number; count: number }>();
  for (const r of results) {
    if (r.skipped) continue;
    const t = byTrack.get(r.track) ?? { score: 0, count: 0 };
    t.score += r.score;
    t.count += 1;
    byTrack.set(r.track, t);
  }
  const card = {
    at: new Date().toISOString(),
    gitHead: gitHead(),
    engine: impl.name,
    track: args.track,
    singleSeed: args.seed,
    tracks: Object.fromEntries([...byTrack].map(([k, v]) => [k, { scenarios: v.count, score: Number((v.score / v.count).toFixed(4)) }])),
    results: EXPLAIN ? results : results.map(({ title: _t, expect: _e, failure, ...r }) => ({ ...r, failure: failure && { seed: failure.seed, detail: "" } })),
  };
  const dir = process.env.SB_OUT_DIR || join(REPO_ROOT, ".split-brain");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scorecard.json"), `${JSON.stringify(card, null, 2)}\n`);
  appendFileSync(join(dir, "score-history.jsonl"), `${JSON.stringify({ ...card, results: results.map(({ id, passed, seeds, score }) => ({ id, passed, seeds, score })) })}\n`);
  writeFileSync(join(dir, "score-card.svg"), renderCard(card));
  if (args.json) {
    console.log(JSON.stringify(card, null, 2));
    return;
  }
  console.log("");
  for (const [track, t] of byTrack) {
    const f = t.score / t.count;
    console.log(` ${paint(1, track.padEnd(10))} ${bar(f)} ${(f * 100).toFixed(0).padStart(3)}%  (${t.score.toFixed(1)}/${t.count})`);
  }
  console.log(paint(90, `\n Saved .split-brain/scorecard.json, score-history.jsonl and score-card.svg (share it!)\n`));
}

main().catch((err) => {
  console.error(String((err as Error)?.message ?? err));
  process.exit(1);
});
