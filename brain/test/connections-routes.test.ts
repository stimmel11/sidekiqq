import { google } from "googleapis";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDeps } from "@/lib/deps";
import { pkceChallenge } from "@/lib/crypto";
import { GET as listGet } from "@/app/api/connections/route";
import { GET as connectGet, POST as connectPost } from "@/app/api/connections/[connectorId]/connect/route";
import { GET as callbackGet } from "@/app/api/connections/[connectorId]/callback/route";
import { POST as disconnectPost } from "@/app/api/connections/[connectorId]/disconnect/route";
import { POST as capabilitiesPost } from "@/app/api/connections/[connectorId]/capabilities/route";
import { POLICY, type ImplementedCapability, type Out } from "@/lib/connectors/capabilities";
import { invokeCapability, readEmail } from "@/lib/connectors/invoke";
import type { Connection } from "@/lib/connectors/manage";
import { ConnectionUnusableError, type Connector } from "@/lib/connectors/types";
import { executeTool, TOOL_ALIASES, toolDefinitions } from "@/lib/assistant/tools";
import { connectionActions, connectionsNotice, STATUS_PRESENTATION } from "@/lib/dashboard/connections";
import { SESSION_COOKIE, signSession } from "@/lib/dashboard/session";
import { middleware } from "@/middleware";
import { makeDeps, pairDevice, params, req, type TestDeps } from "./fakes";

const OWNER = { "x-owner-secret": "test-owner-secret-0123456789" };
const SESSION_SECRET = "test-session-secret-0123456789abcdef";
const G = "https://www.googleapis.com/auth/";
const ALL_SCOPES = [`${G}gmail.readonly`, `${G}gmail.compose`, `${G}calendar.readonly`, `${G}drive.readonly`, `${G}contacts.readonly`, `${G}contacts.other.readonly`];
const P = (connectorId: string) => params({ connectorId });

async function connectGoogle(deps: TestDeps, extra: Record<string, unknown> = {}) {
  await deps.connections.save("google", {
    secret: "1//refresh-SECRET",
    secretKind: "refresh_token",
    account: "owner@example.com",
    grantedScopes: ALL_SCOPES,
    connectedAt: "2026-10-01T00:00:00.000Z",
    ...extra,
  });
}

async function sessionCookie(): Promise<string> {
  return `${SESSION_COOKIE}=${(await signSession(SESSION_SECRET)).value}`;
}

async function list(deps: TestDeps): Promise<Connection[]> {
  const res = await listGet(req("GET", "/api/connections", { headers: OWNER }), params({}));
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Connection[] }).items;
}

beforeEach(() => {
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.GOOGLE_CLIENT_ID = "cid.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "csecret";
  process.env.APP_URL = "https://brain.example.com";
});
afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.APP_URL;
  vi.restoreAllMocks();
});

