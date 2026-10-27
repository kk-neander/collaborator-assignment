import { applyPlan, type Plan } from "@split-brain/bot/brain";
import { signInvite, verifyInvite } from "@split-brain/relay/tokens";
import { Random } from "@split-brain/sim";
import type { SimClient } from "@split-brain/sim";
import {
  crashes,
  describeDivergence,
  divergences,
  lineStarts,
  safeSpots,
  session,
  TokenLedger,
  verdict,
  workspaceFiles,
  type Scenario,
  type Session,
} from "./scenario.ts";

const NOTES = "src/notes.ts";

function typeToken(s: Session, c: SimClient, path: string, ledger: TokenLedger, spots = safeSpots): void {
  const id = s.doc(path);
  if (!c.handle.isReady(id)) return;
  const text = c.handle.text(id);
  c.handle.insert(id, s.world.rng.pick(spots(text)), ledger.next(c.name.replace(/[^a-z]/g, "")));
}

const join: Scenario = {
  id: "join",
  track: "floor",
  title: "",
  expect: "",
  run(seed, ctx) {
    const s = session(ctx, seed);
    const ledger = new TokenLedger();
    for (let i = 0; i < 60; i++) {
      s.world.run(s.world.rng.int(5, 120));
      typeToken(s, s.world.rng.pick(s.clients), NOTES, ledger);
    }
    return verdict(s, ledger);
  },
};

const invites: Scenario = {
  id: "invites",
  track: "floor",
  title: "",
  expect: "",
  run(seed) {
    const rng = new Random(seed);
    const secret = `secret-${seed}`;
    const alphabet = "abcdefghijklmnopqrstuvwxyzÀéü語🫠 -_'";
    let failures = 0;
    let firstError = "";
    for (let i = 0; i < 200; i++) {
      const name = Array.from({ length: rng.int(1, 24) }, () => rng.pick([...alphabet])).join("") || "x";
      const user = { id: `u${rng.int(0, 1e9)}`, name, kind: "human" as const };
      const token = signInvite({ room: "main", user, exp: 2_000_000_000_000 }, secret);
      try {
        const payload = verifyInvite(token, secret, 1_800_000_000_000);
        if (payload.user.name !== name) throw new Error("name changed in transit");
      } catch (err) {
        failures++;
        firstError ||= (err as Error).message;
      }
    }
    return failures
      ? { pass: false, score: 1 - failures / 200, detail: `${failures}/200 invites were rejected ("${firstError}")` }
      : { pass: true };
  },
};

const idle: Scenario = {
  id: "idle",
  track: "floor",
  title: "",
  expect: "",
  run(seed, ctx) {
    const s = session(ctx, seed);
    s.world.run(5 * 60_000);
    const dropped = s.world.closes.get("idle timeout") ?? 0;
    if (dropped) return { pass: false, detail: `the relay dropped ${dropped} idle connection(s) in 5 minutes`, metrics: { dropped } };
    return verdict(s);
  },
};

const emoji: Scenario = {
  id: "emoji",
  track: "floor",
  title: "",
  expect: "",
  run(seed, ctx) {
    const s = session(ctx, seed, { files: [{ path: "emoji.txt", text: "hello world\n" }] });
    const id = s.doc("emoji.txt");
    const [maya, dev, priya] = s.clients as [SimClient, SimClient, SimClient];
    maya.handle.insert(id, 0, "🫠🫠 ");
    s.world.settle();
    const t = dev.handle.text(id);
    dev.handle.insert(id, t.indexOf("hello") + 5, "X");
    s.world.settle();
    const t2 = priya.handle.text(id);
    priya.handle.delete(id, t2.indexOf("world"), 5);
    s.world.settle();
    const rng = s.world.rng;
    const pieces = ["🫠", "é", "語", "👩‍💻", "a"];
    for (let i = 0; i < 40; i++) {
      const c = rng.pick(s.clients);
      const text = c.handle.text(id);
      const spots = safeSpots(text).filter((p) => p >= text.indexOf("\n") + 1);
      c.handle.insert(id, rng.pick(spots.length ? spots : [text.length]), `${rng.pick(pieces)}\n`);
      s.world.run(rng.int(1, 40));
    }
    s.world.settle();
    const crash = crashes(s);
    if (crash) return { pass: false, detail: crash };
    const d = divergences(s);
    if (d.length) return { pass: false, detail: describeDivergence(d) };
    const firstLine = s.world.server.docText(id)!.split("\n")[0];
    if (firstLine !== "🫠🫠 helloX ") return { pass: false, detail: `first line should be "🫠🫠 helloX " but is "${firstLine}"` };
    return { pass: true };
  },
};

