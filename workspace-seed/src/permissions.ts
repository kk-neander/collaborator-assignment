import type { Note } from "./notes.ts";
import { getUser } from "./users.ts";

export function canEdit(userId: string, note: Note): boolean {
  const user = getUser(userId);
  if (!user) return false;
  // Authors can edit their own notes; admins can edit anything.
  return user.role === "admin" || note.authorId === user.id;
}
