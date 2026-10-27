import { describe, expect, it } from "vitest";
import { Authorship } from "../src/authorship.ts";
import { fromEdit } from "../src/text-operation.ts";

describe("authorship", () => {
  it("tracks inserts and deletes", () => {
    const a = new Authorship(5);
    a.apply(fromEdit(5, 2, 0, "XY"), "maya");
    a.apply(fromEdit(7, 0, 1, ""), "dev");
    a.apply(fromEdit(6, 6, 0, "!"), "ada");
    expect(a.spans()).toEqual([
      { start: 0, end: 1, authorId: "seed" },
      { start: 1, end: 3, authorId: "maya" },
      { start: 3, end: 6, authorId: "seed" },
      { start: 6, end: 7, authorId: "ada" },
    ]);
  });
});
