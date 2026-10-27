import { applyPlan, type Plan } from "@split-brain/bot/brain";
import type { SimClient } from "@split-brain/sim";
import { typeErrors } from "../compile.ts";
import { lineStarts, session, verdict, workspaceFiles, type RunContext, type Scenario, type Session } from "../scenario.ts";

const MARKED = ["src/users.ts", "src/notes.ts", "src/permissions.ts", "src/format.ts", "src/server.ts"];

function marked() {
  return workspaceFiles().map((f) => (MARKED.includes(f.path) ? { ...f, text: `// gen 0\n${f.text}` } : f));
}

function runtimeSession(ctx: RunContext, seed: number): { s: Session; ada: SimClient; humans: SimClient[] } {
  const s = session(ctx, seed, {
    files: marked(),
    people: ["maya", "dev", { name: "ada", user: { name: "Ada (AI)", kind: "bot" } }],
  });
  const ada = s.clients.find((c) => c.name === "ada")!;
  return { s, ada, humans: s.clients.filter((c) => c !== ada) };
}

function typeComment(s: Session, c: SimClient): void {
  const path = s.world.rng.pick(MARKED);
  const id = s.doc(path);
  const text = c.handle.text(id);
  const starts = lineStarts(text).filter((p) => p > text.indexOf("\n"));
  c.handle.insert(id, s.world.rng.pick(starts), `// ${c.name} was here\n`);
}

const noSnapshot = { pass: false, score: 0, detail: "the engine does not implement snapshot()" };

const oneMoment: Scenario = {
  id: "run-one-moment",
  track: "runtime",
  title: "",
  expect: "",
  run(seed, ctx) {
    const { s, ada, humans } = runtimeSession(ctx, seed);
    if (!s.world.server.snapshot) return noSnapshot;
    let gen = 0;
    let runs = 0;
    let tornRuns = 0;
    let torn = "";
    for (let round = 0; round < 12; round++) {
      gen++;
      MARKED.forEach((path, i) => {
        s.world.sched.after(i * s.world.rng.int(10, 60), () => {
          const id = s.doc(path);
          const text = ada.handle.text(id);
          const end = text.indexOf("\n");
          ada.handle.replace(id, 0, end, `// gen ${gen}`);
        });
      });
      for (let k = 0; k < 6; k++) {
        s.world.run(s.world.rng.int(5, 60));
        if (s.world.rng.chance(0.4)) typeComment(s, s.world.rng.pick(humans));
        const files = new Map(s.world.server.snapshot().map((f) => [f.path, f.text]));
        const gens = MARKED.map((p) => Number(/^\/\/ gen (\d+)/.exec(files.get(p) ?? "")?.[1] ?? -1));
        runs++;
        const ok = gens.every((g, i) => i === 0 || g <= gens[i - 1]!) && gens[0]! - gens[gens.length - 1]! <= 1;
        if (!ok) tornRuns++;
        if (!ok && !torn) torn = `run ${runs} saw generations ${gens.join(",")} across ${MARKED.join(", ")} (Ada changed them in that order)`;
      }
    }
    const v = verdict(s);
    if (!v.pass) return v;
    return torn
      ? { pass: false, score: 1 - tornRuns / runs, detail: `${tornRuns}/${runs} runs mixed versions: ${torn}`, metrics: { runs, tornRuns } }
      : { pass: true, metrics: { runs } };
  },
};

function renamePlan(texts: Map<string, string>): Plan {
  const edits: Plan["edits"] = [];
  for (const [path, text] of texts) {
    for (const line of text.split("\n")) if (line.includes("getUser")) edits.push({ path, find: line, replace: line.replaceAll("getUser", "fetchUser") });
  }
  return { summary: "rename", edits };
}

const midRefactor: Scenario = {
  id: "run-mid-refactor",
  seeds: 3,
  track: "runtime",
  title: "",
  expect: "",
  run(seed, ctx) {
    const { s, ada, humans } = runtimeSession(ctx, seed);
    if (!s.world.server.snapshot) return noSnapshot;
    const texts = new Map(MARKED.map((p) => [p, ada.handle.text(s.doc(p))]));
    let compiled = 0;
    let runs = 0;
    let first = "";
    s.world.sched.after(s.world.rng.int(100, 400), () =>
      applyPlan(
        {
          docIdForPath: (p) => (s.docs.has(p) ? s.doc(p) : undefined),
          text: (d) => ada.handle.text(d),
          replace: (d, pos, len, t) => ada.handle.replace(d, pos, len, t),
        },
        renamePlan(texts),
        texts,
      ),
    );
    for (let k = 0; k < 20; k++) {
      s.world.run(s.world.rng.int(5, 40));
      if (s.world.rng.chance(0.3)) typeComment(s, s.world.rng.pick(humans));
      const errors = typeErrors(new Map(s.world.server.snapshot().map((f) => [f.path, f.text])));
      runs++;
      if (!errors.length) compiled++;
      else first ||= `run ${runs}: ${errors[0]}`;
    }
    const v = verdict(s);
    if (!v.pass) return v;
    const score = compiled / runs;
    return { pass: score === 1, score, detail: score < 1 ? `${runs - compiled}/${runs} runs got code that doesn't compile (${first})` : undefined, metrics: { runs, compiled } };
  },
};

const halfTyped: Scenario = {
  id: "run-half-typed",
  seeds: 3,
  track: "runtime",
  title: "",
  expect: "",
  run(seed, ctx) {
    const { s, humans } = runtimeSession(ctx, seed);
    if (!s.world.server.snapshot) return noSnapshot;
    const maya = humans[0]!;
    const id = s.doc("src/notes.ts");
    const line = "export const noteCount = (): number => listNotes().length;\n";
    let at = maya.handle.text(id).length;
    let compiled = 0;
    let runs = 0;
    for (const ch of line) {
      maya.handle.insert(id, at, ch);
      at += ch.length;
      s.world.run(s.world.rng.int(40, 140));
      if (s.world.rng.chance(0.35)) {
        runs++;
        if (!typeErrors(new Map(s.world.server.snapshot().map((f) => [f.path, f.text]))).length) compiled++;
      }
    }
    const v = verdict(s);
    if (!v.pass) return v;
    const score = runs ? compiled / runs : 1;
    return { pass: score === 1, score, detail: score < 1 ? `${runs - compiled}/${runs} runs caught Maya mid-word` : undefined, metrics: { runs, compiled } };
  },
};

export const runtimeScenarios: Scenario[] = [oneMoment, midRefactor, halfTyped];
