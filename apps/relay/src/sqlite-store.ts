import { DatabaseSync } from "node:sqlite";
import type { DurableStore } from "@split-brain/sync";

export class SqliteStore implements DurableStore {
  private readonly db: DatabaseSync;
  private readonly getStmt;
  private readonly setStmt;
  private readonly delStmt;
  private readonly listStmt;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.getStmt = this.db.prepare("SELECT value FROM kv WHERE key = ?");
    this.setStmt = this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    this.delStmt = this.db.prepare("DELETE FROM kv WHERE key = ?");
    this.listStmt = this.db.prepare("SELECT key, value FROM kv WHERE key >= ? AND key < ? ORDER BY key");
  }

  get(key: string): string | undefined {
    const row = this.getStmt.get(key) as { value: string } | undefined;
    return row?.value;
  }

  set(key: string, value: string): void {
    this.setStmt.run(key, value);
  }

  delete(key: string): void {
    this.delStmt.run(key);
  }

  list(prefix: string): Array<[string, string]> {
    const rows = this.listStmt.all(prefix, `${prefix}￿`) as Array<{ key: string; value: string }>;
    return rows.map((r) => [r.key, r.value]);
  }

  close(): void {
    this.db.close();
  }
}
