export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface User {
  id: string;
  name: string;
  kind: "human" | "bot";
}

export interface TreeNode {
  id: string;
  name: string;
  parentId: string | null;
  kind: "file" | "dir";
  deleted?: boolean;
}

export type TreeChange =
  | { type: "create"; id: string; parentId: string; name: string; kind: "file" | "dir"; text?: string }
  | { type: "rename"; id: string; name: string }
  | { type: "move"; id: string; parentId: string }
  | { type: "delete"; id: string }
  | { type: "restore"; id: string };

export interface DurableStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  list(prefix: string): Array<[string, string]>;
}

export interface LocalStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): string[];
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SeedFile {
  path: string;
  text: string;
}

export interface ServerEnv {
  store: DurableStore;
  now(): number;
  timers: Timers;
  seed?: SeedFile[];
}

export interface ServerHandle {
  connect(connId: string, user: User, send: (msg: Json) => void): void;
  receive(connId: string, msg: Json): void;
  disconnect(connId: string): void;
  docText(docId: string): string | undefined;
  tree(): TreeNode[];
  authorship?(docId: string): Array<{ start: number; end: number; authorId: string }> | undefined;
  snapshot?(): Array<{ path: string; text: string }>;
}
export interface LinkHandlers {
  onOpen(): void;
  onMessage(msg: Json): void;
  onClose(reason: string): void;
}

export interface Link {
  send(msg: Json): void;
  close(): void;
}
export interface ClientEnv {
  clientId: string;
  connect(handlers: LinkHandlers): Link;
  timers: Timers;
  now(): number;
  random(): number;
  local?: LocalStore;
}
export interface ClientStats {
  droppedChars: number;
  anomalies: number;
}

export interface ClientHandle {
  start(): void;
  stop(): void;
  open(docId: string): void;
  isReady(docId: string): boolean;
  text(docId: string): string;
  insert(docId: string, pos: number, text: string): void;
  delete(docId: string, pos: number, length: number): void;
  replace(docId: string, pos: number, length: number, text: string): void;
  undo(docId: string): boolean;
  changeTree(change: TreeChange): void;
  tree(): TreeNode[];
  isSynced(): boolean;
  stats(): ClientStats;
}
export interface Implementation {
  name: string;
  createServer(env: ServerEnv): ServerHandle;
  createClient(env: ClientEnv): ClientHandle;
}
