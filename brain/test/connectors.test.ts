import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setDeps } from "@/lib/deps";
import {
  BACKGROUND_ALLOWED,
  CAPABILITY_IDS,
  POLICY,
  type Caller,
  type ImplementedCapability,
  type In,
  type Out,
} from "@/lib/connectors/capabilities";
import { GoogleConnector } from "@/lib/connectors/google";
import { invokeCapability, readEmail } from "@/lib/connectors/invoke";
import { CapabilityDeniedError, CapabilityUnavailableError, type Connector } from "@/lib/connectors/types";
import { AuditRepo } from "@/lib/repos/audit";
import { makeDeps, MemoryKV, msg, pairDevice, params, req, ScriptedLLM, toolUse, type TestDeps } from "./fakes";
import { POST as ask } from "@/app/api/ask/route";

const SRC = path.resolve(__dirname, "../src");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
const strip = (f: string) =>
  readFileSync(f, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const NOW = new Date("2026-10-16T15:00:00Z");
const validInputs: Record<ImplementedCapability, unknown> = {
  "email.read": { op: "search", query: "from:dana", max: 5 },
  "email.draft": { to: ["dana@acme.com"], subject: "Hi", body: "SECRET BODY TEXT" },
  "calendar.read": { timeMin: "2026-10-16T00:00:00.000Z", timeMax: "2026-10-17T00:00:00.000Z", max: 10 },
  "files.read": { query: "proposal", max: 3, includeContent: false },
  "contacts.lookup": { name: "Dana", max: 5 },
  "video.create_room": { topic: "Sync with Dana" },
};

describe("policy table (docs/CONNECTORS.md §2, §4 floor)", () => {
  it("has no send capability; executors are not callable", () => {
    expect(CAPABILITY_IDS.some((c) => /send|execute/i.test(c))).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(POLICY, "email.send")).toBe(false);
  });

  it("checkout and device actions are always user_finishes; invites and holds are confirm", () => {
    expect(POLICY["grocery.checkout"]).toBe("user_finishes");
    expect(POLICY["device.call"]).toBe("user_finishes");
    expect(POLICY["device.open_url"]).toBe("user_finishes");
    expect(POLICY["calendar.invite.prepare"]).toBe("confirm");
    expect(POLICY["calendar.hold.prepare"]).toBe("confirm");
  });

  it("background callers may only read email, calendar and contacts", () => {
    expect([...BACKGROUND_ALLOWED].sort()).toEqual(["calendar.read", "contacts.lookup", "email.read"]);
  });
});

