import { Random } from "@split-brain/sim";
import type { Json } from "@split-brain/contract";
import { crashes, divergences, session, TokenLedger, type Scenario, type SeedOutcome, type Session } from "../scenario.ts";
import { round, sentBy, skip } from "./util.ts";

const NOTES = "src/notes.ts";
const NOTES_TEXT = "export const notes: string[] = [];\n\nexport function add(n: string) {\n  notes.push(n);\n}\n";
const FILES = [{ path: NOTES, text: NOTES_TEXT }];
const INITIAL_LEN = NOTES_TEXT.length;

function typeRound(s: Session, ledger: TokenLedger): void {
  const rng = s.world.rng;
  const id = s.doc(NOTES);
  const c = rng.pick(s.clients);
  if (!c.handle.isReady(id)) return;
  const text = c.handle.text(id);
  const spots = [0, ...[...text.matchAll(/[>\n]/g)].map((m) => m.index! + 1)];
  c.handle.insert(id, rng.pick(spots), ledger.next(c.name));
}

function honestTyping(s: Session, ledger: TokenLedger, rounds: number): void {
  for (let i = 0; i < rounds; i++) {
    s.world.run(s.world.rng.int(20, 120));
    typeRound(s, ledger);
  }
  s.world.settle();
}

interface Health {
  crash?: string;
  settled: boolean;
  diverged: number;
  lost: string[];
  duplicated: string[];
}

function health(s: Session, ledger: TokenLedger): Health {
  const settled = s.world.settle(600_000);
  const text = [...s.docs.values()].map((id) => s.world.server.docText(id) ?? "").join("\n");
  const { lost, duplicated } = ledger.check(text);
  return { crash: crashes(s), settled, diverged: divergences(s).length, lost, duplicated };
}

function hostileVerdict(h: Health, extra: Array<[string, boolean]> = []): SeedOutcome {
  const checks: Array<[string, boolean]> = [
    ["the server threw on a hostile message", !h.crash],
    ["honest clients never reconverged", h.settled && h.diverged === 0],
    ["honest keystrokes were lost", h.lost.length === 0],
    ...extra,
  ];
  const ok = checks.filter(([, good]) => good).length;
  const failed = checks.filter(([, good]) => !good).map(([what]) => what);
  const detail = h.crash
    ? `the server threw while handling a hostile message: ${h.crash}`
    : failed.length
      ? failed.join("; ") + (h.lost.length ? ` (e.g. ${h.lost.slice(0, 3).join(" ")})` : "")
      : undefined;
  return { pass: failed.length === 0, score: ok / checks.length, detail };
}

type Mutator = (msg: Json, rng: Random) => Json;
const BIG = 1e15;

function mapNumbers(value: Json, f: (n: number) => number): Json {
  if (typeof value === "number") return f(value);
  if (Array.isArray(value)) return value.map((v) => mapNumbers(v, f));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapNumbers(v, f)]));
  return value;
}
function mapStrings(value: Json, f: (s: string) => string): Json {
  if (typeof value === "string") return f(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, f));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, f)]));
  return value;
}
const isObj = (m: Json): m is { [k: string]: Json } => !!m && typeof m === "object" && !Array.isArray(m);

const mutators: Mutator[] = [
  (m, r) => mapNumbers(m, () => r.pick([BIG, -BIG, 0.5, -1, 2 ** 31, Number.MAX_SAFE_INTEGER, -0.0001])),
  (m, r) => mapStrings(m, () => r.pick(["", "🫠".repeat(1000), "../../etc", "\u0000", "[]", "{}"])),
  (m, r) => {
    if (!isObj(m)) return m;
    const keys = Object.keys(m).filter((k) => k !== "t");
    if (!keys.length) return m;
    const drop = r.pick(keys);
    return Object.fromEntries(Object.entries(m).filter(([k]) => k !== drop));
  },
  (m, r) => mapStrings(m, () => r.pick(["hello", "op", "tree", "open", "root", "maya", "999"])),
  (m, r) => (isObj(m) && m.t === "op" ? { ...m, baseRevision: 0, op: [r.pick([999, -50, BIG, 3])] } : m),
  (m) => m,
];

function notImpersonating(msg: Json, honestIds: Set<string>): Json {
  if (isObj(msg) && typeof msg.clientId === "string" && honestIds.has(msg.clientId)) return { ...msg, clientId: `hostile-${msg.clientId}` };
  return msg;
}

