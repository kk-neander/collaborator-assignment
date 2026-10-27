import { useEffect, useState } from "react";
import { fetchInvites, type Invite } from "../api.ts";
import { userColor } from "../env.ts";
import { Avatar } from "../ui/Avatar.tsx";
import { IconBrain } from "../ui/icons.tsx";

const VERSIONS: Array<{ who: string; color: string; code: string }> = [
  { who: "Maya", color: "#e5484d", code: "export function createNote(authorId: string, text: string) {" },
  { who: "Dev", color: "#3e63dd", code: "export function createNote(author: string, body: string, now = Date.now()) {" },
  { who: "Priya", color: "#30a46c", code: "export async function createNote(authorId: string, text = \"\") {" },
  { who: "Ada (AI)", color: "#8e4ec6", code: "export function addNote(authorId: UserId, text: NonEmpty<string>) {" },
];

export function Landing() {
  const [invites, setInvites] = useState<Invite[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetchInvites()
      .then(setInvites)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const humans = (invites ?? []).filter((i) => i.user.kind === "human");

  return (
    <div className="landing">
      <div className="landing-glow" aria-hidden="true" />
      <header className="landing-nav">
        <span className="brand">
          <IconBrain className="brand-icon" /> Split Brain
        </span>
        <a className="nav-link" href="/demo">
          Live demo →
        </a>
      </header>
      <main className="landing-main">
        <h1 className="landing-title">
          <span className="glitch" data-text="Split Brain">
            Split Brain
          </span>
          <span className="landing-dash"> — </span>
          <span className="landing-sub">
            3 humans. 1 AI. <em>4 versions of the same file.</em>
          </span>
        </h1>
        <p className="landing-lede">
          A live multiplayer IDE where Maya, Dev, Priya and Ada (AI) edit the same code at the same time. Every keystroke races
          every other one. When the copies stop agreeing, you get a split brain.
        </p>

        <div className="versions" aria-hidden="true">
          {VERSIONS.map((v, i) => (
            <div key={v.who} className="version-line" style={{ animationDelay: `${i * 120}ms`, borderColor: v.color }}>
              <span className="version-who" style={{ color: v.color }}>
                {v.who}
              </span>
              <code>{v.code}</code>
            </div>
          ))}
          <div className="version-stamp">SPLIT BRAIN</div>
        </div>

        <div className="landing-actions">
          <a className="btn btn-hero" href="/demo">
            Open the 3-person demo
            <span className="btn-hero-hint">Maya, Dev and Priya side by side</span>
          </a>
          <div className="join">
            <div className="join-label">or join as</div>
            <div className="join-buttons">
              {humans.map((inv) => (
                <a key={inv.user.id} className="btn btn-join" href={`/?token=${encodeURIComponent(inv.token)}`} style={{ ["--user" as string]: userColor(inv.user) }}>
                  <Avatar user={inv.user} size={22} />
                  {inv.user.name}
                </a>
              ))}
              {!invites && !error && <span className="muted">Loading invites…</span>}
              {error && <span className="error-text">Couldn't load invites: {error}</span>}
              {invites && humans.length === 0 && <span className="muted">This relay has demo invites turned off. Ask a teammate for an invite link.</span>}
            </div>
          </div>
        </div>
        <ul className="features">
          <li>
            <b>Live, character by character</b>
            <span>Operational transforms over one WebSocket. Every caret and selection, in color.</span>
          </li>
          <li>
            <b>Break the network on purpose</b>
            <span>Partition a teammate, add 800 ms of lag, skew their clock — then watch the divergence meter.</span>
          </li>
          <li>
            <b>Ada refactors while you type</b>
            <span>Ask the AI to rename across files and keep typing in the same lines. Who wins?</span>
          </li>
        </ul>
      </main>
      <footer className="landing-foot muted">Everything runs on your laptop. No accounts, no cloud.</footer>
    </div>
  );
}
