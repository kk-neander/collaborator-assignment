import { ClientCore, realTimers, webSocketConnect } from "@split-brain/sync";
import { randomUUID } from "node:crypto";
import { applyPlan, buildPrompt, parsePlan, PlanError, type BotTask } from "./brain.ts";
import { configFromEnv, createLlm, LlmCallError, LlmConfigError, type LlmClient } from "./llm.ts";

const RELAY = (process.env.RELAY_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const WS = RELAY.replace(/^http/, "ws");

function log(event: string, data: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), svc: "bot", event, ...data })}\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<{ status: number; body: T | undefined }> {
  const res = await fetch(`${RELAY}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as T) : undefined };
}

async function botInvite(): Promise<string> {
  if (process.env.BOT_TOKEN) return process.env.BOT_TOKEN;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${RELAY}/api/invites`);
      const body = (await res.json()) as { invites?: Array<{ user: { kind: string }; token: string }> };
      const invite = body.invites?.find((i) => i.user.kind === "bot");
      if (invite) return invite.token;
      throw new Error("no bot invite (set BOT_TOKEN if demo invites are off)");
    } catch (err) {
      if (attempt % 10 === 0) log("waiting_for_relay", { error: String(err) });
      await sleep(1000);
    }
  }
}

class Ada {
  private readonly client: ClientCore;
  private readonly token: string;
  private readonly llm: LlmClient;

  constructor(token: string, llm: LlmClient) {
    this.token = token;
    this.llm = llm;
    this.client = new ClientCore({
      clientId: `ada-${randomUUID().slice(0, 8)}`,
      connect: webSocketConnect(`${WS}/ws?token=${encodeURIComponent(token)}`),
      timers: realTimers,
      now: () => Date.now(),
      random: Math.random,
      log: (event, data) => log(event, data),
    });
    this.client.on("status", (s) => log("status", { status: s }));
    this.client.on("notice", (kind, message) => log("notice", { kind, message }));
    this.client.on("tree", () => this.openAllFiles());
    setInterval(() => this.client.reportHashes(), 2000);
  }

  start(): void {
    this.client.start();
  }

  private openAllFiles(): void {
    for (const node of this.client.treeNodes()) {
      if (node.kind === "file" && !node.deleted) this.client.open(node.id);
    }
  }

  private files() {
    const tree = this.client.fileTree();
    return this.client
      .treeNodes()
      .filter((n) => n.kind === "file" && tree.isLive(n.id) && this.client.isReady(n.id))
      .map((n) => ({ path: tree.path(n.id), docId: n.id, text: this.client.text(n.id) }));
  }

  private async report(id: string, patch: Record<string, unknown>): Promise<void> {
    await api(`/api/bot/tasks/${id}`, this.token, { method: "POST", body: JSON.stringify(patch) }).catch(() => undefined);
  }

  async run(task: BotTask): Promise<void> {
    log("task", { id: task.id, instruction: task.instruction });
    await this.waitUntilOnline();
    const files = this.files();
    const snapshot = new Map(files.map((f) => [f.path, f.text]));
    const prompt = buildPrompt(task, files);
    let reply;
    try {
      reply = await this.llm.complete({ ...prompt, maxTokens: 4096 });
    } catch (err) {
      const message = err instanceof LlmCallError ? err.message : String(err);
      log("llm_failed", { id: task.id, error: message });
      await this.report(task.id, { status: "failed", message: `LLM call failed: ${message}` });
      return;
    }
    let plan;
    try {
      plan = parsePlan(reply.text);
    } catch (err) {
      const message = err instanceof PlanError ? err.message : String(err);
      await this.report(task.id, { status: "failed", message });
      return;
    }
    await this.report(task.id, { status: "applying", message: plan.summary });
    const tree = this.client.fileTree();
    const result = applyPlan(
      {
        docIdForPath: (path) => {
          const node = tree.findByPath(path);
          return node && node.kind === "file" && this.client.isReady(node.id) ? node.id : undefined;
        },
        text: (docId) => this.client.text(docId),
        replace: (docId, pos, length, text) => this.client.replace(docId, pos, length, text),
      },
      plan,
      snapshot,
    );
    const conflictNote = result.conflicts.length
      ? ` ${result.conflicts.length} edit(s) skipped: ${[...new Set(result.conflicts.map((c) => `${c.path} (${c.reason})`))].join(", ")}.`
      : "";
    await this.report(task.id, {
      status: result.applied.length || !result.conflicts.length ? "done" : "failed",
      message: `${plan.summary}${conflictNote}`,
      applied: result.applied.length,
      conflicts: result.conflicts.length,
    });
    log("task_done", { id: task.id, applied: result.applied.length, conflicts: result.conflicts.length, tokensIn: reply.inputTokens, tokensOut: reply.outputTokens });
  }

  private async waitUntilOnline(): Promise<void> {
    for (let i = 0; i < 300 && this.client.getStatus() !== "online"; i++) await sleep(100);
    this.openAllFiles();
    for (let i = 0; i < 100 && this.files().length === 0; i++) await sleep(100);
  }
}

async function main(): Promise<void> {
  const token = await botInvite();
  let llm: LlmClient;
  try {
    llm = createLlm(configFromEnv());
  } catch (err) {
    if (!(err instanceof LlmConfigError)) throw err;
    log("config_error", { error: err.message });
    process.stderr.write(`\n${err.message}\n\n`);
    for (;;) {
      await api("/api/bot/status", token, { method: "POST", body: JSON.stringify({ error: err.message.split("\n")[0] }) }).catch(() => undefined);
      await sleep(15_000);
    }
  }
  const ada = new Ada(token, llm);
  ada.start();
  log("ready", { model: llm.label });
  for (;;) {
    await api("/api/bot/status", token, { method: "POST", body: JSON.stringify({ model: llm.label }) }).catch(() => undefined);
    let next;
    try {
      next = await api<BotTask>("/api/bot/next", token);
    } catch (err) {
      log("poll_failed", { error: String(err) });
      await sleep(2000);
      continue;
    }
    if (next.status === 200 && next.body) await ada.run(next.body);
    else if (next.status !== 204) await sleep(2000);
  }
}

main().catch((err) => {
  log("fatal", { error: String(err) });
  process.exit(1);
});
