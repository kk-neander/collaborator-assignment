import { HEARTBEAT_MS, PROTOCOL_VERSION, type ClientMessage, type OpEntry, type ServerMessage, type TreeChange, type User } from "@split-brain/protocol";
import { apply, baseLength, compose, fromEdit, invert, transform, transformPosition, type TextOp } from "./text-operation.ts";
import { FileTree } from "./tree.ts";
import { textHash, type LocalStore } from "./store.ts";

export interface Link {
  send(msg: ClientMessage): void;
  close(): void;
}

export interface LinkHandlers {
  onOpen(): void;
  onMessage(msg: ServerMessage): void;
  onClose(reason: string): void;
}

export type Connect = (handlers: LinkHandlers) => Link;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ClientEnv {
  connect: Connect;
  timers: Timers;
  now(): number;
  random(): number;
  clientId: string;
  local?: LocalStore;
  heartbeatMs?: number;
  log?(event: string, data?: Record<string, unknown>): void;
}

export type ChangeOrigin = "local" | "remote" | "undo" | "redo" | "snapshot";

export interface RemoteCursor {
  clientId: string;
  user: User;
  anchor: number;
  head: number;
}

export interface ClientEvents {
  change(docId: string, op: TextOp, origin: ChangeOrigin): void;
  tree(nodes: ReturnType<FileTree["list"]>): void;
  presence(docId: string, cursors: RemoteCursor[]): void;
  status(status: ClientStatus): void;
  notice(kind: string, message: string, data?: Record<string, unknown>): void;
}

export type ClientStatus = "offline" | "connecting" | "online";

interface Outstanding {
  seq: number;
  op: TextOp;
  ts: number;
}

export function localFirst(localTs: number, remoteTs: number): boolean {
  return localTs < remoteTs;
}

interface ClientDoc {
  id: string;
  ready: boolean;
  deleted: boolean;
  catchingUp: boolean;
  text: string;
  serverText: string;
  revision: number;
  outstanding?: Outstanding;
  buffer?: TextOp;
  nextSeq: number;
  undo: TextOp[];
  redo: TextOp[];
  lastLocalAt: number;
  cursors: Map<string, RemoteCursor>;
}

interface PendingTreeChange {
  seq: number;
  change: TreeChange;
}

const UNDO_GROUP_MS = 700;

export class ClientCore {
  readonly clientId: string;
  user?: User;
  private status: ClientStatus = "offline";
  private wantOnline = false;
  private link?: Link;
  private linkGen = 0;
  private attempts = 0;
  private reconnectTimer?: unknown;
  private heartbeatTimer?: unknown;
  private lastHeard = 0;
  private readonly docs = new Map<string, ClientDoc>();
  private tree = new FileTree();
  private treeRevision = 0;
  private treeSeq = 0;
  private readonly pendingTree: PendingTreeChange[] = [];
  private readonly listeners: { [K in keyof ClientEvents]: Set<ClientEvents[K]> } = {
    change: new Set(),
    tree: new Set(),
    presence: new Set(),
    status: new Set(),
    notice: new Set(),
  };
  readonly stats = { droppedEdits: 0, droppedChars: 0, resyncs: 0, anomalies: 0 };

  private readonly env: ClientEnv;

  constructor(env: ClientEnv) {
    this.env = env;
    this.clientId = env.clientId;
    this.restorePending();
  }

