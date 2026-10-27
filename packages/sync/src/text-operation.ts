export type Component = number | string;
export type TextOp = Component[];

export function isRetain(c: Component): c is number {
  return typeof c === "number" && c > 0;
}
export function isDelete(c: Component): c is number {
  return typeof c === "number" && c < 0;
}
export function isInsert(c: Component): c is string {
  return typeof c === "string";
}

export function baseLength(op: TextOp): number {
  let n = 0;
  for (const c of op) {
    if (isRetain(c)) n += c;
    else if (isDelete(c)) n -= c;
  }
  return n;
}

export function targetLength(op: TextOp): number {
  let n = 0;
  for (const c of op) {
    if (isRetain(c)) n += c;
    else if (isInsert(c)) n += c.length;
  }
  return n;
}

function push(op: TextOp, c: Component): void {
  if (c === 0 || c === "") return;
  const last = op[op.length - 1];
  if (last === undefined) {
    op.push(c);
    return;
  }
  if (isRetain(c) && isRetain(last)) {
    op[op.length - 1] = last + c;
  } else if (isDelete(c) && isDelete(last)) {
    op[op.length - 1] = last + c;
  } else if (isInsert(c) && isInsert(last)) {
    op[op.length - 1] = last + c;
  } else if (isInsert(c) && isDelete(last)) {
    const prev = op[op.length - 2];
    if (prev !== undefined && isInsert(prev)) {
      op[op.length - 2] = prev + c;
    } else {
      op.splice(op.length - 1, 0, c);
    }
  } else {
    op.push(c);
  }
}

export function normalize(op: TextOp): TextOp {
  const out: TextOp = [];
  for (const c of op) push(out, c);
  return out;
}

export function isNoop(op: TextOp): boolean {
  return op.every((c) => isRetain(c));
}

export class OperationError extends Error {}

export function apply(text: string, op: TextOp): string {
  if (baseLength(op) !== text.length) {
    throw new OperationError(`operation expects length ${baseLength(op)}, document has ${text.length}`);
  }
  let pos = 0;
  const parts: string[] = [];
  for (const c of op) {
    if (isRetain(c)) {
      if (pos + c > text.length) throw new OperationError("retain past end of document");
      parts.push(text.slice(pos, pos + c));
      pos += c;
    } else if (isInsert(c)) {
      parts.push(c);
    } else {
      pos -= c;
      if (pos > text.length) throw new OperationError("delete past end of document");
    }
  }
  return parts.join("");
}

export function invert(text: string, op: TextOp): TextOp {
  let pos = 0;
  const out: TextOp = [];
  for (const c of op) {
    if (isRetain(c)) {
      push(out, c);
      pos += c;
    } else if (isInsert(c)) {
      push(out, -c.length);
    } else {
      push(out, text.slice(pos, pos - c));
      pos -= c;
    }
  }
  return normalize(out);
}

export function fromEdit(docLength: number, pos: number, deleteCount: number, insert: string): TextOp {
  if (pos < 0 || deleteCount < 0 || pos + deleteCount > docLength) {
    throw new OperationError(`edit out of range: pos=${pos} delete=${deleteCount} length=${docLength}`);
  }
  const out: TextOp = [];
  push(out, pos);
  push(out, insert);
  push(out, -deleteCount);
  push(out, docLength - pos - deleteCount);
  return out;
}

class Cursor {
  private i = 0;
  private offset = 0;
  private readonly op: TextOp;
  constructor(op: TextOp) {
    this.op = op;
  }

  peek(): Component | undefined {
    const c = this.op[this.i];
    if (c === undefined) return undefined;
    if (this.offset === 0) return c;
    if (isRetain(c)) return c - this.offset;
    if (isDelete(c)) return c + this.offset;
    return c.slice(this.offset);
  }

  take(n?: number): Component | undefined {
    const c = this.peek();
    if (c === undefined) return undefined;
    const size = isInsert(c) ? c.length : Math.abs(c);
    if (n === undefined || n >= size) {
      this.i += 1;
      this.offset = 0;
      return c;
    }
    this.offset += n;
    if (isRetain(c)) return n;
    if (isDelete(c)) return -n;
    return c.slice(0, n);
  }
}

export function compose(a: TextOp, b: TextOp): TextOp {
  if (targetLength(a) !== baseLength(b)) {
    throw new OperationError("compose: length mismatch");
  }
  const out: TextOp = [];
  const ca = new Cursor(a);
  const cb = new Cursor(b);
  for (;;) {
    const x = ca.peek();
    const y = cb.peek();
    if (x === undefined && y === undefined) break;
    if (x !== undefined && isDelete(x)) {
      push(out, ca.take()!);
      continue;
    }
    if (y !== undefined && isInsert(y)) {
      push(out, cb.take()!);
      continue;
    }
    if (x === undefined || y === undefined) throw new OperationError("compose: ran off the end");
    const sx = isInsert(x) ? x.length : x;
    const sy = Math.abs(y as number);
    const n = Math.min(sx, sy);
    const px = ca.take(n)!;
    const py = cb.take(n)!;
    if (isRetain(px) && isRetain(py)) push(out, n);
    else if (isInsert(px) && isRetain(py)) push(out, px);
    else if (isRetain(px) && isDelete(py)) push(out, -n);
  }
  return normalize(out);
}

export function transform(a: TextOp, b: TextOp, aFirst = true): [TextOp, TextOp] {
  if (baseLength(a) !== baseLength(b)) {
    throw new OperationError("transform: base length mismatch");
  }
  const a2: TextOp = [];
  const b2: TextOp = [];
  const ca = new Cursor(a);
  const cb = new Cursor(b);
  for (;;) {
    const x = ca.peek();
    const y = cb.peek();
    if (x === undefined && y === undefined) break;
    if (!aFirst && x !== undefined && isInsert(x) && y !== undefined && isInsert(y)) {
      push(a2, y.length);
      push(b2, y);
      cb.take();
      continue;
    }
    if (x !== undefined && isInsert(x)) {
      push(a2, x);
      push(b2, x.length);
      ca.take();
      continue;
    }
    if (y !== undefined && isInsert(y)) {
      push(a2, y.length);
      push(b2, y);
      cb.take();
      continue;
    }
    if (x === undefined || y === undefined) throw new OperationError("transform: ran off the end");
    const n = Math.min(Math.abs(x), Math.abs(y));
    const px = ca.take(n) as number;
    const py = cb.take(n) as number;
    if (isRetain(px) && isRetain(py)) {
      push(a2, n);
      push(b2, n);
    } else if (isDelete(px) && isRetain(py)) {
      push(a2, -n);
    } else if (isRetain(px) && isDelete(py)) {
      push(b2, -n);
    }
  }
  return [normalize(a2), normalize(b2)];
}
export function transformPosition(pos: number, op: TextOp, stickLeft = false): number {
  let index = 0;
  let out = pos;
  for (const c of op) {
    if (index > pos) break;
    if (isRetain(c)) {
      index += c;
    } else if (isInsert(c)) {
      if (index < pos || (index === pos && !stickLeft)) out += c.length;
    } else {
      out -= Math.min(-c, Math.max(0, pos - index));
      index -= c;
    }
  }
  return out;
}
export function isValidOp(value: unknown): value is TextOp {
  if (!Array.isArray(value)) return false;
  return value.every(
    (c) => (typeof c === "number" && Number.isInteger(c) && c !== 0) || (typeof c === "string" && c.length > 0),
  );
}