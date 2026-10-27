import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { apply, baseLength, compose, fromEdit, invert, transform, transformPosition, type TextOp } from "../src/text-operation.ts";

const alphabet = fc.constantFrom("a", "b", "c", " ", "\n", "🫠", "é", "語");
const docArb = fc.array(alphabet, { maxLength: 30 }).map((parts) => parts.join(""));

function opFor(doc: string): fc.Arbitrary<TextOp> {
  const boundaries: number[] = [0];
  for (let i = 0; i < doc.length; ) {
    i += doc.codePointAt(i)! > 0xffff ? 2 : 1;
    boundaries.push(i);
  }
  return fc
    .record({
      start: fc.constantFrom(...boundaries),
      len: fc.integer({ min: 0, max: 6 }),
      insert: fc.array(alphabet, { maxLength: 4 }).map((p) => p.join("")),
    })
    .map(({ start, len, insert }) => {
      const end = boundaries.filter((b) => b >= start)[Math.min(len, boundaries.filter((b) => b >= start).length - 1)]!;
      return fromEdit(doc.length, start, end - start, insert);
    });
}

const docAndTwoOps = docArb.chain((doc) => fc.tuple(fc.constant(doc), opFor(doc), opFor(doc)));

describe("text operations", () => {
  it("fromEdit + apply edits the right range", () => {
    expect(apply("hello world", fromEdit(11, 6, 5, "there"))).toBe("hello there");
    expect(apply("🫠x", fromEdit(3, 2, 1, "y"))).toBe("🫠y");
  });

  it("transform converges (TP1)", () => {
    fc.assert(
      fc.property(docAndTwoOps, ([doc, a, b]) => {
        const [a2, b2] = transform(a, b);
        expect(apply(apply(doc, a), b2)).toBe(apply(apply(doc, b), a2));
      }),
      { numRuns: 2000 },
    );
  });

  it("puts the first op's insert first on a tie", () => {
    const a = fromEdit(3, 1, 0, "A");
    const b = fromEdit(3, 1, 0, "B");
    const [, b2] = transform(a, b);
    expect(apply(apply("xyz", a), b2)).toBe("xAByz");
  });

  it("compose equals sequential apply", () => {
    fc.assert(
      fc.property(
        docArb.chain((doc) => opFor(doc).chain((a) => fc.tuple(fc.constant(doc), fc.constant(a), opFor(apply(doc, a))))),
        ([doc, a, b]) => {
          expect(apply(doc, compose(a, b))).toBe(apply(apply(doc, a), b));
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("invert undoes", () => {
    fc.assert(
      fc.property(docArb.chain((doc) => fc.tuple(fc.constant(doc), opFor(doc))), ([doc, op]) => {
        expect(apply(apply(doc, op), invert(doc, op))).toBe(doc);
      }),
    );
  });

  it("rejects ops for a different length", () => {
    expect(() => apply("abc", fromEdit(4, 0, 0, "x"))).toThrow();
    expect(baseLength(fromEdit(4, 0, 0, "x"))).toBe(4);
  });

  it("moves cursors past inserts before them", () => {
    expect(transformPosition(5, fromEdit(10, 2, 0, "abc"))).toBe(8);
    expect(transformPosition(1, fromEdit(10, 2, 0, "abc"))).toBe(1);
    expect(transformPosition(5, fromEdit(10, 2, 2, ""))).toBe(3);
  });
});
