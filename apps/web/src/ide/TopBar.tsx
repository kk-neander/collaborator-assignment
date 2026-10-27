import type { User } from "@split-brain/protocol";
import type { ClientCore, ClientStatus } from "@split-brain/sync";
import { useEffect, useRef, useState } from "react";
import { createInvite, type RunRecord } from "../api.ts";
import { copyText, inviteLink } from "../env.ts";
import { Avatar } from "../ui/Avatar.tsx";
import { useTick } from "../ui/hooks.ts";
import { IconBrain, IconLink, IconLogout, IconMoon, IconSun } from "../ui/icons.tsx";
import type { Theme } from "../ui/theme.ts";
import { useToast } from "../ui/toasts.tsx";
import { formatDuration, RunPill } from "./RunPanel.tsx";

export interface TopBarProps {
  client: ClientCore;
  token: string;
  user: User | undefined;
  status: ClientStatus;
  path: string | null;
  docId: string | null;
  peers: User[];
  embed: boolean;
  theme: Theme;
  onToggleTheme(): void;
  onLeave(): void;
  lastRun?: RunRecord;
  onShowRuns?(): void;
}

const STATUS_LABEL: Record<ClientStatus, string> = { online: "online", connecting: "connecting", offline: "offline" };

export function TopBar(props: TopBarProps) {
  const { client, user, status, path, docId, peers, embed } = props;
  useTick(250);
  const [, bump] = useState(0);
  useEffect(() => client.on("change", (changed) => changed === docId && bump((n) => n + 1)), [client, docId]);
  const pending = client.pendingCount();
  const revision = docId ? client.revision(docId) : 0;
  const segments = path ? path.split("/") : [];

  return (
    <header className="topbar">
      {!embed && (
        <a className="topbar-brand" href="/demo" title="Split Brain demo">
          <IconBrain className="brand-icon" />
          <span>Split Brain</span>
        </a>
      )}
      <nav className="crumbs" aria-label="File path" data-testid="file-path">
        {segments.length === 0 ? (
          <span className="muted">No file open</span>
        ) : (
          segments.map((seg, i) => (
            <span key={i} className={i === segments.length - 1 ? "crumb crumb-last" : "crumb"}>
              {seg}
            </span>
          ))
        )}
      </nav>
      <div className="topbar-spacer" />
      {peers.length > 0 && (
        <div className="peers" aria-label="Also in this file">
          {peers.map((p) => (
            <Avatar key={p.id} user={p} size={22} />
          ))}
        </div>
      )}
      <span className={`status-pill status-${status}`} data-testid="connection-status" title={`Connection: ${STATUS_LABEL[status]}`}>
        <span className="status-dot" />
        {STATUS_LABEL[status]}
      </span>
      <span className="metric" title="Server revision of this file" data-testid="revision">
        rev <b>{revision}</b>
      </span>
      <span className={`metric ${pending > 0 ? "metric-hot" : ""}`} title="Local changes not yet confirmed by the relay" data-testid="pending">
        {pending > 0 ? (
          <>
            <b>{pending}</b> pending
          </>
        ) : (
          "synced"
        )}
      </span>
      {!embed && props.lastRun && (
        <button
          className="last-run"
          onClick={props.onShowRuns}
          title={`Last run: ${props.lastRun.command === "test" ? "tests" : "type-check"} by ${props.lastRun.requestedBy.name}${props.lastRun.durationMs !== undefined ? ` in ${formatDuration(props.lastRun.durationMs)}` : ""}`}
          data-testid="last-run"
        >
          <span className="last-run-label">{props.lastRun.command === "test" ? "tests" : "types"}</span>
          <RunPill status={props.lastRun.status} />
        </button>
      )}
      {!embed && <InviteButton token={props.token} />}
      {!embed && (
        <button className="icon-btn" onClick={props.onToggleTheme} title={props.theme === "dark" ? "Switch to light" : "Switch to dark"} aria-label="Toggle theme">
          {props.theme === "dark" ? <IconSun /> : <IconMoon />}
        </button>
      )}
      <UserChip user={user} onLeave={props.onLeave} />
    </header>
  );
}

function UserChip({ user, onLeave }: { user: User | undefined; onLeave(): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (!user) return <span className="user-chip muted">…</span>;
  return (
    <div className="user-chip-wrap" ref={ref}>
      <button className="user-chip" onClick={() => setOpen((o) => !o)} data-testid="user-chip" aria-haspopup="menu" aria-expanded={open}>
        <Avatar user={user} size={22} />
        <span className="user-chip-name">{user.name}</span>
      </button>
      {open && (
        <div className="menu menu-right" role="menu">
          <div className="menu-note">
            Signed in as <b>{user.name}</b>
          </div>
          <button className="menu-item" role="menuitem" onClick={onLeave}>
            <IconLogout /> Leave session
          </button>
        </div>
      )}
    </div>
  );
}

function InviteButton({ token }: { token: string }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [link, setLink] = useState<string>();
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const create = async () => {
    setBusy(true);
    try {
      const invite = await createInvite(token, name.trim() || "Guest");
      const url = inviteLink(invite.token);
      setLink(url);
      const copied = await copyText(url);
      toast(
        copied
          ? { tone: "success", title: "Invite link copied", message: `Send it to ${invite.user.name}.` }
          : { tone: "info", title: "Invite link created", message: "Copy it from the box." },
      );
    } catch (err) {
      toast({ tone: "error", title: "Couldn't create invite", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="invite-wrap" ref={ref}>
      <button
        className="btn btn-primary btn-sm"
        onClick={() => {
          setOpen((o) => !o);
          setLink(undefined);
        }}
        data-testid="invite-button"
      >
        <IconLink /> Invite someone
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Invite someone">
          <div className="popover-title">Invite someone to this session</div>
          <form
            className="popover-row"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <input className="input" placeholder="Their name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus />
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
              {busy ? "…" : "Create link"}
            </button>
          </form>
          {link && (
            <div className="popover-row">
              <input className="input input-mono" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn btn-sm" type="button" onClick={() => void copyText(link).then((ok) => ok && toast({ tone: "success", title: "Copied" }))}>
                Copy
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
