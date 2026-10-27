import { randomUUID } from "node:crypto";
import type { User } from "@split-brain/protocol";

export type BotTaskStatus = "queued" | "thinking" | "applying" | "done" | "failed";

export interface BotTaskRecord {
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

const KEEP = 50;
const BOT_ONLINE_MS = 40_000;

export class BotTasks {
  private readonly tasks: BotTaskRecord[] = [];
  private readonly waiters: Array<(task: BotTaskRecord | undefined) => void> = [];
  private status: Omit<BotStatus, "online"> = { lastSeenAt: 0 };

  enqueue(instruction: string, user: User): BotTaskRecord {
    const now = Date.now();
    const task: BotTaskRecord = {
      id: randomUUID().slice(0, 8),
      instruction: instruction.slice(0, 2000),
      requestedBy: { id: user.id, name: user.name },
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.push(task);
    if (this.tasks.length > KEEP) this.tasks.splice(0, this.tasks.length - KEEP);
    const waiter = this.waiters.shift();
    if (waiter) {
      task.status = "thinking";
      waiter(task);
    }
    return task;
  }

  next(timeoutMs: number): Promise<BotTaskRecord | undefined> {
    this.status.lastSeenAt = Date.now();
    const queued = this.tasks.find((t) => t.status === "queued");
    if (queued) {
      queued.status = "thinking";
      queued.updatedAt = Date.now();
      return Promise.resolve(queued);
    }
    return new Promise((resolve) => {
      const waiter = (task: BotTaskRecord | undefined) => {
        clearTimeout(timer);
        resolve(task);
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(undefined);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  update(id: string, patch: Partial<Pick<BotTaskRecord, "status" | "message" | "applied" | "conflicts">>): BotTaskRecord | undefined {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return undefined;
    Object.assign(task, patch, { updatedAt: Date.now() });
    this.status.lastSeenAt = Date.now();
    return task;
  }

  heartbeat(model?: string, error?: string): void {
    this.status = { lastSeenAt: Date.now(), model, error };
  }

  snapshot(): { bot: BotStatus; tasks: BotTaskRecord[] } {
    return {
      bot: { ...this.status, online: !this.status.error && Date.now() - this.status.lastSeenAt < BOT_ONLINE_MS },
      tasks: [...this.tasks].reverse(),
    };
  }
}
