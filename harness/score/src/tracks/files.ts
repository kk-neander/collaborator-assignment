import { Random, type SimClient } from "@split-brain/sim";
import type { SeedFile, TreeChange, TreeNode } from "@split-brain/contract";
import { crashes, isLive, pathOf, safeSpots, session, TokenLedger, verdict, type Scenario, type Session } from "../scenario.ts";
import { nodeAt, treeKey, treeProblems } from "./util.ts";

const people = (seed: number, names = ["maya", "dev", "priya"]) => {
  const pre = new Random(seed * 977 + 13);
  return names.map((name) => ({ name, link: { latency: pre.int(20, 150), jitter: 20 } }));
};

function nodeById(s: Session, id: string): TreeNode | undefined {
  return s.world.server.tree().find((n) => n.id === id);
}

function treeTrouble(s: Session): string | undefined {
  const nodes = s.world.server.tree();
  const problems = treeProblems(nodes);
  if (problems.length) return `the shared tree is broken: ${problems.slice(0, 2).join("; ")}`;
  const want = treeKey(nodes);
  const off = s.clients.filter((c) => treeKey(c.handle.tree()) !== want);
  if (off.length) return `${off.map((c) => c.name).join(", ")} see${off.length === 1 ? "s" : ""} a different file tree than the relay`;
  return undefined;
}

function settledTree(s: Session): string | undefined {
  const settled = s.world.settle(600_000);
  const crash = crashes(s);
  if (crash) return crash;
  if (!settled) return "never settled: some client still has unconfirmed changes";
  return treeTrouble(s);
}

function seedTexts(s: Session, files: SeedFile[]): Map<string, string> {
  return new Map(files.map((f) => [nodeAt(s.world, f.path, "file"), f.text]));
}

function tryInsert(c: SimClient, id: string, text: string, ledger?: TokenLedger): string | undefined {
  try {
    if (!c.handle.isReady(id)) return undefined;
    const mine = c.handle.text(id);
    const tok = ledger ? ledger.next(c.name) : text;
    c.handle.insert(id, mine.length, tok);
    return tok;
  } catch {
    return undefined;
  }
}

const cycleMoves: Scenario = {
  id: "cycle-moves",
  track: "files",
  title: "",
  expect: "",
  seeds: 10,
  run(seed, ctx) {
    const files: SeedFile[] = Array.from({ length: 6 }, (_, i) => ({ path: `d${i}/f${i}.ts`, text: `export const f${i} = ${i};\n` }));
    const s = session(ctx, seed, { files, people: people(seed), open: files.map((f) => f.path) });
    const rng = s.world.rng;
    const dirs = files.map((_, i) => nodeAt(s.world, `d${i}`, "dir"));
    const root = nodeAt(s.world, "", "dir");
    const texts = seedTexts(s, files);
    let okRounds = 0;
    let tried = 0;
    let applied = 0;
    let firstProblem: string | undefined;
    const rounds = 15;
    for (let r = 0; r < rounds; r++) {
      const tidy = rng.pick(dirs);
      if (nodeById(s, tidy)?.parentId !== root) rng.pick(s.clients).handle.changeTree({ type: "move", id: tidy, parentId: root });
      s.world.settle();
      const ring = [...dirs].sort(() => rng.next() - 0.5).slice(0, rng.chance(0.5) ? 2 : 3);
      const movers = [...s.clients].sort(() => rng.next() - 0.5);
      const plan = ring.map((id, k) => ({ at: s.world.now + rng.int(0, 20), c: movers[k]!, id, into: ring[(k + 1) % ring.length]! }));
      plan.sort((a, b) => a.at - b.at);
      for (const p of plan) {
        s.world.run(Math.max(0, p.at - s.world.now));
        p.c.handle.changeTree({ type: "move", id: p.id, parentId: p.into });
      }
      const trouble = settledTree(s);
      if (trouble) firstProblem ??= `round ${r + 1}: ${trouble}`;
      else okRounds++;
      tried += plan.length;
      applied += plan.filter((p) => nodeById(s, p.id)?.parentId === p.into).length;
    }
    const nodes = s.world.server.tree();
    for (const [id, text] of texts) {
      if (!isLive(nodes, id)) {
        firstProblem ??= `a file disappeared: ${pathOf(nodes, id)}`;
        okRounds = Math.min(okRounds, rounds - 1);
      } else if (s.world.server.docText(id) !== text) {
        firstProblem ??= `the contents of ${pathOf(nodes, id)} changed although nobody edited it`;
        okRounds = Math.min(okRounds, rounds - 1);
      }
    }
    const score = okRounds / rounds;
    const metrics = { okRounds, rounds, movesTried: tried, movesApplied: applied };
    return firstProblem ? { pass: false, score, detail: firstProblem, metrics } : { pass: true, score, metrics };
  },
};

