import type { User } from "@split-brain/protocol";

function isEmbeddedWindow(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

if (isEmbeddedWindow() && !window.name) window.name = `sb-${uuid().slice(0, 8)}`;

export function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function scopedKey(base: string): string {
  return window.name ? `${base}:${window.name}` : base;
}

function sessionGet(key: string): string | null {
  try {
    return sessionStorage.getItem(scopedKey(key));
  } catch {
    return null;
  }
}

function sessionSet(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(scopedKey(key));
    else sessionStorage.setItem(scopedKey(key), value);
  } catch {
  }
}

export function sessionJson<T>(key: string, fallback: T): T {
  const raw = sessionGet(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setSessionJson(key: string, value: unknown): void {
  sessionSet(key, JSON.stringify(value));
}

const TOKEN_KEY = "sb:token";

export function takeTokenFromUrl(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    sessionSet(TOKEN_KEY, fromUrl);
    url.searchParams.delete("token");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    return fromUrl;
  }
  return sessionGet(TOKEN_KEY);
}

export function clearToken(): void {
  sessionSet(TOKEN_KEY, null);
}

export function getClientId(): string {
  const key = "sb:clientId";
  let id = sessionGet(key);
  if (!id) {
    id = uuid();
    sessionSet(key, id);
  }
  return id;
}

export function isEmbed(): boolean {
  return new URLSearchParams(window.location.search).get("embed") === "1";
}

export interface InviteInfo {
  room?: string;
  user?: User;
  exp?: number;
}

export function decodeInvite(token: string): InviteInfo | null {
  const body = token.split(".")[0];
  if (!body) return null;
  try {
    const b64 = body.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as InviteInfo;
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

export function inviteLink(token: string): string {
  return `${window.location.origin}/?token=${encodeURIComponent(token)}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

const PALETTE = ["#e5484d", "#3e63dd", "#30a46c", "#8e4ec6", "#f76b15", "#0090ff", "#d6409f", "#12a594", "#ffc53d", "#7c66dc"];

export function userColor(user: Pick<User, "id" | "color"> | undefined): string {
  if (!user) return "#8b93a7";
  if (user.color) return user.color;
  let h = 0;
  for (let i = 0; i < user.id.length; i++) h = (h * 31 + user.id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export function initials(name: string): string {
  const clean = name.replace(/\(.*?\)/g, "").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]!.slice(0, 1) + parts[parts.length - 1]!.slice(0, 1)).toUpperCase();
}

export function syncAssertionsEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    return localStorage.getItem("sb:assertSync") === "1";
  } catch {
    return false;
  }
}
