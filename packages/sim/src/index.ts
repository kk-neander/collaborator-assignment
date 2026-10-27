import { IDLE_TIMEOUT_MS } from "@split-brain/protocol";
import type {
  ClientHandle,
  DurableStore,
  Implementation,
  Json,
  LinkHandlers,
  LocalStore,
  SeedFile,
  ServerHandle,
  Timers,
  User,
} from "@split-brain/contract";

export class Random {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  fork(): Random {
    return new Random(Math.floor(this.next() * 4294967296));
  }
}

interface Task {
  at: number;
  order: number;
  fn: () => void;
  cancelled: boolean;
}

export class Scheduler implements Timers {
  now = 0;
  private order = 0;
  private heap: Task[] = [];
  readonly errors: Array<{ at: number; error: unknown }> = [];

  at(time: number, fn: () => void): Task {
    const task: Task = { at: Math.max(time, this.now), order: this.order++, fn, cancelled: false };
    this.push(task);
    return task;
  }

  after(ms: number, fn: () => void): Task {
    return this.at(this.now + Math.max(0, ms), fn);
  }

  setTimeout(fn: () => void, ms: number): unknown {
    return this.after(ms, fn);
  }

  clearTimeout(handle: unknown): void {
    if (handle && typeof handle === "object" && "cancelled" in handle) (handle as Task).cancelled = true;
  }

  runUntil(until: number): void {
    while (this.heap.length > 0 && this.heap[0]!.at <= until) this.step();
    this.now = Math.max(this.now, until);
  }

  runWhile(notDone: () => boolean, limit: number): boolean {
    const deadline = this.now + limit;
    while (notDone()) {
      if (this.heap.length === 0 || this.heap[0]!.at > deadline) {
        this.now = deadline;
        return !notDone();
      }
      this.step();
    }
    return true;
  }

  pending(): number {
    return this.heap.filter((t) => !t.cancelled).length;
  }

  private step(): void {
    const task = this.pop()!;
    if (task.cancelled) return;
    this.now = task.at;
    try {
      task.fn();
    } catch (error) {
      this.errors.push({ at: this.now, error });
    }
  }

  private less(a: Task, b: Task): boolean {
    return a.at < b.at || (a.at === b.at && a.order < b.order);
  }

  private push(task: Task): void {
    const h = this.heap;
    h.push(task);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }

  private pop(): Task | undefined {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (h.length > 0 && last) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}

export class SimStore implements DurableStore {
  private readonly data = new Map<string, string>();
  writes = 0;
  get(key: string): string | undefined {
    return this.data.get(key);
  }
  set(key: string, value: string): void {
    this.writes++;
    this.data.set(key, value);
  }
  delete(key: string): void {
    this.data.delete(key);
  }
  list(prefix: string): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const [k, v] of this.data) if (k.startsWith(prefix)) out.push([k, v]);
    return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
}

export class SimLocalStore implements LocalStore {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  keys(): string[] {
    return [...this.data.keys()];
  }
}

export interface LinkConfig {
  latency: number;
  jitter: number;
}

export interface SimClient {
  name: string;
  user: User;
  clientId: string;
  handle: ClientHandle;
  local: SimLocalStore;
  skew: number;
  link: LinkConfig;
  blockedUntil: number;
  connId?: string;
  closeLink?: (reason: string) => void;
}

export interface WorldOptions {
  seed: number;
  impl: Implementation;
  files: SeedFile[];
  defaultLink?: LinkConfig;
  idleTimeoutMs?: number;
}

export interface AddClientOptions {
  name: string;
  user?: Partial<User>;
  sameBrowserAs?: string;
  clockSkewMs?: number;
  link?: Partial<LinkConfig>;
  clientId?: string;
}

export interface RawConnectOptions {
  name: string;
  user?: Partial<User>;
  link?: Partial<LinkConfig>;
}

export interface RawPeer {
  readonly name: string;
  readonly user: User;
  readonly connId: string;
  readonly inbox: Json[];
  bytesSent: number;
  bytesReceived: number;
  isOpen(): boolean;
  isClosed(): boolean;
  send(msg: unknown): void;
  close(): void;
}

function downServer(): ServerHandle {
  return {
    connect() {},
    receive() {},
    disconnect() {},
    docText() {
      return undefined;
    },
    tree() {
      return [];
    },
  };
}