const renameWhileEditing: Scenario = {
  id: "rename-while-editing",
  track: "files",
  title: "",
  expect: "",
  seeds: 10,
  run(seed, ctx) {
    const files: SeedFile[] = [
      { path: "src/notes.ts", text: "export const notes: string[] = [];\n\nexport function addNote(n: string) {\n  notes.push(n);\n}\n" },
      { path: "src/other.ts", text: "export const other = 1;\n" },
    ];
    const s = session(ctx, seed, { files, people: people(seed) });
    const [maya, dev, priya] = s.clients as [SimClient, SimClient, SimClient];
    const rng = s.world.rng;
    const id = s.doc("src/notes.ts");
    const root = nodeAt(s.world, "", "dir");
    const lib = `lib-${seed}`;
    const steps: TreeChange[] = [
      { type: "rename", id, name: "journal.ts" },
      { type: "create", id: lib, parentId: root, name: "lib", kind: "dir" },
      { type: "move", id, parentId: lib },
      { type: "rename", id: lib, name: "core" },
      { type: "rename", id, name: "notes.ts" },
    ];
    const ledger = new TokenLedger();
    let afterLast = 0;
    let typedSinceLast = 0;
    for (let i = 0; i < 160; i++) {
      s.world.run(rng.int(30, 150));
      const c = rng.chance(0.5) ? dev : priya;
      if (c.handle.isReady(id)) {
        const mine = c.handle.text(id);
        c.handle.insert(id, rng.pick(safeSpots(mine)), ledger.next(c.name));
        if (afterLast) typedSinceLast++;
      }
      if (i % 25 === 12 && steps.length) {
        maya.handle.changeTree(steps.shift()!);
        if (!steps.length) afterLast = i;
      }
    }
    const v = verdict(s, ledger);
    const trouble = treeTrouble(s);
    const nodes = s.world.server.tree();
    const where = isLive(nodes, id) ? pathOf(nodes, id) : "(deleted)";
    const notReady = s.clients.filter((c) => !c.handle.isReady(id)).map((c) => c.name);
    const checks = [v.pass, !trouble, where === "core/notes.ts", notReady.length === 0, typedSinceLast > 0];
    const score = checks.filter(Boolean).length / checks.length;
    const metrics = { typed: ledger.typed.size, typedAfterRenames: typedSinceLast };
    if (!v.pass) return { ...v, score, metrics };
    if (trouble) return { pass: false, score, detail: trouble, metrics };
    if (where !== "core/notes.ts") return { pass: false, score, detail: `the file should now be core/notes.ts but is ${where}`, metrics };
    if (notReady.length) return { pass: false, score, detail: `${notReady.join(", ")} lost the open file after the renames`, metrics };
    if (!typedSinceLast) return { pass: false, score, detail: "nobody could type in the file after it was renamed", metrics };
    return { pass: true, score, metrics };
  },
};

