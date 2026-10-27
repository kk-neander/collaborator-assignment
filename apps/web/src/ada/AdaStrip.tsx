import { useState } from "react";
import { ADA_QUICK_PROMPTS, fetchBotTasks, HttpError, postBotTask } from "../api.ts";
import { usePoll } from "../ui/hooks.ts";
import { IconSparkle } from "../ui/icons.tsx";
import { useToast } from "../ui/toasts.tsx";
import { BotStatusLine, isActive, TaskPill } from "./common.tsx";

const LOOSE_INSTRUCTION = ADA_QUICK_PROMPTS[0];

export function AdaStrip({ mayaToken }: { mayaToken: string | undefined }) {
  const toast = useToast();
  const poll = usePoll(fetchBotTasks, 1_500);
  const [busy, setBusy] = useState(false);
  if (poll.error instanceof HttpError && poll.error.status === 404) return null;

  const latest = poll.data?.tasks[0];
  const running = poll.data?.tasks.some(isActive) ?? false;

  const loose = async () => {
    if (!mayaToken) return;
    setBusy(true);
    try {
      await postBotTask(mayaToken, LOOSE_INSTRUCTION);
      poll.refresh();
      toast({ tone: "info", title: "Ada is on it", message: `Maya asked: “${LOOSE_INSTRUCTION}”. Keep typing!` });
    } catch (err) {
      toast({ tone: "error", title: "Couldn't wake Ada", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ada-strip" aria-label="Ada (AI)">
      <div className="ada-strip-top">
        <BotStatusLine snapshot={poll.data} error={poll.error} compact />
        <button className="btn btn-ada btn-sm" onClick={() => void loose()} disabled={busy || !mayaToken} title={`Posts “${LOOSE_INSTRUCTION}” as Maya`} data-testid="let-ada-loose">
          <IconSparkle /> {running ? "Ada is working…" : "Let Ada loose"}
        </button>
      </div>
      {latest ? (
        <div className="ada-strip-task">
          <TaskPill status={latest.status} />
          <span className="ada-strip-text" title={latest.message ?? latest.instruction}>
            <b>{latest.requestedBy.name}:</b> {latest.instruction}
            {latest.message && <span className="muted"> — {latest.message}</span>}
          </span>
        </div>
      ) : (
        <div className="ada-strip-task muted">No tasks yet.</div>
      )}
    </section>
  );
}
