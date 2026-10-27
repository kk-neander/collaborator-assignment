import type { Note } from "./notes.ts";
import { getUser } from "./users.ts";

export function formatNote(note: Note): string {
  const author = getUser(note.authorId)?.name ?? "someone";
  return `${author}: ${note.text}`;
}
