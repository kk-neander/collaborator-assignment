import {
  parseClientMessage,
  type ClientMessage,
  type OpEntry,
  type ServerMessage,
  type TreeChange,
  type User,
} from "@split-brain/protocol";
import { apply, invert, isNoop, transform, type TextOp } from "./text-operation.ts";
import { textHash, type DurableStore } from "./store.ts";
import { Authorship } from "./authorship.ts";
import { FileTree, TreeError, treeFromPaths } from "./tree.ts";

export interface SeedFile {
  path: string;
  text: string;
}

export interface ServerEnv {
  store: DurableStore;
  now(): number;
  seed?: SeedFile[];
  log?(event: string, data?: Record<string, unknown>): void;
  timers?: { setTimeout(fn: () => void, ms: number): unknown };
}

export interface Connection {
  user: User;
  send(msg: ServerMessage): void;
}

interface DocState {
  id: string;
  text: string;
  revision: number;
  log: OpEntry[];
  subscribers: Set<string>;
  lastSeq: Map<string, { seq: number; revision: number }>;
  reports: Map<string, { revision: number; hash: string; at: number; user: User }>;
  authors: Authorship;
  cache?: { revision: number; text: string };
}

interface ConnState {
  conn: Connection;
  clientId?: string;
  docs: Set<string>;
}

export interface InspectReport {
  docs: Array<{
    docId: string;
    path: string;
    revision: number;
    hash: string;
    length: number;
    clients: Array<{ clientId: string; user: User; revision: number; hash: string; status: "match" | "diverged" | "behind" }>;
  }>;
  clients: Array<{ clientId: string; user: User; connected: boolean }>;
}

const pad = (n: number) => n.toString().padStart(4, "0");

export function incomingFirst(incomingTs: number, existingTs: number): boolean {
  return incomingTs <= existingTs;
}

export class ServerCore {
  private readonly docs = new Map<string, DocState>();
  private readonly conns = new Map<string, ConnState>();
  private readonly clientConn = new Map<string, string>();
  private tree: FileTree;
  private treeRevision = 0;
  private readonly treeLastSeq = new Map<string, { seq: number; revision: number }>();

  private readonly env: ServerEnv;

  constructor(env: ServerEnv) {
    this.env = env;
    this.tree = new FileTree();
    this.load();
  }

  private load(): void {
    const treeRaw = this.env.store.get("tree");
    if (treeRaw === undefined) {
      this.seed(this.env.seed ?? []);
      return;
    }
    const saved = JSON.parse(treeRaw) as {
      revision: number;
      nodes: ReturnType<FileTree["list"]>;
      lastSeq: Record<string, { seq: number; revision: number }>;
    };
    this.tree = new FileTree(saved.nodes);
    this.treeRevision = saved.revision;
    for (const [k, v] of Object.entries(saved.lastSeq)) this.treeLastSeq.set(k, v);
    for (const node of this.tree.list()) {
      if (node.kind === "file") this.loadDoc(node.id);
    }
  }

  private loadDoc(docId: string): void {
    const base = this.env.store.get(`base/${docId}`) ?? "";
    const log = this.env.store.list(`op/${docId}/`).map(([, v]) => JSON.parse(v) as OpEntry);
    const authors = new Authorship(base.length);
    let text = base;
    for (const e of log) {
      text = apply(text, e.op);
      authors.apply(e.op, e.author.id);
    }
    const doc = this.newDoc(docId, text, log.length);
    doc.log = log;
    doc.authors = authors;
    for (const e of log) doc.lastSeq.set(e.clientId, { seq: e.seq, revision: e.revision });
    this.docs.set(docId, doc);
  }

  private seed(files: SeedFile[]): void {
    const { nodes, fileIds } = treeFromPaths(files.map((f) => f.path));
    this.tree = new FileTree(nodes);
    for (const f of files) {
      const id = fileIds.get(f.path)!;
      this.docs.set(id, this.newDoc(id, f.text, 0));
      this.env.store.set(`base/${id}`, f.text);
    }
    this.saveTree();
  }