const deleteVsEdit: Scenario = {
  id: "delete-vs-edit",
  track: "files",
  title: "",
  expect: "",
  seeds: 10,
  run(seed, ctx) {
    const files: SeedFile[] = [
      { path: "src/users.ts", text: "export function getUser(id: string) {\n  return { id };\n}\n" },
      { path: "src/notes.ts", text: "export const notes = [];\n" },
    ];
    const s = session(ctx, seed, {
      files,
      people: [
        { name: "maya", link: { latency: 30, jitter: 10 } },
        { name: "dev", link: { latency: 250, jitter: 40 } },
        { name: "priya", link: { latency: 60, jitter: 20 } },
      ],
    });
    const [maya, dev, priya] = s.clients as [SimClient, SimClient, SimClient];
    const rng = s.world.rng;
    const id = s.doc("src/users.ts");
    const typed: string[] = [];
    const ledger = new TokenLedger();
    const deleteAt = s.world.now + rng.int(800, 2000);
    const stopAt = deleteAt + rng.int(500, 1500);
    let deleted = false;
    const blip = rng.chance(0.5) ? rng.pick(s.clients) : undefined;
    while (s.world.now < stopAt) {
      s.world.run(rng.int(40, 120));
      if (!deleted && s.world.now >= deleteAt) {
        maya.handle.changeTree({ type: "delete", id });
        deleted = true;
      }
      const tok = tryInsert(dev, id, "", ledger);
      if (tok) typed.push(tok);
    }
    s.world.settle();
    if (blip) {
      s.world.dropConnection(blip.name);
      s.world.settle();
    }
    priya.handle.changeTree({ type: "restore", id });
    s.world.settle();
    for (const c of s.clients) c.handle.open(id);
    s.world.settle();
    const after: string[] = [];
    for (const c of s.clients) {
      const tok = tryInsert(c, id, `<${c.name}back${seed}>`);
      if (tok) after.push(tok);
    }
    const settled = s.world.settle(600_000);
    const crash = crashes(s);
    if (crash) return { pass: false, score: 0, detail: crash };
    const nodes = s.world.server.tree();
    if (!isLive(nodes, id)) return { pass: false, score: 0, detail: "the restored file is still gone" };
    const text = s.world.server.docText(id) ?? "";
    const recovered = typed.filter((t) => text.includes(t)).length;
    const landed = after.filter((t) => text.includes(t)).length;
    const stale = s.clients.filter((c) => c.handle.isReady(id) && c.handle.text(id) !== text).map((c) => c.name);
    const recoveredShare = typed.length ? recovered / typed.length : 1;
    const score = (recoveredShare + (stale.length || !settled ? 0 : 1) + landed / s.clients.length) / 3;
    const metrics = { typed: typed.length, recovered, typedAfterRestore: landed, blip: blip ? 1 : 0 };
    if (recovered < typed.length) {
      return { pass: false, score, metrics, detail: `${typed.length - recovered} of Dev's ${typed.length} keystroke tokens did not come back with the file` };
    }
    if (!settled || stale.length) {
      return { pass: false, score, metrics, detail: `after the restore ${stale.join(", ") || "someone"} still show${stale.length === 1 ? "s" : ""} a stale copy of the file` };
    }
    if (landed < s.clients.length) return { pass: false, score, metrics, detail: `only ${landed}/${s.clients.length} people could type in the restored file` };
    return { pass: true, score, metrics };
  },
};

