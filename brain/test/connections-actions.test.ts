import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDeps } from "@/lib/deps";
import { SESSION_COOKIE, signSession } from "@/lib/dashboard/session";
import { makeDeps, type TestDeps } from "./fakes";

/** Dashboard server actions behind the Connections screen: session required, codes only in redirects. */

const SECRET = "test-session-secret-0123456789abcdef";
const jar = new Map<string, string>();

class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined),
    set: (n: string, v: string) => jar.set(n, v),
    delete: (n: string) => jar.delete(n),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Redirect) return e.to;
    throw e;
  }
  throw new Error("expected a redirect");
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function connect(deps: TestDeps) {
  await deps.connections.save("google", { secret: "1//r", secretKind: "refresh_token", grantedScopes: [], connectedAt: "2026-10-01T00:00:00.000Z" });
}

beforeEach(() => {
  jar.clear();
  process.env.SESSION_SECRET = SECRET;
  process.env.GOOGLE_CLIENT_ID = "cid.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "csecret";
  process.env.APP_URL = "https://brain.example.com";
});
afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.APP_URL;
});

describe("Connections server actions", () => {
  it("every action needs the owner session", async () => {
    const { setCapabilityAction, connectConnectorAction, disconnectConnectorAction } = await import("@/app/(dashboard)/dashboard/actions");
    const deps = makeDeps();
    setDeps(deps);
    await connect(deps);
    expect(await redirectOf(setCapabilityAction(form({ connectorId: "google", capability: "email.read", on: "0" })))).toBe("/login");
    expect(await redirectOf(connectConnectorAction(form({ connectorId: "google" })))).toBe("/login");
    expect(await redirectOf(disconnectConnectorAction(undefined, form({ connectorId: "google", confirm: "disconnect" })))).toBe("/login");
    expect((await deps.connections.load("google"))?.enabled).toBeUndefined();
  });

  it("toggles one capability, refuses anything the connector doesn't offer", async () => {
    const { setCapabilityAction } = await import("@/app/(dashboard)/dashboard/actions");
    jar.set(SESSION_COOKIE, (await signSession(SECRET)).value);
    const deps = makeDeps();
    setDeps(deps);
    await connect(deps);
    expect(await redirectOf(setCapabilityAction(form({ connectorId: "google", capability: "files.read", on: "0" })))).toBe("/dashboard/connections?done=saved");
    expect((await deps.connections.load("google"))?.enabled).toEqual(["email.read", "email.draft", "calendar.read", "contacts.lookup"]);
    expect(await redirectOf(setCapabilityAction(form({ connectorId: "google", capability: "files.read", on: "1" })))).toBe("/dashboard/connections?done=saved");
    expect((await deps.connections.load("google"))?.enabled).toContain("files.read");
    expect(await redirectOf(setCapabilityAction(form({ connectorId: "google", capability: "email.send", on: "1" })))).toBe("/dashboard/connections?error=unknown");
    expect(await redirectOf(setCapabilityAction(form({ connectorId: "../x", capability: "email.read", on: "1" })))).toBe("/dashboard/connections?error=unknown");
    await deps.connections.clear("google");
    expect(await redirectOf(setCapabilityAction(form({ connectorId: "google", capability: "email.read", on: "1" })))).toBe("/dashboard/connections?error=not_connected");
  });

  it("disconnect needs the dialog's confirm value; connect redirects to Google", async () => {
    const { disconnectConnectorAction, connectConnectorAction } = await import("@/app/(dashboard)/dashboard/actions");
    jar.set(SESSION_COOKIE, (await signSession(SECRET)).value);
    const deps = makeDeps();
    setDeps(deps);
    await connect(deps);
    expect(await disconnectConnectorAction(undefined, form({ connectorId: "google" }))).toMatchObject({ error: expect.any(String) });
    expect(await deps.connections.load("google")).not.toBeNull();

    const { google } = await import("googleapis");
    vi.spyOn(google.auth.OAuth2.prototype, "revokeToken").mockImplementation((async () => ({ data: {} })) as never);
    expect(await redirectOf(disconnectConnectorAction(undefined, form({ connectorId: "google", confirm: "disconnect" })))).toBe("/dashboard/connections?done=disconnected");
    expect(await deps.connections.load("google")).toBeNull();

    const to = new URL(await redirectOf(connectConnectorAction(form({ connectorId: "google" }))));
    expect(to.host).toBe("accounts.google.com");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    vi.restoreAllMocks();
  });
});
