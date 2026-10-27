import { getUser } from "./users.ts";

export interface Note {
  id: number;
  authorId: string;
  text: string;
  createdAt: number;
}

const notes: Note[] = [];
let nextId = 1;

export function createNote(authorId: string, text: string, now = Date.now()): Note {
  if (!getUser(authorId)) throw new Error(`unknown user ${authorId}`);
  const note = { id: nextId++, authorId, text: text.trim(), createdAt: now };
  notes.push(note);
  return note;
}

// TODO(ai): add pagination (limit + cursor) to listNotes
export function listNotes(): Note[] {
  return [...notes].sort((a, b) => b.createdAt - a.createdAt);
}

export function resetNotes(): void {
  notes.length = 0;
  nextId = 1;
}