describe("connections routes: owner only (docs/CONNECTORS.md §9)", () => {
  it("refuses no auth, a device token, a device token with a session cookie, and a forged cookie", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const { token } = await pairDevice(deps, "phone");
    const cookie = await sessionCookie();
    const forged = `${SESSION_COOKIE}=${(await signSession("another-secret-that-is-long-enough-0000")).value}`;
    const cases: Record<string, string>[] = [{}, { authorization: `Bearer ${token}` }, { authorization: `Bearer ${token}`, cookie }, { cookie: forged }];
    for (const headers of cases) {
      expect((await listGet(req("GET", "/api/connections", { headers }), params({}))).status).toBe(401);
      expect((await capabilitiesPost(req("POST", "/api/connections/google/capabilities", { headers, body: { enabled: [] } }), P("google"))).status).toBe(401);
      expect((await disconnectPost(req("POST", "/api/connections/google/disconnect", { headers }), P("google"))).status).toBe(401);
      expect((await connectPost(req("POST", "/api/connections/google/connect", { headers }), P("google"))).status).toBe(401);
    }
  });

  it("accepts the owner secret or the dashboard session; refuses cross-site cookie writes", async () => {
    const deps = makeDeps();
    setDeps(deps);
    await connectGoogle(deps);
    const cookie = await sessionCookie();
    const res = await listGet(req("GET", "/api/connections", { headers: { cookie } }), params({}));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const ok = await capabilitiesPost(
      req("POST", "/api/connections/google/capabilities", { headers: { cookie, origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }, body: { enabled: ["email.read"] } }),
      P("google"),
    );
    expect(ok.status).toBe(200);
    const crossSite: Record<string, string>[] = [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }];
    for (const h of crossSite) {
      const bad = await capabilitiesPost(req("POST", "/api/connections/google/capabilities", { headers: { cookie, ...h }, body: { enabled: [] } }), P("google"));
      expect(bad.status).toBe(403);
    }
    expect((await deps.connections.load("google"))?.enabled).toEqual(["email.read"]);
  });

  it("middleware: the cookie reaches only the connections API; connect/callback legs are public", async () => {
    const cookie = (await signSession(SESSION_SECRET)).value;
    const mk = (path: string, withCookie: boolean) => {
      const headers = new Headers();
      if (withCookie) headers.set("cookie", `${SESSION_COOKIE}=${cookie}`);
      return new NextRequest(new URL(path, "https://brain.example"), { headers });
    };
    expect((await middleware(mk("/api/connections", true))).headers.get("x-middleware-next")).toBe("1");
    expect((await middleware(mk("/api/connections/google/disconnect", true))).headers.get("x-middleware-next")).toBe("1");
    expect((await middleware(mk("/api/connections", false))).status).toBe(401);
    expect((await middleware(mk("/api/commitments", true))).status).toBe(401);
    expect((await middleware(mk("/api/connections/google/callback", false))).headers.get("x-middleware-next")).toBe("1");
    expect((await middleware(mk("/api/connections/google/connect", false))).headers.get("x-middleware-next")).toBe("1");
    expect((await middleware(mk("/api/connections/google/disconnect", false))).status).toBe(401);
  });
});

describe("GET /api/connections", () => {
  it("not connected: every capability listed with its fixed tier in plain words", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const [g] = await list(deps);
    expect(g).toMatchObject({ connectorId: "google", status: "not_connected" });
    expect(g!.account).toBeUndefined();
    expect(g!.capabilities.map((c) => c.id)).toEqual(["email.read", "email.draft", "calendar.read", "files.read", "contacts.lookup"]);
    for (const c of g!.capabilities) {
      expect(c.tier).toBe(POLICY[c.id]);
      expect(c.enabled).toBe(false);
      expect(c.tierLabel).toBe("reads automatically");
      expect(c.label.length).toBeGreaterThan(5);
    }
    // No executor is ever listed.
    expect(JSON.stringify(g)).not.toMatch(/email\.send|sender/);
  });

  it("connected: account, connectedAt, lastUsedAt from the audit log, no secret anywhere", async () => {
    const deps = makeDeps();
    setDeps(deps);
    await connectGoogle(deps);
    await readEmail(deps, { op: "search", query: "from:dana", max: 3 }, { caller: "ask" });
    const res = await listGet(req("GET", "/api/connections", { headers: OWNER }), params({}));
    const text = await res.text();
    expect(text).not.toContain("refresh-SECRET");
    const [g] = (JSON.parse(text) as { items: Connection[] }).items;
    expect(g).toMatchObject({ status: "connected", account: "owner@example.com", connectedAt: "2026-10-01T00:00:00.000Z" });
    expect(g!.lastUsedAt).toBeTruthy();
    expect(g!.capabilities.every((c) => c.enabled && c.granted && c.ownerEnabled)).toBe(true);
  });

  it("shows ungranted scopes as not enabled, needs_reauth, everything off, and an unreadable record", async () => {
    const deps = makeDeps();
    setDeps(deps);
    await connectGoogle(deps, { grantedScopes: [`${G}gmail.readonly`] });
    let [g] = await list(deps);
    const draft = g!.capabilities.find((c) => c.id === "email.draft")!;
    expect(draft).toMatchObject({ ownerEnabled: true, granted: false, enabled: false });
    expect(g!.capabilities.find((c) => c.id === "email.read")).toMatchObject({ enabled: true, granted: true });

    await connectGoogle(deps, { enabled: [] });
    [g] = await list(deps);
    expect(g!.status).toBe("disabled");

    await connectGoogle(deps, { status: "needs_reauth", lastError: "invalid_grant" });
    [g] = await list(deps);
    expect(g).toMatchObject({ status: "needs_reauth", lastError: "invalid_grant" });

    await deps.kv.set("t:conn:google:tokens", "v1.garbage.garbage.garbage");
    [g] = await list(deps);
    expect(g!.status).toBe("error");
    expect(g!.lastError).toMatch(/Reconnect/);
  });
});