export class World {
  readonly sched = new Scheduler();
  readonly rng: Random;
  readonly store = new SimStore();
  server!: ServerHandle;
  readonly clients = new Map<string, SimClient>();
  private connSeq = 0;
  inFlight = 0;
  private serverEpoch = 0;
  private serverDownUntil = 0;
  private readonly liveLinks = new Map<string, { client: SimClient; close: (reason: string) => void }>();
  private readonly rawLinks = new Map<string, (reason: string) => void>();
  readonly trace: Array<{ at: number; dir: "c2s" | "s2c"; client: string; msg: Json }> = [];
  traceEnabled = false;
  readonly closes = new Map<string, number>();

  private readonly opts: WorldOptions;

  constructor(opts: WorldOptions) {
    this.opts = opts;
    this.rng = new Random(opts.seed);
    this.bootServer();
  }

  get now(): number {
    return this.sched.now;
  }

  private bootServer(): void {
    this.serverEpoch += 1;
    try {
      this.server = this.opts.impl.createServer({
        store: this.store,
        now: () => this.sched.now,
        timers: this.sched,
        seed: this.opts.files,
      });
    } catch (error) {
      this.sched.errors.push({ at: this.sched.now, error });
      this.server = downServer();
    }
  }

  addClient(options: AddClientOptions): SimClient {
    const shared = options.sameBrowserAs ? this.clients.get(options.sameBrowserAs)?.local : undefined;
    const local = shared ?? new SimLocalStore();
    const user: User = {
      id: options.user?.id ?? options.name,
      name: options.user?.name ?? options.name,
      kind: options.user?.kind ?? "human",
    };
    const clientId = options.clientId ?? `${options.name}-${this.rng.int(1000, 9999)}`;
    const client: SimClient = {
      name: options.name,
      user,
      clientId,
      local,
      skew: options.clockSkewMs ?? 0,
      link: { ...(this.opts.defaultLink ?? { latency: 20, jitter: 10 }), ...options.link },
      blockedUntil: 0,
      handle: undefined as unknown as ClientHandle,
    };
    const rng = this.rng.fork();
    client.handle = this.opts.impl.createClient({
      clientId,
      timers: this.sched,
      now: () => this.sched.now + client.skew,
      random: () => rng.next(),
      local,
      connect: (handlers) => this.openLink(client, handlers),
    });
    this.clients.set(options.name, client);
    return client;
  }

  client(name: string): SimClient {
    const c = this.clients.get(name);
    if (!c) throw new Error(`no client ${name}`);
    return c;
  }

  private delay(client: { link: LinkConfig }): number {
    return Math.max(0, client.link.latency + (this.rng.next() * 2 - 1) * client.link.jitter);
  }

  private openLink(client: SimClient, handlers: LinkHandlers) {
    const connId = `c${++this.connSeq}`;
    const epoch = this.serverEpoch;
    let open = false;
    let closed = false;
    let lastUp = 0;
    let lastDown = 0;
    const serialize = (msg: Json): Json => JSON.parse(JSON.stringify(msg)) as Json;
    const idleMs = this.opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    let lastHeard = this.now;
    const armIdle = () => {
      this.sched.at(lastHeard + idleMs, () => {
        if (closed) return;
        if (this.now - lastHeard >= idleMs) close("idle timeout");
        else armIdle();
      });
    };

    const close = (reason: string) => {
      if (closed) return;
      closed = true;
      this.closes.set(reason, (this.closes.get(reason) ?? 0) + 1);
      this.liveLinks.delete(connId);
      if (client.connId === connId) client.connId = undefined;
      if (open && epoch === this.serverEpoch) this.server.disconnect(connId);
      this.sched.after(this.delay(client), () => handlers.onClose(reason));
    };

    const connectAt = this.now + this.delay(client) * 2;
    this.sched.at(connectAt, () => {
      if (closed) return;
      if (this.now < client.blockedUntil || this.now < this.serverDownUntil || epoch !== this.serverEpoch) {
        close("connection refused");
        return;
      }
      open = true;
      client.connId = connId;
      armIdle();
      this.liveLinks.set(connId, { client, close });
      this.server.connect(connId, client.user, (msg) => {
        if (closed) return;
        const copy = serialize(msg);
        if (this.traceEnabled) this.trace.push({ at: this.now, dir: "s2c", client: client.name, msg: copy });
        lastDown = Math.max(lastDown, this.now + this.delay(client));
        this.inFlight++;
        this.sched.at(lastDown, () => {
          this.inFlight--;
          if (!closed) handlers.onMessage(copy);
        });
      });
      handlers.onOpen();
    });

    return {
      send: (msg: Json) => {
        if (closed) return;
        const copy = serialize(msg);
        if (this.traceEnabled) this.trace.push({ at: this.now, dir: "c2s", client: client.name, msg: copy });
        lastUp = Math.max(lastUp, this.now + this.delay(client));
        this.inFlight++;
        this.sched.at(lastUp, () => {
          this.inFlight--;
          if (!closed && open && epoch === this.serverEpoch) {
            lastHeard = this.now;
            this.server.receive(connId, copy);
          }
        });
      },
      close: () => close("closed by client"),
    };
  }

