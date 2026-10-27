import type { TreeChange, TreeNode } from "@split-brain/protocol";
import { ROOT_ID, type ClientCore, type FileTree as Tree } from "@split-brain/sync";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { setSessionJson, sessionJson, uuid } from "../env.ts";
import {
  IconChevron,
  IconFile,
  IconFilePlus,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconMove,
  IconPencil,
  IconTrash,
  IconX,
} from "../ui/icons.tsx";
import { useToast } from "../ui/toasts.tsx";

export interface FileTreeProps {
  client: ClientCore;
  treeVersion: number;
  ready: boolean;
  selectedId: string | null;
  onOpen(id: string): void;
  onCreated(id: string): void;
}

type Editing = { mode: "rename"; id: string } | { mode: "create"; parentId: string; kind: "file" | "dir" } | null;

function sortedChildren(tree: Tree, parentId: string): TreeNode[] {
  return tree
    .children(parentId)
    .sort((a, b) => (a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true })));
}

function folderOf(tree: Tree, id: string | null): string {
  if (!id) return ROOT_ID;
  const node = tree.get(id);
  if (!node || !tree.isLive(id)) return ROOT_ID;
  if (node.kind === "dir") return node.id;
  return node.parentId ?? ROOT_ID;
}

function isInside(tree: Tree, id: string, ancestorId: string): boolean {
  let cur = tree.get(id);
  while (cur) {
    if (cur.id === ancestorId) return true;
    if (cur.parentId === null) return false;
    cur = tree.get(cur.parentId);
  }
  return false;
}

