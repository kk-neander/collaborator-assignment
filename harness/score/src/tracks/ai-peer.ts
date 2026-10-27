import { join } from "node:path";
import { applyPlan, buildPrompt, parsePlan, type ApplyResult, type Plan } from "@split-brain/bot/brain";
import { configFromEnv, createLlm, LlmConfigError, type LlmClient } from "@split-brain/bot/llm";
import type { SimClient } from "@split-brain/sim";
import { typeErrors } from "../compile.ts";
import {
  lineStarts,
  REPO_ROOT,
  session,
  TokenLedger,
  verdict,
  workspaceFiles,
  type RunContext,
  type Scenario,
  type SeedOutcome,
  type Session,
} from "../scenario.ts";

let llm: LlmClient | undefined;
let llmProblem: string | undefined;

function getLlm(): LlmClient | undefined {
  if (llm || llmProblem) return llm;
  try {
    llm = createLlm({ ...configFromEnv(), cacheDir: process.env.LLM_CACHE_DIR || join(REPO_ROOT, ".split-brain/llm-cache") });
  } catch (err) {
    llmProblem = err instanceof LlmConfigError ? "needs a real LLM: set LLM_PROVIDER / LLM_MODEL / LLM_API_KEY in .env" : String(err);
  }
  return llm;
}

interface AdaRun {
  s: Session;
  ledger: TokenLedger;
  ada: SimClient;
  humans: SimClient[];
  plan?: Plan;
  result?: ApplyResult;
  planError?: string;
  snapshot: Map<string, string>;
}

async function adaTask(
  seed: number,
  ctx: RunContext,
  instruction: string,
  opts: {
    typingPaths: string[];
    spots?: (path: string, text: string) => number[];
    duringThinking?: (s: Session, humans: SimClient[]) => void;
    plan?: Plan;
  },
): Promise<AdaRun> {
  const paths = workspaceFiles().map((f) => f.path);
  const s = session(ctx, seed, { people: ["maya", "dev", { name: "ada", user: { name: "Ada (AI)", kind: "bot" } }] });
  const ada = s.clients.find((c) => c.name === "ada")!;
  const humans = s.clients.filter((c) => c !== ada);
  const ledger = new TokenLedger();
  const snapshot = new Map(paths.map((p) => [p, ada.handle.text(s.doc(p))]));
  let plan = opts.plan;
  let planError: string | undefined;
  if (!plan) {
    const prompt = buildPrompt({ id: `seed-${seed}`, instruction, requestedBy: "Maya" }, paths.map((p) => ({ path: p, text: snapshot.get(p)! })));
    try {
      const reply = await getLlm()!.complete({ ...prompt, maxTokens: 4096 });
      plan = parsePlan(reply.text);
    } catch (err) {
      planError = String((err as Error)?.message ?? err);
    }
  }
  const thinkMs = s.world.rng.int(3000, 8000);
  const until = s.world.now + thinkMs;
  const spots = opts.spots ?? ((_p: string, t: string) => lineStarts(t));
  opts.duringThinking?.(s, humans);
  while (s.world.now < until) {
    s.world.run(s.world.rng.int(80, 300));
    const c = s.world.rng.pick(humans);
    const path = s.world.rng.pick(opts.typingPaths);
    const id = s.doc(path);
    const choices = spots(path, c.handle.text(id));
    if (choices.length) c.handle.insert(id, s.world.rng.pick(choices), ledger.next(c.name));
  }
  let result: ApplyResult | undefined;
  if (plan) {
    result = applyPlan(
      {
        docIdForPath: (p) => (s.docs.has(p) ? s.doc(p) : undefined),
        text: (d) => ada.handle.text(d),
        replace: (d, pos, len, text) => ada.handle.replace(d, pos, len, text),
      },
      plan,
      snapshot,
    );
  }
  for (let i = 0; i < 10; i++) {
    s.world.run(s.world.rng.int(50, 200));
    const c = s.world.rng.pick(humans);
    const path = s.world.rng.pick(opts.typingPaths);
    const choices = spots(path, c.handle.text(s.doc(path)));
    if (choices.length) c.handle.insert(s.doc(path), s.world.rng.pick(choices), ledger.next(c.name));
  }
  return { s, ledger, ada, humans, plan, result, planError, snapshot };
}

function finalFiles(s: Session): Map<string, string> {
  return new Map([...s.docs].map(([p, id]) => [p, (s.world.server.docText(id) ?? "").replace(/<[a-z]+\d+>/g, "")]));
}

function grade(checks: Array<[string, boolean]>, base?: SeedOutcome): SeedOutcome {
  if (base && !base.pass) return { ...base, score: 0 };
  const passed = checks.filter(([, ok]) => ok).length;
  const failed = checks.filter(([, ok]) => !ok).map(([what]) => what);
  return { pass: failed.length === 0, score: passed / checks.length, detail: failed.length ? failed.join("; ") : undefined };
}

const needLlm = (): SeedOutcome | undefined => (getLlm() ? undefined : { pass: false, skip: llmProblem });

const rename: Scenario = {
  id: "ada-rename",
  track: "ai-peer",
  title: "",
  expect: "",
  seeds: 3,
  needsLlm: true,
  async run(seed, ctx) {
    const missing = needLlm();
    if (missing) return missing;
    const paths = workspaceFiles().filter((f) => f.text.includes("getUser")).map((f) => f.path);
    const r = await adaTask(seed, ctx, "Rename getUser to fetchUser everywhere.", { typingPaths: paths });
    if (r.planError) return { pass: false, score: 0, detail: `Ada's plan failed: ${r.planError}` };
    const v = verdict(r.s, r.ledger);
    const files = finalFiles(r.s);
    const leftovers = [...files].filter(([p, t]) => p.endsWith(".ts") && /\bgetUser\b/.test(t)).map(([p]) => p);
    const errors = typeErrors(files);
    return grade(
      [
        [v.detail ?? "nobody's typing was lost", v.pass],
        [`getUser still in ${leftovers.join(", ")}`, leftovers.length === 0],
        [`type errors: ${errors.slice(0, 2).join(" | ")}`, errors.length === 0],
      ],
    );
  },
};

