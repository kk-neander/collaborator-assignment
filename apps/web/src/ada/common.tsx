import type { BotSnapshot, BotTask, BotTaskStatus } from "../api.ts";

const STATUS_LABEL: Record<BotTaskStatus, string> = {
  queued: "queued",
  thinking: "thinking",
  applying: "applying",
  done: "done",
  failed: "failed",
};

export function isActive(task: BotTask): boolean {
  return task.status === "queued" || task.status === "thinking" || task.status === "applying";
}

export function TaskPill({ status }: { status: BotTaskStatus }) {
  return (
    <span className={`task-pill task-${status}`}>
      {(status === "thinking" || status === "applying") && <span className="spinner spinner-xs" />}
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function BotStatusLine({ snapshot, error, compact }: { snapshot: BotSnapshot | undefined; error: Error | undefined; compact?: boolean }) {
  if (!snapshot) {
    return (
      <div className={`bot-status bot-unknown${compact ? " compact" : ""}`}>
        <span className="status-dot" />
        <span>{error ? `Ada isn't reachable: ${error.message}` : "Checking on Ada…"}</span>
      </div>
    );
  }
  const { bot } = snapshot;
  if (bot.online) {
    return (
      <div className={`bot-status bot-online${compact ? " compact" : ""}`} data-testid="bot-status">
        <span className="status-dot" />
        <span>
          Ada is <b>online</b>
          {bot.model && <span className="bot-model">{bot.model}</span>}
        </span>
        {bot.error && <span className="bot-error">{bot.error}</span>}
      </div>
    );
  }
  return (
    <div className={`bot-status bot-offline${compact ? " compact" : ""}`} data-testid="bot-status">
      <span className="status-dot" />
      <span>
        Ada is <b>offline</b>
      </span>
      {bot.error && <span className="bot-error">{bot.error}</span>}
    </div>
  );
}

export function TaskCounts({ task }: { task: BotTask }) {
  if (task.applied === undefined && task.conflicts === undefined) return null;
  return (
    <span className="task-counts">
      {task.applied !== undefined && <span>{task.applied} edits applied</span>}
      {task.conflicts !== undefined && task.conflicts > 0 && <span className="task-conflicts">{task.conflicts} conflicts</span>}
    </span>
  );
}
