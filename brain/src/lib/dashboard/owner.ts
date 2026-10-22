import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isOwnerSecret } from "../auth";
import { sha256 } from "../crypto";
import type { Deps } from "../deps";
import { config } from "../env";
import { LOGIN_PATH } from "./guard";
import { SESSION_COOKIE, sessionCookieOptions, sessionSecretFromEnv, signSession, verifySession } from "./session";

/** Node-side session helpers for dashboard server components and server actions. */

export const LOGIN_MAX_ATTEMPTS = 10;
export const LOGIN_WINDOW_SECONDS = 15 * 60;

export async function hasOwnerSession(): Promise<boolean> {
  const jar = await cookies();
  return verifySession(jar.get(SESSION_COOKIE)?.value, sessionSecretFromEnv());
}

/** Use at the top of every dashboard page and server action (middleware already checked; this is defense in depth). */
export async function requireOwnerSession(): Promise<void> {
  if (!(await hasOwnerSession())) redirect(LOGIN_PATH);
}

export type LoginResult = { ok: true } | { ok: false; error: string };

/**
 * Check the owner secret and, on success, set the signed session cookie.
 * Attempts are limited per IP (hashed) so the login form cannot be used to brute-force OWNER_SECRET.
 */
export async function loginWithOwnerSecret(deps: Deps, candidate: string, ip: string, now = new Date()): Promise<LoginResult> {
  const secret = sessionSecretFromEnv();
  if (!secret) return { ok: false, error: "Sign-in is turned off: set SESSION_SECRET (32+ characters) on the server." };
  const attempts = await deps.kv.incrWithTtl(`${config.redisPrefix()}:dashlogin:${sha256(ip)}`, LOGIN_WINDOW_SECONDS);
  if (attempts > LOGIN_MAX_ATTEMPTS) return { ok: false, error: "Too many attempts. Wait 15 minutes and try again." };
  let valid = false;
  try {
    valid = candidate.length > 0 && candidate.length <= 512 && isOwnerSecret(candidate);
  } catch {
    return { ok: false, error: "Sign-in is turned off: OWNER_SECRET is not configured on the server." };
  }
  if (!valid) return { ok: false, error: "That owner secret didn't match." };
  const token = await signSession(secret, now);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token.value, sessionCookieOptions(token.expiresAt));
  return { ok: true };
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}
