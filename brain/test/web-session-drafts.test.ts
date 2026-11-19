import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDeps } from "@/lib/deps";
import { draftFingerprint } from "@/lib/confirmation";
import { invokeCapability } from "@/lib/connectors/invoke";
import { CODE_MESSAGES, SESSION_EXPIRED, approveDraft, completeCommitment, discardDraft, outcomeFor, type FetchLike } from "@/lib/dashboard/browser-api";
import { makeDeps, type TestDeps } from "./fakes";
import { sessionFetch } from "./session-fetch";

/** Web app slice 2c-ii-b (docs/WEBAPP.md §4.2): the dashboard posts drafts and commitments from the browser as the session. */

const SECRET = "test-session-secret-0123456789abcdef";
const SRC = path.resolve(__dirname, "../src");

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});
afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

async function setup(): Promise<{ deps: TestDeps; id: string; fp: string }> {
  const deps = makeDeps();
  setDeps(deps);
  const out = await invokeCapability(deps, "email.draft", { to: ["dana@acme.com"], subject: "Proposal", body: "Here it is." }, { caller: "ask" });
  return { deps, id: out.draftId, fp: draftFingerprint((await deps.repos.drafts.get(out.draftId))!) };
}

function recorder(status = 200, body: unknown = { ok: true }) {
  const calls: { path: string; init: RequestInit }[] = [];
  const f: FetchLike = async (p, init) => {
    calls.push({ path: p, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { f, calls };
}

describe("request shape", () => {
  it("approve posts exactly { confirmation } as same-origin JSON, with no bearer token", async () => {
    const { f, calls } = recorder();
    const fp = "a".repeat(64);
    expect(await approveDraft("drf_1", fp, f)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const { path: p, init } = calls[0]!;
    expect(p).toBe("/api/drafts/drf_1/approve");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error" });
    expect(JSON.parse(init.body as string)).toEqual({ confirmation: fp });
    const h = new Headers(init.headers);
    expect(h.get("content-type")).toBe("application/json");
    expect(h.has("authorization")).toBe(false);
  });

  it("discard and complete post no body", async () => {
    const { f, calls } = recorder();
    await discardDraft("drf_1", f);
    await completeCommitment("cmt_1", f);
    expect(calls.map((c) => c.path)).toEqual(["/api/drafts/drf_1/discard", "/api/commitments/cmt_1/complete"]);
    for (const c of calls) {
      expect(c.init.method).toBe("POST");
      expect(c.init.body).toBeUndefined();
    }
  });

  it("odd ids and malformed fingerprints never leave the browser", async () => {
    const { f, calls } = recorder();
    for (const id of ["", "../x", "a/b", "a?b", "x".repeat(65), "drf 1", "%2e%2e"]) {
      expect((await approveDraft(id, "a".repeat(64), f)).ok).toBe(false);
      expect((await discardDraft(id, f)).ok).toBe(false);
      expect((await completeCommitment(id, f)).ok).toBe(false);
    }
    for (const fp of ["", "send", "A".repeat(64), "a".repeat(63), "a".repeat(65), `${"a".repeat(63)}g`]) {
      expect(await approveDraft("drf_1", fp, f)).toMatchObject({ ok: false, error: CODE_MESSAGES.confirmation_required });
    }
    expect(calls).toHaveLength(0);
  });
});

describe("against the real routes as a session", () => {
  it("approve sends exactly once; a double click sends once", async () => {
    const { deps, id, fp } = await setup();
    const f = await sessionFetch();
    const [a, b] = await Promise.all([approveDraft(id, fp, f), approveDraft(id, fp, f)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(deps.sender.sendDraft).toHaveBeenCalledOnce();
    expect((await deps.repos.drafts.get(id))?.status).toBe("sent");
  });

  it("a draft edited after the dialog opened is refused with 409 changed, nothing sent", async () => {
    const { deps, id, fp } = await setup();
    const d = (await deps.repos.drafts.get(id))!;
    await deps.kv.hset("t:drafts", id, JSON.stringify({ ...d, body: "Wire the money to this account." }));
    expect((await deps.repos.drafts.get(id))?.body).not.toBe(d.body);
    const r = await approveDraft(id, fp, await sessionFetch());
    expect(r).toEqual({ ok: false, error: CODE_MESSAGES.changed });
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
    expect((await deps.repos.drafts.get(id))?.status).toBe("pending");
  });

  it("a cross-site request is refused and nothing is sent", async () => {
    const { deps, id, fp } = await setup();
    const f = await sessionFetch({ headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" } });
    expect(await approveDraft(id, fp, f)).toEqual({ ok: false, error: CODE_MESSAGES.cross_site });
    expect(await discardDraft(id, f)).toEqual({ ok: false, error: CODE_MESSAGES.cross_site });
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
    expect((await deps.repos.drafts.get(id))?.status).toBe("pending");
  });

  it("an invalid session is 401 with a sign-in message; nothing is sent", async () => {
    const { deps, id, fp } = await setup();
    const f = await sessionFetch({ secret: "some-other-secret-0123456789abcdef" });
    expect(await approveDraft(id, fp, f)).toEqual({ ok: false, error: CODE_MESSAGES.unauthorized });
    expect(await completeCommitment("cmt_x", f)).toEqual({ ok: false, error: CODE_MESSAGES.unauthorized });
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
  });

  it("discarding a sent draft is refused", async () => {
    const { deps, id, fp } = await setup();
    const f = await sessionFetch();
    expect((await approveDraft(id, fp, f)).ok).toBe(true);
    expect(await discardDraft(id, f)).toEqual({ ok: false, error: CODE_MESSAGES.not_pending });
    expect((await deps.repos.drafts.get(id))?.status).toBe("sent");
  });
});

describe("outcomes", () => {
  it("a network failure on approve says the result is unknown", async () => {
    const f = vi.fn<FetchLike>().mockRejectedValue(new TypeError("Failed to fetch"));
    const r = await approveDraft("drf_1", "a".repeat(64), f);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/result is unknown/) });
  });

  it("a gateway error or timeout on approve is also 'result unknown' (Gmail may have sent it)", async () => {
    for (const status of [502, 504]) {
      const { f } = recorder(status, "<html>gateway</html>");
      expect(await approveDraft("drf_1", "a".repeat(64), f)).toMatchObject({ ok: false, error: expect.stringMatching(/result is unknown/) });
    }
    const { f } = recorder(503, {});
    expect((await approveDraft("drf_1", "a".repeat(64), f)) as { error: string }).toMatchObject({ error: expect.stringMatching(/nothing was sent/) });
  });

  it("a 401 is the SESSION_EXPIRED message the components send to sign-in", async () => {
    const { f } = recorder(401, { code: "unauthorized", error: "x" });
    expect(await completeCommitment("cmt_1", f)).toEqual({ ok: false, error: SESSION_EXPIRED });
  });

  it("maps codes first, then status, then the route's message", () => {
    expect(outcomeFor(200, { ok: true, warning: "No Meet link" })).toEqual({ ok: true, warning: "No Meet link" });
    expect(outcomeFor(204, {})).toEqual({ ok: true });
    expect(outcomeFor(409, { code: "changed_in_provider", error: "x" })).toEqual({ ok: false, error: CODE_MESSAGES.changed_in_provider });
    expect(outcomeFor(503, { code: "who_knows" }, { 503: "Not configured." })).toEqual({ ok: false, error: "Not configured." });
    expect(outcomeFor(418, { error: "teapot" })).toEqual({ ok: false, error: "teapot" });
    expect(outcomeFor(500, "nope" as unknown as Record<string, unknown>)).toEqual({ ok: false, error: "Request failed (500)." });
    // A code that names an Object.prototype key is not a message.
    expect(outcomeFor(400, { code: "constructor", error: "bad" })).toEqual({ ok: false, error: "bad" });
  });
});

describe("static: the dashboard has no server-side send path left", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
  }
  const dashboard = [...files(path.join(SRC, "app/(dashboard)")), ...files(path.join(SRC, "lib/dashboard"))];

  it("no dashboard file imports the approve route handler or the old bridge approval module", () => {
    for (const f of dashboard) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/api\/drafts\/\[id\]\/approve\/route/);
      expect(s, f).not.toMatch(/dashboard\/approval/);
    }
  });

  it("only browser-api.ts names the approve path, and only DraftDecision calls approveDraft", () => {
    for (const f of dashboard) {
      const s = readFileSync(f, "utf8");
      const rel = path.relative(SRC, f);
      if (/\/approve\b/.test(s.replace(/^\s*(\*|\/\/).*$/gm, ""))) expect(rel).toBe("lib/dashboard/browser-api.ts");
      if (/\bapproveDraft\(/.test(s)) expect(["lib/dashboard/browser-api.ts", "app/(dashboard)/dashboard/drafts/[id]/DraftDecision.tsx"]).toContain(rel);
    }
  });

  it("the server actions no longer approve, discard or complete", () => {
    const s = readFileSync(path.join(SRC, "app/(dashboard)/dashboard/actions.ts"), "utf8");
    expect(s).not.toMatch(/approveDraft|discardDraft|completeCommitment/);
  });
});
