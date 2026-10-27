import type { User } from "@split-brain/protocol";
import type { InspectReport } from "@split-brain/sync";

export type ClientSyncStatus = "match" | "diverged" | "behind";
export type MeterState = "waiting" | "in-sync" | "catching-up" | "split";

export interface MeterClient {
  clientId: string;
  user: User;
  status: ClientSyncStatus;
  revision: number;
  hash: string;
}

export interface MeterDoc {
  docId: string;
  path: string;
  revision: number;
  hash: string;
  clients: MeterClient[];
  state: Exclude<MeterState, "waiting">;
  versions: number;
}

export interface MeterSummary {
  state: MeterState;
  docs: MeterDoc[];
  focus?: MeterDoc;
  splitDocs: number;
}

const RANK: Record<MeterDoc["state"], number> = { split: 0, "catching-up": 1, "in-sync": 2 };

export function summarize(report: InspectReport): MeterSummary {
  const connected = new Set(report.clients.map((c) => c.clientId));
  const docs: MeterDoc[] = [];
  for (const d of report.docs) {
    const clients = d.clients.filter((c) => connected.has(c.clientId));
    if (clients.length === 0) continue;
    const diverged = clients.filter((c) => c.status === "diverged");
    const behind = clients.some((c) => c.status === "behind");
    const versions = new Set([d.hash, ...diverged.map((c) => c.hash)]).size;
    docs.push({
      docId: d.docId,
      path: d.path,
      revision: d.revision,
      hash: d.hash,
      clients,
      state: diverged.length > 0 ? "split" : behind ? "catching-up" : "in-sync",
      versions,
    });
  }
  docs.sort((a, b) => RANK[a.state] - RANK[b.state] || b.versions - a.versions || a.path.localeCompare(b.path));
  const splitDocs = docs.filter((d) => d.state === "split").length;
  const state: MeterState = docs.length === 0 ? "waiting" : splitDocs > 0 ? "split" : docs.some((d) => d.state === "catching-up") ? "catching-up" : "in-sync";
  return { state, docs, focus: docs[0], splitDocs };
}

export function userState(summary: MeterSummary, userId: string): ClientSyncStatus | undefined {
  let worst: ClientSyncStatus | undefined;
  for (const d of summary.docs) {
    for (const c of d.clients) {
      if (c.user.id !== userId) continue;
      if (c.status === "diverged") return "diverged";
      if (c.status === "behind") worst = "behind";
      else if (!worst) worst = "match";
    }
  }
  return worst;
}