const mutationFuzz: Scenario = {
  id: "mutation-fuzz",
  track: "hostile",
  title: "",
  expect: "",
  seeds: 12,
  run(seed, ctx) {
    const s = session(ctx, seed, { files: FILES });
    s.world.traceEnabled = true;
    const ledger = new TokenLedger();
    honestTyping(s, ledger, 40);
    const honestIds = new Set(s.clients.map((c) => c.clientId));
    const recorded = s.world.trace.filter((e) => e.dir === "c2s").map((e) => e.msg);
    const rng = s.world.rng;
    const peer = s.world.rawConnect({ name: "mallory", user: { id: "mallory", name: "Mallory" } });
    s.world.settle();
    peer.send({ t: "hello", clientId: "mallory-1", protocol: 1 });
    peer.send({ t: "open", docId: s.doc(NOTES) });
    s.world.settle();
    let sent = 0;
    for (let i = 0; i < 400; i++) {
      const base = recorded.length ? rng.pick(recorded) : { t: "ping", ts: 0 };
      let m = notImpersonating(JSON.parse(JSON.stringify(base)) as Json, honestIds);
      for (let k = 0, n = rng.int(1, 3); k < n; k++) m = rng.pick(mutators)(m, rng);
      peer.send(m);
      sent++;
      if (rng.chance(0.5)) peer.send(m);
      if (i % 10 === 0) {
        s.world.run(rng.int(1, 40));
        typeRound(s, ledger);
      }
    }
    s.world.settle();
    honestTyping(s, ledger, 30);
    const h = health(s, ledger);
    return {
      ...hostileVerdict(h),
      metrics: { mutatedSent: sent, errors: s.world.sched.errors.length, lost: h.lost.length, duplicated: h.duplicated.length, rejected: peer.inbox.filter((m) => isObj(m) && m.t === "error").length },
    };
  },
};

const impersonation: Scenario = {
  id: "impersonation",
  track: "hostile",
  title: "",
  expect: "",
  seeds: 12,
  run(seed, ctx) {
    const s = session(ctx, seed, { files: FILES });
    s.world.traceEnabled = true;
    const victim = s.clients[0]!;
    const id = s.doc(NOTES);
    const rng = s.world.rng;
    const ledger = new TokenLedger();
    s.world.dropConnection(victim.name);
    s.world.settle();
    for (let i = 0; i < 6; i++) {
      s.world.run(rng.int(20, 80));
      victim.handle.insert(id, 0, ledger.next("maya"));
    }
    s.world.settle();
    const hello = sentBy(s.world, victim.name).find((m) => isObj(m) && m.t === "hello") as { clientId: string } | undefined;
    if (!hello) return { pass: false, score: 0, detail: "could not observe the victim's hello on the wire" };
    const stolen = hello.clientId;
    const peer = s.world.rawConnect({ name: "mallory", user: { id: "mallory", name: "Mallory" }, link: { latency: 5, jitter: 0 } });
    s.world.settle();
    peer.send({ t: "hello", clientId: stolen, protocol: 1 });
    peer.send({ t: "open", docId: id });
    peer.send({ t: "op", docId: id, baseRevision: 0, seq: 999_999, op: [INITIAL_LEN] });
    s.world.settle();
    const victimTokens: string[] = [];
    for (let i = 0; i < 40; i++) {
      s.world.run(rng.int(10, 60));
      if (victim.handle.isReady(id)) {
        const t = ledger.next("maya");
        victimTokens.push(t);
        victim.handle.insert(id, 0, t);
      }
      if (rng.chance(0.25)) peer.send({ t: "op", docId: id, baseRevision: 0, seq: 999_999 + i + 1, op: [INITIAL_LEN] });
    }
    s.world.settle();
    honestTyping(s, ledger, 20);
    const h = health(s, ledger);
    const serverText = s.world.server.docText(id) ?? "";
    const lostVictim = victimTokens.filter((t) => !serverText.includes(t));
    const v = hostileVerdict(h, [["the victim's own keystrokes were dropped", lostVictim.length === 0]]);
    return {
      ...v,
      detail: lostVictim.length
        ? `${lostVictim.length} of the victim's ${victimTokens.length} keystrokes were silently dropped after the impostor reused their id (e.g. ${lostVictim.slice(0, 3).join(" ")})`
        : v.detail,
      metrics: { victimTyped: victimTokens.length, victimLost: lostVictim.length, errors: s.world.sched.errors.length },
    };
  },
};

