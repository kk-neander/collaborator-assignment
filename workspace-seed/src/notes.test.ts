import { beforeEach, describe, expect, it } from "vitest";
import { formatNote } from "./format.ts";
import { createNote, listNotes, resetNotes } from "./notes.ts";
import { canEdit } from "./permissions.ts";

describe("notes", () => {
  beforeEach(() => resetNotes());

  it("creates and lists newest first", () => {
    createNote("u2", "first", 1);
    createNote("u3", "second", 2);
    expect(listNotes().map((n) => n.text)).toEqual(["second", "first"]);
  });

  it("rejects unknown authors", () => {
    expect(() => createNote("nobody", "hi")).toThrow();
  });

  it("formats with the author's name", () => {
    expect(formatNote(createNote("u1", "hello"))).toBe("Maya: hello");
  });

  it("lets authors and admins edit", () => {
    const note = createNote("u2", "mine");
    expect(canEdit("u2", note)).toBe(true);
    expect(canEdit("u1", note)).toBe(true);
    expect(canEdit("u3", note)).toBe(false);
  });
});