  private newDoc(id: string, text: string, revision: number): DocState {
    return { id, text, revision, log: [], subscribers: new Set(), lastSeq: new Map(), reports: new Map(), authors: new Authorship(text.length) };
  }

  private saveTree(): void {
    this.env.store.set(
      "tree",
      JSON.stringify({ revision: this.treeRevision, nodes: this.tree.list(), lastSeq: Object.fromEntries(this.treeLastSeq) }),
    );
  }

  private unflushed: Array<[string, string]> = [];
  private flushTimer?: unknown;

  private persistEntry(doc: DocState, entry: OpEntry): void {
    this.unflushed.push([`op/${doc.id}/${pad(entry.revision)}`, JSON.stringify(entry)]);
    if (this.flushTimer === undefined && this.env.timers) {
      this.flushTimer = this.env.timers.setTimeout(() => this.flush(), 2000);
    }
  }

  private flush(): void {
    this.flushTimer = undefined;
    for (const [key, value] of this.unflushed.splice(0)) this.env.store.set(key, value);
  }

  connect(connId: string, conn: Connection): void {
    this.conns.set(connId, { conn, docs: new Set() });
  }

  disconnect(connId: string): void {
    const state = this.conns.get(connId);
    if (!state) return;
    for (const docId of state.docs) this.docs.get(docId)?.subscribers.delete(connId);
    this.conns.delete(connId);
    if (state.clientId && this.clientConn.get(state.clientId) === connId) {
      this.clientConn.delete(state.clientId);
      this.broadcastAll({ t: "left", clientId: state.clientId }, connId);
    }
  }

