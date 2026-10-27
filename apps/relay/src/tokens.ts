import { createHmac, timingSafeEqual } from "node:crypto";
import type { User } from "@split-brain/protocol";

export interface InvitePayload {
  room: string;
  user: User;
  exp: number;
}

export class TokenError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

export function signInvite(payload: InvitePayload, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  const mac = createHmac("sha256", secret).update(body).digest();
  return `${body}.${b64url(mac)}`;
}

function decodePayload(body: string): InvitePayload {
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)))) as InvitePayload;
  } catch {
    throw new TokenError("expired", "invite token expired");
  }
}

export function verifyInvite(token: string, secret: string, now: number): InvitePayload {
  const [body, mac] = token.split(".");
  if (!body || !mac) throw new TokenError("malformed", "invite token is malformed");
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new TokenError("bad_signature", "invite token signature does not match");
  }
  const payload = decodePayload(body);
  if (typeof payload.exp !== "number" || payload.exp < now) throw new TokenError("expired", "invite token expired");
  return payload;
}