const offlineReorg: Scenario = {
  id: "offline-reorg",
  track: "files",
  title: "",
  expect: "",
  seeds: 10,
  run(seed, ctx) {
    const files: SeedFile[] = [
      { path: "src/a.ts", text: "export const a = 1;\n" },
      { path: "src/b.ts", text: "export const b = 2;\n" },
      { path: "src/c.ts", text: "export const c = 3;\n\nexport function sum() {\n  return 6;\n}\n" },
      { path: "docs/readme.md", text: "# Readme\n" },
      { path: "docs/old/legacy.md", text: "# Legacy\n" },
    ];
    const s = session(ctx, seed, { files, people: people(seed) });
    const [maya, dev, priya] = s.clients as [SimClient, SimClient, SimClient];
    const rng = s.world.rng;
    const ids = {
      src: nodeAt(s.world, "src", "dir"),
      docs: nodeAt(s.world, "docs", "dir"),
      old: nodeAt(s.world, "docs/old", "dir"),
      a: s.doc("src/a.ts"),
      b: s.doc("src/b.ts"),
      c: s.doc("src/c.ts"),
    };
    const seedText = new Map(files.map((f) => [s.doc(f.path), f.text]));
    const ledger = new TokenLedger();
    const feature = `feature-${seed}-priya`;
    const fresh = `new-${seed}-priya`;
    s.world.partition("priya", 30_000);
    const offline: TreeChange[] = [
      { type: "create", id: feature, parentId: ids.src, name: "feature", kind: "dir" },
      { type: "move", id: ids.a, parentId: feature },
      { type: "rename", id: ids.b, name: "beta.ts" },
      { type: "delete", id: ids.old },
      { type: "create", id: fresh, parentId: feature, name: "new.ts", kind: "file", text: `// priya's new file ${seed}\n` },
    ];
    for (const change of offline) {
      priya.handle.changeTree(change);
      s.world.run(rng.int(50, 400));
    }
    for (let i = 0; i < 8; i++) {
      const mine = priya.handle.text(ids.c);
      priya.handle.insert(ids.c, rng.pick(safeSpots(mine)), ledger.next("priya"));
    }
    const online: Array<[SimClient, TreeChange]> = [];
    if (rng.chance(0.5)) online.push([dev, { type: "create", id: `feature-${seed}-dev`, parentId: ids.src, name: "feature", kind: "dir" }]);
    if (rng.chance(0.5)) online.push([maya, { type: "rename", id: ids.src, name: "source" }]);
    if (rng.chance(0.5)) online.push([maya, { type: "delete", id: ids.b }]);
    if (rng.chance(0.5)) online.push([dev, { type: "move", id: ids.old, parentId: ids.src }]);
    if (rng.chance(0.5)) online.push([dev, { type: "rename", id: ids.a, name: "alpha.ts" }]);
    if (rng.chance(0.5)) online.push([maya, { type: "create", id: `beta-${seed}`, parentId: ids.src, name: "beta.ts", kind: "file", text: "// someone else's beta\n" }]);
    for (const [c, change] of online) {
      c.handle.changeTree(change);
      s.world.run(rng.int(100, 2000));
      const mine = c.handle.text(ids.c);
      c.handle.insert(ids.c, rng.pick(safeSpots(mine)), ledger.next(c.name));
    }
    s.world.run(31_000);
    const trouble = settledTree(s);
    if (trouble) return { pass: false, score: 0, detail: trouble };
    const v = verdict(s, ledger);
    const nodes = s.world.server.tree();
    const damaged: string[] = [];
    for (const [id, text] of seedText) {
      if (id === ids.c || !isLive(nodes, id)) continue;
      if (s.world.server.docText(id) !== text) damaged.push(pathOf(nodes, id));
    }
    const freshNode = nodes.find((n) => n.id === fresh);
    if (freshNode && isLive(nodes, fresh) && s.world.server.docText(fresh) !== `// priya's new file ${seed}\n`) damaged.push(pathOf(nodes, fresh));
    const ghosts = s.clients.flatMap((c) => c.handle.tree().filter((n) => !nodes.some((m) => m.id === n.id)).map((n) => `${c.name}:${n.name}`));
    const accepted = offline.filter((ch) => {
      const n = nodes.find((m) => m.id === ch.id);
      if (!n) return false;
      if (ch.type === "create") return true;
      if (ch.type === "move") return n.parentId === ch.parentId;
      if (ch.type === "rename") return n.name === ch.name;
      if (ch.type === "delete") return !!n.deleted;
      return false;
    }).length;
    const checks = [v.pass, damaged.length === 0, ghosts.length === 0];
    const score = checks.filter(Boolean).length / checks.length;
    const metrics = { offlineChanges: offline.length, accepted, conflicts: online.length };
    if (!v.pass) return { ...v, score, metrics };
    if (damaged.length) return { pass: false, score, metrics, detail: `file contents changed by the reorganisation: ${damaged.join(", ")}` };
    if (ghosts.length) return { pass: false, score, metrics, detail: `clients still show nodes the relay never accepted (${ghosts.slice(0, 3).join(", ")})` };
    return { pass: true, score, metrics };
  },
};

