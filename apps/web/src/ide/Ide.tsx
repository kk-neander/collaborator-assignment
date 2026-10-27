import type { User } from "@split-brain/protocol";
import { ROOT_ID, type ClientCore, type ClientStatus, type FileTree as Tree } from "@split-brain/sync";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clearToken, decodeInvite, getClientId, isEmbed, sessionJson, setSessionJson } from "../env.ts";
import type { DocBinding } from "../editor/binding.ts";
import { fetchRuns } from "../api.ts";
import { createSyncSession } from "../sync.ts";
import { usePoll } from "../ui/hooks.ts";
import { useTheme } from "../ui/theme.ts";
import { useToast, type ToastInput } from "../ui/toasts.tsx";
import { EditorPane } from "./EditorPane.tsx";
import { FileTree } from "./FileTree.tsx";
import { Sidebar, type SidebarTab } from "./Sidebar.tsx";
import { TopBar } from "./TopBar.tsx";

const HASH_REPORT_MS = 2_000;
const WARM_DOCS = 12;
const STUCK_AFTER_MS = 8_000;

function isLiveFile(tree: Tree, id: string | null): id is string {
  return !!id && tree.get(id)?.kind === "file" && tree.isLive(id);
}

function firstFile(tree: Tree, parentId = ROOT_ID): string | null {
  const kids = tree
    .children(parentId)
    .sort((a, b) => (a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true })));
  for (const k of kids) {
    if (k.kind === "file") return k.id;
    const inner = firstFile(tree, k.id);
    if (inner) return inner;
  }
  return null;
}

function noticeToast(client: ClientCore, kind: string, message: string, data?: Record<string, unknown>): ToastInput {
  const docId = typeof data?.docId === "string" ? data.docId : undefined;
  const path = docId ? client.fileTree().path(docId) : "";
  const where = path ? `${path}: ` : "";
  switch (kind) {
    case "tree_rejected":
      return { tone: "error", title: "File change rejected", message };
    case "edits_dropped":
      return { tone: "error", title: "Unsynced edits were dropped", message: where + message };
    case "doc_deleted":
      return { tone: "warn", title: "File deleted", message: where + message };
    case "op_rejected":
      return { tone: "error", title: "Edit rejected by the relay", message: where + message };
    default:
      return { tone: "error", title: `Relay: ${kind}`, message: where + message };
  }
}

