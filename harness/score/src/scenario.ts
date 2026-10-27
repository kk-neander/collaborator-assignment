import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Implementation, SeedFile, TreeNode } from "@split-brain/contract";
import { World, type AddClientOptions, type SimClient, type WorldOptions } from "@split-brain/sim";

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");

export type Track = "floor" | "sync-core" | "ai-peer" | "files" | "runtime" | "hostile";

export interface SeedOutcome {
  pass: boolean;
  skip?: string;
  score?: number;
  detail?: string;
  metrics?: Record<string, number>;
}

export interface Scenario {
  id: string;
  track: Track;
  title: string;
  expect: string;
  seeds?: number;
  needsLlm?: boolean;
  run(seed: number, ctx: RunContext): SeedOutcome | Promise<SeedOutcome>;
}

export interface RunContext {
  impl: Implementation;
}

let seedFiles: SeedFile[] | undefined;

export function workspaceFiles(): SeedFile[] {
  if (seedFiles) return seedFiles;
  const dir = join(REPO_ROOT, "workspace-seed");
  const out: SeedFile[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ path: relative(dir, full).split(sep).join("/"), text: readFileSync(full, "utf8") });
    }
  };
  if (existsSync(dir)) walk(dir);
  seedFiles = out;
  return out;
}

export function pathOf(nodes: TreeNode[], id: string): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parts: string[] = [];
  let cur = byId.get(id);
  while (cur && cur.parentId !== null) {
    parts.unshift(cur.name);
    cur = byId.get(cur.parentId);
  }
  return parts.join("/");
}

export function isLive(nodes: TreeNode[], id: string): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let cur = byId.get(id);
  while (cur) {
    if (cur.deleted) return false;
    if (cur.parentId === null) return true;
    cur = byId.get(cur.parentId);
  }
  return false;
}

export function fileId(world: World, path: string): string {
  const nodes = world.server.tree();
  const node = nodes.find((n) => n.kind === "file" && isLive(nodes, n.id) && pathOf(nodes, n.id) === path);
  if (!node) throw new Error(`no file ${path} on the server`);
  return node.id;
}

export interface Session {
  world: World;
  docs: Map<string, string>;
  clients: SimClient[];
  doc(path: string): string;
}

export interface SessionOptions extends Partial<Omit<WorldOptions, "impl" | "seed">> {
  people?: Array<string | AddClientOptions>;
  open?: string[];
}

export function session(ctx: RunContext, seed: number, opts: SessionOptions = {}): Session {
  const world = new World({ seed, impl: ctx.impl, files: opts.files ?? workspaceFiles(), defaultLink: opts.defaultLink, idleTimeoutMs: opts.idleTimeoutMs });
  const paths = opts.open ?? (opts.files ?? workspaceFiles()).map((f) => f.path);
  const docs = new Map(paths.map((p) => [p, fileId(world, p)]));
  const clients: SimClient[] = [];
  for (const p of opts.people ?? ["maya", "dev", "priya"]) {
    const c = world.addClient(typeof p === "string" ? { name: p } : p);
    c.handle.start();
    clients.push(c);
  }
  world.settle();
  for (const c of clients) for (const id of docs.values()) c.handle.open(id);
  world.settle();
  return {
    world,
    docs,
    clients,
    doc: (path) => {
      const id = docs.get(path);
      if (!id) throw new Error(`${path} is not open in this session`);
      return id;
    },
  };
}

const TOKEN = /<[a-z]+\d+>/g;

export function tokensIn(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

export function safeSpots(text: string): number[] {
  const spots = new Set<number>([0, text.length]);
  for (let i = 0; i < text.length; i++) if (text[i] === "\n" || text[i] === ">") spots.add(i + 1);
  return [...spots].sort((a, b) => a - b);
}

export function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length - 1; i++) if (text[i] === "\n") out.push(i + 1);
  return out;
}

export class TokenLedger {
  private n = 0;
  readonly typed = new Set<string>();
  next(prefix: string): string {
    const t = `<${prefix}${this.n++}>`;
    this.typed.add(t);
    return t;
  }
  check(text: string): { lost: string[]; duplicated: string[] } {
    const seen = new Map<string, number>();
    for (const t of tokensIn(text)) seen.set(t, (seen.get(t) ?? 0) + 1);
    return {
      lost: [...this.typed].filter((t) => !seen.has(t)),
      duplicated: [...seen].filter(([t, n]) => n > 1 && this.typed.has(t)).map(([t]) => t),
    };
  }
}

export interface Divergence {
  path: string;
  who: string;
  expected: number;
  got: number;
}

export function divergences(s: Session): Divergence[] {
  const out: Divergence[] = [];
  for (const [path, id] of s.docs) {
    const server = s.world.server.docText(id);
    if (server === undefined) continue;
    for (const c of s.clients) {
      if (!c.handle.isReady(id)) continue;
      const mine = c.handle.text(id);
      if (mine !== server) out.push({ path, who: c.name, expected: server.length, got: mine.length });
    }
  }
  return out;
}

export function describeDivergence(d: Divergence[]): string {
  const first = d[0]!;
  return `${d.length} copies differ from the relay (e.g. ${first.who}'s ${first.path}: ${first.got} chars vs ${first.expected})`;
}

export function crashes(s: Session): string | undefined {
  const e = s.world.sched.errors[0];
  return e ? `crashed at t=${Math.round(e.at)}ms: ${String((e.error as Error)?.message ?? e.error).slice(0, 160)}` : undefined;
}

export function verdict(s: Session, ledger?: TokenLedger, texts?: () => string): SeedOutcome {
  const settled = s.world.settle(600_000);
  const crash = crashes(s);
  if (crash) return { pass: false, detail: crash };
  if (!settled) return { pass: false, detail: "never settled: some client still has unconfirmed edits after 10 virtual minutes" };
  const d = divergences(s);
  if (d.length) return { pass: false, detail: describeDivergence(d) };
  if (ledger) {
    const all = texts ? texts() : [...s.docs.values()].map((id) => s.world.server.docText(id) ?? "").join("\n");
    const { lost, duplicated } = ledger.check(all);
    if (lost.length) return { pass: false, detail: `${lost.length} typed token(s) vanished, e.g. ${lost.slice(0, 3).join(" ")}`, metrics: { lost: lost.length } };
    if (duplicated.length) return { pass: false, detail: `${duplicated.length} token(s) appear twice, e.g. ${duplicated.slice(0, 3).join(" ")}`, metrics: { duplicated: duplicated.length } };
  }
  return { pass: true };
}