interface Pair {
  kind: string;
  ceiling: number;
  setup(ctx: PairCtx): { a: () => void; b: () => void; grade: () => [number, number]; why: () => string };
}
interface PairCtx {
  s: Session;
  A: SimClient;
  B: SimClient;
  dir: (name: string) => string;
  file: (name: string) => string;
  id: (name: string) => string;
  live: (id: string) => boolean;
  parent: (id: string) => string | null | undefined;
  name: (id: string) => string | undefined;
  liveWith: (marker: string) => TreeNode | undefined;
  ledger: TokenLedger;
}
const PAIRS: Pair[] = [
  {
    kind: "both rename the same file",
    ceiling: 1,
    setup: ({ A, B, file, name }) => {
      const f = file("f.ts");
      return {
        a: () => A.handle.changeTree({ type: "rename", id: f, name: "alpha.ts" }),
        b: () => B.handle.changeTree({ type: "rename", id: f, name: "beta.ts" }),
        grade: () => [name(f) === "alpha.ts" ? 1 : 0, name(f) === "beta.ts" ? 1 : 0],
        why: () => "a file can only have one name",
      };
    },
  },
  {
    kind: "both move the same file",
    ceiling: 1,
    setup: ({ A, B, file, dir, parent }) => {
      const f = file("f.ts");
      const d1 = dir("left");
      const d2 = dir("right");
      return {
        a: () => A.handle.changeTree({ type: "move", id: f, parentId: d1 }),
        b: () => B.handle.changeTree({ type: "move", id: f, parentId: d2 }),
        grade: () => [parent(f) === d1 ? 1 : 0, parent(f) === d2 ? 1 : 0],
        why: () => "a file can only live in one folder",
      };
    },
  },
  {
    kind: "move two folders into each other",
    ceiling: 1,
    setup: ({ A, B, dir, parent }) => {
      const x = dir("x");
      const y = dir("y");
      return {
        a: () => A.handle.changeTree({ type: "move", id: x, parentId: y }),
        b: () => B.handle.changeTree({ type: "move", id: y, parentId: x }),
        grade: () => [parent(x) === y ? 1 : 0, parent(y) === x ? 1 : 0],
        why: () => "both moves together would make a loop",
      };
    },
  },
  {
    kind: "rename vs move of one file",
    ceiling: 2,
    setup: ({ A, B, file, dir, name, parent }) => {
      const f = file("f.ts");
      const d = dir("target");
      return {
        a: () => A.handle.changeTree({ type: "rename", id: f, name: "renamed.ts" }),
        b: () => B.handle.changeTree({ type: "move", id: f, parentId: d }),
        grade: () => [name(f) === "renamed.ts" ? 1 : 0, parent(f) === d ? 1 : 0],
        why: () => "these two don't conflict at all",
      };
    },
  },
  {
    kind: "move a file into a folder that's being renamed",
    ceiling: 2,
    setup: ({ A, B, file, dir, name, parent }) => {
      const f = file("f.ts");
      const d = dir("target");
      return {
        a: () => A.handle.changeTree({ type: "move", id: f, parentId: d }),
        b: () => B.handle.changeTree({ type: "rename", id: d, name: "renamed" }),
        grade: () => [parent(f) === d ? 1 : 0, name(d) === "renamed" ? 1 : 0],
        why: () => "these two don't conflict at all",
      };
    },
  },
  {
    kind: "delete a folder vs move a file into it",
    ceiling: 1.5,
    setup: ({ A, B, file, dir, live, parent }) => {
      const f = file("f.ts");
      const d = dir("target");
      return {
        a: () => A.handle.changeTree({ type: "delete", id: d }),
        b: () => B.handle.changeTree({ type: "move", id: f, parentId: d }),
        grade: () => [live(d) ? 0 : 1, live(f) ? (parent(f) === d ? 1 : 0.5) : 0],
        why: () => "the folder can't be both gone and hold the moved file; at best the file survives elsewhere",
      };
    },
  },
  {
    kind: "delete a folder vs create a file inside it",
    ceiling: 1.5,
    setup: ({ A, B, dir, id, live, liveWith }) => {
      const d = dir("target");
      const marker = `// created by B ${id("marker")}\n`;
      return {
        a: () => A.handle.changeTree({ type: "delete", id: d }),
        b: () => B.handle.changeTree({ type: "create", id: id("created"), parentId: d, name: "fresh.ts", kind: "file", text: marker }),
        grade: () => {
          const n = liveWith(marker);
          return [live(d) ? 0 : 1, n ? (n.parentId === d ? 1 : 0.5) : 0];
        },
        why: () => "the folder can't be both gone and hold the new file; at best the file survives elsewhere",
      };
    },
  },
  {
    kind: "rename onto a name someone else is creating",
    ceiling: 1.5,
    setup: ({ A, B, file, dir, id, name, liveWith }) => {
      const f = file("f.ts");
      const p = dir("");
      const marker = `// created by B ${id("marker")}\n`;
      return {
        a: () => A.handle.changeTree({ type: "rename", id: f, name: "x.ts" }),
        b: () => B.handle.changeTree({ type: "create", id: id("created"), parentId: p, name: "x.ts", kind: "file", text: marker }),
        grade: () => {
          const n = liveWith(marker);
          return [name(f) === "x.ts" ? 1 : 0, n ? (n.name === "x.ts" && n.parentId === p ? 1 : 0.5) : 0];
        },
        why: () => "only one file can be called x.ts; at best the other survives under another name",
      };
    },
  },
  {
    kind: "type in a file while it's deleted",
    ceiling: 1.5,
    setup: ({ s, A, B, file, live, ledger }) => {
      const f = file("f.ts");
      const typed: string[] = [];
      return {
        a: () => {
          for (let i = 0; i < 4; i++) {
            const tok = tryInsert(A, f, "", ledger);
            if (tok) typed.push(tok);
            s.world.run(s.world.rng.int(20, 60));
          }
        },
        b: () => B.handle.changeTree({ type: "delete", id: f }),
        grade: () => {
          const text = s.world.server.docText(f) ?? "";
          const kept = typed.length > 0 && typed.every((t) => text.includes(t));
          return [live(f) && kept ? 1 : kept ? 0.5 : 0, live(f) ? 0 : 1];
        },
        why: () => "the file can't be both deleted and hold the new typing; at best the typing comes back on restore",
      };
    },
  },
];
const bothIntents: Scenario = {
  id: "both-intents",
  track: "files",
  title: "",
  expect: "",
  seeds: 10,
  run(seed, ctx) {
    const files: SeedFile[] = [];
    PAIRS.forEach((_, k) => {
      files.push({ path: `p${k}/f.ts`, text: `export const p${k} = ${k};\n` });
      for (const d of ["left", "right", "x", "y", "target"]) files.push({ path: `p${k}/${d}/.keep`, text: "" });
    });
    const s = session(ctx, seed, { files, people: people(seed), open: PAIRS.map((_, k) => `p${k}/f.ts`) });
    const rng = s.world.rng;
    const ledger = new TokenLedger();
    const races: Array<{ pair: Pair; run: ReturnType<Pair["setup"]>; aAt: number; bAt: number; A: SimClient; B: SimClient }> = [];
    PAIRS.forEach((pair, k) => {
      const [A, B] = rng.chance(0.5) ? [s.clients[0]!, s.clients[1]!] : [s.clients[1]!, s.clients[0]!];
      const pc: PairCtx = {
        s,
        A,
        B,
        dir: (name) => nodeAt(s.world, name ? `p${k}/${name}` : `p${k}`, "dir"),
        file: (name) => nodeAt(s.world, `p${k}/${name}`, "file"),
        id: (name) => `p${k}-${name}-${seed}`,
        live: (id) => isLive(s.world.server.tree(), id),
        parent: (id) => nodeById(s, id)?.parentId,
        name: (id) => nodeById(s, id)?.name,
        liveWith: (marker) => {
          const nodes = s.world.server.tree();
          return nodes.find((n) => n.kind === "file" && isLive(nodes, n.id) && s.world.server.docText(n.id) === marker);
        },
        ledger,
      };
      const t = s.world.now + rng.int(0, 400);
      races.push({ pair, run: pair.setup(pc), aAt: t + rng.int(0, 30), bAt: t + rng.int(0, 30), A, B });
    });
    const events = races.flatMap((r) => [
      { at: r.aAt, go: r.run.a },
      { at: r.bAt, go: r.run.b },
    ]);
    events.sort((x, y) => x.at - y.at);
    for (const e of events) {
      s.world.run(Math.max(0, e.at - s.world.now));
      e.go();
    }
    const trouble = settledTree(s);
    if (trouble) return { pass: false, score: 0, detail: trouble };
    const grades = races.map((r) => r.run.grade());
    const probeIx = races.findIndex((r) => r.pair.kind === "type in a file while it's deleted");
    const probe = races[probeIx]!;
    const pf = nodeAt(s.world, `p${probeIx}`, "dir");
    const deletedFile = s.world.server.tree().find((n) => n.parentId === pf && n.kind === "file" && n.deleted);
    if (deletedFile && grades[probeIx]![0] === 0) {
      probe.B.handle.changeTree({ type: "restore", id: deletedFile.id });
      s.world.settle();
      const back = probe.run.grade()[0];
      if (back > 0) grades[probeIx]![0] = 0.5;
    }
    const honoured = grades.reduce((n, [a, b]) => n + a + b, 0);
    const total = races.length * 2;
    const ceiling = PAIRS.reduce((n, p) => n + p.ceiling, 0);
    const score = honoured / total;
    const metrics = { honoured, intents: total, best: ceiling, ceiling: Number((ceiling / total).toFixed(3)) };
    if (honoured >= ceiling) return { pass: true, score, metrics };
    const worst = races
      .map((r, i) => ({ r, lost: r.pair.ceiling - grades[i]![0] - grades[i]![1] }))
      .filter((x) => x.lost > 0)
      .sort((x, y) => y.lost - x.lost)[0];
    return {
      pass: false,
      score,
      metrics,
      detail: `honoured ${honoured} of ${total} intents (the best possible is ${ceiling}); e.g. "${worst?.r.pair.kind}" kept less than it could (${worst?.r.run.why()})`,
    };
  },
};
export const filesScenarios: Scenario[] = [cycleMoves, renameWhileEditing, deleteVsEdit, offlineReorg, bothIntents];