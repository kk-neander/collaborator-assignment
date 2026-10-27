import type { User } from "@split-brain/protocol";
import { useEffect, useState } from "react";
import { AdaPanel } from "../ada/AdaPanel.tsx";
import { fetchBotTasks, fetchIncidents, fetchInvites, fetchRequirements, type Incident, type Requirement, type RunsSnapshot, type Severity } from "../api.ts";
import { isActive } from "../ada/common.tsx";
import { Avatar } from "../ui/Avatar.tsx";
import { timeAgo, usePoll, useTick, type PollState } from "../ui/hooks.ts";
import { RunPanel } from "./RunPanel.tsx";

export type SidebarTab = "incidents" | "ceo" | "ada" | "run";
type Tab = SidebarTab;

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "incidents", label: "#incidents" },
  { id: "ceo", label: "CEO wants" },
  { id: "ada", label: "Ask Ada" },
  { id: "run", label: "Run" },
];

export interface SidebarProps {
  token: string;
  tab: Tab;
  onTab(tab: Tab): void;
  runs: PollState<RunsSnapshot>;
}

export function Sidebar({ token, tab, onTab, runs }: SidebarProps) {
  const incidents = usePoll(fetchIncidents, 15_000);
  const requirements = usePoll(fetchRequirements, 60_000);
  const bot = usePoll(fetchBotTasks, 1_500, tab !== "ada");
  const adaBusy = bot.data?.tasks.some(isActive) ?? false;
  const sev1 = (incidents.data ?? []).filter((i) => i.severity === "sev1").length;
  const team = useTeam();
  const running = runs.data?.runs.some((r) => r.status === "running") ?? false;
  const visible = TABS.filter(
    (t) => (t.id !== "incidents" || (incidents.data?.length ?? 0) > 0) && (t.id !== "ceo" || (requirements.data?.length ?? 0) > 0),
  );
  const loaded = incidents.data !== undefined && requirements.data !== undefined;
  useEffect(() => {
    if (loaded && !visible.some((t) => t.id === tab)) onTab("ada");
  }, [loaded, visible, tab, onTab]);

  return (
    <aside className="sidebar" aria-label="Team">
      <div className="tabs" role="tablist">
        {visible.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab${tab === t.id ? " tab-active" : ""}`} onClick={() => onTab(t.id)} data-testid={`tab-${t.id}`}>
            {t.label}
            {t.id === "incidents" && sev1 > 0 && <span className="tab-badge">{sev1}</span>}
            {t.id === "ada" && adaBusy && tab !== "ada" && <span className="tab-dot" title="Ada is working" />}
            {t.id === "run" && running && tab !== "run" && <span className="tab-dot tab-dot-run" title="A run is in progress" />}
          </button>
        ))}
      </div>
      <div className="sidebar-body">
        {tab === "incidents" && <IncidentsPanel data={incidents.data} error={incidents.error} team={team} />}
        {tab === "ceo" && <RequirementsPanel />}
        {tab === "ada" && <AdaPanel token={token} />}
        {tab === "run" && <RunPanel token={token} runs={runs} />}
      </div>
    </aside>
  );
}

function useTeam(): Map<string, User> {
  const [team, setTeam] = useState(() => new Map<string, User>());
  useEffect(() => {
    fetchInvites()
      .then((list) => setTeam(new Map(list.map((i) => [i.user.name, i.user]))))
      .catch(() => {
      });
  }, []);
  return team;
}

const SEV_RANK: Record<Severity, number> = { sev1: 0, sev2: 1, sev3: 2 };

export function sortIncidents(list: Incident[]): Incident[] {
  return [...list].sort((a, b) => {
    const s = (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9);
    if (s !== 0) return s;
    return (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0);
  });
}

export function RichText({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
          <code key={i} className="inline-code">
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function IncidentsPanel({ data, error, team }: { data: Incident[] | undefined; error: Error | undefined; team: Map<string, User> }) {
  useTick(30_000);
  if (error && !data) return <PanelError what="incidents" error={error} />;
  if (!data) return <PanelLoading />;
  if (data.length === 0) return <div className="panel-empty">No incidents. Suspiciously quiet.</div>;
  return (
    <div className="channel">
      <div className="channel-head">
        <span className="channel-name">#incidents</span>
        <span className="muted">{data.length} open</span>
      </div>
      {sortIncidents(data).map((inc) => (
        <article key={inc.id} className={`incident sev-${inc.severity}`} data-testid={`incident-${inc.id}`}>
          <Avatar user={team.get(inc.reporter?.name) ?? { id: inc.reporter?.name ?? inc.id, name: inc.reporter?.name ?? "?" }} size={30} />
          <div className="incident-main">
            <header className="incident-meta">
              <span className="incident-who">{inc.reporter?.name}</span>
              {inc.reporter?.role && <span className="incident-role">{inc.reporter.role}</span>}
              <time className="incident-time" dateTime={inc.at} title={new Date(inc.at).toLocaleString()}>
                {timeAgo(Date.parse(inc.at) || Date.now())}
              </time>
            </header>
            <div className="incident-title">
              <span className={`sev-pill sev-pill-${inc.severity}`}>{inc.severity.toUpperCase()}</span>
              <span className="incident-id">{inc.id}</span>
              {inc.title}
            </div>
            <p className="incident-body">
              <RichText text={inc.body ?? ""} />
            </p>
          </div>
        </article>
      ))}
    </div>
  );
}

function RequirementsPanel() {
  const { data, error } = usePoll(fetchRequirements, 30_000);
  if (error && !data) return <PanelError what="requirements" error={error} />;
  if (!data) return <PanelLoading />;
  const rule = data.filter((r) => r.id === "RULE");
  const wants = data.filter((r) => r.id !== "RULE");
  if (data.length === 0) return <div className="panel-empty">The CEO hasn't asked for anything… yet.</div>;
  return <RequirementsList wants={wants} rule={rule} />;
}

export function RequirementsList({ wants, rule }: { wants: Requirement[]; rule: Requirement[] }) {
  return (
    <div className="ceo">
      <h2 className="ceo-title">The CEO wants</h2>
      <ol className="ceo-list">
        {wants.map((r) => (
          <li key={r.id} className="ceo-item" data-testid={`req-${r.id}`}>
            <div className="ceo-item-title">{r.title}</div>
            {r.detail && <div className="ceo-item-detail">{r.detail}</div>}
          </li>
        ))}
      </ol>
      {rule.map((r) => (
        <div key={r.id} className="callout" role="note" data-testid="req-RULE">
          <div className="callout-label">The rule</div>
          <div className="callout-title">{r.title}</div>
          {r.detail && (
            <div className="callout-detail">
              <RichText text={r.detail} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function PanelLoading() {
  return (
    <div className="panel-empty">
      <span className="spinner" />
    </div>
  );
}

function PanelError({ what, error }: { what: string; error: Error }) {
  return (
    <div className="panel-empty error-text">
      Couldn't load {what}: {error.message}
    </div>
  );
}