export function Ide({ token }: { token: string }) {
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const embed = useMemo(isEmbed, []);
  const invite = useMemo(() => decodeInvite(token), [token]);
  const expired = invite?.exp !== undefined && invite.exp < Date.now();

  const [session] = useState(() =>
    createSyncSession({
      token,
      clientId: getClientId(),
      userId: invite?.user?.id,
      onStorageError: (message) => toastRef.current({ tone: "error", title: "Offline edits can't be saved", message }),
    }),
  );
  const client = session.client;
  const [theme, toggleTheme] = useTheme();
  const [status, setStatus] = useState<ClientStatus>(client.getStatus());
  const [user, setUser] = useState<User | undefined>(client.user ?? invite?.user);
  const [treeReady, setTreeReady] = useState(false);
  const [treeVersion, setTreeVersion] = useState(0);
  const [presenceVersion, setPresenceVersion] = useState(0);
  const [selected, setSelected] = useState<string | null>(() => sessionJson<string | null>("sb:selected", null));
  const [generation, setGeneration] = useState<Record<string, number>>({});
  const [stuck, setStuck] = useState(false);
  const warm = useRef<string[]>(sessionJson<string[]>("sb:open", []));
  const liveness = useRef(new Map<string, boolean>());
  const pendingSelect = useRef<string | null>(null);
  const restored = useRef(false);
  const bindingRef = useRef<DocBinding | null>(null);
  const directory = useRef(new Map<string, User>());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [tab, setTab] = useState<SidebarTab>(() => sessionJson<SidebarTab>("sb:tab", "incidents"));
  const chooseTab = (t: SidebarTab) => {
    setTab(t);
    setSessionJson("sb:tab", t);
  };
  const runs = usePoll(fetchRuns, 2_000, !embed);

  useEffect(() => {
    if (expired) return;
    return session.start();
  }, [session, expired]);

  useEffect(() => {
    const offs = [
      client.on("status", (s) => {
        setStatus(s);
        if (client.user) {
          setUser(client.user);
          directory.current.set(client.user.id, client.user);
        }
        if (s === "online") setStuck(false);
        setPresenceVersion((v) => v + 1);
      }),
      client.on("tree", () => {
        setTreeReady(true);
        setTreeVersion((v) => v + 1);
      }),
      client.on("presence", (_docId, cursors) => {
        for (const c of cursors) directory.current.set(c.user.id, c.user);
        setPresenceVersion((v) => v + 1);
      }),
      client.on("notice", (kind, message, data) => toastRef.current(noticeToast(client, kind, message, data))),
    ];
    return () => offs.forEach((off) => off());
  }, [client]);

  useEffect(() => {
    const id = setInterval(() => client.reportHashes(), HASH_REPORT_MS);
    return () => clearInterval(id);
  }, [client]);

  useEffect(() => {
    if (status === "online" || expired) return;
    const timer = setTimeout(() => setStuck(true), STUCK_AFTER_MS);
    return () => clearTimeout(timer);
  }, [status, expired]);

  const persistWarm = () => setSessionJson("sb:open", warm.current);

  const select = useCallback(
    (id: string) => {
      setSelected(id);
      setSessionJson("sb:selected", id);
      warm.current = [id, ...warm.current.filter((x) => x !== id)];
      while (warm.current.length > WARM_DOCS) {
        const victim = warm.current.pop()!;
        client.close(victim);
        liveness.current.delete(victim);
      }
      persistWarm();
      liveness.current.set(id, isLiveFile(client.fileTree(), id));
    },
    [client],
  );

  useEffect(() => {
    if (!treeReady) return;
    const tree = client.fileTree();
    if (!restored.current) {
      restored.current = true;
      warm.current = warm.current.filter((id) => isLiveFile(tree, id));
      for (const id of warm.current) {
        client.open(id);
        liveness.current.set(id, true);
      }
      persistWarm();
      const initial = isLiveFile(tree, selectedRef.current) ? selectedRef.current : firstFile(tree);
      if (initial) select(initial);
      else setSelected(null);
      return;
    }
    if (pendingSelect.current && isLiveFile(tree, pendingSelect.current)) {
      const id = pendingSelect.current;
      pendingSelect.current = null;
      select(id);
    }
    const current = selectedRef.current;
    if (current && !tree.get(current)) {
      const fallback = firstFile(tree);
      if (fallback) select(fallback);
    } else if (!current) {
      const fallback = firstFile(tree);
      if (fallback) select(fallback);
    }
    let changed = false;
    for (const id of new Set([...warm.current, ...(current ? [current] : [])])) {
      const live = isLiveFile(tree, id);
      const was = liveness.current.get(id);
      liveness.current.set(id, live);
      if (was === false && live) {
        client.close(id);
        setGeneration((g) => ({ ...g, [id]: (g[id] ?? 0) + 1 }));
      } else if (was === true && !live && id !== current) {
        client.close(id);
        warm.current = warm.current.filter((x) => x !== id);
        changed = true;
      }
    }
    if (changed) persistWarm();
  }, [treeVersion, treeReady, client, select]);

  useEffect(() => {
    (window as unknown as { __sb?: unknown }).__sb = {
      session,
      client,
      get docId() {
        return selectedRef.current;
      },
      editorText: () => bindingRef.current?.editorText() ?? null,
      clientText: () => (selectedRef.current && client.isReady(selectedRef.current) ? client.text(selectedRef.current) : null),
      binding: () => bindingRef.current,
    };
  }, [session, client]);

  const tree = client.fileTree();
  const path = selected && tree.get(selected) ? tree.path(selected) : null;
  const deleted = !!selected && treeReady && !isLiveFile(tree, selected);
  const peers = useMemo(() => {
    if (!selected) return [];
    const seen = new Map<string, User>();
    for (const c of client.cursors(selected)) if (c.user.id !== user?.id) seen.set(c.user.id, c.user);
    return [...seen.values()];
  }, [selected, presenceVersion, client, user]);

  const leave = () => {
    session.client.stop();
    clearToken();
    window.location.href = embed ? "/?embed=1" : "/";
  };

  if (expired) {
    return (
      <div className="center-screen">
        <div className="center-card">
          <h1>This invite has expired</h1>
          <p className="muted">Ask whoever invited you for a fresh link.</p>
          <button className="btn btn-primary" onClick={leave}>
            Back to start
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`ide${embed ? " ide-embed" : ""}`} data-user={user?.id} style={user ? { ["--me" as string]: user.color ?? "var(--accent)" } : undefined}>
      <TopBar
        client={client}
        token={token}
        user={user}
        status={status}
        path={path}
        docId={selected}
        peers={peers}
        embed={embed}
        theme={theme}
        onToggleTheme={toggleTheme}
        onLeave={leave}
        lastRun={runs.data?.runs[0]}
        onShowRuns={() => chooseTab("run")}
      />
      {stuck && status !== "online" && (
        <div className="banner banner-error" role="alert">
          <span>
            Can't reach the relay{status === "connecting" ? " — still trying" : ""}. If this keeps happening, your invite link may be invalid.
          </span>
          <button className="btn btn-sm" onClick={leave}>
            Back to start
          </button>
        </div>
      )}
      <div className="ide-body">
        <aside className="ide-tree">
          <FileTree
            client={client}
            treeVersion={treeVersion}
            ready={treeReady}
            selectedId={selected}
            onOpen={select}
            onCreated={(id) => {
              pendingSelect.current = id;
            }}
          />
        </aside>
        <main className="ide-editor">
          {selected && path !== null && treeReady ? (
            <EditorPane
              key={`${selected}:${generation[selected] ?? 0}`}
              client={client}
              docId={selected}
              path={path}
              deleted={deleted}
              onRestore={() => client.changeTree({ type: "restore", id: selected })}
              onBinding={(b) => {
                bindingRef.current = b;
              }}
              directory={directory.current}
            />
          ) : (
            <div className="editor-empty">
              {treeReady ? (
                <span className="muted">Pick a file on the left, or create one.</span>
              ) : (
                <span className="muted">
                  <span className="spinner" /> Connecting to the session…
                </span>
              )}
            </div>
          )}
        </main>
        {!embed && <Sidebar token={token} tab={tab} onTab={chooseTab} runs={runs} />}
      </div>
    </div>
  );
}