  rawConnect(options: RawConnectOptions): RawPeer {
    const name = options.name;
    const user: User = {
      id: options.user?.id ?? name,
      name: options.user?.name ?? name,
      kind: options.user?.kind ?? "human",
    };
    const link: LinkConfig = { ...(this.opts.defaultLink ?? { latency: 20, jitter: 10 }), ...options.link };
    const connId = `r${++this.connSeq}`;
    const epoch = this.serverEpoch;
    const connectAt = this.now + this.delay({ link }) * 2;
    let open = false;
    let closed = false;
    let lastUp = 0;
    let lastDown = 0;
    const close = (reason: string) => {
      if (closed) return;
      closed = true;
      this.closes.set(reason, (this.closes.get(reason) ?? 0) + 1);
      this.rawLinks.delete(connId);
      if (open && epoch === this.serverEpoch) this.server.disconnect(connId);
    };
    const peer: RawPeer = {
      name,
      user,
      connId,
      inbox: [],
      bytesSent: 0,
      bytesReceived: 0,
      isOpen: () => open && !closed,
      isClosed: () => closed,
      send: (msg: unknown) => {
        if (closed) return;
        const text = JSON.stringify(msg) ?? "null";
        const copy = JSON.parse(text) as Json;
        if (this.traceEnabled) this.trace.push({ at: this.now, dir: "c2s", client: name, msg: copy });
        peer.bytesSent += text.length;
        lastUp = Math.max(lastUp, this.now + this.delay({ link }), connectAt);
        this.inFlight++;
        this.sched.at(lastUp, () => {
          this.inFlight--;
          if (!closed && open && epoch === this.serverEpoch) this.server.receive(connId, copy);
        });
      },
      close: () => close("closed by client"),
    };
    this.sched.at(connectAt, () => {
      if (closed) return;
      if (epoch !== this.serverEpoch || this.now < this.serverDownUntil) {
        close("connection refused");
        return;
      }
      open = true;
      this.rawLinks.set(connId, close);
      this.server.connect(connId, user, (msg) => {
        if (closed) return;
        const text = JSON.stringify(msg) ?? "null";
        const copy = JSON.parse(text) as Json;
        if (this.traceEnabled) this.trace.push({ at: this.now, dir: "s2c", client: name, msg: copy });
        peer.bytesReceived += text.length;
        lastDown = Math.max(lastDown, this.now + this.delay({ link }));
        this.inFlight++;
        this.sched.at(lastDown, () => {
          this.inFlight--;
          if (!closed) peer.inbox.push(copy);
        });
      });
    });
    return peer;
  }
  partition(name: string, ms: number): void {
    const client = this.client(name);
    client.blockedUntil = this.now + ms;
    for (const [, l] of this.liveLinks) if (l.client === client) l.close("network partition");
  }
  dropConnection(name: string): void {
    const client = this.client(name);
    for (const [, l] of this.liveLinks) if (l.client === client) l.close("connection reset");
  }

  setLink(name: string, link: Partial<LinkConfig>): void {
    Object.assign(this.client(name).link, link);
  }
  restartServer(downMs = 500): void {
    for (const [, l] of [...this.liveLinks]) l.close("server restarting");
    for (const close of [...this.rawLinks.values()]) close("server restarting");
    this.serverEpoch += 1;
    const blocked = this.now + downMs;
    this.serverDownUntil = Math.max(this.serverDownUntil, blocked);
    for (const c of this.clients.values()) c.blockedUntil = Math.max(c.blockedUntil, blocked);
    this.sched.at(blocked, () => this.bootServer());
  }
  run(ms: number): void {
    this.sched.runUntil(this.now + ms);
  }

  settle(limitMs = 120_000): boolean {
    const clients = [...this.clients.values()];
    return this.sched.runWhile(() => this.inFlight > 0 || !clients.every((c) => c.handle.isSynced()), limitMs);
  }

  serverText(docId: string): string | undefined {
    return this.server.docText(docId);
  }
}
