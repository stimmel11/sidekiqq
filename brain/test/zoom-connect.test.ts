import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDeps } from "@/lib/deps";
import { pkceChallenge } from "@/lib/crypto";
import { GET as listGet } from "@/app/api/connections/route";
import { GET as connectGet, POST as connectPost } from "@/app/api/connections/[connectorId]/connect/route";
import { GET as callbackGet } from "@/app/api/connections/[connectorId]/callback/route";
import { POST as disconnectPost } from "@/app/api/connections/[connectorId]/disconnect/route";
import type { Connection } from "@/lib/connectors/manage";
import { oauthFlow } from "@/lib/connectors/oauth";
import type { ConnectionStore } from "@/lib/connectors/store";
import { ZOOM_MEETING_SCOPE, ZoomAuth, type FetchLike } from "@/lib/connectors/zoom/auth";
import { makeDeps, params, req, type TestDeps } from "./fakes";

const OWNER = { "x-owner-secret": "test-owner-secret-0123456789" };
const CFG = { clientId: "zoom-cid", clientSecret: "zoom-csecret", redirectUri: "https://brain.example.com/api/connections/zoom/callback" };
const P = params({ connectorId: "zoom" });

type Call = { url: string; init: RequestInit };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Deps with Zoom configured, backed by a fake Zoom token endpoint. */
function zoomDeps(handler: (url: string, init: RequestInit) => Response = () => tokenOk()) {
  const calls: Call[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  const deps = makeDeps({ zoomAuth: (c: ConnectionStore) => new ZoomAuth(CFG, c, fn) });
  setDeps(deps);
  return { deps, calls };
}
const tokenOk = (refresh = "zoom-rt-NEW", scope = ZOOM_MEETING_SCOPE) =>
  json(200, { access_token: "zoom-at-1", refresh_token: refresh, expires_in: 3600, scope, token_type: "bearer" });

async function startConnect(): Promise<URL> {
  const res = await connectPost(req("POST", "/api/connections/zoom/connect", { headers: OWNER }), P);
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const go = await connectGet(req("GET", new URL(url).pathname + new URL(url).search), P);
  expect(go.status).toBe(307);
  return new URL(go.headers.get("location")!);
}

async function callback(query: string): Promise<string | null> {
  const res = await callbackGet(req("GET", `/api/connections/zoom/callback?${query}`), P);
  expect(res.status).toBe(303);
  const to = new URL(res.headers.get("location")!);
  expect(to.pathname).toBe("/dashboard/connections");
  expect(to.searchParams.get("connector")).toBe("zoom");
  return to.searchParams.get("connect");
}

async function zoomRow(): Promise<Connection> {
  const res = await listGet(req("GET", "/api/connections", { headers: OWNER }), params({}));
  return ((await res.json()) as { items: Connection[] }).items.find((c) => c.connectorId === "zoom")!;
}

async function issueState(deps: TestDeps, verifier = "zoom-verifier-abcdefghijklmnopqrstuvwxyz-0123") {
  return { state: await deps.connections.issueState("zoom", verifier), verifier };
}

beforeEach(() => {
  process.env.APP_URL = "https://brain.example.com";
});
afterEach(() => {
  delete process.env.APP_URL;
  setDeps(null);
  vi.restoreAllMocks();
});

describe("Zoom connect (generic /api/connections/zoom/*)", () => {
  it("has an OAuth flow registered under the connector id", () => {
    expect(oauthFlow("zoom")).toBeDefined();
  });

  it("connect redirects to Zoom's authorize page with PKCE S256 and a single-use state", async () => {
    const { deps, calls } = zoomDeps();
    const loc = await startConnect();
    expect(`${loc.origin}${loc.pathname}`).toBe("https://zoom.us/oauth/authorize");
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("client_id")).toBe("zoom-cid");
    expect(loc.searchParams.get("redirect_uri")).toBe(CFG.redirectUri);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.toString()).not.toContain("zoom-csecret");
    const verifier = await deps.connections.consumeState("zoom", loc.searchParams.get("state")!);
    expect(pkceChallenge(verifier!)).toBe(loc.searchParams.get("code_challenge"));
    expect(await deps.connections.consumeState("zoom", loc.searchParams.get("state")!)).toBeNull();
    expect(calls).toHaveLength(0); // nothing is called at Zoom until the callback
  });

  it("is a 404 when Zoom isn't configured (the connector isn't registered)", async () => {
    setDeps(makeDeps());
    expect((await connectPost(req("POST", "/api/connections/zoom/connect", { headers: OWNER }), P)).status).toBe(404);
  });

  it("connect needs the owner (no device token, no secret in the URL)", async () => {
    zoomDeps();
    expect((await connectPost(req("POST", "/api/connections/zoom/connect"), P)).status).toBe(401);
    expect((await connectGet(req("GET", "/api/connections/zoom/connect?secret=x"), P)).status).toBe(400);
  });

  it("callback exchanges the code with the PKCE verifier and stores the refresh token encrypted", async () => {
    const { deps, calls } = zoomDeps();
    const { state, verifier } = await issueState(deps);
    expect(await callback(`code=zc-1&state=${state}`)).toBe("connected");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://zoom.us/oauth/token");
    const f = new URLSearchParams(String(calls[0]!.init.body));
    expect(f.get("grant_type")).toBe("authorization_code");
    expect(f.get("code")).toBe("zc-1");
    expect(f.get("code_verifier")).toBe(verifier);
    expect(f.get("redirect_uri")).toBe(CFG.redirectUri);

    const stored = await deps.connections.load("zoom");
    expect(stored).toMatchObject({ secret: "zoom-rt-NEW", secretKind: "refresh_token", grantedScopes: [ZOOM_MEETING_SCOPE], status: "connected" });
    expect(stored!.connectedAt).toBe(deps.clock().toISOString());
    // Encrypted at rest: the raw KV value never holds the token.
    const raw = deps.kv as unknown as { strings: Map<string, unknown>; hashes: Map<string, Map<string, string>> };
    const dump = JSON.stringify([...raw.strings.values(), ...[...raw.hashes.values()].map((h) => [...h.values()])]);
    expect(dump.length).toBeGreaterThan(50);
    expect(dump).not.toContain("zoom-rt-NEW");

    const row = await zoomRow();
    expect(row.status).toBe("connected");
    expect(row.capabilities.find((c) => c.id === "video.create_room")).toMatchObject({ enabled: true, granted: true });
    expect(row).not.toHaveProperty("account");
    expect(JSON.stringify(row)).not.toContain("zoom-rt");

    // The state is single use: replaying the same redirect does nothing.
    expect(await callback(`code=zc-1&state=${state}`)).toBe("expired");
    expect(calls).toHaveLength(1);
  });

  it("refuses a cancelled, malformed, unknown or other-connector state without calling Zoom", async () => {
    const { deps, calls } = zoomDeps();
    expect(await callback("error=access_denied&state=x")).toBe("cancelled");
    expect(await callback("code=zc-1")).toBe("invalid");
    expect(await callback("state=abc")).toBe("invalid");
    expect(await callback("code=zc-1&state=unknown-state-0123456789abcdef")).toBe("expired");
    const googleState = await deps.connections.issueState("google", "google-verifier-abcdefghijklmnopqrstuvwxyz");
    expect(await callback(`code=zc-1&state=${googleState}`)).toBe("expired");
    expect(calls).toHaveLength(0);
    expect(await deps.connections.load("zoom")).toBeNull();
  });

  it("a failed exchange or a missing refresh token stores nothing and never echoes Zoom's reply", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let reply = json(400, { error: "invalid_grant", reason: "leaked-token-material-xyz" });
    const { deps } = zoomDeps(() => reply);
    let { state } = await issueState(deps);
    expect(await callback(`code=zc-1&state=${state}`)).toBe("failed");
    expect(await deps.connections.load("zoom")).toBeNull();

    reply = json(200, { access_token: "zoom-at-1", expires_in: 3600, scope: ZOOM_MEETING_SCOPE }); // no refresh_token
    ({ state } = await issueState(deps));
    expect(await callback(`code=zc-2&state=${state}`)).toBe("failed");
    expect(await deps.connections.load("zoom")).toBeNull();

    const logged = JSON.stringify(errSpy.mock.calls);
    expect(logged).not.toContain("leaked-token-material-xyz");
    expect(logged).not.toContain("zoom-at-1");
  });

  it("callback answers failed (after burning the state) when Zoom isn't configured", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const { state } = await issueState(deps);
    expect(await callback(`code=zc-1&state=${state}`)).toBe("failed");
    expect(await deps.connections.consumeState("zoom", state)).toBeNull();
  });

  it("reconnecting keeps the owner's switches, replaces the dead token and clears needs_reauth", async () => {
    const { deps } = zoomDeps(() => tokenOk("zoom-rt-SECOND"));
    await deps.connections.save("zoom", {
      secret: "zoom-rt-DEAD",
      secretKind: "refresh_token",
      grantedScopes: [ZOOM_MEETING_SCOPE],
      connectedAt: "2026-10-01T00:00:00.000Z",
      enabled: [],
      status: "needs_reauth",
      lastError: "Zoom rejected the stored sign-in.",
    });
    expect((await zoomRow()).status).toBe("needs_reauth");
    const { state } = await issueState(deps);
    expect(await callback(`code=zc-1&state=${state}`)).toBe("connected");
    const stored = await deps.connections.load("zoom");
    expect(stored).toMatchObject({ secret: "zoom-rt-SECOND", status: "connected", enabled: [] });
    expect(stored).not.toHaveProperty("lastError");
    expect((await zoomRow()).status).toBe("disabled"); // the owner had turned video.create_room off
  });

  it("a callback that granted no meeting scope connects, but the capability shows as not granted", async () => {
    const { deps } = zoomDeps(() => tokenOk("zoom-rt-NEW", "user:read:user"));
    const { state } = await issueState(deps);
    expect(await callback(`code=zc-1&state=${state}`)).toBe("connected");
    const row = await zoomRow();
    expect(row.capabilities.find((c) => c.id === "video.create_room")).toMatchObject({ enabled: false, granted: false });
  });
});

