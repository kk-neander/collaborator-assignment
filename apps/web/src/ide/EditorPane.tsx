import type { User } from "@split-brain/protocol";
import type { ClientCore } from "@split-brain/sync";
import { useEffect, useRef, useState } from "react";
import { fetchBlame, fetchInspect, fetchInvites } from "../api.ts";
import { isEmbed, syncAssertionsEnabled, userColor } from "../env.ts";
import { DocBinding, type BindingIssueKind } from "../editor/binding.ts";
import { languageLabel } from "../editor/languages.ts";
import { useTick } from "../ui/hooks.ts";
import { IconRedo, IconUndo } from "../ui/icons.tsx";
import { useToast } from "../ui/toasts.tsx";

const ISSUE_TITLE: Record<BindingIssueKind, string> = {
  mismatch: "Editor out of sync with the engine",
  apply_failed: "Edit not applied",
  remote_failed: "Remote edit not applied",
};

export interface EditorPaneProps {
  client: ClientCore;
  docId: string;
  path: string;
  deleted: boolean;
  onRestore(): void;
  onBinding(binding: DocBinding | null): void;
  directory: Map<string, User>;
}

export function EditorPane({ client, docId, path, deleted, onRestore, onBinding, directory }: EditorPaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const onBindingRef = useRef(onBinding);
  onBindingRef.current = onBinding;
  const [binding, setBinding] = useState<DocBinding | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const b = new DocBinding({
      client,
      docId,
      path,
      parent: host.current!,
      colorOf: (user) => userColor(user),
      onIssue: (kind, message) => toastRef.current({ tone: "error", title: ISSUE_TITLE[kind], message }),
      onReady: () => setReady(true),
      assertSync: syncAssertionsEnabled(),
      lineWrapping: isEmbed(),
    });
    setBinding(b);
    setReady(b.isReady());
    onBindingRef.current(b);
    return () => {
      onBindingRef.current(null);
      b.destroy();
      setBinding(null);
    };
  }, [client, docId]);

  useEffect(() => binding?.setPath(path), [binding, path]);
  useEffect(() => binding?.setLocked(deleted), [binding, deleted]);

  return (
    <div className="editor-pane">
      {deleted && (
        <div className="banner banner-warn" role="alert">
          <span>
            <b>{path}</b> was deleted. You're looking at the last synced text.
          </span>
          <button className="btn btn-sm" onClick={onRestore}>
            Restore file
          </button>
        </div>
      )}
      <div className="editor-host" ref={host} data-testid="editor" data-doc-id={docId} />
      {!ready && (
        <div className="editor-loading" aria-live="polite">
          <span className="spinner" /> Loading {path}…
        </div>
      )}
      <EditorStatus binding={binding} path={path} ready={ready} directory={directory} />
    </div>
  );
}

function EditorStatus({ binding, path, ready, directory }: { binding: DocBinding | null; path: string; ready: boolean; directory: Map<string, User> }) {
  useTick(200);
  const pos = binding && ready ? binding.cursorPosition() : null;
  return (
    <div className="editor-status">
      {binding && (
        <span className="editor-status-group">
          <button className="mini-btn" title="Undo your last edit (⌘Z / Ctrl+Z)" aria-label="Undo" onClick={() => binding.undo()} disabled={!ready}>
            <IconUndo />
          </button>
          <button className="mini-btn" title="Redo (⇧⌘Z / Ctrl+Y)" aria-label="Redo" onClick={() => binding.redo()} disabled={!ready}>
            <IconRedo />
          </button>
        </span>
      )}
      {pos && (
        <span className="muted">
          Ln {pos.line}, Col {pos.col}
        </span>
      )}
      <span className="muted">{languageLabel(path)}</span>
      <span className="topbar-spacer" />
      {binding && <BlameToggle binding={binding} directory={directory} />}
    </div>
  );
}

const BLAME_REFRESH_MS = 2_000;

function BlameToggle({ binding, directory }: { binding: DocBinding; directory: Map<string, User> }) {
  const toast = useToast();
  const [on, setOn] = useState(false);
  const [authors, setAuthors] = useState<User[]>([]);

  useEffect(() => {
    if (!on) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void Promise.allSettled([fetchInvites(), fetchInspect()]).then(([inv, insp]) => {
      if (inv.status === "fulfilled") for (const i of inv.value) if (!directory.has(i.user.id)) directory.set(i.user.id, i.user);
      if (insp.status === "fulfilled") for (const c of insp.value.clients) if (!directory.has(c.user.id)) directory.set(c.user.id, c.user);
    });
    const load = async () => {
      try {
        const { spans } = await fetchBlame(binding.docId);
        if (stopped) return;
        const seen = new Map<string, User>();
        const ranges = spans
          .filter((s) => s.authorId !== "seed" && s.end > s.start)
          .map((s) => {
            const user = directory.get(s.authorId) ?? { id: s.authorId, name: s.authorId, kind: "human" as const };
            seen.set(user.id, user);
            return { from: s.start, to: s.end, color: userColor(user), author: user.name };
          });
        binding.setBlame(ranges);
        setAuthors([...seen.values()]);
      } catch (err) {
        if (stopped) return;
        toast({ tone: "error", title: "Blame unavailable", message: err instanceof Error ? err.message : String(err) });
        setOn(false);
        return;
      }
      if (!stopped) timer = setTimeout(load, BLAME_REFRESH_MS);
    };
    void load();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      binding.setBlame(null);
      setAuthors([]);
    };
  }, [on, binding, directory, toast]);

  return (
    <span className="editor-status-group">
      {on &&
        authors.map((a) => (
          <span key={a.id} className="blame-chip" style={{ ["--chip" as string]: userColor(a) }}>
            {a.name}
          </span>
        ))}
      <button className={`mini-btn mini-btn-text${on ? " active" : ""}`} onClick={() => setOn((v) => !v)} aria-pressed={on} title="Tint text by who wrote it">
        Blame
      </button>
    </span>
  );
}
