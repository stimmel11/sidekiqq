import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encrypt, pkceChallenge, pkcePair } from "@/lib/crypto";
import type { ImplementedCapability, Out } from "@/lib/connectors/capabilities";
import { GoogleConnector } from "@/lib/connectors/google";
import { invokeCapability, isInvalidGrant, readEmail } from "@/lib/connectors/invoke";
import { ConnectionStore, connectionAad, effectiveCapabilities, parseScopes, StoredConnectionSchema, type StoredConnectionInput } from "@/lib/connectors/store";
import { ConnectionUnusableError, type Connector } from "@/lib/connectors/types";
import { GoogleTokenStore } from "@/lib/google/auth";
import { runScan } from "@/lib/scan/scanner";
import { makeDeps, MemoryKV } from "./fakes";

const NOW = new Date("2026-10-16T15:00:00Z");
const G = "https://www.googleapis.com/auth/";
const ALL_GOOGLE_SCOPES = `openid email ${G}gmail.readonly ${G}gmail.compose ${G}calendar.readonly ${G}drive.readonly`;

function store(kv = new MemoryKV(), ring: { current: Buffer; previous?: Buffer } = { current: randomBytes(32) }) {
  let keys = ring;
  return {
    kv,
    s: new ConnectionStore(kv, "t", () => keys),
    setKeys: (k: typeof ring) => {
      keys = k;
    },
  };
}

const base: StoredConnectionInput = {
  secret: "1//refresh-SECRET",
  secretKind: "refresh_token",
  account: "owner@example.com",
  grantedScopes: [`${G}gmail.readonly`],
  connectedAt: "2026-10-01T00:00:00.000Z",
};

