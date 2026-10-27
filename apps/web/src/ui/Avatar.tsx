import { initials, userColor } from "../env.ts";

export function Avatar({ user, size = 24, ring }: { user: { id: string; name: string; color?: string; kind?: string }; size?: number; ring?: string }) {
  const color = userColor(user);
  return (
    <span
      className={`avatar${user.kind === "bot" ? " avatar-bot" : ""}`}
      title={user.name}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: color, boxShadow: ring ? `0 0 0 2px var(--bg), 0 0 0 4px ${ring}` : undefined }}
    >
      {user.kind === "bot" ? "✦" : initials(user.name)}
    </span>
  );
}
