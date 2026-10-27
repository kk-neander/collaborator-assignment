import type { TreeChange, TreeNode } from "@split-brain/protocol";

export const ROOT_ID = "root";

export class TreeError extends Error {}

export class FileTree {
  readonly nodes = new Map<string, TreeNode>();

  constructor(nodes: TreeNode[] = []) {
    if (!nodes.some((n) => n.id === ROOT_ID)) {
      this.nodes.set(ROOT_ID, { id: ROOT_ID, name: "/", parentId: null, kind: "dir" });
    }
    for (const n of nodes) this.nodes.set(n.id, { ...n });
  }

  list(): TreeNode[] {
    return [...this.nodes.values()].map((n) => ({ ...n }));
  }

  get(id: string): TreeNode | undefined {
    return this.nodes.get(id);
  }

  isLive(id: string): boolean {
    let cur = this.nodes.get(id);
    while (cur) {
      if (cur.deleted) return false;
      if (cur.parentId === null) return true;
      cur = this.nodes.get(cur.parentId);
    }
    return false;
  }

  children(parentId: string): TreeNode[] {
    return [...this.nodes.values()].filter((n) => n.parentId === parentId && !n.deleted);
  }

  path(id: string): string {
    const parts: string[] = [];
    let cur = this.nodes.get(id);
    while (cur && cur.parentId !== null) {
      parts.unshift(cur.name);
      cur = this.nodes.get(cur.parentId);
    }
    return parts.join("/");
  }

  findByPath(path: string): TreeNode | undefined {
    for (const n of this.nodes.values()) {
      if (!n.deleted && this.isLive(n.id) && this.path(n.id) === path) return n;
    }
    return undefined;
  }

  private isDescendant(id: string, ancestorId: string): boolean {
    let cur = this.nodes.get(id);
    while (cur) {
      if (cur.id === ancestorId) return true;
      if (cur.parentId === null) return false;
      cur = this.nodes.get(cur.parentId);
    }
    return false;
  }

  private assertNameFree(parentId: string, name: string, exceptId?: string): void {
    if (name.includes("/") || name === "." || name === "..") throw new TreeError(`invalid name "${name}"`);
    if (this.children(parentId).some((n) => n.name === name && n.id !== exceptId)) {
      throw new TreeError(`"${name}" already exists in ${this.path(parentId) || "/"}`);
    }
  }

  private requireDir(id: string): TreeNode {
    const node = this.nodes.get(id);
    if (!node || !this.isLive(id)) throw new TreeError(`folder ${id} does not exist`);
    if (node.kind !== "dir") throw new TreeError(`${this.path(id)} is not a folder`);
    return node;
  }

  validate(change: TreeChange): void {
    switch (change.type) {
      case "create": {
        if (this.nodes.has(change.id)) throw new TreeError(`id ${change.id} already used`);
        this.requireDir(change.parentId);
        this.assertNameFree(change.parentId, change.name);
        return;
      }
      case "rename": {
        const node = this.nodes.get(change.id);
        if (!node || change.id === ROOT_ID || !this.isLive(change.id)) throw new TreeError("node does not exist");
        this.assertNameFree(node.parentId!, change.name, change.id);
        return;
      }
      case "move": {
        const node = this.nodes.get(change.id);
        if (!node || change.id === ROOT_ID || !this.isLive(change.id)) throw new TreeError("node does not exist");
        this.requireDir(change.parentId);
        if (this.isDescendant(change.parentId, change.id)) {
          throw new TreeError(`cannot move ${this.path(change.id)} into itself`);
        }
        this.assertNameFree(change.parentId, node.name, change.id);
        return;
      }
      case "delete": {
        if (change.id === ROOT_ID || !this.isLive(change.id)) throw new TreeError("node does not exist");
        return;
      }
      case "restore": {
        const node = this.nodes.get(change.id);
        if (!node || !node.deleted) throw new TreeError("node is not deleted");
        if (node.parentId === null || !this.isLive(node.parentId)) throw new TreeError("parent folder is gone");
        this.assertNameFree(node.parentId, node.name, change.id);
        return;
      }
    }
  }

  apply(change: TreeChange): void {
    switch (change.type) {
      case "create":
        this.nodes.set(change.id, { id: change.id, name: change.name, parentId: change.parentId, kind: change.kind });
        return;
      case "rename":
        this.nodes.set(change.id, { ...this.nodes.get(change.id)!, name: change.name });
        return;
      case "move":
        this.nodes.set(change.id, { ...this.nodes.get(change.id)!, parentId: change.parentId });
        return;
      case "delete":
        this.nodes.set(change.id, { ...this.nodes.get(change.id)!, deleted: true });
        return;
      case "restore": {
        const { deleted: _deleted, ...rest } = this.nodes.get(change.id)!;
        this.nodes.set(change.id, rest);
        return;
      }
    }
  }
}

export function seedId(prefix: string, path: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${prefix}_${h.toString(36)}`;
}

export function treeFromPaths(paths: string[]): { nodes: TreeNode[]; fileIds: Map<string, string> } {
  const nodes: TreeNode[] = [{ id: ROOT_ID, name: "/", parentId: null, kind: "dir" }];
  const dirIds = new Map<string, string>([["", ROOT_ID]]);
  const fileIds = new Map<string, string>();
  for (const path of [...paths].sort()) {
    const parts = path.split("/");
    let parentPath = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parentPath ? `${parentPath}/${parts[i]}` : parts[i]!;
      if (!dirIds.has(dirPath)) {
        const id = seedId("d", dirPath);
        dirIds.set(dirPath, id);
        nodes.push({ id, name: parts[i]!, parentId: dirIds.get(parentPath)!, kind: "dir" });
      }
      parentPath = dirPath;
    }
    const id = seedId("f", path);
    fileIds.set(path, id);
    nodes.push({ id, name: parts[parts.length - 1]!, parentId: dirIds.get(parentPath)!, kind: "file" });
  }
  return { nodes, fileIds };
}
