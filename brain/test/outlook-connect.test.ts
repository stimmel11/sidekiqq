import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDeps } from "@/lib/deps";
import { pkceChallenge } from "@/lib/crypto";
import { GET as listGet } from "@/app/api/connections/route";
import { GET as connectGet, POST as connectPost } from "@/app/api/connections/[connectorId]/connect/route";
import { GET as callbackGet } from "@/app/api/connections/[connectorId]/callback/route";
import { POST as disconnectPost } from "@/app/api/connections/[connectorId]/disconnect/route";
import { GET as scanGet } from "@/app/api/cron/scan/route";
import type { Connection } from "@/lib/connectors/manage";
import { oauthFlow } from "@/lib/connectors/oauth";
import { invokeCapability, readEmail, routeConnector } from "@/lib/connectors/invoke";
import { gmailRecentQuery } from "@/lib/connectors/google";
import { OutlookConnector } from "@/lib/connectors/outlook";
import type { ConnectionStore } from "@/lib/connectors/store";
import { ConnectionUnusableError, ReauthRequiredError } from "@/lib/connectors/types";
import {
  MicrosoftAuth,
  MicrosoftAuthError,
  microsoftConfigFromEnv,
  normalizeGrantedScopes,
  OutlookNotConnectedError,
  OUTLOOK_REQUESTED_SCOPES,
  type FetchLike,
  type MicrosoftAppConfig,
} from "@/lib/connectors/outlook/auth";
import { OutlookMail } from "@/lib/microsoft/mail";
import type { EmailMessage } from "@/lib/google/workspace";
import { makeDeps, msg, params, req, ScriptedLLM, toolUse, type TestDeps } from "./fakes";

const OWNER = { "x-owner-secret": "test-owner-secret-0123456789" };
const CFG: MicrosoftAppConfig = {
  clientId: "ms-cid",
  clientSecret: "ms-csecret",
  redirectUri: "https://brain.example.com/api/connections/outlook/callback",
  tenant: "common",
};
const P = params({ connectorId: "outlook" });
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const ME_URL_PREFIX = "https://graph.microsoft.com/v1.0/me?";

type Call = { url: string; init: RequestInit };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const form = (c: Call) => new URLSearchParams(String(c.init.body));

const tokenOk = (refresh: string | null = "ms-rt-NEW", scope = "https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read openid profile") =>
  json(200, { token_type: "Bearer", access_token: "ms-at-1", expires_in: 3600, scope, ...(refresh ? { refresh_token: refresh } : {}) });
const meOk = (mail = "Stimmel@Contoso.com") => json(200, { mail, userPrincipalName: "stimmel@contoso.onmicrosoft.com" });

function defaultHandler(url: string): Response {
  if (url === TOKEN_URL) return tokenOk();
  if (url.startsWith(ME_URL_PREFIX)) return meOk();
  return json(404, {});
}

