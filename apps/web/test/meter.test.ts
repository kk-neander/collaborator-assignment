import type { InspectReport } from "@split-brain/sync";
import { describe, expect, it } from "vitest";
import { summarize, userState } from "../src/demo/meter.ts";

const maya = { id: "maya", name: "Maya", kind: "human" as const, color: "#e5484d" };
const dev = { id: "dev", name: "Dev", kind: "human" as const, color: "#3e63dd" };
const priya = { id: "priya", name: "Priya", kind: "human" as const, color: "#30a46c" };

type Status = "match" | "diverged" | "behind";

function report(docs: Array<{ path: string; hash: string; clients: Array<[string, typeof maya, Status, string?]> }>, connected: string[]): InspectReport {
  const users = new Map<string, typeof maya>();
  return {
    docs: docs.map((d, i) => ({
      docId: `f_${i}`,
      path: d.path,
      revision: 7,
      hash: d.hash,
      length: 10,
      clients: d.clients.map(([clientId, user, status, hash]) => {
        users.set(clientId, user);
        return { clientId, user, revision: status === "behind" ? 5 : 7, hash: hash ?? (status === "match" ? d.hash : "x"), status };
      }),
    })),
    clients: connected.map((clientId) => ({ clientId, user: users.get(clientId) ?? maya, connected: true })),
  };
}

describe("divergence meter", () => {
  it("waits when nobody reports", () => {
    expect(summarize(report([{ path: "a.ts", hash: "h", clients: [] }], [])).state).toBe("waiting");
  });

  it("is in sync when every connected client matches", () => {
    const s = summarize(report([{ path: "a.ts", hash: "h", clients: [["c1", maya, "match"], ["c2", dev, "match"]] }], ["c1", "c2"]));
    expect(s.state).toBe("in-sync");
    expect(userState(s, "dev")).toBe("match");
  });

  it("is catching up when someone is only behind", () => {
    const s = summarize(report([{ path: "a.ts", hash: "h", clients: [["c1", maya, "match"], ["c2", dev, "behind"]] }], ["c1", "c2"]));
    expect(s.state).toBe("catching-up");
    expect(userState(s, "dev")).toBe("behind");
  });

  it("counts versions on a split brain and focuses the worst file", () => {
    const s = summarize(
      report(
        [
          { path: "ok.ts", hash: "h0", clients: [["c1", maya, "match"]] },
          { path: "src/notes.ts", hash: "h", clients: [["c1", maya, "diverged", "m"], ["c2", dev, "diverged", "d"], ["c3", priya, "match"]] },
          { path: "b.ts", hash: "h2", clients: [["c2", dev, "diverged", "z"]] },
        ],
        ["c1", "c2", "c3"],
      ),
    );
    expect(s.state).toBe("split");
    expect(s.focus?.path).toBe("src/notes.ts");
    expect(s.focus?.versions).toBe(3);
    expect(s.splitDocs).toBe(2);
    expect(userState(s, "priya")).toBe("match");
    expect(userState(s, "maya")).toBe("diverged");
  });

  it("ignores stale reports from disconnected clients", () => {
    const s = summarize(report([{ path: "a.ts", hash: "h", clients: [["gone", maya, "diverged"], ["c2", dev, "match"]] }], ["c2"]));
    expect(s.state).toBe("in-sync");
    expect(s.docs[0]!.clients.map((c) => c.clientId)).toEqual(["c2"]);
  });
});
