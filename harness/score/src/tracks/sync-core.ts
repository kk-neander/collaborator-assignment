import { Random, type SimClient } from "@split-brain/sim";
import {
  crashes,
  describeDivergence,
  divergences,
  lineStarts,
  safeSpots,
  session,
  TokenLedger,
  verdict,
  type Scenario,
  type SeedOutcome,
  type Session,
} from "../scenario.ts";
import { creditLowerIsBetter, quantile, round } from "./util.ts";

function healthy(s: Session, limitMs = 600_000): SeedOutcome | undefined {
  const settled = s.world.settle(limitMs);
  const crash = crashes(s);
  if (crash) return { pass: false, score: 0, detail: crash };
  if (!settled) return { pass: false, score: 0, detail: "never settled: some client still has unconfirmed edits" };
  const d = divergences(s);
  if (d.length) return { pass: false, score: 0, detail: describeDivergence(d) };
  return undefined;
}

class Stopwatch {
  ms = 0;
  time<T>(fn: () => T): T {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.ms += performance.now() - t0;
    }
  }
}

const STANDUP = "src/standup.md";
const STANDUP_TEXT = "# Standup\n\n- shipped the importer\n- blocked on review\n- next: search\n";
const WORDS = ["merge", "query", "pizza", "rebase", "lambda", "vector", "kernel", "socket", "cursor", "branch", "commit", "tensor", "quorum", "deploy"];