describe("invokeCapability", () => {
  function setup() {
    const deps = makeDeps({ now: NOW });
    setDeps(deps);
    return deps;
  }

  it("runs an auto read through the Google connector and audits it", async () => {
    const deps = setup();
    deps.ws.messages = [
      { id: "m1", threadId: "t1", from: "dana@acme.com", to: "me", subject: "Hi", date: NOW.toISOString(), snippet: "", labels: [], cc: "", body: "b" },
    ];
    const out = await readEmail(deps, { op: "search", query: "from:dana", max: 5 }, { caller: "ask", device: "watch" });
    expect(out.map((m) => m.id)).toEqual(["m1"]);
    const [row] = await deps.repos.audit.recent();
    expect(row).toMatchObject({ connector: "google", capability: "email.read", tier: "auto", caller: "ask", device: "watch", ok: true });
    expect(row?.summary).toContain("from:dana");
    expect(row?.args).toBeUndefined(); // first-party: arguments are not logged
  });

  it("email.draft creates a provider draft and never logs the body", async () => {
    const deps = setup();
    const out = await invokeCapability(deps, "email.draft", validInputs["email.draft"] as In<"email.draft">, { caller: "ask" });
    expect(out.providerDraftId).toMatch(/^gdraft_/);
    expect(deps.ws.createDraft).toHaveBeenCalledOnce();
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
    const raw = JSON.stringify(await deps.repos.audit.recent());
    expect(raw).toContain("dana@acme.com");
    expect(raw).not.toContain("SECRET BODY TEXT");
  });

  it("refuses names outside the closed list", async () => {
    const deps = setup();
    for (const name of ["email.send", "gmail.send", "send_email", "calendar.invite", "payment.checkout", "__proto__", "toString"]) {
      await expect(invokeCapability(deps, name, {}, { caller: "ask" })).rejects.toBeInstanceOf(CapabilityDeniedError);
    }
    expect(await deps.repos.audit.recent()).toEqual([]);
  });

  it("confirm and user_finishes tiers never run in the brain", async () => {
    const deps = setup();
    for (const cap of ["calendar.invite.prepare", "calendar.hold.prepare", "grocery.checkout", "device.call", "device.open_url"]) {
      await expect(invokeCapability(deps, cap, {}, { caller: "ask" })).rejects.toBeInstanceOf(CapabilityDeniedError);
    }
  });

  it.each<Caller>(["cron", "brief"])("background caller %s cannot write or read files", async (caller) => {
    const deps = setup();
    await expect(invokeCapability(deps, "email.draft", validInputs["email.draft"], { caller })).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(invokeCapability(deps, "files.read", validInputs["files.read"], { caller })).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(invokeCapability(deps, "grocery.cart.add", {}, { caller })).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(deps.ws.createDraft).not.toHaveBeenCalled();
    // ...but may read email and calendar
    await expect(invokeCapability(deps, "calendar.read", validInputs["calendar.read"], { caller })).resolves.toEqual([]);
  });

  it("an allowed but unbuilt capability is unavailable, not silently ignored", async () => {
    const deps = setup();
    await expect(invokeCapability(deps, "grocery.search", { query: "milk" }, { caller: "ask" })).rejects.toBeInstanceOf(CapabilityUnavailableError);
    // Built, but Zoom isn't configured in these deps, so no connector offers it.
    await expect(invokeCapability(deps, "video.create_room", { topic: "x" }, { caller: "ask" })).rejects.toBeInstanceOf(CapabilityUnavailableError);
  });

  it("validates input before the connector sees it", async () => {
    const deps = setup();
    const spy = vi.spyOn(deps.ws, "searchGmail");
    await expect(invokeCapability(deps, "email.read", { op: "search", query: "x", max: 999 }, { caller: "ask" })).rejects.toThrow(/invalid input/);
    await expect(invokeCapability(deps, "email.read", { op: "delete", id: "m1" }, { caller: "ask" })).rejects.toThrow(/invalid input/);
    await expect(invokeCapability(deps, "calendar.read", { timeMin: "tomorrow", timeMax: "x", max: 1 }, { caller: "ask" })).rejects.toThrow(/invalid input/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("audits failures (e.g. Google not connected) and rethrows them", async () => {
    const deps = makeDeps({ now: NOW, googleConnected: false });
    await expect(readEmail(deps, { op: "account" }, { caller: "cron" })).rejects.toThrow(/not connected/);
    const [row] = await deps.repos.audit.recent();
    expect(row).toMatchObject({ capability: "email.read", caller: "cron", ok: false });
    expect(row?.error).toMatch(/not connected/);
  });

  it("logs arguments for non-first-party connectors", async () => {
    const deps = setup();
    const third: Connector = {
      id: "mcp-test",
      displayName: "Test MCP",
      firstParty: false,
      capabilities: ["files.read"],
      scopesFor: () => [],
      invoke: async <C extends ImplementedCapability>() => [] as unknown as Out<C>,
    };
    const withThird: TestDeps = { ...deps, connectors: () => [third] };
    await invokeCapability(withThird, "files.read", validInputs["files.read"], { caller: "ask" });
    const [row] = await deps.repos.audit.recent();
    expect(row?.connector).toBe("mcp-test");
    expect(row?.args).toContain("proposal");
  });

  it("never logs an email body, even for a third-party email.draft", async () => {
    const deps = setup();
    const third: Connector = {
      id: "mcp-mail",
      displayName: "Test mail MCP",
      firstParty: false,
      capabilities: ["email.draft"],
      scopesFor: () => [],
      invoke: async <C extends ImplementedCapability>() => ({ providerDraftId: "p1" }) as unknown as Out<C>,
    };
    await invokeCapability({ ...deps, connectors: () => [third] }, "email.draft", validInputs["email.draft"], { caller: "ask" });
    const [row] = await deps.repos.audit.recent();
    expect(row?.args).toContain("dana@acme.com");
    expect(JSON.stringify(row)).not.toContain("SECRET BODY TEXT");
  });

  it("rejects implausible addresses at the policy layer", async () => {
    const deps = setup();
    await expect(
      invokeCapability(deps, "email.draft", { to: ["dana@acme.com\r\nBcc: x@y.z"], subject: "s", body: "b" }, { caller: "ask" }),
    ).rejects.toThrow(/invalid input/);
    await expect(invokeCapability(deps, "email.draft", { to: ["Dana"], subject: "s", body: "b" }, { caller: "ask" })).rejects.toThrow(/invalid input/);
    expect(deps.ws.createDraft).not.toHaveBeenCalled();
  });

  it("hostile caller: every capability and invented names, every caller → zero sends", async () => {
    const deps = setup();
    const names = [...CAPABILITY_IDS, "email.send", "calendar.invite", "drafts.send", "messages.send", "execute"];
    for (const caller of ["ask", "task", "brief", "cron", "dashboard"] as Caller[]) {
      for (const name of names) {
        const input = (validInputs as Record<string, unknown>)[name] ?? { to: ["x@y.z"], subject: "s", body: "b" };
        await invokeCapability(deps, name, input, { caller }).catch(() => undefined);
      }
    }
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
    // Owner-initiated callers may create drafts (never send); background callers may not.
    expect(deps.ws.createDraft).toHaveBeenCalledTimes(3);
  });
});

describe("Google connector", () => {
  it("asks for the minimal scopes per capability", () => {
    const g = new GoogleConnector(async () => {
      throw new Error("unused");
    });
    expect(g.scopesFor(["email.read"])).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(g.scopesFor(["email.read", "email.draft", "calendar.read", "files.read"])).toHaveLength(4);
    expect(g.scopesFor(["grocery.search"])).toEqual([]);
  });
});

describe("tools use the capability layer", () => {
  it("/api/ask lookups go through invokeCapability and are audited with the device", async () => {
    const llm = new ScriptedLLM([
      () => msg([toolUse("search_gmail", { query: "from:dana", maxResults: 3 })]),
      (p) => {
        const last = p.messages.at(-1)!;
        expect((last.content as { is_error?: boolean }[])[0]?.is_error).toBeFalsy();
        return msg([toolUse("respond", { reply: "Nothing new from Dana.", spoken: "Nothing new from Dana." })]);
      },
    ]);
    const deps = makeDeps({ llm, now: NOW });
    setDeps(deps);
    const { token } = await pairDevice(deps, "phone");
    const res = await ask(req("POST", "/api/ask", { token, body: { text: "anything from Dana?", device: "phone" } }), params({}));
    expect(res.status).toBe(200);
    const [row] = await deps.repos.audit.recent();
    expect(row).toMatchObject({ capability: "email.read", caller: "ask", device: "phone", ok: true });
  });
});

describe("static: nothing bypasses invokeCapability", () => {
  const files = walk(SRC);
  it("only lib/connectors/invoke.ts calls Connector.invoke", () => {
    const callers = files.filter((f) => /\.\s*invoke\s*\(/.test(strip(f))).map((f) => path.relative(SRC, f));
    expect(callers).toEqual(["lib/connectors/invoke.ts"]);
  });

  it("GoogleWorkspace is constructed only by deps; nothing calls deps.workspace()", () => {
    const users = files.filter((f) => /\bGoogleWorkspace\b/.test(strip(f))).map((f) => path.relative(SRC, f)).sort();
    expect(users).toEqual(["lib/deps.ts", "lib/google/workspace.ts"]);
    expect(files.filter((f) => /deps\s*\.\s*workspace\s*\(/.test(strip(f)))).toEqual([]);
  });
});

describe("audit repo", () => {
  it("keeps at most maxRows and drops rows past retention", async () => {
    let now = NOW.getTime();
    const kv = new MemoryKV(() => now);
    const repo = new AuditRepo(kv, "t", () => new Date(now), 30, 3);
    for (let i = 0; i < 5; i++) await repo.add({ connector: "google", capability: "email.read", tier: "auto", caller: "ask", summary: `s${i}`, ok: true });
    expect(await repo.prune()).toBe(2);
    expect((await repo.recent()).map((r) => r.summary)).toEqual(["s4", "s3", "s2"]);
    now += 31 * 86_400_000;
    expect(await repo.prune()).toBe(3);
    expect(await repo.recent()).toEqual([]);
  });
});