describe("Zoom disconnect", () => {
  it("deletes the stored token and revokes it at Zoom with the app's Basic auth", async () => {
    const { deps, calls } = zoomDeps(() => json(200, { status: "success" }));
    await deps.connections.save("zoom", { secret: "zoom-rt-LIVE", secretKind: "refresh_token", grantedScopes: [ZOOM_MEETING_SCOPE], connectedAt: "2026-10-01T00:00:00.000Z" });
    const res = await disconnectPost(req("POST", "/api/connections/zoom/disconnect", { headers: OWNER }), P);
    expect(await res.json()).toEqual({ ok: true, revoked: true });
    expect(await deps.connections.load("zoom")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://zoom.us/oauth/revoke");
    expect(new URLSearchParams(String(calls[0]!.init.body)).get("token")).toBe("zoom-rt-LIVE");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("zoom-cid:zoom-csecret").toString("base64")}`);
    expect((await zoomRow()).status).toBe("not_connected");
  });

  it("a failed revoke still deletes locally and reports revoked: false", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { deps } = zoomDeps(() => json(500, { error: "server_error" }));
    await deps.connections.save("zoom", { secret: "zoom-rt-LIVE", secretKind: "refresh_token", grantedScopes: [ZOOM_MEETING_SCOPE], connectedAt: "2026-10-01T00:00:00.000Z" });
    const res = await disconnectPost(req("POST", "/api/connections/zoom/disconnect", { headers: OWNER }), P);
    expect(await res.json()).toEqual({ ok: true, revoked: false });
    expect(await deps.connections.load("zoom")).toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("zoom-rt-LIVE");
  });

  it("a connection that already needs reauth is deleted without calling Zoom", async () => {
    const { deps, calls } = zoomDeps();
    await deps.connections.save("zoom", { secret: "zoom-rt-DEAD", secretKind: "refresh_token", grantedScopes: [], connectedAt: "2026-10-01T00:00:00.000Z", status: "needs_reauth" });
    const res = await disconnectPost(req("POST", "/api/connections/zoom/disconnect", { headers: OWNER }), P);
    expect(await res.json()).toEqual({ ok: true, revoked: true });
    expect(calls).toHaveLength(0);
  });
});