export function FileTree({ client, treeVersion, ready, selectedId, onOpen, onCreated }: FileTreeProps) {
  const toast = useToast();
  const tree = client.fileTree();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(sessionJson<string[]>("sb:collapsed", [])));
  const [focusId, setFocusId] = useState<string | null>(selectedId);
  const [editing, setEditing] = useState<Editing>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [moveId, setMoveId] = useState<string | null>(null);

  useEffect(() => setSessionJson("sb:collapsed", [...collapsed]), [collapsed]);
  useEffect(() => {
    if (selectedId) setFocusId(selectedId);
  }, [selectedId]);
  useEffect(() => {
    if (editing?.mode === "rename" && !tree.isLive(editing.id)) setEditing(null);
    if (editing?.mode === "create" && !tree.isLive(editing.parentId)) setEditing(null);
  }, [treeVersion, editing, tree]);

  const send = (change: TreeChange) => client.changeTree(change);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const startCreate = (kind: "file" | "dir", parentId = folderOf(tree, focusId)) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(parentId);
      return next;
    });
    setEditing({ mode: "create", parentId, kind });
  };

  const commitCreate = (parentId: string, kind: "file" | "dir", name: string) => {
    setEditing(null);
    const clean = name.trim();
    if (!clean) return;
    const id = `${kind === "file" ? "f" : "d"}_${uuid().replace(/-/g, "").slice(0, 16)}`;
    send(kind === "file" ? { type: "create", id, parentId, name: clean, kind, text: "" } : { type: "create", id, parentId, name: clean, kind });
    if (kind === "file") onCreated(id);
  };

  const commitRename = (id: string, name: string) => {
    setEditing(null);
    const clean = name.trim();
    const node = tree.get(id);
    if (!clean || !node || clean === node.name) return;
    send({ type: "rename", id, name: clean });
  };

  const remove = (id: string) => {
    const node = tree.get(id);
    if (!node) return;
    send({ type: "delete", id });
    toast({
      tone: "info",
      title: `Deleted ${node.name}`,
      message: tree.path(id),
      action: { label: "Restore", run: () => send({ type: "restore", id }) },
      durationMs: 8_000,
    });
  };

  const openMenu = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    setFocusId(id);
    setMenu({ id, x: e.clientX, y: e.clientY });
  };

  const onRowKey = (e: KeyboardEvent, node: TreeNode) => {
    if (e.key === "F2") {
      e.preventDefault();
      setEditing({ mode: "rename", id: node.id });
    } else if (e.key === "Delete") {
      e.preventDefault();
      remove(node.id);
    }
  };

  const renderNodes = (parentId: string, depth: number): ReactNode => {
    const nodes = sortedChildren(tree, parentId);
    const creating = editing?.mode === "create" && editing.parentId === parentId ? editing : null;
    return (
      <>
        {creating && (
          <div className="tree-row tree-row-editing" style={{ paddingLeft: 10 + depth * 14 }}>
            <span className="tree-icon">{creating.kind === "dir" ? <IconFolder /> : <IconFile />}</span>
            <NameInput
              initial=""
              placeholder={creating.kind === "dir" ? "folder name" : "file name"}
              onCommit={(name) => commitCreate(parentId, creating.kind, name)}
              onCancel={() => setEditing(null)}
            />
          </div>
        )}
        {nodes.map((node) => {
          const isDir = node.kind === "dir";
          const open = isDir && !collapsed.has(node.id);
          const renaming = editing?.mode === "rename" && editing.id === node.id;
          return (
            <div key={node.id} role="none">
              {renaming ? (
                <div className="tree-row tree-row-editing" style={{ paddingLeft: 10 + depth * 14 }}>
                  <span className="tree-icon">{isDir ? <IconFolder /> : <IconFile />}</span>
                  <NameInput initial={node.name} onCommit={(name) => commitRename(node.id, name)} onCancel={() => setEditing(null)} />
                </div>
              ) : (
                <div
                  className={`tree-row${node.id === selectedId ? " tree-row-selected" : ""}${node.id === focusId ? " tree-row-focus" : ""}`}
                  style={{ paddingLeft: 10 + depth * 14 }}
                  onContextMenu={(e) => openMenu(e, node.id)}
                  data-testid={`tree-row-${tree.path(node.id)}`}
                  data-node-id={node.id}
                >
                  <button
                    className="tree-main"
                    role="treeitem"
                    aria-expanded={isDir ? open : undefined}
                    aria-selected={node.id === selectedId}
                    onClick={() => {
                      setFocusId(node.id);
                      if (isDir) toggle(node.id);
                      else onOpen(node.id);
                    }}
                    onDoubleClick={() => setEditing({ mode: "rename", id: node.id })}
                    onKeyDown={(e) => onRowKey(e, node)}
                    title={tree.path(node.id)}
                  >
                    {isDir ? <IconChevron className={`tree-chevron${open ? " open" : ""}`} /> : <span className="tree-chevron-pad" />}
                    <span className={`tree-icon ${isDir ? "tree-icon-dir" : `tree-icon-file ext-${extOf(node.name)}`}`}>
                      {isDir ? open ? <IconFolderOpen /> : <IconFolder /> : <IconFile />}
                    </span>
                    <span className="tree-name">{node.name}</span>
                  </button>
                  <span className="tree-actions">
                    {isDir && (
                      <button className="tree-act" title="New file here" aria-label={`New file in ${node.name}`} onClick={() => startCreate("file", node.id)}>
                        <IconFilePlus />
                      </button>
                    )}
                    <button className="tree-act" title="Rename (F2)" aria-label={`Rename ${node.name}`} onClick={() => setEditing({ mode: "rename", id: node.id })}>
                      <IconPencil />
                    </button>
                    <button className="tree-act" title="Move to…" aria-label={`Move ${node.name}`} onClick={() => setMoveId(node.id)}>
                      <IconMove />
                    </button>
                    <button className="tree-act tree-act-danger" title="Delete" aria-label={`Delete ${node.name}`} onClick={() => remove(node.id)}>
                      <IconTrash />
                    </button>
                  </span>
                </div>
              )}
              {open && renderNodes(node.id, depth + 1)}
            </div>
          );
        })}
      </>
    );
  };

  const menuNode = menu ? tree.get(menu.id) : undefined;

  return (
    <div className="filetree">
      <div className="pane-head">
        <span className="pane-title">Files</span>
        <span className="pane-actions">
          <button className="icon-btn" title="New file" aria-label="New file" onClick={() => startCreate("file")} disabled={!ready} data-testid="new-file">
            <IconFilePlus />
          </button>
          <button className="icon-btn" title="New folder" aria-label="New folder" onClick={() => startCreate("dir")} disabled={!ready} data-testid="new-folder">
            <IconFolderPlus />
          </button>
        </span>
      </div>
      <div className="tree-scroll" role="tree" aria-label="Files">
        {ready ? renderNodes(ROOT_ID, 0) : <div className="tree-empty muted">Connecting…</div>}
        {ready && sortedChildren(tree, ROOT_ID).length === 0 && !editing && <div className="tree-empty muted">No files yet.</div>}
      </div>

      {menu && menuNode && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menuNode.kind === "dir" && (
            <>
              <button className="menu-item" onClick={() => startCreate("file", menuNode.id)}>
                <IconFilePlus /> New file
              </button>
              <button className="menu-item" onClick={() => startCreate("dir", menuNode.id)}>
                <IconFolderPlus /> New folder
              </button>
              <div className="menu-sep" />
            </>
          )}
          <button className="menu-item" onClick={() => setEditing({ mode: "rename", id: menuNode.id })}>
            <IconPencil /> Rename
          </button>
          <button className="menu-item" onClick={() => setMoveId(menuNode.id)}>
            <IconMove /> Move to…
          </button>
          <button className="menu-item menu-item-danger" onClick={() => remove(menuNode.id)}>
            <IconTrash /> Delete
          </button>
        </ContextMenu>
      )}

      {moveId && tree.get(moveId) && (
        <MoveDialog
          tree={tree}
          nodeId={moveId}
          onClose={() => setMoveId(null)}
          onMove={(parentId) => {
            setMoveId(null);
            send({ type: "move", id: moveId, parentId });
          }}
        />
      )}
    </div>
  );
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "none";
}

