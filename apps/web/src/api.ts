import type { User } from "@split-brain/protocol";
import type { InspectReport } from "@split-brain/sync";

export type { InspectReport };

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch (err) {
    throw new HttpError(0, `Can't reach the relay (${err instanceof Error ? err.message : String(err)})`);
  }
  const type = res.headers.get("content-type") ?? "";
  const body: unknown = type.includes("application/json") ? await res.json().catch(() => null) : await res.text().catch(() => "");
  if (!res.ok) {
    const obj = (body && typeof body === "object" ? body : {}) as { error?: string; message?: string };
    throw new HttpError(res.status, obj.message ?? obj.error ?? `${res.status} ${res.statusText}`);
  }
  if (!type.includes("application/json")) {
    throw new HttpError(404, `${url} did not return JSON`);
  }
  return body as T;
}

function postJson<T>(url: string, body: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return request<T>(url, { method: "POST", headers, body: JSON.stringify(body) });
}

export interface Invite {
  user: User;
  token: string;
}

export async function fetchInvites(): Promise<Invite[]> {
  const res = await request<{ invites: Invite[] }>("/api/invites");
  return res.invites;
}

export function createInvite(token: string, name: string): Promise<Invite> {
  return postJson<Invite>("/api/invites", { name }, token);
}

export function fetchInspect(room?: string): Promise<InspectReport> {
  return request<InspectReport>(room ? `/api/inspect?room=${encodeURIComponent(room)}` : "/api/inspect");
}

export type Severity = "sev1" | "sev2" | "sev3";

export interface Incident {
  id: string;
  severity: Severity;
  at: string;
  reporter: { name: string; role: string };
  title: string;
  body: string;
}

export interface Requirement {
  id: string;
  title: string;
  detail: string;
}

export async function fetchIncidents(): Promise<Incident[]> {
  const list = await request<unknown>("/api/incidents");
  return Array.isArray(list) ? (list as Incident[]) : [];
}

export async function fetchRequirements(): Promise<Requirement[]> {
  const list = await request<unknown>("/api/requirements");
  return Array.isArray(list) ? (list as Requirement[]) : [];
}

export interface BlameSpan {
  start: number;
  end: number;
  authorId: string;
}

export function fetchBlame(docId: string): Promise<{ docId: string; spans: BlameSpan[] }> {
  return request(`/api/blame?doc=${encodeURIComponent(docId)}`);
}

export interface ChaosUser {
  userId: string;
  name: string;
  latencyMs: number;
  jitterMs: number;
  partitionedUntil: number;
  skewMs: number;
}

export interface ChaosPreset {
  name: string;
  label: string;
  description: string;
}

export interface ChaosState {
  users: ChaosUser[];
  presets: ChaosPreset[];
}

export interface ChaosUserPatch {
  latencyMs?: number;
  jitterMs?: number;
  partitionMs?: number;
  drop?: true;
  skewMs?: number;
}

export async function fetchChaosState(): Promise<ChaosState | null> {
  try {
    const state = await request<ChaosState>("/chaos/api/state");
    if (!state || !Array.isArray(state.users)) return null;
    return { users: state.users, presets: Array.isArray(state.presets) ? state.presets : [] };
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 0 || err.status === 502 || err.status === 503)) return null;
    throw err;
  }
}

export function patchChaosUser(userId: string, patch: ChaosUserPatch): Promise<unknown> {
  return postJson(`/chaos/api/users/${encodeURIComponent(userId)}`, patch);
}

export function applyChaosPreset(name: string): Promise<unknown> {
  return postJson(`/chaos/api/presets/${encodeURIComponent(name)}`, {});
}

export function resetChaos(): Promise<unknown> {
  return postJson("/chaos/api/reset", {});
}

export type BotTaskStatus = "queued" | "thinking" | "applying" | "done" | "failed";

export interface BotTask {
  id: string;
  instruction: string;
  requestedBy: { id: string; name: string };
  status: BotTaskStatus;
  message?: string;
  applied?: number;
  conflicts?: number;
  createdAt: number;
  updatedAt: number;
}

export interface BotStatus {
  online: boolean;
  lastSeenAt: number;
  model?: string;
  error?: string;
}

export interface BotSnapshot {
  bot: BotStatus;
  tasks: BotTask[];
}

export function fetchBotTasks(): Promise<BotSnapshot> {
  return request<BotSnapshot>("/api/bot/tasks");
}

export function postBotTask(token: string, instruction: string): Promise<BotTask> {
  return postJson<BotTask>("/api/bot/tasks", { instruction }, token);
}

export const ADA_QUICK_PROMPTS = [
  "Rename getUser to fetchUser everywhere",
  "Implement the TODO(ai) in src/notes.ts",
  "Return 404 JSON for unknown routes in src/server.ts",
  "Add input validation to createNote",
] as const;

export type RunCommand = "test" | "typecheck";
export type RunStatus = "running" | "passed" | "failed" | "error";

export interface RunRecord {
  id: string;
  command: RunCommand;
  requestedBy: { id: string; name: string };
  at: number;
  status: RunStatus;
  exitCode?: number;
  output?: string;
  durationMs?: number;
  files?: number;
}

export interface RunsSnapshot {
  runnerConfigured: boolean;
  runs: RunRecord[];
}

export function fetchRuns(): Promise<RunsSnapshot> {
  return request<RunsSnapshot>("/api/runs");
}

export function startRun(token: string, command: RunCommand): Promise<RunRecord> {
  return postJson<RunRecord>("/api/run", { command }, token);
}