describe("ConnectionStore", () => {
  it("encrypts per connector; a ciphertext can't be replayed under another connector", async () => {
    const { kv, s } = store();
    await s.save("google", base);
    const raw = await kv.get("t:conn:google:tokens");
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("refresh-SECRET");
    expect(raw).not.toContain("owner@example.com");
    expect((await s.load("google"))?.secret).toBe("1//refresh-SECRET");
    expect((await s.load("google"))?.status).toBe("connected");

    // Copy Google's record under another connector's key: the AAD no longer matches.
    await kv.set("t:conn:microsoft:tokens", raw!);
    expect(await s.load("microsoft")).toBeNull();
  });

  it("rejects malformed connector ids instead of building odd Redis keys", async () => {
    const { s } = store();
    await expect(s.save("../google", base)).rejects.toThrow();
    await expect(s.save("Google", base)).rejects.toThrow();
  });

  it("key rotation: reads with TOKEN_ENCRYPTION_KEY_PREV and re-encrypts with the new key", async () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const { kv, s, setKeys } = store(new MemoryKV(), { current: oldKey });
    await s.save("google", base);
    const before = await kv.get("t:conn:google:tokens");

    setKeys({ current: newKey }); // rotated without PREV: unreadable, reconnect required
    expect(await s.load("google")).toBeNull();

    setKeys({ current: newKey, previous: oldKey });
    expect((await s.load("google"))?.secret).toBe("1//refresh-SECRET");
    const after = await kv.get("t:conn:google:tokens");
    expect(after).not.toBe(before);

    setKeys({ current: newKey }); // PREV removed: still readable, it was re-encrypted
    expect((await s.load("google"))?.secret).toBe("1//refresh-SECRET");
  });

  it("migrates the legacy Google record (old AAD) on first load and keeps the legacy key", async () => {
    const key = randomBytes(32);
    const { kv, s } = store(new MemoryKV(), { current: key });
    const legacy = { refreshToken: "1//legacy", email: "owner@example.com", scope: ALL_GOOGLE_SCOPES, connectedAt: "2026-09-01T00:00:00.000Z" };
    await kv.set("t:google:tokens", encrypt(JSON.stringify(legacy), key, "sidekiqq:google-refresh-token:v1"));

    const got = await s.load("google");
    expect(got).toMatchObject({ secret: "1//legacy", secretKind: "refresh_token", account: "owner@example.com", connectedAt: legacy.connectedAt, status: "connected" });
    expect(got?.grantedScopes).toContain(`${G}gmail.readonly`);
    expect(got?.enabled).toBeUndefined();
    expect(await kv.get("t:google:tokens")).toBeTruthy(); // kept for one release
    const migrated = await kv.get("t:conn:google:tokens");
    expect(migrated).toBeTruthy();
    expect(migrated).not.toContain("1//legacy");

    // The new record wins from now on, even if the legacy one changes.
    await kv.set("t:google:tokens", encrypt(JSON.stringify({ ...legacy, refreshToken: "1//other" }), key, "sidekiqq:google-refresh-token:v1"));
    expect((await s.load("google"))?.secret).toBe("1//legacy");
  });

  it("migration also works when the legacy record was written with the previous key", async () => {
    const oldKey = randomBytes(32);
    const { kv, s } = store(new MemoryKV(), { current: randomBytes(32), previous: oldKey });
    await kv.set("t:google:tokens", encrypt(JSON.stringify({ refreshToken: "1//legacy", connectedAt: "2026-09-01T00:00:00.000Z" }), oldKey, "sidekiqq:google-refresh-token:v1"));
    const got = await s.load("google");
    expect(got?.secret).toBe("1//legacy");
    expect(got?.grantedScopes).toEqual([]); // unknown, not "none"
  });

  it("never migrates for other connectors, and a corrupt legacy record means not connected", async () => {
    const { kv, s } = store();
    await kv.set("t:google:tokens", "v1.garbage.garbage.garbage");
    expect(await s.load("google")).toBeNull();
    expect(await kv.get("t:conn:google:tokens")).toBeNull();
    expect(await s.load("microsoft")).toBeNull();
  });

  it("clear removes the new and the legacy Google record, so nothing is re-migrated", async () => {
    const key = randomBytes(32);
    const { kv, s } = store(new MemoryKV(), { current: key });
    await kv.set("t:google:tokens", encrypt(JSON.stringify({ refreshToken: "1//legacy", connectedAt: "x" }), key, "sidekiqq:google-refresh-token:v1"));
    expect(await s.load("google")).not.toBeNull();
    await s.clear("google");
    expect(await s.load("google")).toBeNull();
    expect(await kv.get("t:google:tokens")).toBeNull();
  });

  it("markNeedsReauth reports only the transition", async () => {
    const { s } = store();
    expect(await s.markNeedsReauth("google", "x")).toBe(false); // not connected
    await s.save("google", base);
    expect(await s.markNeedsReauth("google", "invalid_grant")).toBe(true);
    expect(await s.markNeedsReauth("google", "invalid_grant")).toBe(false);
    expect(await s.load("google")).toMatchObject({ status: "needs_reauth", lastError: "invalid_grant" });
  });

  it("setEnabled only accepts capabilities the connector offers", async () => {
    const { s } = store();
    const google = new GoogleConnector(async () => {
      throw new Error("unused");
    });
    expect(await s.setEnabled(google, ["email.read"])).toBeNull(); // not connected
    await s.save("google", base);
    await expect(s.setEnabled(google, ["grocery.checkout"])).rejects.toThrow(/does not offer/);
    expect((await s.setEnabled(google, ["email.read", "email.read", "calendar.read"]))?.enabled).toEqual(["email.read", "calendar.read"]);
  });

  it("state carries the PKCE verifier and is single use; tickets are single use and per connector", async () => {
    const { s } = store();
    const state = await s.issueState("google", "verifier-123");
    expect(await s.consumeState("microsoft", state)).toBeNull();
    expect(await s.consumeState("google", state)).toBe("verifier-123");
    expect(await s.consumeState("google", state)).toBeNull();
    expect(await s.consumeState("google", "bad state!")).toBeNull();

    const ticket = await s.issueConnectTicket("google");
    expect(await s.consumeConnectTicket("microsoft", ticket)).toBe(false);
    expect(await s.consumeConnectTicket("google", ticket)).toBe(true);
    expect(await s.consumeConnectTicket("google", ticket)).toBe(false);
  });
});

describe("effectiveCapabilities", () => {
  const google = new GoogleConnector(async () => {
    throw new Error("unused");
  });
  const stored = (over: Partial<StoredConnectionInput>) => StoredConnectionSchema.parse({ ...base, grantedScopes: [], ...over });

  it("defaults to everything the connector offers when scopes are unknown", () => {
    expect(effectiveCapabilities(google, stored({}))).toEqual([...google.capabilities]);
  });

  it("drops capabilities whose scope was not granted", () => {
    const caps = effectiveCapabilities(google, stored({ grantedScopes: parseScopes(`openid ${G}gmail.readonly ${G}calendar.readonly`) }));
    expect(caps).toEqual(["email.read", "calendar.read"]);
  });

  it("honours the owner's enabled list", () => {
    expect(effectiveCapabilities(google, stored({ grantedScopes: parseScopes(ALL_GOOGLE_SCOPES), enabled: ["calendar.read"] }))).toEqual(["calendar.read"]);
  });
});