function NameInput({ initial, placeholder, onCommit, onCancel }: { initial: string; placeholder?: string; onCommit(name: string): void; onCancel(): void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      className="tree-input"
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      aria-label={placeholder ?? "New name"}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(value.trim() !== "" && value !== initial)}
    />
  );
}

function ContextMenu({ x, y, onClose, children }: { x: number; y: number; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const left = Math.min(x, window.innerWidth - 190);
  const top = Math.min(y, window.innerHeight - 200);
  return (
    <div ref={ref} className="menu menu-floating" style={{ left, top }} role="menu" onClick={onClose}>
      {children}
    </div>
  );
}

function MoveDialog({ tree, nodeId, onClose, onMove }: { tree: Tree; nodeId: string; onClose(): void; onMove(parentId: string): void }) {
  const node = tree.get(nodeId)!;
  const folders = [...tree.nodes.values()]
    .filter((n) => n.kind === "dir" && tree.isLive(n.id) && !isInside(tree, n.id, nodeId))
    .map((n) => ({ id: n.id, path: n.id === ROOT_ID ? "/" : `/${tree.path(n.id)}` }))
    .sort((a, b) => a.path.localeCompare(b.path));
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={`Move ${node.name}`}>
        <div className="modal-head">
          <span>
            Move <b>{node.name}</b> to…
          </span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </div>
        <div className="modal-list">
          {folders.map((f) => {
            const current = f.id === node.parentId;
            return (
              <button key={f.id} className="modal-item" disabled={current} onClick={() => onMove(f.id)} data-testid={`move-target-${f.path}`}>
                <IconFolder />
                <span className="mono">{f.path}</span>
                {current && <span className="muted modal-item-note">current</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
