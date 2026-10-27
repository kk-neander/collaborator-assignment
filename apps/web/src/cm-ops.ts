import { ChangeSet } from "@codemirror/state";
import { baseLength, normalize, type TextOp } from "@split-brain/sync";

export interface PlainChange {
  from: number;
  to: number;
  insert: string;
}

export const LINE_SEPARATOR = "\n";

export function changeSetToTextOp(changes: ChangeSet): TextOp {
  const op: TextOp = [];
  let pos = 0;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (fromA > pos) op.push(fromA - pos);
    const text = inserted.sliceString(0, inserted.length, LINE_SEPARATOR);
    if (text.length > 0) op.push(text);
    if (toA > fromA) op.push(-(toA - fromA));
    pos = toA;
  });
  if (changes.length > pos) op.push(changes.length - pos);
  return normalize(op);
}

export function textOpToChanges(op: TextOp): PlainChange[] {
  const out: PlainChange[] = [];
  let pos = 0;
  for (const c of op) {
    if (typeof c === "string") {
      const last = out[out.length - 1];
      if (last && last.to === pos) last.insert += c;
      else out.push({ from: pos, to: pos, insert: c });
    } else if (c > 0) {
      pos += c;
    } else if (c < 0) {
      const last = out[out.length - 1];
      if (last && last.to === pos) last.to = pos - c;
      else out.push({ from: pos, to: pos - c, insert: "" });
      pos -= c;
    }
  }
  return out;
}
export function textOpToChangeSet(op: TextOp, docLength: number): ChangeSet {
  const expected = baseLength(op);
  if (expected !== docLength) {
    throw new RangeError(`operation expects length ${expected}, editor has ${docLength}`);
  }
  return ChangeSet.of(textOpToChanges(op), docLength, LINE_SEPARATOR);
}
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
export function diffToTextOp(oldText: string, newText: string): TextOp {
  const max = Math.min(oldText.length, newText.length);
  let start = 0;
  while (start < max && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++;
  if (start > 0 && start < oldText.length && isHighSurrogate(oldText.charCodeAt(start - 1))) start--;
  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > start && endNew > start && oldText.charCodeAt(endOld - 1) === newText.charCodeAt(endNew - 1)) {
    endOld--;
    endNew--;
  }
  if (endOld < oldText.length && endNew < newText.length && isLowSurrogate(oldText.charCodeAt(endOld))) {
    endOld++;
    endNew++;
  }
  const op: TextOp = [];
  if (start > 0) op.push(start);
  if (endNew > start) op.push(newText.slice(start, endNew));
  if (endOld > start) op.push(-(endOld - start));
  if (oldText.length > endOld) op.push(oldText.length - endOld);
  return normalize(op);
}
export function editEndPosition(op: TextOp): number | undefined {
  let pos = 0;
  let end: number | undefined;
  for (const c of op) {
    if (typeof c === "string") {
      pos += c.length;
      end = pos;
    } else if (c > 0) {
      pos += c;
    } else if (c < 0) {
      end = pos;
    }
  }
  return end;
}