const forgedAuthorship: Scenario = {
  id: "forged-authorship",
  track: "hostile",
  title: "",
  expect: "",
  seeds: 8,
  run(seed, ctx) {
    const s = session(ctx, seed, { files: FILES, people: ["maya", "dev"] });
    if (!s.world.server.authorship) return skip("the engine does not implement authorship(); this scenario grades blame");
    const id = s.doc(NOTES);
    const ledger = new TokenLedger();
    honestTyping(s, ledger, 15);
    const victimId = s.clients[0]!.user.id;
    const peer = s.world.rawConnect({ name: "mallory", user: { id: "mallory", name: "Mallory" } });
    s.world.settle();
    peer.send({ t: "hello", clientId: victimId, protocol: 1, author: victimId, user: { id: victimId, name: "Maya", kind: "human" } } as unknown as Json);
    peer.send({ t: "open", docId: id });
    s.world.settle();
    const marks: string[] = [];
    for (let i = 0; i < 12; i++) {
      const mark = `❖m${seed}_${i}❖`;
      marks.push(mark);
      peer.send({ t: "op", docId: id, baseRevision: 0, seq: i + 1, op: [mark, INITIAL_LEN], author: victimId, user: { id: victimId, name: "Maya" }, clientId: victimId } as unknown as Json);
      s.world.settle();
    }
    honestTyping(s, ledger, 10);
    const h = health(s, ledger);
    if (h.crash) return { pass: false, score: 0, detail: `the server threw: ${h.crash}` };
    const text = s.world.server.docText(id) ?? "";
    const spans = s.world.server.authorship(id);
    if (!spans) return skip("authorship() returned nothing for this document");
    const ownerOf = (pos: number) => spans.find((sp) => pos >= sp.start && pos < sp.end)?.authorId;
    const landed = marks.filter((m) => text.includes(m));
    let correct = 0;
    let misattributed = 0;
    for (const m of landed) {
      const at = text.indexOf(m);
      const owners = new Set(Array.from({ length: m.length }, (_, k) => ownerOf(at + k)));
      if (owners.size === 1 && owners.has("mallory")) correct++;
      if ([...owners].some((o) => o === victimId)) misattributed++;
    }
    const credited = landed.length ? correct / landed.length : 1;
    const checks: Array<[string, boolean]> = [
      ["honest clients diverged or stalled", h.settled && h.diverged === 0],
      ["forged characters were blamed on the victim", misattributed === 0],
      ["forged characters were not credited to the hostile identity", credited >= 1],
      ["the hostile insert never landed", landed.length > 0],
    ];
    const ok = checks.filter(([, g]) => g).length;
    const failed = checks.filter(([, g]) => !g).map(([w]) => w);
    return {
      pass: failed.length === 0,
      score: ok / checks.length,
      detail: failed.length ? `${failed.join("; ")} (${misattributed}/${landed.length} marks attributed to Maya, ${correct} to Mallory)` : undefined,
      metrics: { marks: landed.length, creditedToHostile: correct, blamedOnVictim: misattributed },
    };
  },
};

const flood: Scenario = {
  id: "flood",
  track: "hostile",
  title: "",
  expect: "",
  seeds: 8,
  run(seed, ctx) {
    const s = session(ctx, seed, { files: FILES });
    const id = s.doc(NOTES);
    const rng = s.world.rng;
    const ledger = new TokenLedger();
    honestTyping(s, ledger, 20);
    const peer = s.world.rawConnect({ name: "mallory", user: { id: "mallory", name: "Mallory" }, link: { latency: 1, jitter: 0 } });
    s.world.settle();
    peer.send({ t: "hello", clientId: "flood-1", protocol: 1 });
    peer.send({ t: "open", docId: id });
    s.world.settle();
    const huge = "A".repeat(2_000_000);
    let flooded = 0;
    for (let i = 0; i < 3000; i++) {
      const kind = rng.int(0, 4);
      if (kind === 0) peer.send({ t: "op", docId: id, baseRevision: 9_999_999, seq: i + 1, op: [huge] });
      else if (kind === 1) peer.send({ t: "presence", docId: id, anchor: 2 ** 40, head: -5 });
      else if (kind === 2) peer.send({ t: "ping", ts: i });
      else if (kind === 3) peer.send({ t: "hash", docId: id, revision: 999_999, hash: huge.slice(0, 100_000) });
      else peer.send({ t: "open", docId: huge.slice(0, 2_000) });
      flooded++;
      if (i % 200 === 0) {
        s.world.run(rng.int(1, 20));
        typeRound(s, ledger);
      }
    }
    s.world.settle();
    honestTyping(s, ledger, 25);
    const h = health(s, ledger);
    return { ...hostileVerdict(h), metrics: { flooded, errors: s.world.sched.errors.length, hostileMB: round(peer.bytesSent / 1e6, 1), lost: h.lost.length } };
  },
};

export const hostileScenarios: Scenario[] = [mutationFuzz, impersonation, forgedAuthorship, flood];
