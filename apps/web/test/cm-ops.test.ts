import { ChangeSet, EditorState, Text } from "@codemirror/state";
import { apply, compose, fromEdit, normalize, type TextOp } from "@split-brain/sync";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  changeSetToTextOp,
  diffToTextOp,
  editEndPosition,
  LINE_SEPARATOR,
  textOpToChanges,
  textOpToChangeSet,
} from "../src/cm-ops.ts";

const alphabet = fc.constantFrom("a", "b", "Z", " ", "\n", "\r", "\r\n", "\t", "🫠", "👩‍💻", "é", "é", "語", "{", "}");
const docArb = fc.array(alphabet, { maxLength: 40 }).map((parts) => parts.join(""));
const insertArb = fc.array(alphabet, { maxLength: 5 }).map((parts) => parts.join(""));

function cmText(doc: string): Text {
  return Text.of(doc.split(LINE_SEPARATOR));
}

function cmString(text: Text): string {
  return text.sliceString(0, text.length, LINE_SEPARATOR);
}

function editFor(doc: string): fc.Arbitrary<TextOp> {
  return fc
    .record({ a: fc.integer({ min: 0, max: doc.length }), b: fc.integer({ min: 0, max: doc.length }), insert: insertArb })
    .map(({ a, b, insert }) => fromEdit(doc.length, Math.min(a, b), Math.abs(a - b), insert));
}

function opFor(doc: string): fc.Arbitrary<TextOp> {
  const step = (text: string, op: TextOp, left: number): fc.Arbitrary<TextOp> => {
    if (left === 0) return fc.constant(op);
    return editFor(text).chain((e) => step(apply(text, e), compose(op, e), left - 1));
  };
  return fc.integer({ min: 1, max: 4 }).chain((n) => editFor(doc).chain((first) => step(apply(doc, first), first, n - 1)));
}

function changeSetFor(doc: string): fc.Arbitrary<ChangeSet> {
  return fc
    .array(
      fc.record({ a: fc.integer({ min: 0, max: doc.length }), b: fc.integer({ min: 0, max: doc.length }), insert: insertArb }),
      { minLength: 1, maxLength: 5 },
    )
    .map((specs) => {
      const sorted = specs
        .map((s) => ({ from: Math.min(s.a, s.b), to: Math.max(s.a, s.b), insert: s.insert }))
        .sort((x, y) => x.from - y.from);
      const ranges: { from: number; to: number; insert: string }[] = [];
      let end = -1;
      for (const r of sorted) {
        if (r.from <= end) continue;
        ranges.push(r);
        end = r.to;
      }
      return ChangeSet.of(ranges, doc.length, LINE_SEPARATOR);
    });
}