describe("POST /api/connections/:id/capabilities", () => {
  it("sets the enabled list, and invokeCapability then refuses a disabled capability", async () => {
    const deps = makeDeps();
    setDeps(deps);
    await connectGoogle(deps);
    const res = await capabilitiesPost(req("POST", "/api/connections/google/capabilities", { headers: OWNER, body: { enabled: ["email.read", "calendar.read"] } }), P("google"));
    expect(res.status).toBe(200);
    const c = (await res.json()) as Connection;
    expect(c.capabilities.filter((x) => x.enabled).map((x) => x.id)).toEqual(["email.read", "calendar.read"]);
    await expect(invokeCapability(deps, "files.read", { query: "x", max: 1, includeContent: false }, { caller: "ask" })).rejects.toBeInstanceOf(ConnectionUnusableError);
  });

  it("no toggle can name a send path, another connector's capability or an invented one", async () => {
    const deps = makeDeps();
    setDeps(deps);
    await connectGoogle(deps, { enabled: ["email.read"] });
    for (const bad of ["email.send", "grocery.checkout", "device.call", "calendar.invite.prepare", "send_email", "__proto__"]) {
      const res = await capabilitiesPost(req("POST", "/api/connections/google/capabilities", { headers: OWNER, body: { enabled: ["email.read", bad] } }), P("google"));
      expect(res.status, bad).toBe(400);
    }
    expect((await deps.connections.load("google"))?.enabled).toEqual(["email.read"]);
    // Tiers come only from POLICY: a tier field in the body is not part of the schema and changes nothing.
    await capabilitiesPost(req("POST", "/api/connections/google/capabilities", { headers: OWNER, body: { enabled: ["email.draft"], tier: { "email.draft": "auto" } } }), P("google"));
    const [g] = await list(deps);
    expect(g!.capabilities.find((x) => x.id === "email.draft")!.tier).toBe(POLICY["email.draft"]);
  });

  it("404 for an unknown connector, 409 when not connected, 400 for a bad body", async () => {
    const deps = makeDeps();
    setDeps(deps);
    expect((await capabilitiesPost(req("POST", "/api/connections/zoom/capabilities", { headers: OWNER, body: { enabled: [] } }), P("zoom"))).status).toBe(404);
    expect((await capabilitiesPost(req("POST", "/api/connections/google/capabilities", { headers: OWNER, body: { enabled: ["email.read"] } }), P("google"))).status).toBe(409);
    expect((await capabilitiesPost(req("POST", "/api/connections/google/capabilities", { headers: OWNER, body: { enabled: "email.read" } }), P("google"))).status).toBe(400);
  });
});