  receive(connId: string, raw: unknown): void {
    const state = this.conns.get(connId);
    if (!state) return;
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.env.log?.("bad_message", { connId, error: parsed.error });
      return;
    }
    const msg = parsed.msg;
    if (msg.t !== "hello" && msg.t !== "ping" && !state.clientId) {
      state.conn.send({ t: "error", code: "not_ready", message: "send hello first" });
      return;
    }
    switch (msg.t) {
      case "hello":
        return this.onHello(connId, state, msg);
      case "open":
        return this.onOpen(connId, state, msg);
      case "close":
        state.docs.delete(msg.docId);
        this.docs.get(msg.docId)?.subscribers.delete(connId);
        return;
      case "undo":
        return this.onUndo(msg.docId);
      case "op":
        return this.onOp(connId, state, msg);
      case "presence":
        return this.onPresence(connId, state, msg);
      case "tree":
        return this.onTree(state, msg);
      case "hash": {
        const doc = this.docs.get(msg.docId);
        doc?.reports.set(state.clientId!, { revision: msg.revision, hash: msg.hash, at: this.env.now(), user: state.conn.user });
        return;
      }
      case "ping":
        state.conn.send({ t: "pong", ts: msg.ts, serverTime: this.env.now() });
        return;
    }
  }

  private onHello(connId: string, state: ConnState, msg: Extract<ClientMessage, { t: "hello" }>): void {
    state.clientId = msg.clientId;
    const previous = this.clientConn.get(msg.clientId);
    if (previous && previous !== connId) this.disconnect(previous);
    this.clientConn.set(msg.clientId, connId);
    state.conn.send({
      t: "welcome",
      serverTime: this.env.now(),
      user: state.conn.user,
      treeRevision: this.treeRevision,
      tree: this.tree.list(),
    });
  }

  private onOpen(connId: string, state: ConnState, msg: Extract<ClientMessage, { t: "open" }>): void {
    const doc = this.docs.get(msg.docId);
    if (!doc || !this.tree.isLive(msg.docId)) {
      state.conn.send({ t: "docDeleted", docId: msg.docId });
      return;
    }
    state.docs.add(doc.id);
    doc.subscribers.add(connId);
    if (msg.knownRevision !== undefined && msg.knownRevision <= doc.revision) {
      state.conn.send({ t: "ops", docId: doc.id, entries: this.entriesSince(doc, msg.knownRevision).slice(0, 25000), caughtUp: true });
    } else {
      state.conn.send({ t: "snapshot", docId: doc.id, ...this.snapshotOf(doc) });
    }
  }

  private onOp(connId: string, state: ConnState, msg: Extract<ClientMessage, { t: "op" }>): void {
    const clientId = state.clientId!;
    const doc = this.docs.get(msg.docId);
    if (!doc) {
      state.conn.send({ t: "docDeleted", docId: msg.docId });
      return;
    }
    if (this.alreadyApplied(doc, clientId, msg.seq, state)) return;
    if (msg.baseRevision > doc.revision) {
      state.conn.send({ t: "error", code: "bad_revision", message: `base ${msg.baseRevision} is ahead of ${doc.revision}` });
      return;
    }
    let op: TextOp = msg.op;
    for (const entry of this.entriesSince(doc, msg.baseRevision)) {
      op = transform(op, entry.op, incomingFirst(msg.ts, entry.ts ?? 0))[0];
    }
    const inverse = invert(doc.text, op);
    this.applyToDoc(doc, op, state.conn.user);
    doc.revision += 1;
    const entry: OpEntry = { revision: doc.revision, op, inverse, clientId, seq: msg.seq, author: state.conn.user, ts: msg.ts };
    doc.log.push(entry);
    doc.lastSeq.set(clientId, { seq: msg.seq, revision: doc.revision });
    this.persistEntry(doc, entry);

    const authorConn = this.clientConn.get(clientId) ?? connId;
    this.conns.get(authorConn)?.conn.send({ t: "ack", docId: doc.id, seq: msg.seq, revision: doc.revision });
    for (const sub of doc.subscribers) {
      const s = this.conns.get(sub);
      if (!s || s.clientId === clientId) continue;
      s.conn.send({ t: "ops", docId: doc.id, entries: [entry], caughtUp: true });
    }
    if (isNoop(op)) this.env.log?.("noop_op", { docId: doc.id, clientId });
  }

  private onUndo(docId: string): void {
    const doc = this.docs.get(docId);
    const last = doc?.log[doc.log.length - 1];
    if (!doc || !last?.inverse) return;
    const op = last.inverse;
    const inverse = invert(doc.text, op);
    this.applyToDoc(doc, op, last.author);
    doc.revision += 1;
    const entry: OpEntry = { revision: doc.revision, op, inverse, clientId: "relay-undo", seq: doc.revision, author: last.author };
    doc.log.push(entry);
    this.persistEntry(doc, entry);
    for (const sub of doc.subscribers) this.conns.get(sub)?.conn.send({ t: "ops", docId: doc.id, entries: [entry], caughtUp: true });
  }

  private alreadyApplied(doc: DocState, clientId: string, seq: number, state: ConnState): boolean {
    return false;
  }

  private entriesSince(doc: DocState, revision: number): OpEntry[] {
    if (doc.log.length > 500) doc.log.splice(0, doc.log.length - 500);
    return doc.log.filter((e) => e.revision > revision);
  }

  private snapshotOf(doc: DocState): { revision: number; text: string } {
    if (!doc.cache || doc.revision - doc.cache.revision >= 25) doc.cache = { revision: doc.revision, text: doc.text };
    return { revision: doc.revision, text: doc.cache.text };
  }

  private applyToDoc(doc: DocState, op: TextOp, user: User): void {
    const chars = [...doc.text];
    const out: string[] = [];
    let pos = 0;
    for (const c of op) {
      if (typeof c === "string") out.push(c);
      else if (c > 0) {
        out.push(chars.slice(pos, pos + c).join(""));
        pos += c;
      } else pos -= c;
    }
    out.push(chars.slice(pos).join(""));
    doc.text = out.join("");
    doc.authors.apply(op, user.id);
  }

  private onPresence(connId: string, state: ConnState, msg: Extract<ClientMessage, { t: "presence" }>): void {
    const doc = this.docs.get(msg.docId);
    if (!doc) return;
    for (const sub of doc.subscribers) {
      if (sub === connId) continue;
      this.conns.get(sub)?.conn.send({
        t: "presence",
        docId: doc.id,
        clientId: state.clientId!,
        user: state.conn.user,
        anchor: msg.anchor,
        head: msg.head,
      });
    }
  }

  private onTree(state: ConnState, msg: Extract<ClientMessage, { t: "tree" }>): void {
    const clientId = state.clientId!;
    const last = this.treeLastSeq.get(clientId);
    if (last && msg.seq <= last.seq) {
      if (msg.seq === last.seq) state.conn.send({ t: "treeAck", seq: msg.seq, revision: last.revision });
      return;
    }
    const change: TreeChange = msg.change;
    try {
      this.tree.validate(change);
    } catch (err) {
      if (!(err instanceof TreeError)) throw err;
      this.treeLastSeq.set(clientId, { seq: msg.seq, revision: this.treeRevision });
      state.conn.send({ t: "treeReject", seq: msg.seq, reason: err.message });
      return;
    }
    this.tree.apply(change);
    this.treeRevision += 1;
    this.treeLastSeq.set(clientId, { seq: msg.seq, revision: this.treeRevision });
    if (change.type === "create" && change.kind === "file") {
      const text = change.text ?? "";
      this.docs.set(change.id, this.newDoc(change.id, text, 0));
      this.env.store.set(`base/${change.id}`, text);
    }
    this.saveTree();
    state.conn.send({ t: "treeAck", seq: msg.seq, revision: this.treeRevision });
    this.broadcastAll(
      { t: "tree", revision: this.treeRevision, change, clientId, seq: msg.seq, author: state.conn.user },
      this.clientConn.get(clientId),
    );
  }

  private broadcastAll(msg: ServerMessage, exceptConnId?: string): void {
    for (const [id, s] of this.conns) {
      if (id === exceptConnId || !s.clientId) continue;
      s.conn.send(msg);
    }
  }

  docText(docId: string): string | undefined {
    return this.docs.get(docId)?.text;
  }

  snapshotAll(): Array<{ path: string; text: string }> {
    const out: Array<{ path: string; text: string }> = [];
    for (const doc of this.docs.values()) {
      if (this.tree.isLive(doc.id)) out.push({ path: this.tree.path(doc.id), text: doc.text });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  authorship(docId: string): Array<{ start: number; end: number; authorId: string }> | undefined {
    return this.docs.get(docId)?.authors.spans();
  }

  docRevision(docId: string): number | undefined {
    return this.docs.get(docId)?.revision;
  }

  treeNodes() {
    return this.tree.list();
  }

  pathOf(docId: string): string {
    return this.tree.path(docId);
  }

  inspect(): InspectReport {
    const docs: InspectReport["docs"] = [];
    for (const doc of this.docs.values()) {
      if (!this.tree.isLive(doc.id)) continue;
      const hash = textHash(doc.text);
      docs.push({
        docId: doc.id,
        path: this.tree.path(doc.id),
        revision: doc.revision,
        hash,
        length: doc.text.length,
        clients: [...doc.reports.entries()].map(([clientId, r]) => ({
          clientId,
          user: r.user,
          revision: r.revision,
          hash: r.hash,
          status: r.revision !== doc.revision ? "behind" : r.hash === hash ? "match" : "diverged",
        })),
      });
    }
    const clients = [...this.conns.values()]
      .filter((s) => s.clientId)
      .map((s) => ({ clientId: s.clientId!, user: s.conn.user, connected: true }));
    return { docs, clients };
  }
}