  on<K extends keyof ClientEvents>(event: K, fn: ClientEvents[K]): () => void {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  private emit<K extends keyof ClientEvents>(event: K, ...args: Parameters<ClientEvents[K]>): void {
    for (const fn of this.listeners[event]) (fn as (...a: Parameters<ClientEvents[K]>) => void)(...args);
  }

  start(): void {
    this.wantOnline = true;
    this.openLink();
  }

  stop(): void {
    this.wantOnline = false;
    this.closeLink("stopped");
    this.setStatus("offline");
  }

  getStatus(): ClientStatus {
    return this.status;
  }

  private setStatus(status: ClientStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit("status", status);
  }

  private openLink(): void {
    if (!this.wantOnline || this.link) return;
    const gen = ++this.linkGen;
    this.setStatus("connecting");
    this.link = this.env.connect({
      onOpen: () => {
        if (gen !== this.linkGen) return;
        this.lastHeard = this.env.now();
        this.send({ t: "hello", clientId: this.clientId, protocol: PROTOCOL_VERSION });
        this.scheduleHeartbeat();
      },
      onMessage: (msg) => {
        if (gen !== this.linkGen) return;
        this.lastHeard = this.env.now();
        this.handle(msg);
      },
      onClose: (reason) => {
        if (gen !== this.linkGen) return;
        this.link = undefined;
        this.afterClose(reason);
      },
    });
  }

  private closeLink(reason: string): void {
    const link = this.link;
    if (!link) return;
    this.link = undefined;
    this.linkGen++;
    link.close();
    this.afterClose(reason);
  }

  private afterClose(reason: string): void {
    if (this.heartbeatTimer !== undefined) this.env.timers.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.setStatus(this.wantOnline ? "connecting" : "offline");
    this.env.log?.("link_closed", { clientId: this.clientId, reason });
    for (const doc of this.docs.values()) doc.cursors.clear();
    if (!this.wantOnline) return;
    const delay = Math.min(10_000, 250 * 2 ** this.attempts) * (0.5 + this.env.random());
    this.attempts += 1;
    if (this.reconnectTimer !== undefined) this.env.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = this.env.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openLink();
    }, delay);
  }

  private scheduleHeartbeat(): void {
    const every = this.env.heartbeatMs ?? HEARTBEAT_MS;
    this.heartbeatTimer = this.env.timers.setTimeout(() => {
      this.heartbeatTimer = undefined;
      if (!this.link) return;
      if (this.env.now() - this.lastHeard > every * 2 + 5_000) {
        this.closeLink("heartbeat timeout");
        return;
      }
      this.send({ t: "ping", ts: this.env.now() });
      this.scheduleHeartbeat();
    }, every);
  }

  private send(msg: ClientMessage): void {
    this.link?.send(msg);
  }

  private get online(): boolean {
    return this.status === "online" && this.link !== undefined;
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        return this.onWelcome(msg);
      case "snapshot":
        return this.onSnapshot(msg);
      case "ops":
        return this.onOps(msg.docId, msg.entries);
      case "ack":
        return this.onAck(msg.docId, msg.seq, msg.revision);
      case "presence":
        return this.onPresence(msg);
      case "left":
        for (const doc of this.docs.values()) {
          if (doc.cursors.delete(msg.clientId)) this.emit("presence", doc.id, [...doc.cursors.values()]);
        }
        return;
      case "tree":
        this.tree.apply(msg.change);
        this.treeRevision = msg.revision;
        this.afterTreeChange();
        return;
      case "treeAck":
        return this.onTreeAck(msg.seq, msg.revision);
      case "treeReject": {
        const i = this.pendingTree.findIndex((p) => p.seq === msg.seq);
        if (i >= 0) this.pendingTree.splice(i, 1);
        this.emit("notice", "tree_rejected", msg.reason, { seq: msg.seq });
        return;
      }
      case "docDeleted": {
        const doc = this.docs.get(msg.docId);
        if (doc) doc.deleted = true;
        this.emit("notice", "doc_deleted", "This file was deleted by someone else.", { docId: msg.docId });
        return;
      }
      case "error":
        this.emit("notice", msg.code, msg.message);
        this.env.log?.("server_error", { code: msg.code, message: msg.message });
        if (msg.code === "op_rejected") this.stats.anomalies++;
        return;
      case "pong":
        return;
    }
  }

  private onWelcome(msg: Extract<ServerMessage, { t: "welcome" }>): void {
    this.user = msg.user;
    this.attempts = 0;
    this.tree = new FileTree(msg.tree);
    this.treeRevision = msg.treeRevision;
    this.setStatus("online");
    this.afterTreeChange();
    for (const p of this.pendingTree) this.send({ t: "tree", seq: p.seq, change: p.change });
    for (const doc of this.docs.values()) {
      if (doc.deleted) continue;
      doc.catchingUp = true;
      this.send({ t: "open", docId: doc.id, knownRevision: doc.ready ? doc.revision : undefined });
    }
  }

  private onSnapshot(msg: Extract<ServerMessage, { t: "snapshot" }>): void {
    const doc = this.docs.get(msg.docId);
    if (!doc) return;
    const hadText = doc.ready;
    if (doc.outstanding || doc.buffer) {
      const lost = (doc.outstanding ? insertedChars(doc.outstanding.op) : 0) + (doc.buffer ? insertedChars(doc.buffer) : 0);
      this.stats.droppedEdits += 1;
      this.stats.droppedChars += lost;
      this.emit("notice", "edits_dropped", `${lost} unsynced characters could not be merged and were dropped.`, { docId: doc.id });
      doc.outstanding = undefined;
      doc.buffer = undefined;
    }
    if (hadText) this.stats.resyncs += 1;
    const old = doc.text;
    doc.text = msg.text;
    doc.serverText = msg.text;
    doc.revision = msg.revision;
    doc.ready = true;
    doc.catchingUp = false;
    doc.undo = [];
    doc.redo = [];
    this.persistPending(doc);
    const op: TextOp = old.length > 0 ? [-old.length, ...(msg.text ? [msg.text] : [])] : msg.text ? [msg.text] : [];
    this.emit("change", doc.id, op, "snapshot");
  }

  private onOps(docId: string, entries: OpEntry[]): void {
    const doc = this.docs.get(docId);
    if (!doc || !doc.ready) return;
    for (const entry of entries) {
      if (entry.revision <= doc.revision) continue;
      if (entry.revision !== doc.revision + 1) {
        this.stats.anomalies++;
        this.env.log?.("revision_gap", { docId, have: doc.revision, got: entry.revision });
        this.send({ t: "open", docId, knownRevision: doc.revision });
        return;
      }
      if (entry.clientId === this.clientId) {
        doc.serverText = apply(doc.serverText, entry.op);
        doc.revision = entry.revision;
        continue;
      }
      this.applyRemote(doc, entry);
    }
    if (doc.catchingUp) {
      doc.catchingUp = false;
      if (doc.outstanding) this.sendOutstanding(doc);
    }
    this.persistPending(doc);
  }

  private applyRemote(doc: ClientDoc, entry: OpEntry): void {
    let op = entry.op;
    doc.serverText = apply(doc.serverText, op);
    if (doc.outstanding) {
      const [o, r] = transform(doc.outstanding.op, op, localFirst(doc.outstanding.ts, entry.ts ?? 0));
      doc.outstanding = { seq: doc.outstanding.seq, op: o, ts: doc.outstanding.ts };
      op = r;
    }
    if (doc.buffer) {
      const [b, r] = transform(doc.buffer, op, localFirst(this.env.now(), entry.ts ?? 0));
      doc.buffer = b;
      op = r;
    }
    doc.revision = entry.revision;
    doc.text = apply(doc.text, op);
    doc.undo = transformStack(doc.undo, op);
    doc.redo = transformStack(doc.redo, op);
    for (const c of doc.cursors.values()) {
      c.anchor = transformPosition(c.anchor, op);
      c.head = transformPosition(c.head, op);
    }
    this.emit("change", doc.id, op, "remote");
  }

  private onAck(docId: string, seq: number, revision: number): void {
    const doc = this.docs.get(docId);
    if (!doc || !doc.outstanding || doc.outstanding.seq !== seq) return;
    if (revision !== doc.revision + 1) {
      this.stats.anomalies++;
      this.send({ t: "open", docId, knownRevision: doc.revision });
      return;
    }
    this.confirmOutstanding(doc, revision, doc.outstanding.op);
    this.persistPending(doc);
  }

  private confirmOutstanding(doc: ClientDoc, revision: number, op: TextOp): void {
    doc.serverText = apply(doc.serverText, op);
    doc.revision = revision;
    doc.outstanding = undefined;
    if (doc.buffer) {
      doc.outstanding = { seq: doc.nextSeq++, op: doc.buffer, ts: this.env.now() };
      doc.buffer = undefined;
      if (this.online && !doc.catchingUp) this.sendOutstanding(doc);
    }
  }

  private sendOutstanding(doc: ClientDoc): void {
    const o = doc.outstanding!;
    const msg = { t: "op", documentId: doc.id, baseRevision: doc.revision, seq: o.seq, op: o.op, ts: o.ts };
    this.send(msg as unknown as ClientMessage);
  }

  private onPresence(msg: Extract<ServerMessage, { t: "presence" }>): void {
    const doc = this.docs.get(msg.docId);
    if (!doc) return;
    const max = doc.text.length;
    doc.cursors.set(msg.clientId, {
      clientId: msg.clientId,
      user: msg.user,
      anchor: Math.min(msg.anchor, max),
      head: Math.min(msg.head, max),
    });
    this.emit("presence", doc.id, [...doc.cursors.values()]);
  }

  private onTreeAck(seq: number, revision: number): void {
    const i = this.pendingTree.findIndex((p) => p.seq === seq);
    if (i < 0) return;
    const [p] = this.pendingTree.splice(i, 1);
    if (revision > this.treeRevision) {
      this.tree.apply(p!.change);
      this.treeRevision = revision;
    }
    this.afterTreeChange();
  }

  private afterTreeChange(): void {
    for (const doc of this.docs.values()) {
      if (!this.tree.isLive(doc.id)) doc.deleted = true;
    }
    this.emit("tree", this.tree.list());
  }

  open(docId: string): void {
    if (this.docs.has(docId)) return;
    const doc: ClientDoc = {
      id: docId,
      ready: false,
      deleted: false,
      catchingUp: false,
      text: "",
      serverText: "",
      revision: 0,
      nextSeq: 1,
      undo: [],
      redo: [],
      lastLocalAt: 0,
      cursors: new Map(),
    };
    this.docs.set(docId, doc);
    if (this.online) {
      doc.catchingUp = true;
      this.send({ t: "open", docId });
    }
  }

  close(docId: string): void {
    if (!this.docs.delete(docId)) return;
    if (this.online) this.send({ t: "close", docId });
  }

  isReady(docId: string): boolean {
    return this.docs.get(docId)?.ready ?? false;
  }

  text(docId: string): string {
    const doc = this.docs.get(docId);
    if (!doc) throw new Error(`document ${docId} is not open`);
    return doc.text;
  }

  revision(docId: string): number {
    return this.docs.get(docId)?.revision ?? 0;
  }

  cursors(docId: string): RemoteCursor[] {
    return [...(this.docs.get(docId)?.cursors.values() ?? [])];
  }

  applyLocal(docId: string, op: TextOp, origin: ChangeOrigin = "local"): void {
    const doc = this.readyDoc(docId);
    if (baseLength(op) !== doc.text.length) {
      throw new Error(`edit expects length ${baseLength(op)} but ${docId} has ${doc.text.length}`);
    }
    const inverse = invert(doc.text, op);
    doc.text = apply(doc.text, op);
    const now = this.env.now();
    if (origin === "local") {
      doc.redo = [];
      const top = doc.undo[doc.undo.length - 1];
      if (top && now - doc.lastLocalAt < UNDO_GROUP_MS) doc.undo[doc.undo.length - 1] = compose(inverse, top);
      else doc.undo.push(inverse);
      doc.lastLocalAt = now;
    } else if (origin === "undo") {
      doc.redo.push(inverse);
    } else if (origin === "redo") {
      doc.undo.push(inverse);
    }
    for (const c of doc.cursors.values()) {
      c.anchor = transformPosition(c.anchor, op);
      c.head = transformPosition(c.head, op);
    }
    if (doc.outstanding) {
      doc.buffer = doc.buffer ? compose(doc.buffer, op) : op;
    } else {
      doc.outstanding = { seq: doc.nextSeq++, op, ts: this.env.now() };
      if (this.online && !doc.catchingUp) this.sendOutstanding(doc);
    }
    this.persistPending(doc);
    this.emit("change", docId, op, origin);
  }

  insert(docId: string, pos: number, text: string): void {
    this.applyLocal(docId, fromEdit(this.readyDoc(docId).text.length, pos, 0, text));
  }

  delete(docId: string, pos: number, length: number): void {
    this.applyLocal(docId, fromEdit(this.readyDoc(docId).text.length, pos, length, ""));
  }

  replace(docId: string, pos: number, length: number, text: string): void {
    this.applyLocal(docId, fromEdit(this.readyDoc(docId).text.length, pos, length, text));
  }

  undo(docId: string): boolean {
    this.readyDoc(docId);
    if (this.online) this.send({ t: "undo", docId });
    return true;
  }

  redo(docId: string): boolean {
    const doc = this.readyDoc(docId);
    const op = doc.redo.pop();
    if (!op) return false;
    this.applyLocal(docId, op, "redo");
    return true;
  }

  setCursor(docId: string, anchor: number, head: number): void {
    if (this.online && this.docs.get(docId)?.ready) this.send({ t: "presence", docId, anchor, head });
  }

  reportHashes(): void {
    if (!this.online) return;
    for (const doc of this.docs.values()) {
      if (!doc.ready || doc.outstanding || doc.buffer) continue;
      this.send({ t: "hash", docId: doc.id, revision: doc.revision, hash: textHash(doc.text) });
    }
  }

  private readyDoc(docId: string): ClientDoc {
    const doc = this.docs.get(docId);
    if (!doc || !doc.ready) throw new Error(`document ${docId} is not ready`);
    return doc;
  }

  treeNodes() {
    return this.tree.list();
  }

  fileTree(): FileTree {
    return this.tree;
  }

  changeTree(change: TreeChange): number {
    const seq = ++this.treeSeq;
    this.pendingTree.push({ seq, change });
    if (this.online) this.send({ t: "tree", seq, change });
    return seq;
  }

  pendingCount(): number {
    let n = this.pendingTree.length;
    for (const doc of this.docs.values()) {
      if (doc.outstanding) n += 1;
      if (doc.buffer) n += 1;
    }
    return n;
  }

  isSynced(): boolean {
    if (!this.online || this.pendingTree.length > 0) return false;
    for (const doc of this.docs.values()) {
      if (doc.deleted) continue;
      if (!doc.ready || doc.catchingUp || doc.outstanding || doc.buffer) return false;
    }
    return true;
  }

  private pendingKey(docId: string): string {
    return `sb:pending:${docId}`;
  }

  private persistPending(doc: ClientDoc): void {
    const local = this.env.local;
    if (!local) return;
    const key = this.pendingKey(doc.id);
    if (!doc.outstanding && !doc.buffer) {
      local.removeItem(key);
      return;
    }
    local.setItem(
      key,
      JSON.stringify({
        revision: doc.revision,
        serverText: doc.serverText,
        outstanding: doc.outstanding,
        buffer: doc.buffer,
        nextSeq: doc.nextSeq,
      }),
    );
  }

  private restorePending(): void {
    const local = this.env.local;
    if (!local) return;
    const prefix = "sb:pending:";
    for (const key of local.keys()) {
      if (!key.startsWith(prefix)) continue;
      const raw = local.getItem(key);
      if (!raw) continue;
      const saved = JSON.parse(raw) as {
        revision: number;
        serverText: string;
        outstanding?: Outstanding;
        buffer?: TextOp;
        nextSeq: number;
      };
      const docId = key.slice(prefix.length);
      let text = saved.serverText;
      if (saved.outstanding) text = apply(text, saved.outstanding.op);
      if (saved.buffer) text = apply(text, saved.buffer);
      this.docs.set(docId, {
        id: docId,
        ready: true,
        deleted: false,
        catchingUp: false,
        text,
        serverText: saved.serverText,
        revision: saved.revision,
        outstanding: saved.outstanding,
        buffer: saved.buffer,
        nextSeq: saved.nextSeq,
        undo: [],
        redo: [],
        lastLocalAt: 0,
        cursors: new Map(),
      });
    }
  }
}

function transformStack(stack: TextOp[], op: TextOp): TextOp[] {
  const out: TextOp[] = new Array(stack.length);
  let r = op;
  for (let i = stack.length - 1; i >= 0; i--) {
    const [u, r2] = transform(stack[i]!, r);
    out[i] = u;
    r = r2;
  }
  return out;
}

function insertedChars(op: TextOp): number {
  let n = 0;
  for (const c of op) if (typeof c === "string") n += c.length;
  return n;
}
