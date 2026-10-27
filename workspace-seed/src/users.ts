export type Role = "member" | "admin";

export interface User {
  id: string;
  name: string;
  role: Role;
}

const users: User[] = [
  { id: "u1", name: "Maya", role: "admin" },
  { id: "u2", name: "Dev", role: "member" },
  { id: "u3", name: "Priya", role: "member" },
];

export function getUser(id: string): User | undefined {
  return users.find((u) => u.id === id);
}

export function listUsers(): User[] {
  return [...users];
}
