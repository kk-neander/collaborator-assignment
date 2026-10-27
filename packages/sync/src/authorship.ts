import { isDelete, isInsert, type TextOp } from "./text-operation.ts";

export interface AuthorRun {
  length: number;
  authorId: string;
}

export class Authorship {
  private runs: AuthorRun[];

  constructor(length: number, authorId = "seed") {
    this.runs = length > 0 ? [{ length, authorId }] : [];
  }

  apply(op: TextOp, authorId: string): void {
    const out: AuthorRun[] = [];
    const push = (length: number, author: string) => {
      if (length <= 0) return;
      const last = out[out.length - 1];
      if (last && last.authorId === author) last.length += length;
      else out.push({ length, authorId: author });
    };
    let i = 0;
    let offset = 0;
    const take = (n: number, keep: boolean) => {
      while (n > 0) {
        const run = this.runs[i];
        if (!run) return;
        const avail = run.length - offset;
        const k = Math.min(avail, n);
        if (keep) push(k, run.authorId);
        n -= k;
        offset += k;
        if (offset === run.length) {
          i++;
          offset = 0;
        }
      }
    };
    for (const c of op) {
      if (isInsert(c)) push(c.length, authorId);
      else if (isDelete(c)) take(-c, false);
      else take(c, true);
    }
    this.runs = out;
  }

  spans(): Array<{ start: number; end: number; authorId: string }> {
    let pos = 0;
    return this.runs.map((r) => {
      const span = { start: pos, end: pos + r.length, authorId: r.authorId };
      pos += r.length;
      return span;
    });
  }
}
