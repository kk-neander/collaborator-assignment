import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const HEARTBEAT_MS = 45_000;
export const IDLE_TIMEOUT_MS = 30_000;

const textOp = z.array(z.union([z.number().int().refine((n) => n !== 0), z.string().min(1)]));

export const userSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["human", "bot"]),
  color: z.string().optional(),
});
export type User = z.infer<typeof userSchema>;

export const treeNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  parentId: z.string().nullable(),
  kind: z.enum(["file", "dir"]),
  deleted: z.boolean().optional(),
});
export type TreeNode = z.infer<typeof treeNodeSchema>;

export const treeChangeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create"),
    id: z.string().min(1),
    parentId: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(["file", "dir"]),
    text: z.string().optional(),
  }),
  z.object({ type: z.literal("rename"), id: z.string().min(1), name: z.string().min(1) }),
  z.object({ type: z.literal("move"), id: z.string().min(1), parentId: z.string().min(1) }),
  z.object({ type: z.literal("delete"), id: z.string().min(1) }),
  z.object({ type: z.literal("restore"), id: z.string().min(1) }),
]);
export type TreeChange = z.infer<typeof treeChangeSchema>;

export const clientMessageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), clientId: z.string().min(1), protocol: z.number().int() }),
  z.object({ t: z.literal("open"), docId: z.string().min(1), knownRevision: z.number().int().nonnegative().optional() }),
  z.object({ t: z.literal("close"), docId: z.string().min(1) }),
  z.object({ t: z.literal("undo"), docId: z.string().min(1) }),
  z.object({
    t: z.literal("op"),
    docId: z.string().min(1),
    baseRevision: z.number().int().nonnegative(),
    seq: z.number().int().positive(),
    op: textOp,
    ts: z.number(),
  }),
  z.object({
    t: z.literal("presence"),
    docId: z.string().min(1),
    anchor: z.number().int().nonnegative(),
    head: z.number().int().nonnegative(),
  }),
  z.object({ t: z.literal("tree"), seq: z.number().int().positive(), change: treeChangeSchema }),
  z.object({
    t: z.literal("hash"),
    docId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    hash: z.string(),
  }),
  z.object({ t: z.literal("ping"), ts: z.number() }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export interface OpEntry {
  revision: number;
  inverse?: (number | string)[];
  op: (number | string)[];
  clientId: string;
  seq: number;
  author: User;
  ts?: number;
}

export type ServerMessage =
  | { t: "welcome"; serverTime: number; user: User; treeRevision: number; tree: TreeNode[] }
  | { t: "error"; code: string; message: string; fatal?: boolean }
  | { t: "snapshot"; docId: string; revision: number; text: string }
  | { t: "ops"; docId: string; entries: OpEntry[]; caughtUp: boolean }
  | { t: "ack"; docId: string; seq: number; revision: number }
  | { t: "presence"; docId: string; clientId: string; user: User; anchor: number; head: number }
  | { t: "left"; clientId: string }
  | { t: "tree"; revision: number; change: TreeChange; clientId: string; seq: number; author: User }
  | { t: "treeAck"; seq: number; revision: number }
  | { t: "treeReject"; seq: number; reason: string }
  | { t: "docDeleted"; docId: string }
  | { t: "pong"; ts: number; serverTime: number };

export type ParseResult = { ok: true; msg: ClientMessage } | { ok: false; error: string };

export function parseClientMessage(raw: unknown): ParseResult {
  const result = clientMessageSchema.safeParse(raw);
  if (result.success) return { ok: true, msg: result.data };
  return { ok: false, error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}
