import { ClientCore, MemoryLocalStore, realTimers, webSocketConnect, type LocalStore } from "@split-brain/sync";
import { fetchChaosState } from "./api.ts";

export interface SyncSession {
  client: ClientCore;
  skewMs(): number;
  start(): () => void;
  readonly log: Array<{ at: number; event: string; data?: Record<string, unknown> }>;
}

export interface SyncSessionOptions {
  token: string;
  clientId: string;
  userId?: string;
  onStorageError(message: string): void;
}

function localStoreAdapter(onError: (message: string) => void): LocalStore {
  let storage: Storage;
  try {
    storage = window.localStorage;
    storage.getItem("sb:probe");
  } catch {
    onError("localStorage is unavailable: unsent edits will not survive a reload.");
    return new MemoryLocalStore();
  }
  return {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => {
      try {
        storage.setItem(key, value);
      } catch (err) {
        onError(`Could not save unsent edits locally (${err instanceof Error ? err.message : String(err)}).`);
      }
    },
    removeItem: (key) => storage.removeItem(key),
    keys: () => {
      const out: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key !== null) out.push(key);
      }
      return out;
    },
  };
}

export function wsUrl(token: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws?token=${encodeURIComponent(token)}`;
}

const SKEW_POLL_MS = 2_000;
const SKEW_RETRY_MS = 15_000;

export function createSyncSession(opts: SyncSessionOptions): SyncSession {
  let skewMs = 0;
  const log: SyncSession["log"] = [];
  const client = new ClientCore({
    clientId: opts.clientId,
    connect: webSocketConnect(wsUrl(opts.token)),
    timers: realTimers,
    now: () => Date.now() + skewMs,
    random: Math.random,
    local: localStoreAdapter(opts.onStorageError),
    log: (event, data) => {
      log.push({ at: Date.now(), event, data });
      if (log.length > 200) log.splice(0, log.length - 200);
      if (import.meta.env.DEV) console.debug(`[sync] ${event}`, data ?? "");
    },
  });

  const start = () => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let next = SKEW_RETRY_MS;
      try {
        const state = await fetchChaosState();
        if (state) {
          next = SKEW_POLL_MS;
          const mine = state.users.find((u) => u.userId === opts.userId);
          skewMs = mine && Number.isFinite(mine.skewMs) ? mine.skewMs : 0;
        } else {
          skewMs = 0;
        }
      } catch {
      }
      if (!stopped) timer = setTimeout(poll, next);
    };
    client.start();
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      client.stop();
    };
  };

  return { client, skewMs: () => skewMs, start, log };
}
