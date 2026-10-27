import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { IDLE_TIMEOUT_MS, type ServerMessage, type User } from "@split-brain/protocol";
import { realTimers, ServerCore, type SeedFile } from "@split-brain/sync";
import { BotTasks } from "./bot-tasks.ts";
import { SqliteStore } from "./sqlite-store.ts";
import { signInvite, TokenError, verifyInvite } from "./tokens.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const config = {
  port: Number(process.env.PORT ?? 4000),
  dataDir: process.env.DATA_DIR ?? join(repoRoot, ".split-brain/relay-data"),
  seedDir: process.env.SEED_DIR ?? join(repoRoot, "workspace-seed"),
  incidentsDir: process.env.INCIDENTS_DIR ?? join(repoRoot, "incidents"),
  webDist: process.env.WEB_DIST ?? join(repoRoot, "apps/web/dist"),
  idleTimeoutMs: Number(process.env.IDLE_TIMEOUT_MS || IDLE_TIMEOUT_MS),
  demoInvites: (process.env.DEMO_INVITES ?? "on") !== "off",
  inviteTtlMs: Number(process.env.INVITE_TTL_HOURS ?? 24 * 30) * 3_600_000,
  runnerUrl: process.env.RUNNER_URL ?? "",
};

function log(event: string, data: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), svc: "relay", event, ...data })}\n`);
}

mkdirSync(config.dataDir, { recursive: true });
const secret = process.env.RELAY_SECRET || loadOrCreateSecret();

function loadOrCreateSecret(): string {
  const file = join(config.dataDir, "secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const value = randomBytes(32).toString("hex");
  writeFileSync(file, value, { mode: 0o600 });
  return value;
}

const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".css", ".html", ".txt", ".yml", ".yaml", ""]);

function loadSeed(dir: string): SeedFile[] {
  if (!existsSync(dir)) return [];
  const files: SeedFile[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === ".git" || name === "dist") continue;
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.size < 256_000 && TEXT_EXTENSIONS.has(extname(name))) {
        files.push({ path: relative(dir, full).split(sep).join("/"), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(dir);
  return files;
}

interface Room {
  core: ServerCore;
  store: SqliteStore;
}

const rooms = new Map<string, Room>();

function room(name: string): Room {
  let r = rooms.get(name);
  if (!r) {
    const store = new SqliteStore(join(config.dataDir, `${name.replace(/[^a-z0-9_-]/gi, "_")}.sqlite`));
    const core = new ServerCore({ store, now: () => Date.now(), seed: loadSeed(config.seedDir), log, timers: realTimers });
    r = { core, store };
    rooms.set(name, r);
    log("room_loaded", { room: name });
  }
  return r;
}

const DEMO_USERS: User[] = [
  { id: "maya", name: "Maya", kind: "human", color: "#e5484d" },
  { id: "dev", name: "Dev", kind: "human", color: "#3e63dd" },
  { id: "priya", name: "Priya", kind: "human", color: "#30a46c" },
  { id: "ada", name: "Ada (AI)", kind: "bot", color: "#8e4ec6" },
];

function invite(user: User, roomName = "main"): string {
  return signInvite({ room: roomName, user, exp: Date.now() + config.inviteTtlMs }, secret);
}

const botTasks = new BotTasks();

interface RunRecord {
  id: string;
  command: string;
  requestedBy: { id: string; name: string };
  at: number;
  status: "running" | "passed" | "failed" | "error";
  exitCode?: number;
  output?: string;
  durationMs?: number;
  files: number;
}
const runs: RunRecord[] = [];

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJsonFile(path: string): unknown {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function bearer(req: IncomingMessage) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return verifyInvite(token, secret, Date.now());
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  const root = config.webDist;
  let file = resolve(root, `.${decodeURIComponent(pathname)}`);
  if (!file.startsWith(resolve(root)) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(root, "index.html");
  }
  if (!existsSync(file)) {
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("The editor has not been built. Run `docker compose up --build`, or `npm run build -w @split-brain/web`.\n");
    return;
  }
  res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://relay");
  const path = url.pathname;
  try {
    if (path === "/healthz") return sendJson(res, 200, { ok: true, rooms: rooms.size });
    if (path === "/api/invites" && req.method === "GET") {
      if (!config.demoInvites) return sendJson(res, 404, { error: "demo invites are off" });
      return sendJson(res, 200, { invites: DEMO_USERS.map((user) => ({ user, token: invite(user) })) });
    }
    if (path === "/api/invites" && req.method === "POST") {
      const from = bearer(req);
      const body = JSON.parse((await readBody(req)) || "{}") as { name?: string };
      const name = (body.name ?? "").trim().slice(0, 40) || "Guest";
      const user: User = { id: `guest-${randomUUID().slice(0, 8)}`, name, kind: "human" };
      return sendJson(res, 200, { user, token: invite(user, from.room) });
    }
    if (path === "/api/inspect") {
      const roomName = url.searchParams.get("room") ?? "main";
      return sendJson(res, 200, room(roomName).core.inspect());
    }
    if (path === "/api/runs" && req.method === "GET") return sendJson(res, 200, { runnerConfigured: Boolean(config.runnerUrl), runs: [...runs].reverse() });
    if (path === "/api/run" && req.method === "POST") {
      const from = bearer(req);
      if (!config.runnerUrl) return sendJson(res, 503, { error: "runner_offline", message: "No runner configured (RUNNER_URL)." });
      const body = JSON.parse((await readBody(req)) || "{}") as { command?: string };
      const command = body.command === "typecheck" ? "typecheck" : "test";
      const files = room(from.room).core.snapshotAll();
      const record: RunRecord = { id: randomUUID().slice(0, 8), command, requestedBy: { id: from.user.id, name: from.user.name }, at: Date.now(), status: "running", files: files.length };
      runs.push(record);
      if (runs.length > 30) runs.splice(0, runs.length - 30);
      try {
        const r = await fetch(new URL("/run", config.runnerUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ files, command, requestedBy: from.user.id }),
          signal: AbortSignal.timeout(90_000),
        });
        const result = (await r.json()) as { exitCode: number; output: string; durationMs: number };
        Object.assign(record, { status: result.exitCode === 0 ? "passed" : "failed", ...result });
      } catch (err) {
        Object.assign(record, { status: "error", output: `runner unreachable: ${String(err)}` });
      }
      log("run", { id: record.id, by: from.user.id, command, status: record.status });
      return sendJson(res, 200, record);
    }
    if (path === "/api/blame") {
      const docId = url.searchParams.get("doc") ?? "";
      const spans = room(url.searchParams.get("room") ?? "main").core.authorship(docId);
      return spans ? sendJson(res, 200, { docId, spans }) : sendJson(res, 404, { error: "unknown document" });
    }
    if (path === "/api/incidents") return sendJson(res, 200, readJsonFile(join(config.incidentsDir, "incidents.json")) ?? []);
    if (path === "/api/requirements") return sendJson(res, 200, readJsonFile(join(config.incidentsDir, "requirements.json")) ?? []);
    if (path === "/api/bot/tasks" && req.method === "GET") return sendJson(res, 200, botTasks.snapshot());
    if (path === "/api/bot/tasks" && req.method === "POST") {
      const from = bearer(req);
      const body = JSON.parse((await readBody(req)) || "{}") as { instruction?: string };
      const instruction = (body.instruction ?? "").trim();
      if (!instruction) return sendJson(res, 400, { error: "instruction is empty" });
      const task = botTasks.enqueue(instruction, from.user);
      log("bot_task_queued", { id: task.id, by: from.user.id });
      return sendJson(res, 201, task);
    }
    if (path === "/api/bot/next" && req.method === "GET") {
      const from = bearer(req);
      if (from.user.kind !== "bot") return sendJson(res, 403, { error: "only the bot takes tasks" });
      const task = await botTasks.next(25_000);
      return task ? sendJson(res, 200, task) : sendJson(res, 204, null);
    }
    if (path === "/api/bot/status" && req.method === "POST") {
      const from = bearer(req);
      if (from.user.kind !== "bot") return sendJson(res, 403, { error: "only the bot reports status" });
      const body = JSON.parse((await readBody(req)) || "{}") as { model?: string; error?: string };
      botTasks.heartbeat(body.model, body.error);
      return sendJson(res, 200, { ok: true });
    }
    const taskUpdate = /^\/api\/bot\/tasks\/([\w-]+)$/.exec(path);
    if (taskUpdate && req.method === "POST") {
      const from = bearer(req);
      if (from.user.kind !== "bot") return sendJson(res, 403, { error: "only the bot updates tasks" });
      const body = JSON.parse((await readBody(req)) || "{}") as Parameters<BotTasks["update"]>[1];
      const task = botTasks.update(taskUpdate[1]!, body);
      return task ? sendJson(res, 200, task) : sendJson(res, 404, { error: "unknown task" });
    }
    if (path.startsWith("/api/")) return sendJson(res, 404, { error: "not found" });
    return serveStatic(req, res, path);
  } catch (err) {
    if (err instanceof TokenError) return sendJson(res, 401, { error: err.code, message: err.message });
    log("http_error", { path, error: String(err) });
    return sendJson(res, 500, { error: "internal" });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
const lastSeen = new Map<WebSocket, number>();

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://relay");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  let payload;
  try {
    payload = verifyInvite(url.searchParams.get("token") ?? "", secret, Date.now());
  } catch (err) {
    const code = err instanceof TokenError ? err.code : "bad_token";
    log("ws_rejected", { reason: code });
    socket.write(`HTTP/1.1 401 Unauthorized\r\ncontent-type: text/plain\r\n\r\n${code}\n`);
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, payload.room, payload.user));
});

function attach(ws: WebSocket, roomName: string, user: User): void {
  const { core } = room(roomName);
  const connId = randomUUID();
  lastSeen.set(ws, Date.now());
  core.connect(connId, {
    user,
    send: (msg: ServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
  });
  log("connected", { connId, user: user.id, room: roomName });
  ws.on("message", (data) => {
    lastSeen.set(ws, Date.now());
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ t: "error", code: "bad_json", message: "message is not JSON" }));
      return;
    }
    try {
      core.receive(connId, msg);
    } catch (err) {
      log("receive_failed", { connId, user: user.id, error: String((err as Error)?.message ?? err) });
      ws.send(JSON.stringify({ t: "error", code: "internal", message: "the relay could not process that message" }));
    }
  });
  ws.on("close", (code) => {
    lastSeen.delete(ws);
    core.disconnect(connId);
    log("disconnected", { connId, user: user.id, code });
  });
}

const idleCheck = setInterval(() => {
  const now = Date.now();
  for (const [ws, at] of lastSeen) {
    if (now - at > config.idleTimeoutMs) {
      log("idle_timeout", { idleMs: now - at });
      ws.close(4000, "idle timeout");
      lastSeen.delete(ws);
    }
  }
}, 5_000);

server.listen(config.port, () => {
  room("main");
  log("listening", { port: config.port, dataDir: config.dataDir, seedDir: config.seedDir });
});

function shutdown(signal: string): void {
  log("shutdown", { signal });
  clearInterval(idleCheck);
  for (const ws of lastSeen.keys()) ws.close(1001, "relay restarting");
  server.close();
  for (const r of rooms.values()) r.store.close();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
