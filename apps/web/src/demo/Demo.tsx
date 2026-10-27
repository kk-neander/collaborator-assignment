import { useEffect, useMemo, useState } from "react";
import { AdaStrip } from "../ada/AdaStrip.tsx";
import { fetchChaosState, fetchInspect, fetchInvites, type Invite } from "../api.ts";
import { userColor } from "../env.ts";
import { Avatar } from "../ui/Avatar.tsx";
import { usePoll } from "../ui/hooks.ts";
import { IconBrain, IconExternal, IconMoon, IconReload, IconSun } from "../ui/icons.tsx";
import { useTheme } from "../ui/theme.ts";
import { ChaosGlobal, UserChaos } from "./ChaosControls.tsx";
import { DivergenceMeter } from "./DivergenceMeter.tsx";
import { summarize, userState, type ClientSyncStatus } from "./meter.ts";

const USER_STATE_LABEL: Record<ClientSyncStatus, string> = { match: "in sync", behind: "catching up", diverged: "diverged" };

export function Demo() {
  const [invites, setInvites] = useState<Invite[]>();
  const [inviteError, setInviteError] = useState<string>();
  const [reloads, setReloads] = useState<Record<string, number>>({});
  const [theme, toggleTheme] = useTheme();
  const inspect = usePoll(fetchInspect, 1_000);
  const chaos = usePoll(fetchChaosState, 1_000);
  const summary = useMemo(() => (inspect.data ? summarize(inspect.data) : undefined), [inspect.data]);

  useEffect(() => {
    document.title = "Split Brain — live demo";
    fetchInvites()
      .then(setInvites)
      .catch((err: unknown) => setInviteError(err instanceof Error ? err.message : String(err)));
  }, []);

  const humans = (invites ?? []).filter((i) => i.user.kind === "human").slice(0, 3);
  const maya = (invites ?? []).find((i) => i.user.id === "maya") ?? humans[0];
  const chaosState = chaos.data ?? null;

  return (
    <div className={`demo${summary?.state === "split" ? " demo-split" : ""}`}>
      <header className="demo-top">
        <a className="demo-brand" href="/" title="Split Brain">
          <IconBrain className="brand-icon" />
          <span>
            Split Brain
            <small>3 humans · 1 AI · 1 file</small>
          </span>
        </a>
        <DivergenceMeter summary={summary} error={inspect.error} />
        <AdaStrip mayaToken={maya?.token} />
        {chaosState && <ChaosGlobal state={chaosState} onChanged={chaos.refresh} />}
        <button className="icon-btn demo-theme" onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme">
          {theme === "dark" ? <IconSun /> : <IconMoon />}
        </button>
      </header>

      {inviteError && (
        <div className="center-screen">
          <div className="center-card">
            <h1>Can't start the demo</h1>
            <p className="error-text">{inviteError}</p>
            <p className="muted">The demo needs the relay's demo invites (DEMO_INVITES=on).</p>
          </div>
        </div>
      )}

      {!inviteError && (
        <div className="demo-frames" style={{ ["--cols" as string]: String(Math.max(1, humans.length || 3)) }}>
          {humans.length === 0 && (
            <div className="center-screen">
              <span className="spinner" />
            </div>
          )}
          {humans.map((inv) => {
            const state = summary ? userState(summary, inv.user.id) : undefined;
            const chaosUser = chaosState?.users.find((u) => u.userId === inv.user.id);
            const src = `/?token=${encodeURIComponent(inv.token)}&embed=1`;
            return (
              <section key={inv.user.id} className="frame-col" style={{ ["--user" as string]: userColor(inv.user) }} data-testid={`frame-col-${inv.user.id}`}>
                <div className="frame-head">
                  <Avatar user={inv.user} size={24} />
                  <span className="frame-name">{inv.user.name}</span>
                  <span className={`frame-state frame-state-${state ?? "none"}`}>{state ? USER_STATE_LABEL[state] : "no report yet"}</span>
                  <span className="topbar-spacer" />
                  <button
                    className="icon-btn"
                    title={`Reload ${inv.user.name}'s tab`}
                    aria-label={`Reload ${inv.user.name}`}
                    onClick={() => setReloads((r) => ({ ...r, [inv.user.id]: (r[inv.user.id] ?? 0) + 1 }))}
                  >
                    <IconReload />
                  </button>
                  <a className="icon-btn" href={src.replace("&embed=1", "")} target="_blank" rel="noreferrer" title={`Open as ${inv.user.name} in a new tab`} aria-label={`Open ${inv.user.name} in a new tab`}>
                    <IconExternal />
                  </a>
                </div>
                {chaosState && <UserChaos userId={inv.user.id} name={inv.user.name} state={chaosUser} onChanged={chaos.refresh} />}
                <iframe
                  key={reloads[inv.user.id] ?? 0}
                  name={`sb-${inv.user.id}`}
                  title={`${inv.user.name}'s editor`}
                  src={src}
                  allow="clipboard-read; clipboard-write"
                  data-testid={`frame-${inv.user.id}`}
                />
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
