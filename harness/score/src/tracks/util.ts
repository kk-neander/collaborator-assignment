import type { Json, TreeNode } from "@split-brain/contract";
import type { World } from "@split-brain/sim";
import { isLive, pathOf, type SeedOutcome } from "../scenario.ts";

export function skip(why: string): SeedOutcome {
  return { pass: false, score: 0, detail: why, skip: why };
}

export function creditLowerIsBetter(value: number, good: number, bad: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= good) return 1;
  if (value >= bad) return 0;
  return 1 - Math.log(value / good) / Math.log(bad / good);
}
export const round = (n: number, digits = 3) => Number(n.toFixed(digits));

export function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}
export function sentBy(world: World, name: string, since = 0): Json[] {
  return world.trace.filter((e, i) => i >= since && e.dir === "c2s" && e.client === name).map((e) => e.msg);
}
export function nodeAt(world: World, path: string, kind?: "file" | "dir"): string {
  const nodes = world.server.tree();
  const node = nodes.find(
    (n) => (kind === undefined || n.kind === kind) && isLive(nodes, n.id) && (path === "" ? n.parentId === null : pathOf(nodes, n.id) === path),
  );
  if (!node) throw new Error(`no ${kind ?? "node"} at "${path}" on the server`);
  return node.id;
}
export function treeKey(nodes: TreeNode[]): string {
  return JSON.stringify(
    nodes
      .map((n) => [n.id, n.name, n.parentId, n.kind, !!n.deleted] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
}
export function treeProblems(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const roots = nodes.filter((n) => n.parentId === null);
  if (roots.length !== 1) out.push(`${roots.length} roots`);
  for (const n of nodes) {
    const seen = new Set<string>();
    let cur: TreeNode | undefined = n;
    while (cur && cur.parentId !== null) {
      if (seen.has(cur.id)) {
        out.push(`cycle through "${n.name}"`);
        break;
      }
      seen.add(cur.id);
      const parent = byId.get(cur.parentId);
      if (!parent) {
        out.push(`"${cur.name}" points at a missing parent ${cur.parentId}`);
        break;
      }
      if (parent.kind !== "dir") out.push(`"${cur.name}" sits inside the file "${parent.name}"`);
      cur = parent;
    }
  }
  const names = new Map<string, string>();
  for (const n of nodes) {
    if (n.parentId === null || !isLive(nodes, n.id)) continue;
    const key = `${n.parentId}/${n.name}`;
    if (names.has(key)) out.push(`two live entries named "${pathOf(nodes, n.id)}"`);
    names.set(key, n.id);
  }
  return [...new Set(out)];
}
export function quantile(values: number[], q: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}