describe("invokeCapability with a stored connection (§4 step 3)", () => {
  const draft = { to: ["dana@acme.com"], subject: "Hi", body: "b" };

  it("no stored connection: behaves as before (the connector decides)", async () => {
    const deps = makeDeps({ now: NOW });
    await expect(readEmail(deps, { op: "search", query: "x", max: 1 }, { caller: "ask" })).resolves.toEqual([]);
  });

  it("refuses a capability the owner turned off, before the connector runs, and audits nothing", async () => {
    const deps = makeDeps({ now: NOW });
    await deps.connections.save("google", { ...base, grantedScopes: parseScopes(ALL_GOOGLE_SCOPES), enabled: ["email.read", "calendar.read"] });
    const before = deps.ws.drafts.size;
    const err = await invokeCapability(deps, "email.draft", draft, { caller: "ask" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionUnusableError);
    expect((err as ConnectionUnusableError).reason).toBe("disabled");
    expect(deps.ws.drafts.size).toBe(before);
    expect(await deps.repos.audit.recent()).toEqual([]);
    await expect(readEmail(deps, { op: "search", query: "x", max: 1 }, { caller: "ask" })).resolves.toEqual([]);
  });

  it("refuses a capability whose scope Google did not grant", async () => {
    const deps = makeDeps({ now: NOW });
    await deps.connections.save("google", { ...base, grantedScopes: parseScopes(`${G}gmail.readonly`) });
    await expect(invokeCapability(deps, "files.read", { query: "p", max: 1, includeContent: false }, { caller: "ask" })).rejects.toBeInstanceOf(ConnectionUnusableError);
  });

  it("needs_reauth fails every capability with a spoken reconnect message", async () => {
    const deps = makeDeps({ now: NOW });
    await deps.connections.save("google", { ...base, grantedScopes: [], status: "needs_reauth" });
    await expect(readEmail(deps, { op: "account" }, { caller: "cron" })).rejects.toThrow(/reconnected/);
  });

  it("an invalid_grant from the provider marks the connection needs_reauth", async () => {
    const deps = makeDeps({ now: NOW });
    await deps.connections.save("google", { ...base, grantedScopes: [] });
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
    await expect(readEmail(d, { op: "account" }, { caller: "ask" })).rejects.toThrow(/invalid_grant/);
    expect((await deps.connections.load("google"))?.status).toBe("needs_reauth");
    await expect(readEmail(d, { op: "account" }, { caller: "ask" })).rejects.toBeInstanceOf(ConnectionUnusableError);
  });

  it("other provider errors don't touch the connection status", async () => {
    expect(isInvalidGrant(new Error("Request failed with status 500"))).toBe(false);
    expect(isInvalidGrant(new Error("invalid_grant_type_extended"))).toBe(false);
    expect(isInvalidGrant({ response: { data: { error: "invalid_grant" } } })).toBe(true);
  });

  it("the cron scan stops early (409 path) when Google needs reconnecting", async () => {
    const deps = makeDeps({ now: NOW });
    await deps.connections.save("google", { ...base, grantedScopes: [], status: "needs_reauth" });
    await expect(runScan(deps)).rejects.toBeInstanceOf(ConnectionUnusableError);
  });
});

describe("GoogleTokenStore adapter", () => {
  it("a reconnect keeps the owner's enabled capabilities and clears needs_reauth", async () => {
    const kv = new MemoryKV();
    const conns = new ConnectionStore(kv, "t", () => ({ current: Buffer.alloc(32, 7) }));
    const g = new GoogleTokenStore(conns);
    await g.save({ refreshToken: "1//a", email: "owner@example.com", scope: ALL_GOOGLE_SCOPES, connectedAt: "2026-10-01T00:00:00.000Z" });
    await conns.update("google", (v) => ({ ...v, enabled: ["email.read"] }));
    await conns.markNeedsReauth("google", "invalid_grant");

    await g.save({ refreshToken: "1//b", scope: ALL_GOOGLE_SCOPES, connectedAt: "2026-10-02T00:00:00.000Z" });
    const c = await conns.load("google");
    expect(c).toMatchObject({ secret: "1//b", status: "connected", enabled: ["email.read"] });
    expect(c?.lastError).toBeUndefined();
    expect(await g.load()).toMatchObject({ refreshToken: "1//b", scope: expect.stringContaining("gmail.readonly") });
  });

  it("state round-trips the PKCE verifier", async () => {
    const g = new GoogleTokenStore(new ConnectionStore(new MemoryKV(), "t", () => ({ current: randomBytes(32) })));
    const pkce = pkcePair();
    const state = await g.issueState(pkce.verifier);
    expect(await g.consumeState(state)).toBe(pkce.verifier);
    expect(await g.consumeState(state)).toBeNull();
  });
});

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B test vector", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generates a verifier of legal length and charset", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(pkceChallenge(verifier));
  });

  it("uses a distinct AAD per connector", () => {
    expect(connectionAad("google")).not.toBe(connectionAad("microsoft"));
  });
});

