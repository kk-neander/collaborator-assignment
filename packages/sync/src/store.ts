export interface DurableStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  list(prefix: string): Array<[string, string]>;
}

export class MemoryStore implements DurableStore {
  private readonly data = new Map<string, string>();

  get(key: string): string | undefined {
    return this.data.get(key);
  }
  set(key: string, value: string): void {
    this.data.set(key, value);
  }
  delete(key: string): void {
    this.data.delete(key);
  }
  list(prefix: string): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const [k, v] of this.data) if (k.startsWith(prefix)) out.push([k, v]);
    return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
  size(): number {
    return this.data.size;
  }
}

export interface LocalStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): string[];
}

export class MemoryLocalStore implements LocalStore {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  keys(): string[] {
    return [...this.data.keys()];
  }
}

export function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
