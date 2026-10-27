import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";

const PORT = Number(process.env.PORT ?? 8080);
const UPSTREAM = new URL(process.env.RELAY_URL ?? "http://localhost:4000");

function log(event: string, data: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), svc: "chaos", event, ...data })}\n`);
}

interface UserFaults {
  userId: string;
  name: string;
  latencyMs: number;
  jitterMs: number;
  partitionedUntil: number;
  skewMs: number;
}

const users = new Map<string, UserFaults>();
const sockets = new Map<string, Set<{ close(reason: string): void }>>();

function faults(userId: string, name = userId): UserFaults {
  let f = users.get(userId);
  if (!f) {
    f = { userId, name, latencyMs: 0, jitterMs: 0, partitionedUntil: 0, skewMs: 0 };
    users.set(userId, f);
  }
  return f;
}

interface Preset {
  name: string;
  label: string;
  description: string;
  apply(): void;
}

function setAll(patch: Partial<UserFaults>): void {
  for (const f of users.values()) Object.assign(f, patch);
}

function partition(userId: string, ms: number): void {
  faults(userId).partitionedUntil = Date.now() + ms;
  for (const s of sockets.get(userId) ?? []) s.close("network partition");
}

const PRESETS: Preset[] = [
  { name: "calm", label: "Calm", description: "Perfect network.", apply: () => setAll({ latencyMs: 0, jitterMs: 0, partitionedUntil: 0, skewMs: 0 }) },
  {
    name: "coffee-shop",
    label: "Coffee-shop Wi-Fi",
    description: "Everyone gets 300 ms ± 250 ms.",
    apply: () => setAll({ latencyMs: 300, jitterMs: 250 }),
  },
  {
    name: "time-travellers",
    label: "Time travellers",
    description: "Dev's clock is 5 s behind, Priya's 5 s ahead.",
    apply: () => {
      faults("dev", "Dev").skewMs = -5000;
      faults("priya", "Priya").skewMs = 5000;
    },
  },
  {
    name: "train-tunnel",
    label: "Train tunnel",
    description: "Priya drops off for 20 s while everyone keeps typing.",
    apply: () => partition("priya", 20_000),
  },
  {
    name: "split-brain",
    label: "Split brain",
    description: "All of it at once: lag, skew, and a partition.",
    apply: () => {
      faults("maya", "Maya").latencyMs = 50;
      Object.assign(faults("dev", "Dev"), { latencyMs: 900, jitterMs: 400, skewMs: -5000 });
      faults("priya", "Priya").skewMs = 5000;
      partition("maya", 10_000);
    },
  },
];

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function state() {
  return {
    users: [...users.values()],
    presets: PRESETS.map(({ name, label, description }) => ({ name, label, description })),
  };
}

async function control(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (path === "/chaos/api/state" && req.method === "GET") return sendJson(res, 200, state());
  if (path === "/chaos/api/reset" && req.method === "POST") {
    PRESETS[0]!.apply();
    log("reset");
    return sendJson(res, 200, state());
  }
  const preset = /^\/chaos\/api\/presets\/([\w-]+)$/.exec(path);
  if (preset && req.method === "POST") {
    const p = PRESETS.find((x) => x.name === preset[1]);
    if (!p) return sendJson(res, 404, { error: "unknown preset" });
    p.apply();
    log("preset", { name: p.name });
    return sendJson(res, 200, state());
  }
  const user = /^\/chaos\/api\/users\/([\w-]+)$/.exec(path);
  if (user && req.method === "POST") {
    const body = await readJson(req);
    const f = faults(user[1]!);
    for (const key of ["latencyMs", "jitterMs", "skewMs"] as const) {
      if (typeof body[key] === "number") f[key] = Math.max(key === "skewMs" ? -600_000 : 0, Number(body[key]));
    }
    if (typeof body.partitionMs === "number") partition(f.userId, Number(body.partitionMs));
    if (body.drop === true) for (const s of sockets.get(f.userId) ?? []) s.close("connection reset");
    log("faults", { userId: f.userId, ...body });
    return sendJson(res, 200, state());
  }
  return sendJson(res, 404, { error: "not found" });
}

function proxyHttp(req: IncomingMessage, res: ServerResponse): void {
  const upstream = request(
    { hostname: UPSTREAM.hostname, port: UPSTREAM.port, path: req.url, method: req.method, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => sendJson(res, 502, { error: "relay unreachable", relay: UPSTREAM.origin }));
  req.pipe(upstream);
}

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://chaos").pathname;
  if (path.startsWith("/chaos/api/")) {
    control(req, res, path).catch((err) => sendJson(res, 400, { error: String(err) }));
    return;
  }
  proxyHttp(req, res);
});

function userFromToken(token: string): { id: string; name: string } {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")) as {
      user?: { id?: string; name?: string };
    };
    return { id: payload.user?.id ?? "unknown", name: payload.user?.name ?? "unknown" };
  } catch {
    return { id: "unknown", name: "unknown" };
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://chaos");
  const who = userFromToken(url.searchParams.get("token") ?? "");
  const f = faults(who.id, who.name);
  if (Date.now() < f.partitionedUntil) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\ncontent-type: text/plain\r\n\r\nnetwork partition (chaos)\n");
    socket.destroy();
    return;
  }
  const target = new URL(req.url ?? "/", UPSTREAM);
  target.protocol = UPSTREAM.protocol === "https:" ? "wss:" : "ws:";
  const upstream = new WebSocket(target);
  upstream.on("unexpected-response", (_req, response) => {
    let body = "";
    response.on("data", (c: Buffer) => (body += c.toString()));
    response.on("end", () => {
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\ncontent-type: text/plain\r\n\r\n${body}`);
      socket.destroy();
    });
  });
  upstream.on("error", () => socket.destroy());
  upstream.once("open", () => {
    wss.handleUpgrade(req, socket, head, (client) => bridge(client, upstream, f));
  });
});

function sendableCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}

function bridge(client: WebSocket, upstream: WebSocket, f: UserFaults): void {
  let closed = false;
  let lastUp = 0;
  let lastDown = 0;
  const handle = {
    close(reason: string) {
      if (closed) return;
      closed = true;
      client.close(4001, reason);
      upstream.close(1000, reason);
      sockets.get(f.userId)?.delete(handle);
    },
  };
  if (!sockets.has(f.userId)) sockets.set(f.userId, new Set());
  sockets.get(f.userId)!.add(handle);

  const delay = () => Math.max(0, f.latencyMs + (Math.random() * 2 - 1) * f.jitterMs);
  const forward = (to: WebSocket, data: RawData, isBinary: boolean, dir: "up" | "down") => {
    const at = Math.max(Date.now() + delay(), dir === "up" ? lastUp : lastDown);
    if (dir === "up") lastUp = at;
    else lastDown = at;
    setTimeout(() => {
      if (!closed && to.readyState === to.OPEN) to.send(data, { binary: isBinary });
    }, at - Date.now());
  };
  client.on("message", (data, isBinary) => forward(upstream, data, isBinary, "up"));
  upstream.on("message", (data, isBinary) => forward(client, data, isBinary, "down"));
  client.on("close", () => handle.close("client closed"));
  upstream.on("close", (code, reason) => {
    if (closed) return;
    closed = true;
    client.close(sendableCode(code), reason.toString());
    sockets.get(f.userId)?.delete(handle);
  });
  log("bridged", { userId: f.userId });
}

async function loadUsers(attempt = 0): Promise<void> {
  try {
    const res = await fetch(new URL("/api/invites", UPSTREAM));
    const body = (await res.json()) as { invites?: Array<{ user: { id: string; name: string } }> };
    for (const inv of body.invites ?? []) faults(inv.user.id, inv.user.name);
  } catch {
    if (attempt < 30) setTimeout(() => void loadUsers(attempt + 1), 1000);
  }
}

server.listen(PORT, () => {
  log("listening", { port: PORT, relay: UPSTREAM.origin });
  void loadUsers();
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