const todo: Scenario = {
  id: "ada-todo",
  track: "ai-peer",
  title: "",
  expect: "",
  seeds: 3,
  needsLlm: true,
  async run(seed, ctx) {
    const missing = needLlm();
    if (missing) return missing;
    const insideListNotes = (path: string, text: string) => {
      if (path !== "src/notes.ts") return [];
      const start = text.indexOf("export function listNotes");
      const end = text.indexOf("\n}", start);
      return lineStarts(text).filter((p) => p > start && p <= end);
    };
    const r = await adaTask(seed, ctx, "Implement the TODO(ai) in src/notes.ts.", { typingPaths: ["src/notes.ts"], spots: insideListNotes });
    if (r.planError) return { pass: false, score: 0, detail: `Ada's plan failed: ${r.planError}` };
    const v = verdict(r.s, r.ledger);
    const files = finalFiles(r.s);
    const notes = files.get("src/notes.ts")!;
    const errors = typeErrors(files);
    const changed = !/export function listNotes\(\)/.test(notes) || !notes.includes("TODO(ai): add pagination");
    return grade([
      [v.detail ?? "Maya's typing survived", v.pass],
      ["listNotes is unchanged: Ada's edit didn't land", changed],
      [`type errors: ${errors.slice(0, 2).join(" | ")}`, errors.length === 0],
      [`${r.result?.conflicts.length ?? 0} edit(s) skipped as conflicts`, (r.result?.conflicts.length ?? 0) === 0],
    ]);
  },
};

const DEV_FIX = 'res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));';

const sameBug: Scenario = {
  id: "ada-same-bug",
  track: "ai-peer",
  title: "",
  expect: "",
  seeds: 3,
  needsLlm: true,
  async run(seed, ctx) {
    const missing = needLlm();
    if (missing) return missing;
    const r = await adaTask(seed, ctx, "Return a 404 JSON response for unknown routes in src/server.ts.", {
      typingPaths: ["src/notes.ts"],
      duringThinking: (s, humans) => {
        const dev = humans.find((h) => h.name === "dev")!;
        const id = s.doc("src/server.ts");
        const text = dev.handle.text(id);
        const line = 'res.writeHead(404).end("not found");';
        const at = text.indexOf(line);
        if (at >= 0) dev.handle.replace(id, at, line.length, DEV_FIX);
      },
    });
    if (r.planError) return { pass: false, score: 0, detail: `Ada's plan failed: ${r.planError}` };
    const v = verdict(r.s, r.ledger);
    const files = finalFiles(r.s);
    const server = files.get("src/server.ts")!;
    const errors = typeErrors(files);
    const handlers = (server.match(/writeHead\(404/g) ?? []).length;
    const devKept = server.includes(DEV_FIX);
    const told = (r.result?.conflicts.length ?? 0) > 0;
    return grade([
      [v.detail ?? "no typing lost", v.pass],
      [`${handlers} 404 handlers in src/server.ts`, handlers === 1],
      ["Dev's fix was overwritten without anyone being told", devKept || told],
      [`type errors: ${errors.slice(0, 2).join(" | ")}`, errors.length === 0],
    ]);
  },
};

function renamePlan(texts: Map<string, string>): Plan {
  const edits: Plan["edits"] = [];
  for (const [path, text] of texts) {
    for (const line of text.split("\n")) if (line.includes("getUser")) edits.push({ path, find: line, replace: line.replaceAll("getUser", "fetchUser") });
  }
  return { summary: "rename", edits };
}

const blame: Scenario = {
  id: "blame",
  track: "ai-peer",
  title: "",
  expect: "",
  async run(seed, ctx) {
    const paths = workspaceFiles().filter((f) => f.text.includes("getUser")).map((f) => f.path);
    const texts = new Map(workspaceFiles().map((f) => [f.path, f.text]));
    const r = await adaTask(seed, ctx, "rename", { typingPaths: paths, plan: renamePlan(new Map(paths.map((p) => [p, texts.get(p)!]))) });
    const v = verdict(r.s, r.ledger);
    if (!v.pass) return v;
    const server = r.s.world.server;
    if (!server.authorship) return { pass: false, score: 0, detail: "the engine does not implement authorship()" };
    let wrong = 0;
    let checked = 0;
    let firstWrong = "";
    for (const p of paths) {
      const id = r.s.doc(p);
      const text = server.docText(id)!;
      const spans = server.authorship(id) ?? [];
      const authorAt = (i: number) => spans.find((sp) => i >= sp.start && i < sp.end)?.authorId;
      for (const m of text.matchAll(/<([a-z]+)\d+>/g)) {
        checked++;
        const who = authorAt(m.index!);
        if (who !== m[1]) {
          wrong++;
          firstWrong ||= `${m[0]} in ${p} is attributed to ${who ?? "nobody"}`;
        }
      }
      for (const m of text.matchAll(/fetchUser/g)) {
        checked++;
        const who = authorAt(m.index!);
        if (who !== "ada") {
          wrong++;
          firstWrong ||= `Ada's "fetchUser" in ${p} is attributed to ${who ?? "nobody"}`;
        }
      }
    }
    return wrong ? { pass: false, score: 1 - wrong / Math.max(1, checked), detail: firstWrong } : { pass: true };
  },
};

export const aiPeerScenarios: Scenario[] = [rename, todo, sameBug, blame];