/** Deps with Outlook configured, backed by a fake Microsoft token endpoint and Graph /me. */
function outlookDeps(handler: (url: string, init: RequestInit) => Response = defaultHandler, extra: Parameters<typeof makeDeps>[0] = {}) {
  const calls: Call[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  const deps = makeDeps({ ...extra, outlookAuth: (c: ConnectionStore) => new MicrosoftAuth(CFG, c, fn) });
  setDeps(deps);
  return { deps, calls };
}

async function startConnect(): Promise<URL> {
  const res = await connectPost(req("POST", "/api/connections/outlook/connect", { headers: OWNER }), P);
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const go = await connectGet(req("GET", new URL(url).pathname + new URL(url).search), P);
  expect(go.status).toBe(307);
  return new URL(go.headers.get("location")!);
}

async function callback(query: string): Promise<string | null> {
  const res = await callbackGet(req("GET", `/api/connections/outlook/callback?${query}`), P);
  expect(res.status).toBe(303);
  const to = new URL(res.headers.get("location")!);
  expect(to.pathname).toBe("/dashboard/connections");
  expect(to.searchParams.get("connector")).toBe("outlook");
  return to.searchParams.get("connect");
}

async function outlookRow(): Promise<Connection | undefined> {
  const res = await listGet(req("GET", "/api/connections", { headers: OWNER }), params({}));
  return ((await res.json()) as { items: Connection[] }).items.find((c) => c.connectorId === "outlook");
}

async function issueState(deps: TestDeps, verifier = "ms-verifier-abcdefghijklmnopqrstuvwxyz-0123456") {
  return { state: await deps.connections.issueState("outlook", verifier), verifier };
}

function storeOutlook(deps: TestDeps, over: Record<string, unknown> = {}) {
  return deps.connections.save("outlook", {
    secret: "ms-rt-OLD",
    secretKind: "refresh_token",
    account: "stimmel@contoso.com",
    grantedScopes: ["offline_access", "User.Read", "Mail.Read"],
    connectedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  });
}

function email(id: string, over: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id,
    threadId: `conv_${id}`,
    from: "Dana Lee <dana@acme.com>",
    to: "stimmel@contoso.com",
    cc: "",
    subject: "Deposit",
    date: "2026-10-16T14:00:00.000Z",
    snippet: "",
    labels: [],
    body: "We'll send the deposit by Friday.",
    ...over,
  };
}

beforeEach(() => {
  process.env.APP_URL = "https://brain.example.com";
});
afterEach(() => {
  delete process.env.APP_URL;
  delete process.env.MICROSOFT_ALLOWED_EMAIL;
  delete process.env.MICROSOFT_CLIENT_ID;
  delete process.env.MICROSOFT_CLIENT_SECRET;
  delete process.env.MICROSOFT_TENANT;
  delete process.env.MICROSOFT_REDIRECT_URI;
  setDeps(null);
  vi.restoreAllMocks();
});

describe("Microsoft config", () => {
  it("is off without both client id and secret", () => {
    expect(microsoftConfigFromEnv("https://brain.example.com")).toBeNull();
    process.env.MICROSOFT_CLIENT_ID = "x";
    expect(microsoftConfigFromEnv("https://brain.example.com")).toBeNull();
  });

  it("defaults to the common tenant and the generic callback", () => {
    process.env.MICROSOFT_CLIENT_ID = "x";
    process.env.MICROSOFT_CLIENT_SECRET = "y";
    expect(microsoftConfigFromEnv("https://brain.example.com")).toEqual({
      clientId: "x",
      clientSecret: "y",
      tenant: "common",
      redirectUri: "https://brain.example.com/api/connections/outlook/callback",
    });
  });

  it("leaves Outlook off (instead of throwing) for a tenant that could change the login URL", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.MICROSOFT_CLIENT_ID = "x";
    process.env.MICROSOFT_CLIENT_SECRET = "y";
    for (const bad of ["evil.com/x", "../common", "a b", "common?x=1"]) {
      process.env.MICROSOFT_TENANT = bad;
      expect(microsoftConfigFromEnv("https://brain.example.com")).toBeNull();
    }
    process.env.MICROSOFT_TENANT = "contoso.onmicrosoft.com";
    expect(microsoftConfigFromEnv("https://brain.example.com")?.tenant).toBe("contoso.onmicrosoft.com");
  });

  it("normalises Graph scope URIs to the short names scopesFor uses", () => {
    expect(normalizeGrantedScopes("https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/user.read openid", true)).toEqual([
      "Mail.Read",
      "User.Read",
      "openid",
      "offline_access",
    ]);
    expect(normalizeGrantedScopes("mail.read", false)).toEqual(["Mail.Read"]);
    expect(normalizeGrantedScopes(undefined, false)).toEqual([]);
  });
});