describe("POST /api/connections/:id/disconnect", () => {
  it("revokes at Google, then deletes the stored credential and the legacy record", async () => {
    const deps = makeDeps();
    setDeps(deps);
    await connectGoogle(deps);
    await deps.kv.set("t:google:tokens", "legacy");
    const revoke = vi.spyOn(google.auth.OAuth2.prototype, "revokeToken").mockImplementation((async () => ({ data: {} })) as never);
    const res = await disconnectPost(req("POST", "/api/connections/google/disconnect", { headers: OWNER }), P("google"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: true });
    expect(revoke).toHaveBeenCalledWith("1//refresh-SECRET");
    expect(await deps.connections.load("google")).toBeNull();
    expect(await deps.kv.get("t:google:tokens")).toBeNull();
    expect((await list(deps))[0]!.status).toBe("not_connected");
  });

  it("a failed provider revoke still deletes locally and reports revoked: false", async () => {
    const deps = makeDeps();
    setDeps(deps);
    await connectGoogle(deps);
    vi.spyOn(google.auth.OAuth2.prototype, "revokeToken").mockImplementation((async () => {
      throw new Error("network down");
    }) as never);
    const res = await disconnectPost(req("POST", "/api/connections/google/disconnect", { headers: OWNER }), P("google"));
    expect(await res.json()).toEqual({ ok: true, revoked: false });
    expect(await deps.connections.load("google")).toBeNull();
  });
});

describe("connect and callback", () => {
  it("POST mints a single-use ticket link; GET with it redirects to Google with PKCE S256", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const res = await connectPost(req("POST", "/api/connections/google/connect", { headers: OWNER }), P("google"));
    expect(res.status).toBe(200);
    const { url, expiresAt } = (await res.json()) as { url: string; expiresAt: string };
    expect(url).toMatch(/^https:\/\/brain\.example\.com\/api\/connections\/google\/connect\?ticket=/);
    expect(url).not.toContain("owner-secret");
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now() - 86_400_000 * 365);

    const path = new URL(url).pathname + new URL(url).search;
    const go = await connectGet(req("GET", path), P("google"));
    expect(go.status).toBe(307);
    const loc = new URL(go.headers.get("location")!);
    expect(loc.host).toBe("accounts.google.com");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    const verifier = await deps.googleTokens.consumeState(loc.searchParams.get("state")!);
    expect(pkceChallenge(verifier!)).toBe(loc.searchParams.get("code_challenge"));

    expect((await connectGet(req("GET", path), P("google"))).status).toBe(401); // single use
    expect((await connectGet(req("GET", "/api/connections/google/connect?secret=x"), P("google"))).status).toBe(400);
    expect((await connectGet(req("GET", "/api/connections/google/connect"), P("google"))).status).toBe(401);
    expect((await connectPost(req("POST", "/api/connections/nope/connect", { headers: OWNER }), P("nope"))).status).toBe(404);
  });

  it("callback redirects to the dashboard with a result code, never provider text", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const loc = async (path: string, id = "google") => {
      const res = await callbackGet(req("GET", path), P(id));
      expect(res.status).toBe(303);
      return new URL(res.headers.get("location")!);
    };
    const expired = await loc("/api/connections/google/callback?code=c&state=unknown-state-0123456789");
    expect(expired.pathname).toBe("/dashboard/connections");
    expect(expired.searchParams.get("connect")).toBe("expired");
    const cancelled = await loc("/api/connections/google/callback?error=<script>access_denied");
    expect(cancelled.searchParams.get("connect")).toBe("cancelled");
    expect(cancelled.toString()).not.toContain("script");
    expect((await loc("/api/connections/nope/callback?code=c&state=s", "nope")).searchParams.get("connect")).toBe("invalid");

    const getToken = vi.spyOn(google.auth.OAuth2.prototype, "getToken").mockImplementation((async () => {
      throw new Error("no network in tests");
    }) as never);
    const state = await deps.googleTokens.issueState("verifier-abcdefghijklmnopqrstuvwxyz-0123456789");
    expect((await loc(`/api/connections/google/callback?code=c1&state=${state}`)).searchParams.get("connect")).toBe("failed");
    expect(getToken).toHaveBeenCalledWith({ code: "c1", codeVerifier: "verifier-abcdefghijklmnopqrstuvwxyz-0123456789" });
  });
});

