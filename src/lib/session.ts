import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";

/**
 * The app has no accounts. Each browser gets a random, httpOnly owner id cookie; lessons are
 * associated with it so a visitor can see and extend their own lessons.
 */
export const OWNER_COOKIE = "tutor_uid";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function readOwnerId(): Promise<string | null> {
  const value = (await cookies()).get(OWNER_COOKIE)?.value;
  return value && UUID_RE.test(value) ? value : null;
}

/** Returns the visitor's owner id, creating (and setting) one on first use. Route handlers only. */
export async function ensureOwnerId(): Promise<string> {
  const existing = await readOwnerId();
  if (existing) return existing;
  const id = randomUUID();
  (await cookies()).set(OWNER_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return id;
}