describe("Outlook connect (generic /api/connections/outlook/*)", () => {
  it("is not offered when Microsoft isn't configured", async () => {
    setDeps(makeDeps());
    expect(await outlookRow()).toBeUndefined();
    const res = await connectPost(req("POST", "/api/connections/outlook/connect", { headers: OWNER }), P);
    expect(res.status).toBe(404);
  });

  it("connect redirects to Microsoft's authorize page with PKCE S256, the minimal scopes and a single-use state", async () => {
    const { deps, calls } = outlookDeps();
    expect(oauthFlow("outlook")).toBeDefined();
    const loc = await startConnect();
    expect(`${loc.origin}${loc.pathname}`).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("response_mode")).toBe("query");
    expect(loc.searchParams.get("client_id")).toBe("ms-cid");
    expect(loc.searchParams.get("redirect_uri")).toBe(CFG.redirectUri);
    expect(loc.searchParams.get("scope")).toBe("offline_access User.Read Mail.Read");
    expect(loc.searchParams.get("scope")).not.toMatch(/Send|ReadWrite/i);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.has("client_secret")).toBe(false);
    const state = loc.searchParams.get("state")!;
    const verifier = await deps.connections.consumeState("outlook", state);
    expect(verifier).toBeTruthy();
    expect(loc.searchParams.get("code_challenge")).toBe(pkceChallenge(verifier!));
    expect(calls).toHaveLength(0);
  });

  it("callback exchanges the code with the verifier, labels the account and stores the token encrypted", async () => {
    const { deps, calls } = outlookDeps();
    const { state, verifier } = await issueState(deps);
    expect(await callback(`code=auth-code-1&state=${state}`)).toBe("connected");

    const tokenCall = calls.find((c) => c.url === TOKEN_URL)!;
    expect(tokenCall.init.method).toBe("POST");
    const f = form(tokenCall);
    expect(Object.fromEntries(f)).toMatchObject({
      grant_type: "authorization_code",
      code: "auth-code-1",
      code_verifier: verifier,
      redirect_uri: CFG.redirectUri,
      client_id: "ms-cid",
      client_secret: "ms-csecret",
      scope: "offline_access User.Read Mail.Read",
    });
    const me = calls.find((c) => c.url.startsWith(ME_URL_PREFIX))!;
    expect(me.init.method).toBe("GET");
    expect((me.init.headers as Record<string, string>).Authorization).toBe("Bearer ms-at-1");

    const stored = await deps.connections.load("outlook");
    expect(stored).toMatchObject({ secret: "ms-rt-NEW", secretKind: "refresh_token", account: "stimmel@contoso.com", status: "connected" });
    expect(stored!.grantedScopes).toEqual(expect.arrayContaining(["Mail.Read", "User.Read", "offline_access"]));
    const raw = await deps.kv.get("t:conn:outlook:tokens");
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("ms-rt-NEW");
    expect(raw).not.toContain("ms-at-1");

    const row = await outlookRow();
    expect(row).toMatchObject({ status: "connected", account: "stimmel@contoso.com", displayName: "Outlook (Microsoft 365)" });
    expect(row!.capabilities.map((c) => [c.id, c.enabled, c.tier])).toEqual([["email.read", true, "auto"]]);

    // The state was single use.
    expect(await callback(`code=auth-code-1&state=${state}`)).toBe("expired");
  });

  it("maps a cancelled consent, a missing code and an unknown state without calling Microsoft", async () => {
    const { deps, calls } = outlookDeps();
    const { state } = await issueState(deps);
    expect(await callback(`error=access_denied&state=${state}`)).toBe("cancelled");
    expect(await callback(`state=${state}`)).toBe("invalid");
    // Anything but the owner saying no is a failure (e.g. a work tenant that needs admin consent).
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await callback(`error=consent_required&error_description=AADSTS65001+tenant+detail&state=${state}`)).toBe("failed");
    expect(JSON.stringify(errors.mock.calls)).toContain("consent_required");
    expect(JSON.stringify(errors.mock.calls)).not.toContain("AADSTS");
    expect(await callback(`code=c&state=${"x".repeat(32)}`)).toBe("expired");
    expect(calls).toHaveLength(0);
    expect(await deps.connections.load("outlook")).toBeNull();
  });

  it("refuses a mailbox other than MICROSOFT_ALLOWED_EMAIL and saves nothing", async () => {
    process.env.MICROSOFT_ALLOWED_EMAIL = "owner@contoso.com";
    const { deps } = outlookDeps();
    const { state } = await issueState(deps);
    expect(await callback(`code=c&state=${state}`)).toBe("wrong_account");
    expect(await deps.connections.hasRecord("outlook")).toBe(false);
  });

  it("accepts the allowed mailbox case-insensitively", async () => {
    process.env.MICROSOFT_ALLOWED_EMAIL = "stimmel@contoso.com";
    const { deps } = outlookDeps();
    const { state } = await issueState(deps);
    expect(await callback(`code=c&state=${state}`)).toBe("connected");
  });

  it("with an allow-list, an unreadable account fails closed; without one it connects without a label", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const meFails = (url: string) => (url === TOKEN_URL ? tokenOk() : json(500, {}));
    process.env.MICROSOFT_ALLOWED_EMAIL = "stimmel@contoso.com";
    let { deps } = outlookDeps(meFails);
    let { state } = await issueState(deps);
    expect(await callback(`code=c&state=${state}`)).toBe("failed");
    expect(await deps.connections.hasRecord("outlook")).toBe(false);

    delete process.env.MICROSOFT_ALLOWED_EMAIL;
    ({ deps } = outlookDeps(meFails));
    ({ state } = await issueState(deps));
    expect(await callback(`code=c&state=${state}`)).toBe("connected");
    expect((await deps.connections.load("outlook"))!.account).toBeUndefined();
  });

  it("fails without a refresh token, and never logs Microsoft's error body", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let { deps } = outlookDeps((url) => (url === TOKEN_URL ? tokenOk(null) : meOk()));
    let { state } = await issueState(deps);
    expect(await callback(`code=c&state=${state}`)).toBe("failed");
    expect(await deps.connections.hasRecord("outlook")).toBe(false);

    ({ deps } = outlookDeps(() => json(400, { error: "invalid_grant", error_description: "AADSTS70000 secret-ish detail code=auth-code" })));
    ({ state } = await issueState(deps));
    expect(await callback(`code=auth-code&state=${state}`)).toBe("failed");
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toContain("HTTP 400, invalid_grant");
    expect(logged).not.toContain("AADSTS");
    expect(logged).not.toContain("auth-code");
  });

  it("reconnect keeps the owner's switches, replaces the dead token and clears needs_reauth", async () => {
    const { deps } = outlookDeps();
    await storeOutlook(deps, { secret: "ms-rt-DEAD", status: "needs_reauth", lastError: "x", enabled: [] });
    expect((await outlookRow())!.status).toBe("needs_reauth");
    const { state } = await issueState(deps);
    expect(await callback(`code=c&state=${state}`)).toBe("connected");
    const stored = await deps.connections.load("outlook");
    expect(stored).toMatchObject({ secret: "ms-rt-NEW", status: "connected", enabled: [] });
    expect(stored!.lastError).toBeUndefined();
  });

  it("disconnect deletes the stored token (no revoke endpoint) and the cached access token stops working", async () => {
    const { deps, calls } = outlookDeps();
    const { state } = await issueState(deps);
    expect(await callback(`code=c&state=${state}`)).toBe("connected");
    const auth = deps.outlookAuth()!;
    expect(await auth.accessToken()).toBe("ms-at-1");

    const before = calls.length;
    const res = await disconnectPost(req("POST", "/api/connections/outlook/disconnect", { headers: OWNER }), P);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: false });
    expect(calls.length).toBe(before); // nothing sent to Microsoft
    expect(await deps.connections.hasRecord("outlook")).toBe(false);
    await expect(auth.accessToken()).rejects.toBeInstanceOf(OutlookNotConnectedError);
  });
});

