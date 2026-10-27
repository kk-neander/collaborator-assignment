import { userColor } from "../env.ts";
import type { MeterSummary } from "./meter.ts";

const STATUS_TEXT = { match: "in sync", behind: "behind", diverged: "DIVERGED" } as const;

export function DivergenceMeter({ summary, error }: { summary: MeterSummary | undefined; error: Error | undefined }) {
  const state = error && !summary ? "error" : (summary?.state ?? "waiting");
  const focus = summary?.focus;
  let headline: string;
  let detail = "";
  switch (state) {
    case "split":
      headline = `SPLIT BRAIN — ${focus?.versions ?? 2} versions of ${focus?.path ?? "a file"}`;
      detail = summary && summary.splitDocs > 1 ? `and ${summary.splitDocs - 1} more file${summary.splitDocs > 2 ? "s" : ""}` : "Copies disagree at the same revision.";
      break;
    case "catching-up":
      headline = "Catching up";
      detail = "Some copies are a few edits behind.";
      break;
    case "in-sync":
      headline = "In sync";
      detail = "Every copy matches the relay.";
      break;
    case "error":
      headline = "Relay unreachable";
      detail = error?.message ?? "";
      break;
    default:
      headline = "Waiting for editors…";
      detail = "Hashes are reported every 2 s.";
  }
  return (
    <section className={`meter meter-${state}`} aria-live="polite" data-testid="divergence-meter" data-state={state}>
      <div className="meter-banner">
        <span className="meter-light" aria-hidden="true" />
        <div className="meter-text">
          <div className="meter-headline" data-text={headline}>
            {headline}
          </div>
          <div className="meter-detail">{detail}</div>
        </div>
      </div>
      {summary && summary.docs.length > 0 && (
        <ul className="meter-docs">
          {summary.docs.slice(0, 4).map((d) => (
            <li key={d.docId} className={`meter-doc meter-doc-${d.state}`}>
              <span className="meter-path" title={`${d.path} @ rev ${d.revision}`}>
                {d.path}
              </span>
              <span className="meter-rev">r{d.revision}</span>
              <span className="meter-dots">
                {d.clients.map((c) => (
                  <span
                    key={c.clientId}
                    className={`meter-dot dot-${c.status}`}
                    style={{ ["--user" as string]: userColor(c.user) }}
                    title={`${c.user.name}: ${STATUS_TEXT[c.status]} (rev ${c.revision}, hash ${c.hash})`}
                    data-status={c.status}
                  >
                    {c.user.kind === "bot" ? "✦" : c.user.name.slice(0, 1)}
                  </span>
                ))}
              </span>
            </li>
          ))}
          {summary.docs.length > 4 && <li className="meter-more muted">+{summary.docs.length - 4} more files</li>}
        </ul>
      )}
    </section>
  );
}