const flakyWifi: Scenario = {
  id: "flaky-wifi",
  track: "floor",
  title: "",
  expect: "",
  run(seed, ctx) {
    const s = session(ctx, seed, { defaultLink: { latency: 80, jitter: 60 } });
    const ledger = new TokenLedger();
    for (let i = 0; i < 300; i++) {
      s.world.run(s.world.rng.int(5, 60));
      const c = s.world.rng.pick(s.clients);
      typeToken(s, c, NOTES, ledger);
      if (s.world.rng.chance(0.06)) s.world.dropConnection(c.name);
      if (s.world.rng.chance(0.02)) s.world.partition(c.name, s.world.rng.int(200, 4000));
    }
    return verdict(s, ledger);
  },
};

const sameSpot: Scenario = {
  id: "same-spot",
  track: "floor",
  title: "",
  expect: "",
  run(seed, ctx) {
    const s = session(ctx, seed, {
      people: [
        { name: "maya", clockSkewMs: 0 },
        { name: "dev", clockSkewMs: 0 },
        { name: "priya", clockSkewMs: 4000 },
      ],
      defaultLink: { latency: 60, jitter: 0 },
    });
    const ledger = new TokenLedger();
    const id = s.doc(NOTES);
    for (let round = 0; round < 25; round++) {
      const line = s.world.rng.int(0, 20);
      for (const c of s.clients) {
        const starts = lineStarts(c.handle.text(id));
        c.handle.insert(id, starts[Math.min(line, starts.length - 1)]!, ledger.next(c.name));
      }
      s.world.run(s.world.rng.int(0, 200));
      s.world.settle();
    }
    return verdict(s, ledger);
  },
};

const lateJoiner: Scenario = {
  id: "late-joiner",
  track: "floor",
  title: "",
  expect: "",
  run(seed, ctx) {
    const s = session(ctx, seed, { people: ["maya", "dev"] });
    const ledger = new TokenLedger();
    const id = s.doc(NOTES);
    for (let i = 0; i < 40; i++) {
      s.world.run(s.world.rng.int(5, 80));
      typeToken(s, s.world.rng.pick(s.clients), NOTES, ledger);
    }
    for (const name of ["sam", "lee", "kim"]) {
      const late = s.world.addClient({ name });
      late.handle.start();
      s.clients.push(late);
      s.world.run(s.world.rng.int(0, 100));
      late.handle.open(id);
      for (let i = 0; i < 10; i++) {
        s.world.run(s.world.rng.int(1, 30));
        typeToken(s, s.world.rng.pick(s.clients.slice(0, 2)), NOTES, ledger);
      }
    }
    return verdict(s, ledger);
  },
};

const relayRestart: Scenario = {
  id: "relay-restart",
  track: "floor",
  title: "",
  expect: "",
  run(seed, ctx) {
    const s = session(ctx, seed);
    const ledger = new TokenLedger();
    const restarts = new Set([60, 140, 220].map((n) => n + s.world.rng.int(-20, 20)));
    for (let i = 0; i < 260; i++) {
      s.world.run(s.world.rng.int(5, 50));
      typeToken(s, s.world.rng.pick(s.clients), NOTES, ledger);
      if (restarts.has(i)) s.world.restartServer(s.world.rng.int(200, 1500));
    }
    return verdict(s, ledger);
  },
};

const longOffline: Scenario = {
  id: "long-offline",
  track: "floor",
  title: "",
  expect: "",
  run(seed, ctx) {
    const s = session(ctx, seed);
    const ledger = new TokenLedger();
    const [maya, dev, priya] = s.clients as [SimClient, SimClient, SimClient];
    s.world.partition("priya", 30 * 60_000);
    for (let i = 0; i < 20; i++) typeToken(s, priya, NOTES, ledger);
    for (let i = 0; i < 900; i++) {
      s.world.run(s.world.rng.int(50, 100));
      typeToken(s, i % 2 ? maya : dev, NOTES, ledger);
    }
    s.world.run(30 * 60_000);
    return verdict(s, ledger);
  },
};

const twoTabs: Scenario = {
  id: "two-tabs",
  track: "floor",
  title: "",
  expect: "",
  run(seed, ctx) {
    const s = session(ctx, seed, { people: ["dev"] });
    const ledger = new TokenLedger();
    const id = s.doc(NOTES);
    const tab1 = s.world.addClient({ name: "mayatab", user: { id: "maya", name: "Maya" }, clientId: `maya-tab1-${seed}` });
    tab1.handle.start();
    s.world.settle();
    tab1.handle.open(id);
    s.world.settle();
    s.world.partition("mayatab", 20_000);
    for (let i = 0; i < 8; i++) typeToken(s, tab1, NOTES, ledger);
    const tab2 = s.world.addClient({ name: "mayatabtwo", user: { id: "maya", name: "Maya" }, sameBrowserAs: "mayatab" });
    tab2.handle.start();
    tab2.handle.open(id);
    tab1.handle.stop();
    const reloaded = s.world.addClient({
      name: "mayatab",
      user: { id: "maya", name: "Maya" },
      clientId: tab1.clientId,
      sameBrowserAs: "mayatabtwo",
    });
    reloaded.handle.start();
    reloaded.handle.open(id);
    s.clients.push(tab2, reloaded);
    s.world.run(25_000);
    for (let i = 0; i < 5; i++) typeToken(s, tab2, NOTES, ledger);
    return verdict(s, ledger);
  },
};