describe("MicrosoftAuth token minting", () => {
  it("refreshes from the stored token, caches it, and writes a rotated refresh token back", async () => {
    let n = 0;
    const { deps, calls } = outlookDeps(() => {
      n++;
      return json(200, { access_token: `ms-at-${n}`, refresh_token: "ms-rt-ROTATED", expires_in: 3600, scope: "https://graph.microsoft.com/Mail.Read" });
    });
    await storeOutlook(deps);
    const auth = deps.outlookAuth()!;
    const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()]);
    expect(a).toBe("ms-at-1");
    expect(b).toBe("ms-at-1");
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(form(calls[0]!))).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "ms-rt-OLD",
      scope: OUTLOOK_REQUESTED_SCOPES.join(" "),
      client_secret: "ms-csecret",
    });
    expect(await auth.accessToken()).toBe("ms-at-1");
    expect(calls).toHaveLength(1);
    expect((await deps.connections.load("outlook"))!.secret).toBe("ms-rt-ROTATED");

    auth.invalidate();
    expect(await auth.accessToken()).toBe("ms-at-2");
    expect(form(calls[1]!).get("refresh_token")).toBe("ms-rt-ROTATED");
  });

  it("refreshes again after the token nears expiry", async () => {
    let n = 0;
    let now = 1_000_000;
    const calls: Call[] = [];
    const deps = makeDeps({
      outlookAuth: (c) =>
        new MicrosoftAuth(
          CFG,
          c,
          async (url, init) => {
            calls.push({ url, init });
            n++;
            return json(200, { access_token: `ms-at-${n}`, expires_in: 3600 });
          },
          () => now,
        ),
    });
    await storeOutlook(deps);
    const auth = deps.outlookAuth()!;
    expect(await auth.accessToken()).toBe("ms-at-1");
    now += 3600_000 - 30_000;
    expect(await auth.accessToken()).toBe("ms-at-2");
    // No refresh token in the reply: the stored one is kept.
    expect((await deps.connections.load("outlook"))!.secret).toBe("ms-rt-OLD");
  });

  it("doesn't bring back a connection the owner disconnected while the rotated token was being saved", async () => {
    let disconnectNext = false;
    const { deps } = outlookDeps(() => {
      disconnectNext = true;
      return json(200, { access_token: "ms-at-1", refresh_token: "ms-rt-ROTATED", expires_in: 3600 });
    });
    await storeOutlook(deps);
    const load = deps.connections.load.bind(deps.connections);
    vi.spyOn(deps.connections, "load").mockImplementation(async (id: string) => {
      const out = await load(id);
      if (disconnectNext) {
        disconnectNext = false;
        await deps.connections.clear("outlook"); // lands between the write-back's read and its write
      }
      return out;
    });
    await deps.outlookAuth()!.accessToken();
    expect(await deps.connections.hasRecord("outlook")).toBe(false);
  });

  it("doesn't overwrite a reconnect that landed during a refresh", async () => {
    let deps!: TestDeps;
    ({ deps } = outlookDeps(() => {
      // A reconnect lands while Microsoft is answering the refresh.
      void deps.connections.save("outlook", { secret: "ms-rt-RECONNECT", secretKind: "refresh_token", grantedScopes: [], connectedAt: "2026-10-20T00:00:00.000Z" });
      return json(200, { access_token: "ms-at-old-grant", refresh_token: "ms-rt-ROTATED", expires_in: 3600 });
    }));
    await storeOutlook(deps);
    await deps.outlookAuth()!.accessToken();
    expect((await deps.connections.load("outlook"))!.secret).toBe("ms-rt-RECONNECT");
  });

  it("a dead refresh token is a ReauthRequiredError for the stored secret; invokeCapability marks needs_reauth and alerts once", async () => {
    const { deps } = outlookDeps(() => json(400, { error: "invalid_grant", error_description: "AADSTS700082 expired" }));
    await storeOutlook(deps);
    const auth = deps.outlookAuth()!;
    const err = await auth.accessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReauthRequiredError);
    expect((err as ReauthRequiredError).connectorId).toBe("outlook");
    expect((err as ReauthRequiredError).failedSecret).toBe("ms-rt-OLD");
    expect((err as Error).message).not.toContain("AADSTS");

    // Through the capability layer with the real token source behind a real OutlookMail.
    const mail = new OutlookMail(auth);
    const connector = new OutlookConnector(async () => mail);
    const d = { ...deps, connectors: () => [connector] } as TestDeps;
    await expect(invokeCapability(d, "email.read", { op: "search", query: "deposit", max: 5 }, { caller: "ask" })).rejects.toBeInstanceOf(ReauthRequiredError);
    expect((await deps.connections.load("outlook"))!.status).toBe("needs_reauth");
    expect((await deps.repos.alerts.since(null)).items.map((a) => [a.kind, a.title])).toEqual([["connection_needs_reauth", "Reconnect Outlook (Microsoft 365)"]]);
    // Next call fails fast with "reconnect Outlook", without calling Microsoft.
    await expect(invokeCapability(d, "email.read", { op: "account" }, { caller: "cron" })).rejects.toBeInstanceOf(ConnectionUnusableError);
  });

  it("interaction_required also needs a reconnect; invalid_client (our secret) does not", async () => {
    let code = "interaction_required";
    const { deps } = outlookDeps(() => json(400, { error: code }));
    await storeOutlook(deps);
    await expect(deps.outlookAuth()!.accessToken()).rejects.toBeInstanceOf(ReauthRequiredError);
    code = "invalid_client";
    const err = await deps.outlookAuth()!.accessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MicrosoftAuthError);
    expect((err as Error).message).toBe("Microsoft sign-in failed (HTTP 400, invalid_client).");
    // Microsoft usually answers invalid_client with 401: still not a reconnect.
    const { deps: d401 } = outlookDeps(() => json(401, { error: "invalid_client" }));
    await storeOutlook(d401);
    await expect(d401.outlookAuth()!.accessToken()).rejects.toBeInstanceOf(MicrosoftAuthError);
    expect((await d401.connections.load("outlook"))!.status).toBe("connected");
  });

  it("not connected is OutlookNotConnectedError, before any network call", async () => {
    const { deps, calls } = outlookDeps();
    await expect(deps.outlookAuth()!.accessToken()).rejects.toBeInstanceOf(OutlookNotConnectedError);
    expect(calls).toHaveLength(0);
  });

  it("end to end: a Graph search uses the minted token and stays read-only", async () => {
    const { deps, calls } = outlookDeps(() => json(200, { access_token: "ms-at-graph", expires_in: 3600 }));
    await storeOutlook(deps);
    const mail = new OutlookMail(deps.outlookAuth()!, {
      fetch: async (url, init) => {
        calls.push({ url, init: init as RequestInit });
        return json(200, {
          value: [{ id: "AAMk1", conversationId: "AQQk1", subject: "Deposit", from: { emailAddress: { name: "Dana", address: "dana@acme.com" } }, receivedDateTime: "2026-10-16T14:00:00Z" }],
        });
      },
    });
    const d = { ...deps, connectors: () => [new OutlookConnector(async () => mail)] } as TestDeps;
    const out = await readEmail(d, { op: "search", query: "deposit", max: 5 }, { caller: "ask" });
    expect(out).toEqual([expect.objectContaining({ id: "AAMk1", threadId: "AQQk1", from: "Dana <dana@acme.com>", subject: "Deposit" })]);
    const graph = calls.filter((c) => c.url.startsWith("https://graph.microsoft.com/"));
    expect(graph).toHaveLength(1);
    expect(graph[0]!.init.method).toBe("GET");
    expect((graph[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer ms-at-graph");
  });
});

describe("email.read routing between Gmail and Outlook", () => {
  it("keeps reading Gmail when Outlook isn't configured or isn't connected", async () => {
    const deps = makeDeps({ outlook: true });
    await deps.connections.save("google", { secret: "g-rt", secretKind: "refresh_token", grantedScopes: [], connectedAt: "2026-10-01T00:00:00.000Z" });
    deps.ws.messages = [email("g1")];
    expect((await routeConnector(deps, "email.read"))!.id).toBe("google");
    const out = await readEmail(deps, { op: "search", query: "deposit", max: 5 }, { caller: "ask" });
    expect(out.map((m) => m.id)).toEqual(["g1"]);
    expect(deps.outlook.calls).toHaveLength(0);
  });

  it("reads Outlook for an Outlook-only owner and audits it as outlook without arguments", async () => {
    const deps = makeDeps({ outlook: true, googleConnected: false });
    await storeOutlook(deps);
    deps.outlook.messages = [email("o1")];
    expect((await routeConnector(deps, "email.read"))!.id).toBe("outlook");
    const out = await readEmail(deps, { op: "thread", threadId: "conv_o1" }, { caller: "ask", device: "watch" });
    expect(out.map((m) => m.id)).toEqual(["o1"]);
    const [row] = await deps.repos.audit.recent(1);
    expect(row).toMatchObject({ connector: "outlook", capability: "email.read", caller: "ask", ok: true, summary: "thread" });
    expect(row!.args).toBeUndefined();
  });

  it("with both connected, Gmail wins (Outlook is registered after Google)", async () => {
    const deps = makeDeps({ outlook: true });
    await deps.connections.save("google", { secret: "g-rt", secretKind: "refresh_token", grantedScopes: [], connectedAt: "2026-10-01T00:00:00.000Z" });
    await storeOutlook(deps);
    expect((await routeConnector(deps, "email.read"))!.id).toBe("google");
  });

  it("reads Outlook when Google is connected but can't read mail (switched off or scope not granted)", async () => {
    const deps = makeDeps({ outlook: true });
    await storeOutlook(deps);
    const google = { secret: "g-rt", secretKind: "refresh_token" as const, connectedAt: "2026-10-01T00:00:00.000Z" };
    await deps.connections.save("google", { ...google, grantedScopes: [], enabled: ["calendar.read"] });
    expect((await routeConnector(deps, "email.read"))!.id).toBe("outlook");
    expect((await routeConnector(deps, "calendar.read"))!.id).toBe("google");
    await deps.connections.save("google", { ...google, grantedScopes: ["https://www.googleapis.com/auth/calendar.readonly"] });
    expect((await routeConnector(deps, "email.read"))!.id).toBe("outlook");
  });

  it("an Outlook sign-in without Mail.Read shows as disabled and never reads", async () => {
    const deps = makeDeps({ outlook: true, googleConnected: false });
    setDeps(deps);
    await storeOutlook(deps, { grantedScopes: ["offline_access", "User.Read"] });
    const row = await outlookRow();
    expect(row).toMatchObject({ status: "disabled" });
    expect(row!.capabilities[0]).toMatchObject({ id: "email.read", enabled: false, granted: false });
    await expect(readEmail(deps, { op: "account" }, { caller: "cron" })).rejects.toBeInstanceOf(ConnectionUnusableError);
    expect(deps.outlook.calls).toHaveLength(0);
  });

  it("an Outlook connection that needs reauth fails with 'reconnect Outlook' instead of falling back to Gmail", async () => {
    const deps = makeDeps({ outlook: true });
    await storeOutlook(deps, { status: "needs_reauth" });
    deps.ws.messages = [email("g1")];
    const err = await readEmail(deps, { op: "search", query: "x", max: 5 }, { caller: "ask" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionUnusableError);
    expect((err as Error).message).toContain("Outlook (Microsoft 365) needs to be reconnected");
    expect(deps.outlook.calls).toHaveLength(0);
  });

  it("other capabilities never route to Outlook", async () => {
    const deps = makeDeps({ outlook: true });
    await storeOutlook(deps);
    expect((await routeConnector(deps, "calendar.read"))!.id).toBe("google");
    expect((await routeConnector(deps, "email.draft"))!.id).toBe("google");
  });

  it("the Outlook connector offers email.read only, scoped to Mail.Read", () => {
    const c = new OutlookConnector(async () => {
      throw new Error("unused");
    });
    expect(c.capabilities).toEqual(["email.read"]);
    expect(c.scopesFor(["email.read"])).toEqual(["Mail.Read"]);
    expect(c.scopesFor(["email.draft"])).toEqual([]);
    expect(c.firstParty).toBe(true);
  });

  it("list_ids is provider-neutral: Gmail gets the Inbox+Sent query, Outlook gets the date", async () => {
    const since = "2026-10-16T12:00:00.000Z";
    const g = makeDeps();
    const spy = vi.spyOn(g.ws, "listMessageIds");
    await readEmail(g, { op: "list_ids", since, max: 50 }, { caller: "cron" });
    expect(spy).toHaveBeenCalledWith(gmailRecentQuery(new Date(since)), 50);
    expect(gmailRecentQuery(new Date(since))).toBe(`(in:inbox OR in:sent) after:${Date.parse(since) / 1000} -category:promotions -category:social -in:chats`);

    const o = makeDeps({ outlook: true, googleConnected: false });
    await storeOutlook(o);
    await readEmail(o, { op: "list_ids", since, max: 50 }, { caller: "cron" });
    expect(o.outlook.calls).toEqual([{ op: "list_ids", arg: since }]);

    await expect(readEmail(g, { op: "list_ids", query: "in:inbox", max: 5 } as never, { caller: "cron" })).rejects.toThrow(/invalid input/);
  });

  it("the cron scan works for an Outlook-only owner", async () => {
    const llm = new ScriptedLLM([
      () =>
        msg([
          toolUse("record_email_analysis", {
            summary: "Dana will send the deposit Friday.",
            categories: ["Payment"],
            importance: "MEDIUM",
            people: ["Dana Lee"],
            commitments: [{ who: "Dana Lee", what: "Send deposit", dueAt: "2026-10-23", dueInferred: false, confidence: "CONFIRMED" }],
            decisions: [],
            followups: [],
          }),
        ]),
    ]);
    const deps = makeDeps({ llm, outlook: true, googleConnected: false });
    setDeps(deps);
    await storeOutlook(deps);
    deps.outlook.messages = [email("o1")];
    const res = await scanGet(req("GET", "/api/cron/scan", { token: "test-cron-secret" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ processed: 1, failed: 0, commitmentsAdded: 1 });
    expect(deps.outlook.calls.map((c) => c.op)).toEqual(["account", "list_ids", "message"]);
    expect((await deps.repos.commitments.list("open"))[0]).toMatchObject({ what: "Send deposit", source: { kind: "email", ref: "o1" } });
  });

  it("the cron scan answers 409 when no mailbox is connected", async () => {
    const deps = makeDeps({ outlook: true, googleConnected: false });
    setDeps(deps);
    const res = await scanGet(req("GET", "/api/cron/scan", { token: "test-cron-secret" }));
    expect(res.status).toBe(409);
    expect(deps.outlook.calls).toHaveLength(0);
  });

  it("the cron scan answers 409 when the stored Outlook record can't be read", async () => {
    const deps = makeDeps({ outlook: true, googleConnected: false });
    setDeps(deps);
    await storeOutlook(deps);
    deps.outlook.connected = false; // what MicrosoftAuth throws when load() finds no readable record
    const res = await scanGet(req("GET", "/api/cron/scan", { token: "test-cron-secret" }));
    expect(res.status).toBe(409);
  });
});