class Keys {
  private next = 0x4e00;
  readonly label = new Map<string, string>();
  fresh(label: string): string {
    const ch = String.fromCharCode(this.next++);
    this.label.set(ch, label);
    return ch;
  }
  show(text: string): string {
    return [...text].map((c) => this.label.get(c) ?? (c === "\n" ? "⏎" : c)).join("");
  }
}
interface Word {
  who: string;
  label: string;
  chars: string[];
  classic: boolean;
}
function contiguous(text: string, chars: string[]): boolean {
  const at = chars.map((c) => text.indexOf(c));
  return at.every((p, i) => p >= 0 && (i === 0 || p === at[i - 1]! + 1));
}
const noInterleave: Scenario = {
  id: "no-interleave",
  track: "sync-core",
  title: "",
  expect: "",
  seeds: 10,
  run(seed, ctx) {
    const pre = new Random(seed * 7919 + 1);
    const people = ["maya", "dev", "priya"].map((name) => ({ name, link: { latency: pre.int(40, 150), jitter: 20 } }));
    const s = session(ctx, seed, { files: [{ path: STANDUP, text: STANDUP_TEXT }], people });
    const id = s.doc(STANDUP);
    const rng = s.world.rng;
    const keys = new Keys();
    const rounds: Word[][] = [];
    let wordIx = rng.int(0, WORDS.length - 1);
    for (let r = 0; r < 12; r++) {
      const host = s.clients[r % s.clients.length]!;
      const marker = keys.fresh("|");
      host.handle.insert(id, rng.pick(lineStarts(host.handle.text(id))), `${marker}\n`);
      s.world.settle();
      const typists = [...s.clients].sort(() => rng.next() - 0.5).slice(0, rng.chance(0.5) ? 2 : 3);
      const events: Array<{ at: number; c: SimClient; ch: string; prev: string; classic: boolean }> = [];
      const words: Word[] = [];
      for (const c of typists) {
        const label = WORDS[wordIx++ % WORDS.length]!;
        const classic = rng.chance(0.5);
        const w: Word = { who: c.name, label, chars: [...label].map((l) => keys.fresh(l)), classic };
        words.push(w);
        let at = s.world.now + rng.int(0, 30);
        let prev = marker;
        for (const ch of w.chars) {
          events.push({ at, c, ch, prev, classic });
          prev = ch;
          at += rng.int(60, 120);
        }
      }
      events.sort((a, b) => a.at - b.at);
      const seenAt = new Map<SimClient, Set<string>>();
      for (const e of events) {
        s.world.run(Math.max(0, e.at - s.world.now));
        const mine = e.c.handle.text(id);
        let caret = mine.indexOf(e.prev) + 1;
        if (caret === 0) return { pass: false, score: 0, detail: `${e.c.name}'s own keystroke vanished from their screen mid-word` };
        if (e.classic) {
          const seen = seenAt.get(e.c);
          while (seen && caret < mine.length && keys.label.has(mine[caret]!) && !seen.has(mine[caret]!)) caret++;
        }
        e.c.handle.insert(id, caret, e.ch);
        seenAt.set(e.c, new Set(e.c.handle.text(id)));
      }
      rounds.push(words);
      s.world.settle();
    }
    const bad = healthy(s);
    if (bad) return bad;
    const final = s.world.server.docText(id)!;
    const all = rounds.flat();
    const split = all.filter((w) => !contiguous(final, w.chars));
    const score = 1 - split.length / all.length;
    const metrics = {
      words: all.length,
      split: split.length,
      classicWords: all.filter((w) => w.classic).length,
      classicSplit: split.filter((w) => w.classic).length,
      modernSplit: split.filter((w) => !w.classic).length,
    };
    if (!split.length) return { pass: true, score, metrics };
    const shown = rounds.find((r) => r.includes(split[0]!))!;
    const spots = shown.flatMap((w) => w.chars.map((c) => final.indexOf(c)));
    const soup = keys.show(final.slice(Math.min(...spots), Math.max(...spots) + 1));
    return {
      pass: false,
      score,
      metrics,
      detail: `${split.length}/${all.length} words came out in pieces, e.g. ${shown.map((w) => `${w.who} typed "${w.label}"`).join(", ")} and everyone now reads "${soup}"`,
    };
  },
};
function codeFile(rng: Random, targetChars: number): string {
  const parts: string[] = [];
  let n = 0;
  let size = 0;
  const idents = ["user", "note", "page", "item", "cache", "token", "event", "query"];
  while (size < targetChars) {
    const a = rng.pick(idents);
    const b = rng.pick(idents);
    const line =
      n % 12 === 0
        ? `\nexport function ${a}${n}(${b}: string): string {\n`
        : n % 12 === 11
          ? `}\n`
          : `  const ${a}_${n} = ${b}.slice(${rng.int(0, 99)}, ${rng.int(100, 999)}); // ${rng.next().toString(36).slice(2, 10)}\n`;
    parts.push(line);
    size += line.length;
    n++;
  }
  return parts.join("");
}
const crowdedRoom: Scenario = {
  id: "crowded-room",
  track: "sync-core",
  title: "",
  expect: "",
  seeds: 3,
  run(seed, ctx) {
    const pre = new Random(seed * 31 + 7);
    const text = codeFile(pre, 12_000);
    const humans = Array.from({ length: 50 }, (_, i) => ({ name: `p${i}`, link: { latency: pre.int(10, 150), jitter: 20 } }));
    const bots = Array.from({ length: 5 }, (_, i) => ({
      name: `ada${i}`,
      user: { name: `Ada ${i} (AI)`, kind: "bot" as const },
      link: { latency: 15, jitter: 5 },
    }));
    const watch = new Stopwatch();
    const s = watch.time(() => session(ctx, seed, { files: [{ path: "src/app.ts", text }], people: [...humans, ...bots] }));
    const joinMs = watch.ms;
    watch.ms = 0;
    const id = s.doc("src/app.ts");
    const rng = s.world.rng;
    const ledger = new TokenLedger();
    let edits = 0;
    for (let i = 0; i < 1500; i++) {
      watch.time(() => s.world.run(rng.int(1, 12)));
      const c = rng.pick(s.clients);
      if (!c.handle.isReady(id)) continue;
      const mine = watch.time(() => c.handle.text(id));
      if (c.user.kind === "bot") {
        const block = Array.from({ length: 3 }, () => `  // ${ledger.next("ada")} generated\n`).join("");
        watch.time(() => c.handle.insert(id, rng.pick(lineStarts(mine)), block));
      } else {
        const tok = ledger.next("p");
        watch.time(() => c.handle.insert(id, rng.pick(safeSpots(mine)), tok));
      }
      edits++;
    }
    const v = watch.time(() => verdict(s, ledger));
    const msPerEdit = watch.ms / edits;
    const metrics = { edits, people: s.clients.length, msPerEdit: round(msPerEdit), joinMs: round(joinMs, 1) };
    if (!v.pass) return { ...v, score: 0, metrics: { ...metrics, ...v.metrics } };
    const score = creditLowerIsBetter(msPerEdit, 2, 200);
    return score >= 1
      ? { pass: true, score, metrics }
      : { pass: false, score, metrics, detail: `converged, but each edit cost ${msPerEdit.toFixed(2)} ms of wall time across the room (full credit at ≤ 2 ms)` };
  },
};
const hugeFile: Scenario = {
  id: "huge-file",
  track: "sync-core",
  title: "",
  expect: "",
  seeds: 2,
  run(seed, ctx) {
    const pre = new Random(seed * 131 + 3);
    const text = codeFile(pre, 10 * 1024 * 1024);
    const people = ["maya", "dev", "priya"].map((name) => ({ name, link: { latency: pre.int(20, 100), jitter: 15 } }));
    const watch = new Stopwatch();
    const s = watch.time(() => session(ctx, seed, { files: [{ path: "data/fixtures.ts", text }], people }));
    const joinMs = watch.ms;
    watch.ms = 0;
    const id = s.doc("data/fixtures.ts");
    const rng = s.world.rng;
    const ledger = new TokenLedger();
    let edits = 0;
    for (let i = 0; i < 300; i++) {
      watch.time(() => s.world.run(rng.int(20, 120)));
      const c = rng.pick(s.clients);
      if (!c.handle.isReady(id)) continue;
      const mine = watch.time(() => c.handle.text(id));
      const at = mine.indexOf("\n", rng.int(0, mine.length - 2)) + 1;
      const pos = at > 0 && at < mine.length ? at : 0;
      const end = mine.indexOf("\n", pos);
      const cut = mine.slice(pos, end).indexOf(" // ");
      if (rng.chance(0.25) && cut > 0 && !mine.slice(pos, end).includes("<")) {
        watch.time(() => c.handle.delete(id, pos + cut, end - pos - cut));
      } else {
        const tok = ledger.next(c.name);
        watch.time(() => c.handle.insert(id, pos, `${tok}\n`));
      }
      edits++;
    }
    const v = watch.time(() => verdict(s, ledger));
    const msPerEdit = watch.ms / edits;
    const metrics = { edits, sizeMB: round(text.length / 1024 / 1024, 2), msPerEdit: round(msPerEdit, 2), joinMs: round(joinMs, 1) };
    if (!v.pass) return { ...v, score: 0, metrics: { ...metrics, ...v.metrics } };
    const score = creditLowerIsBetter(msPerEdit, 5, 1000);
    return score >= 1
      ? { pass: true, score, metrics }
      : { pass: false, score, metrics, detail: `converged, but each edit cost ${msPerEdit.toFixed(1)} ms of wall time on a 10 MB file (full credit at ≤ 5 ms)` };
  },
};
const longHistory: Scenario = {
  id: "long-history",
  track: "sync-core",
  title: "",
  expect: "",
  seeds: 3,
  run(seed, ctx) {
    const s = session(ctx, seed, { files: [{ path: "src/log.ts", text: codeFile(new Random(seed), 4_000) }] });
    const id = s.doc("src/log.ts");
    const [maya, dev, priya] = s.clients as [SimClient, SimClient, SimClient];
    const rng = s.world.rng;
    const ledger = new TokenLedger();
    s.world.partition("priya", 24 * 3_600_000);
    for (let i = 0; i < 15; i++) {
      const mine = priya.handle.text(id);
      priya.handle.insert(id, rng.pick(safeSpots(mine)), ledger.next("priya"));
    }
    let edits = 0;
    while (edits < 20_000) {
      s.world.run(rng.int(1, 6));
      const c = edits % 2 ? maya : dev;
      const mine = c.handle.text(id);
      const fillers = [...mine.matchAll(/ zz\d+/g)];
      if (fillers.length > 40 || (fillers.length > 0 && rng.chance(0.45))) {
        const f = rng.pick(fillers);
        c.handle.delete(id, f.index!, f[0].length);
      } else if (rng.chance(0.02)) {
        c.handle.insert(id, rng.pick(safeSpots(mine)), ledger.next(c.name));
      } else {
        const ends = lineStarts(mine).map((p) => mine.indexOf("\n", p)).filter((p) => p > 0);
        c.handle.insert(id, rng.pick(ends), ` zz${edits}`);
      }
      edits++;
    }
    s.world.sched.runWhile(() => s.world.inFlight > 0 || !maya.handle.isSynced() || !dev.handle.isSynced(), 60_000);
    priya.blockedUntil = s.world.now;
    const t0 = performance.now();
    const v = verdict(s, ledger);
    const catchUpMs = performance.now() - t0;
    const metrics = { history: edits, catchUpMs: round(catchUpMs, 1) };
    if (!v.pass) return { ...v, score: 0, metrics: { ...metrics, ...v.metrics } };
    const score = creditLowerIsBetter(catchUpMs, 250, 30_000);
    return score >= 1
      ? { pass: true, score, metrics }
      : { pass: false, score, metrics, detail: `merged correctly, but catching up took ${Math.round(catchUpMs)} ms of wall time (full credit at ≤ 250 ms)` };
  },
};
const nearLightSpeed: Scenario = {
  id: "near-light-speed",
  track: "sync-core",
  title: "",
  expect: "",
  seeds: 5,
  run(seed, ctx) {
    const pre = new Random(seed * 17 + 5);
    const sydney = 150;
    const people = [
      { name: "maya", link: { latency: sydney, jitter: 0 } },
      { name: "dev", link: { latency: pre.int(10, 30), jitter: 0 } },
      { name: "priya", link: { latency: pre.int(30, 60), jitter: 0 } },
    ];
    const s = session(ctx, seed, { files: [{ path: STANDUP, text: STANDUP_TEXT }], people });
    const id = s.doc(STANDUP);
    const [maya, ...watchers] = s.clients as [SimClient, SimClient, SimClient];
    const rng = s.world.rng;
    const keys = new Keys();
    const typedAt = new Map<string, number>();
    const pending = new Map<SimClient, string[]>(watchers.map((w) => [w, []]));
    const extra: number[] = [];
    let under50 = 0;
    const poll = () => {
      for (const w of watchers) {
        const queue = pending.get(w)!;
        if (!queue.length) continue;
        const theirs = w.handle.text(id);
        while (queue.length && theirs.includes(queue[0]!)) {
          const ch = queue.shift()!;
          const took = s.world.now - typedAt.get(ch)!;
          extra.push(took - (sydney + w.link.latency));
          if (took <= 50) under50++;
        }
      }
    };
    let caret = maya.handle.text(id).length;
    const until = s.world.now + 12_000;
    let typed = 0;
    while (s.world.now < until) {
      const stop = s.world.now + (rng.chance(0.1) ? rng.int(300, 900) : rng.int(25, 70));
      while (s.world.now < stop) {
        s.world.run(Math.min(2, stop - s.world.now));
        poll();
      }
      const ch = keys.fresh(String.fromCharCode(97 + (typed % 26)));
      caret = Math.min(caret, maya.handle.text(id).length);
      maya.handle.insert(id, caret, ch);
      caret++;
      typed++;
      typedAt.set(ch, s.world.now);
      for (const w of watchers) pending.get(w)!.push(ch);
      if (rng.chance(0.05)) {
        rng.pick(watchers).handle.insert(id, 0, keys.fresh("#"));
        caret++;
      }
    }
    for (let i = 0; i < 5000 && [...pending.values()].some((q) => q.length); i++) {
      s.world.run(2);
      poll();
    }
    const bad = healthy(s);
    if (bad) return bad;
    const missing = [...pending.values()].reduce((n, q) => n + q.length, 0);
    if (missing) return { pass: false, score: 0, detail: `${missing} keystrokes never reached a watcher` };
    const p50 = quantile(extra, 0.5);
    const p95 = quantile(extra, 0.95);
    const metrics = { keystrokes: typed, p50ExtraMs: round(p50, 1), p95ExtraMs: round(p95, 1), floorMs: sydney + watchers[0]!.link.latency, under50ms: under50 };
    const score = creditLowerIsBetter(Math.max(0, p95), 20, 1500);
    return score >= 1
      ? { pass: true, score, metrics }
      : {
          pass: false,
          score,
          metrics,
          detail: `95% of keystrokes arrived within ${Math.round(p95)} ms more than the network needs (median ${Math.round(p50)} ms extra); full credit at ≤ 20 ms extra`,
        };
  },
};
export const syncCoreScenarios: Scenario[] = [noInterleave, crowdedRoom, hugeFile, longHistory, nearLightSpeed];