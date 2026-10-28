import { google } from "googleapis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDeps } from "@/lib/deps";
import { pkceChallenge } from "@/lib/crypto";
import { GET as connectGet } from "@/app/api/google/connect/route";
import { GET as callbackGet } from "@/app/api/google/callback/route";
import { makeDeps, req } from "./fakes";

const OWNER = { "x-owner-secret": "test-owner-secret-0123456789" };

describe("Google OAuth uses PKCE (docs/CONNECTORS.md §7)", () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = "cid.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "csecret";
    process.env.APP_URL = "https://brain.example.com";
  });
  afterEach(() => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.APP_URL;
    vi.restoreAllMocks();
  });

  it("connect sends an S256 challenge; the verifier stays server-side with the state", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const res = await connectGet(req("GET", "/api/google/connect", { headers: OWNER }));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    const challenge = loc.searchParams.get("code_challenge")!;
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loc.toString()).not.toContain("code_verifier");
    const verifier = await deps.googleTokens.consumeState(loc.searchParams.get("state")!);
    expect(verifier).toBeTruthy();
    expect(pkceChallenge(verifier!)).toBe(challenge);
  });

  it("callback passes the stored verifier to the token exchange and refuses unknown states", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const getToken = vi.spyOn(google.auth.OAuth2.prototype, "getToken").mockImplementation((async () => {
      throw new Error("no network in tests");
    }) as never);

    const bad = await callbackGet(req("GET", "/api/google/callback?code=c1&state=unknown-state-0123456789"));
    expect(bad.status).toBe(400);
    expect(getToken).not.toHaveBeenCalled();

    const state = await deps.googleTokens.issueState("verifier-abcdefghijklmnopqrstuvwxyz-0123456789");
    const res = await callbackGet(req("GET", `/api/google/callback?code=c1&state=${state}`));
    expect(res.status).toBe(500); // our fake exchange failed
    expect(getToken).toHaveBeenCalledWith({ code: "c1", codeVerifier: "verifier-abcdefghijklmnopqrstuvwxyz-0123456789" });
    // State is single use.
    expect(await deps.googleTokens.consumeState(state)).toBeNull();
  });
});
