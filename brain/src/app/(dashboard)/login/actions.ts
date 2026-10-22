"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDeps } from "@/lib/deps";
import { safeNextPath } from "@/lib/dashboard/guard";
import { loginWithOwnerSecret } from "@/lib/dashboard/owner";

export type LoginState = { error?: string } | undefined;

export async function loginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  const secret = form.get("secret");
  const next = form.get("next");
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
  let result;
  try {
    result = await loginWithOwnerSecret(getDeps(), typeof secret === "string" ? secret : "", ip);
  } catch (err) {
    console.error("[dashboard] login failed", err);
    return { error: "Sign-in is unavailable: the server can't reach its database." };
  }
  if (!result.ok) return { error: result.error };
  redirect(safeNextPath(typeof next === "string" ? next : null));
}
