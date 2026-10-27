import { useState } from "react";
import { HttpError, startRun, type RunCommand, type RunRecord, type RunsSnapshot, type RunStatus } from "../api.ts";
import { timeAgo, useTick, type PollState } from "../ui/hooks.ts";
import { IconCheck, IconChevron, IconPlay, IconX } from "../ui/icons.tsx";
import { useToast } from "../ui/toasts.tsx";

const COMMAND_LABEL: Record<RunCommand, string> = { test: "Tests", typecheck: "Type-check" };
const STATUS_LABEL: Record<RunStatus, string> = { running: "running", passed: "passed", failed: "failed", error: "error" };

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function RunPill({ status }: { status: RunStatus }) {
  return (
    <span className={`run-pill run-${status}`}>
      {status === "running" && <span className="spinner spinner-xs" />}
      {status === "passed" && <IconCheck />}
      {(status === "failed" || status === "error") && <IconX />}
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function RunPanel({ token, runs }: { token: string; runs: PollState<RunsSnapshot> }) {
  const toast = useToast();
  useTick(1_000);
  const [inFlight, setInFlight] = useState<RunCommand | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const notOnRelay = runs.error instanceof HttpError && runs.error.status === 404;
  const configured = !notOnRelay && (runs.data?.runnerConfigured ?? false);
  const list = runs.data?.runs ?? [];

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const start = async (command: RunCommand) => {
    if (inFlight) return;
    setInFlight(command);
    const early = setTimeout(() => runs.refresh(), 300);
    try {
      const record = await startRun(token, command);
      setOpen((prev) => new Set(prev).add(record.id));
      toast(
        record.status === "passed"
          ? { tone: "success", title: `${COMMAND_LABEL[command]} passed`, message: formatDuration(record.durationMs) }
          : { tone: "error", title: `${COMMAND_LABEL[command]} ${record.status}`, message: firstLines(record.output) },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast({ tone: "error", title: err instanceof HttpError && err.status === 503 ? "Runner offline" : "Run failed to start", message });
    } finally {
      clearTimeout(early);
      setInFlight(null);
      runs.refresh();
    }
  };

  return (
    <div className="run">
      <div className="run-actions">
        <button className="btn btn-run" onClick={() => void start("test")} disabled={!configured || inFlight !== null} data-testid="run-tests">
          {inFlight === "test" ? <span className="spinner spinner-xs" /> : <IconPlay />} Run tests
        </button>
        <button className="btn btn-run btn-run-alt" onClick={() => void start("typecheck")} disabled={!configured || inFlight !== null} data-testid="run-typecheck">
          {inFlight === "typecheck" ? <span className="spinner spinner-xs" /> : <IconCheck />} Type-check
        </button>
      </div>
      {!runs.data && !runs.error && (
        <div className="run-status muted">
          <span className="spinner spinner-xs" /> Checking the runner…
        </div>
      )}
      {(notOnRelay || (runs.data && !configured)) && (
        <div className="run-status" data-testid="runner-offline">
          <span className="status-dot status-dot-off" /> Runner offline
        </div>
      )}
      {runs.error && !notOnRelay && <div className="run-status error-text">Couldn't load runs: {runs.error.message}</div>}
      {inFlight && (
        <div className="run-status muted">
          Running {COMMAND_LABEL[inFlight].toLowerCase()} on a snapshot of every file… this takes 5–20 s.
        </div>
      )}

      <div className="run-feed" data-testid="run-feed">
        {list.length === 0 && runs.data && configured && <div className="muted run-empty">No runs yet. Press a button — everyone sees the result.</div>}
        {list.map((r) => (
          <RunItem key={r.id} run={r} open={open.has(r.id)} onToggle={() => toggle(r.id)} />
        ))}
      </div>
    </div>
  );
}

function RunItem({ run, open, onToggle }: { run: RunRecord; open: boolean; onToggle(): void }) {
  const duration = run.status === "running" ? formatDuration(Date.now() - run.at) : formatDuration(run.durationMs);
  return (
    <article className={`run-item run-item-${run.status}${open ? " open" : ""}`} data-testid={`run-${run.id}`}>
      <button className="run-item-head" onClick={onToggle} aria-expanded={open}>
        <RunPill status={run.status} />
        <span className="run-item-cmd">{COMMAND_LABEL[run.command] ?? run.command}</span>
        <span className="run-item-who">{run.requestedBy.name}</span>
        <span className="run-item-meta muted">
          {timeAgo(run.at)}
          {duration && ` · ${duration}`}
        </span>
        <IconChevron className={`run-item-chevron${open ? " open" : ""}`} />
      </button>
      {open && (
        <div className="run-item-body">
          <div className="run-item-facts muted">
            {run.files !== undefined && <span>{run.files} files</span>}
            {run.exitCode !== undefined && <span>exit code {run.exitCode}</span>}
            <span>{new Date(run.at).toLocaleTimeString()}</span>
          </div>
          <pre className="run-output">{run.status === "running" ? "Still running…" : run.output?.trim() || "(no output)"}</pre>
        </div>
      )}
    </article>
  );
}

function firstLines(output: string | undefined): string {
  if (!output) return "See the Run tab for details.";
  const lines = output.trim().split("\n");
  const interesting = lines.filter((l) => /fail|error|✗|×/i.test(l)).slice(0, 3);
  return (interesting.length ? interesting : lines.slice(-3)).join("\n").slice(0, 300);
}
