import { useState } from "react";
import { ADA_QUICK_PROMPTS, fetchBotTasks, HttpError, postBotTask } from "../api.ts";
import { timeAgo, usePoll } from "../ui/hooks.ts";
import { IconSend, IconSparkle } from "../ui/icons.tsx";
import { useToast } from "../ui/toasts.tsx";
import { BotStatusLine, TaskCounts, TaskPill } from "./common.tsx";

export function AdaPanel({ token }: { token: string }) {
  const toast = useToast();
  const poll = usePoll(fetchBotTasks, 1_500);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const unavailable = poll.error instanceof HttpError && poll.error.status === 404;

  const submit = async () => {
    const instruction = text.trim();
    if (!instruction || busy) return;
    setBusy(true);
    try {
      await postBotTask(token, instruction);
      setText("");
      poll.refresh();
    } catch (err) {
      toast({ tone: "error", title: "Couldn't ask Ada", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  if (unavailable) {
    return (
      <div className="panel-empty">
        <IconSparkle />
        <p>Ada isn't available on this relay.</p>
      </div>
    );
  }

  const tasks = poll.data?.tasks ?? [];
  return (
    <div className="ada">
      <BotStatusLine snapshot={poll.data} error={poll.error} />
      <form
        className="ada-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          className="input ada-input"
          placeholder="Ask Ada to…"
          value={text}
          rows={3}
          maxLength={2000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          data-testid="ada-input"
        />
        <div className="ada-chips">
          {ADA_QUICK_PROMPTS.map((p) => (
            <button key={p} type="button" className="chip" onClick={() => setText(p)}>
              {p}
            </button>
          ))}
        </div>
        <button className="btn btn-ada" type="submit" disabled={busy || !text.trim()}>
          <IconSend /> {busy ? "Sending…" : "Ask Ada"}
          <kbd>⌘↵</kbd>
        </button>
      </form>
      <div className="ada-feed" aria-live="polite">
        {tasks.length === 0 && <div className="muted ada-empty">No tasks yet. Ada is waiting for instructions.</div>}
        {tasks.map((task) => (
          <article key={task.id} className={`task task-card-${task.status}`}>
            <header className="task-head">
              <TaskPill status={task.status} />
              <span className="task-who">{task.requestedBy.name}</span>
              <span className="muted task-time">{timeAgo(task.updatedAt)}</span>
            </header>
            <div className="task-instruction">{task.instruction}</div>
            {task.message && <div className="task-message">{task.message}</div>}
            <TaskCounts task={task} />
          </article>
        ))}
      </div>
    </div>
  );
}