describe("store hardening", () => {
  it("a migration that read the legacy record before a disconnect does not resurrect it", async () => {
    const key = Buffer.alloc(32, 3);
    const kv = new MemoryKV();
    const s = new ConnectionStore(kv, "t", () => ({ current: key }));
    await kv.set("t:google:tokens", encrypt(JSON.stringify({ refreshToken: "1//legacy", connectedAt: "x" }), key, "sidekiqq:google-refresh-token:v1"));
    // Simulate clear() landing between the migration's read and its write.
    const realGet = kv.get.bind(kv);
    let reads = 0;
    kv.get = async (k: string) => {
      const v = await realGet(k);
      if (k === "t:google:tokens" && ++reads === 1) await kv.del("t:google:tokens");
      return v;
    };
    expect(await s.load("google")).toBeNull();
    kv.get = realGet;
    expect(await kv.get("t:conn:google:tokens")).toBeNull();
  });

  it("markNeedsReauth leaves a newer connection alone", async () => {
    const { s } = store();
    await s.save("google", { ...base, secret: "1//new" });
    expect(await s.markNeedsReauth("google", "invalid_grant", "1//old")).toBe(false);
    expect((await s.load("google"))?.status).toBe("connected");
    expect(await s.markNeedsReauth("google", "invalid_grant", "1//new")).toBe(true);
  });

  it("drops capability ids it no longer knows instead of losing the connection", async () => {
    const key = Buffer.alloc(32, 5);
    const kv = new MemoryKV();
    const s = new ConnectionStore(kv, "t", () => ({ current: key }));
    const rec = { ...base, enabled: ["email.read", "email.retired_capability"], status: "connected" };
    await kv.set("t:conn:google:tokens", encrypt(JSON.stringify(rec), key, connectionAad("google")));
    expect((await s.load("google"))?.enabled).toEqual(["email.read"]);
  });

  it("does not overwrite a record that changed after a rotated read", async () => {
    const oldKey = Buffer.alloc(32, 1);
    const newKey = Buffer.alloc(32, 2);
    const kv = new MemoryKV();
    let ring: { current: Buffer; previous?: Buffer } = { current: oldKey };
    const s = new ConnectionStore(kv, "t", () => ring);
    await s.save("google", base);
    ring = { current: newKey, previous: oldKey };
    const realGet = kv.get.bind(kv);
    let n = 0;
    kv.get = async (k: string) => {
      const v = await realGet(k);
      // After the first read, a reconnect writes a new record.
      if (++n === 1) await kv.set(k, encrypt(JSON.stringify({ ...base, secret: "1//fresh", status: "connected" }), newKey, connectionAad("google")));
      return v;
    };
    await s.load("google");
    kv.get = realGet;
    expect((await s.load("google"))?.secret).toBe("1//fresh");
  });

  it("isInvalidGrant recognises google-auth-library's JSON message form", () => {
    expect(isInvalidGrant(new Error('{"error":"invalid_grant","error_description":"Token has been expired or revoked."}'))).toBe(true);
    expect(isInvalidGrant(new Error("upstream said invalid_grant somewhere"))).toBe(false);
  });
});