describe("needs_reauth owner alert (§7)", () => {
  it("raises exactly one connection_needs_reauth alert on the transition", async () => {
    const deps = makeDeps();
    await connectGoogle(deps, { grantedScopes: [] });
    const failing: Connector = {
      id: "google",
      displayName: "Google",
      firstParty: true,
      capabilities: ["email.read"],
      scopesFor: () => [],
      invoke: async <C extends ImplementedCapability>(): Promise<Out<C>> => {
        throw Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } });
      },
    };
    const d = { ...deps, connectors: () => [failing] };
    await pairDevice(deps, "phone").then(({ device }) => deps.repos.devices.setFcmToken(device.id, "fcm-1", "phone"));
    await expect(readEmail(d, { op: "account" }, { caller: "cron" })).rejects.toThrow(/invalid_grant/);
    await expect(readEmail(d, { op: "account" }, { caller: "cron" })).rejects.toBeInstanceOf(ConnectionUnusableError);
    const alerts = (await deps.repos.alerts.since(null)).items;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "connection_needs_reauth", importance: "HIGH", title: "Reconnect Google" });
    expect(deps.pushFake.sent).toHaveLength(1);
    expect(deps.pushFake.sent[0]!.msg.data?.kind).toBe("connection_needs_reauth");
  });

  it("an alert failure never masks the provider error", async () => {
    const deps = makeDeps();
    await connectGoogle(deps, { grantedScopes: [] });
    const failing: Connector = {
      id: "google",
      displayName: "Google",
      firstParty: true,
      capabilities: ["email.read"],
      scopesFor: () => [],
      invoke: async <C extends ImplementedCapability>(): Promise<Out<C>> => {
        throw Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } });
      },
    };
    const d = {
      ...deps,
      connectors: () => [failing],
      push: () => {
        throw new Error("FCM misconfigured");
      },
    };
    await expect(readEmail(d, { op: "account" }, { caller: "ask" })).rejects.toThrow(/invalid_grant/);
    expect((await deps.connections.load("google"))?.status).toBe("needs_reauth");
  });
});

describe("search_email rename", () => {
  it("offers search_email, not search_gmail, and still runs search_gmail as an alias", async () => {
    const names = toolDefinitions().map((t) => t.name);
    expect(names).toContain("search_email");
    expect(names).not.toContain("search_gmail");
    expect(TOOL_ALIASES).toEqual({ search_gmail: "search_email" });
    const deps = makeDeps();
    const ctx = { deps, now: new Date("2026-10-16T15:00:00Z"), device: "watch" as const, actions: [] };
    const viaAlias = await executeTool("search_gmail", { query: "from:dana" }, ctx);
    const viaNew = await executeTool("search_email", { query: "from:dana" }, ctx);
    expect(viaAlias.isError).toBe(false);
    expect(viaAlias.content).toBe(viaNew.content);
    expect((await executeTool("constructor", {}, ctx)).isError).toBe(true);
  });
});

describe("Connections screen presentation", () => {
  it("status words and buttons per status", () => {
    expect(STATUS_PRESENTATION.needs_reauth.label).toBe("needs reconnect");
    expect(STATUS_PRESENTATION.not_connected.label).toBe("not connected");
    expect(connectionActions({ status: "not_connected" })).toEqual({ connect: "Connect", connectPrimary: true, disconnect: false, toggles: false });
    expect(connectionActions({ status: "needs_reauth" })).toMatchObject({ connect: "Reconnect", connectPrimary: true, disconnect: true, toggles: false });
    expect(connectionActions({ status: "error" })).toMatchObject({ connect: "Reconnect", toggles: false });
    expect(connectionActions({ status: "connected" })).toMatchObject({ connect: "Reconnect", connectPrimary: false, disconnect: true, toggles: true });
    expect(connectionActions({ status: "disabled" })).toMatchObject({ toggles: true });
  });

  it("notices come only from known codes", () => {
    expect(connectionsNotice({ connect: "connected" })).toMatchObject({ tone: "success" });
    expect(connectionsNotice({ connect: "wrong_account" })).toMatchObject({ tone: "danger" });
    expect(connectionsNotice({ done: "disconnected_local" })?.text).toMatch(/didn't confirm/);
    expect(connectionsNotice({ error: "connect" })).toMatchObject({ tone: "danger" });
    expect(connectionsNotice({ connect: "<b>hi</b>", done: "nope", error: "x" })).toBeNull();
  });
});