function renamePlan(texts: Map<string, string>): Plan {
  const edits: Plan["edits"] = [];
  for (const [path, text] of texts) {
    for (const line of text.split("\n")) {
      if (line.includes("getUser")) edits.push({ path, find: line, replace: line.replaceAll("getUser", "fetchUser") });
    }
  }
  return { summary: "Rename getUser to fetchUser", edits };
}

function adaRename(seed: number, ctx: Parameters<Scenario["run"]>[1]) {
  const paths = workspaceFiles().filter((f) => f.text.includes("getUser")).map((f) => f.path);
  const s = session(ctx, seed, {
    people: ["maya", "dev", { name: "ada", user: { name: "Ada (AI)", kind: "bot" } }],
    open: paths,
  });
  const ada = s.clients.find((c) => c.name === "ada")!;
  const humans = s.clients.filter((c) => c !== ada);
  const ledger = new TokenLedger();
  const snapshot = new Map(paths.map((p) => [p, ada.handle.text(s.doc(p))]));
  const thinkMs = s.world.rng.int(3000, 8000);
  const until = s.world.now + thinkMs;
  while (s.world.now < until) {
    s.world.run(s.world.rng.int(50, 250));
    typeToken(s, s.world.rng.pick(humans), s.world.rng.pick(paths), ledger, lineStarts);
  }
  const result = applyPlan(
    {
      docIdForPath: (p) => (s.docs.has(p) ? s.doc(p) : undefined),
      text: (d) => ada.handle.text(d),
      replace: (d, pos, len, text) => ada.handle.replace(d, pos, len, text),
    },
    renamePlan(snapshot),
    snapshot,
  );
  for (let i = 0; i < 20; i++) {
    s.world.run(s.world.rng.int(20, 120));
    typeToken(s, s.world.rng.pick(humans), s.world.rng.pick(paths), ledger, lineStarts);
  }
  return { s, ledger, paths, snapshot, result };
}

const adaClobber: Scenario = {
  id: "ada-clobber",
  track: "floor",
  title: "",
  expect: "",
  run(seed, ctx) {
    const { s, ledger } = adaRename(seed, ctx);
    return verdict(s, ledger);
  },
};

const adaStale: Scenario = {
  id: "ada-stale",
  track: "floor",
  title: "",
  expect: "",
  run(seed, ctx) {
    const { s, paths, snapshot } = adaRename(seed, ctx);
    const v = verdict(s);
    if (!v.pass) return v;
    for (const p of paths) {
      const got = s.world.server.docText(s.doc(p))!.replace(/<[a-z]+\d+>/g, "");
      const want = snapshot.get(p)!.replaceAll("getUser", "fetchUser");
      if (got !== want) {
        const line = got.split("\n").findIndex((l, i) => l !== want.split("\n")[i]);
        return { pass: false, detail: `${p} line ${line + 1} reads "${got.split("\n")[line]?.slice(0, 60)}"` };
      }
    }
    return { pass: true };
  },
};

const undoMine: Scenario = {
  id: "undo-mine",
  track: "floor",
  title: "",
  expect: "",
  run(seed, ctx) {
    const s = session(ctx, seed, { people: ["maya", "dev", { name: "ada", user: { name: "Ada (AI)", kind: "bot" } }] });
    const [maya, dev, ada] = s.clients as [SimClient, SimClient, SimClient];
    const id = s.doc(NOTES);
    const ledger = new TokenLedger();
    const mayaTokens: string[] = [];
    for (let round = 0; round < 6; round++) {
      const t = ledger.next("maya");
      mayaTokens.push(t);
      maya.handle.insert(id, s.world.rng.pick(safeSpots(maya.handle.text(id))), t);
      s.world.run(s.world.rng.int(800, 1500));
      for (const c of [ada, dev]) {
        c.handle.insert(id, s.world.rng.pick(safeSpots(c.handle.text(id))), ledger.next(c.name));
        s.world.run(s.world.rng.int(1, 300));
      }
      s.world.settle();
      maya.handle.undo(id);
      s.world.settle();
      const text = s.world.server.docText(id)!;
      if (text.includes(t)) return { pass: false, detail: `round ${round + 1}: Maya's undo did not remove her own edit ${t}` };
      const others = [...ledger.typed].filter((x) => !mayaTokens.includes(x));
      const missing = others.filter((x) => !text.includes(x));
      if (missing.length) return { pass: false, detail: `round ${round + 1}: Maya's undo removed someone else's edit ${missing[0]}` };
    }
    const v = verdict(s);
    return v;
  },
};

export const floorScenarios: Scenario[] = [
  join,
  invites,
  idle,
  emoji,
  flakyWifi,
  sameSpot,
  lateJoiner,
  relayRestart,
  longOffline,
  twoTabs,
  adaClobber,
  adaStale,
  undoMine,
];