describe("cm-ops", () => {
  it("converts a simple CodeMirror insert, delete and replace", () => {
    const doc = "hello world";
    expect(changeSetToTextOp(ChangeSet.of({ from: 5, insert: "," }, doc.length))).toEqual([5, ",", 6]);
    expect(changeSetToTextOp(ChangeSet.of({ from: 0, to: 6 }, doc.length))).toEqual([-6, 5]);
    expect(changeSetToTextOp(ChangeSet.of({ from: 6, to: 11, insert: "🫠" }, doc.length))).toEqual([6, "🫠", -5]);
  });

  it("converts a TextOp into old-document ranges, merging insert+delete into a replace", () => {
    expect(textOpToChanges([2, "xy", -3, 4])).toEqual([{ from: 2, to: 5, insert: "xy" }]);
    expect(textOpToChanges([-1, 1, "a", 2, -2])).toEqual([
      { from: 0, to: 1, insert: "" },
      { from: 2, to: 2, insert: "a" },
      { from: 4, to: 6, insert: "" },
    ]);
  });

  it("keeps \\r as an ordinary character", () => {
    const doc = "a\r\nb\rc";
    const set = textOpToChangeSet(fromEdit(doc.length, 1, 1, "X\r"), doc.length);
    expect(cmString(set.apply(cmText(doc)))).toBe(apply(doc, fromEdit(doc.length, 1, 1, "X\r")));
    const state = EditorState.create({ doc, extensions: EditorState.lineSeparator.of(LINE_SEPARATOR) });
    expect(state.doc.length).toBe(doc.length);
    expect(state.sliceDoc()).toBe(doc);
  });

  it("rejects an op whose base length does not match the editor", () => {
    expect(() => textOpToChangeSet([3, "x"], 4)).toThrow(RangeError);
  });

  it("TextOp → CM changes → document equals TextOp apply", () => {
    fc.assert(
      fc.property(
        docArb.chain((doc) => fc.tuple(fc.constant(doc), opFor(doc))),
        ([doc, op]) => {
          const set = textOpToChangeSet(op, doc.length);
          expect(cmString(set.apply(cmText(doc)))).toBe(apply(doc, op));
        },
      ),
      { numRuns: 3000 },
    );
  });

  it("TextOp → CM changes → TextOp round-trips to the normalized op", () => {
    fc.assert(
      fc.property(
        docArb.chain((doc) => fc.tuple(fc.constant(doc), opFor(doc))),
        ([doc, op]) => {
          const back = changeSetToTextOp(textOpToChangeSet(op, doc.length));
          expect(back).toEqual(normalize(op));
          expect(apply(doc, back)).toBe(apply(doc, op));
        },
      ),
      { numRuns: 3000 },
    );
  });

  it("CM ChangeSet → TextOp applies identically, and maps back to the same ChangeSet", () => {
    fc.assert(
      fc.property(
        docArb.chain((doc) => fc.tuple(fc.constant(doc), changeSetFor(doc))),
        ([doc, set]) => {
          const op = changeSetToTextOp(set);
          expect(apply(doc, op)).toBe(cmString(set.apply(cmText(doc))));
          const again = textOpToChangeSet(op, doc.length);
          expect(cmString(again.apply(cmText(doc)))).toBe(cmString(set.apply(cmText(doc))));
          expect(changeSetToTextOp(again)).toEqual(op);
        },
      ),
      { numRuns: 3000 },
    );
  });

  it("works through a real EditorState transaction (including emoji typed mid-document)", () => {
    fc.assert(
      fc.property(
        docArb.chain((doc) =>
          changeSetFor(doc).chain((set) =>
            opFor(cmString(set.apply(cmText(doc)))).map((remote) => [doc, set, remote] as const),
          ),
        ),
        ([doc, set, remote]) => {
          const ext = EditorState.lineSeparator.of(LINE_SEPARATOR);
          let state = EditorState.create({ doc, extensions: ext });
          const local = state.update({ changes: set });
          const op = changeSetToTextOp(local.changes);
          state = local.state;
          let mirror = apply(doc, op);
          expect(state.sliceDoc()).toBe(mirror);
          state = state.update({ changes: textOpToChanges(remote) }).state;
          mirror = apply(mirror, remote);
          expect(state.sliceDoc()).toBe(mirror);
          expect(state.doc.length).toBe(mirror.length);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("diffToTextOp produces a minimal op that never splits a surrogate pair", () => {
    fc.assert(
      fc.property(docArb, docArb, (a, b) => {
        const op = diffToTextOp(a, b);
        expect(apply(a, op)).toBe(b);
        let pos = 0;
        for (const c of op) {
          if (typeof c === "number" && c > 0) pos += c;
          else if (typeof c === "number") pos -= c;
          const code = a.charCodeAt(pos);
          if (pos > 0 && pos < a.length) expect(code >= 0xdc00 && code <= 0xdfff).toBe(false);
        }
      }),
      { numRuns: 3000 },
    );
    expect(diffToTextOp("ab🫠cd", "ab🙂cd")).toEqual([2, "🙂", -2, 2]);
    expect(diffToTextOp("same", "same")).toEqual([4]);
  });

  it("editEndPosition points just after the last edit in the new document", () => {
    expect(editEndPosition([3, "abc", 4])).toBe(6);
    expect(editEndPosition([3, -2, 4])).toBe(3);
    expect(editEndPosition([1, "x", 2, -1, 3])).toBe(4);
    expect(editEndPosition([5])).toBeUndefined();
  });
});
