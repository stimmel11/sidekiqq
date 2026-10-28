import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setDeps } from "@/lib/deps";
import { makeDeps, msg, pairDevice, params, req, ScriptedLLM, text, toolUse } from "./fakes";
import { POST as approve } from "@/app/api/drafts/[id]/approve/route";
import { POST as discard } from "@/app/api/drafts/[id]/discard/route";
import { POST as ask } from "@/app/api/ask/route";

/**
 * Safety invariant from ARCHITECTURE.md: /api/drafts/:id/approve is the ONLY path that sends.
 * Enforced two ways:
 *   1. Static: scan every source file for send primitives and allow them only in the
 *      sender module and the approve route.
 *   2. Behavioural: drive every other mail-touching route with spies and assert no send.
 */

const SRC = path.resolve(__dirname, "../src");
const APPROVE_ROUTE = path.join(SRC, "app/api/drafts/[id]/approve/route.ts");
const GOOGLE_SEND = path.join(SRC, "lib/connectors/google/send.ts");
const SENDER_REGISTRY = path.join(SRC, "lib/connectors/senders.ts");
const DEPS_MODULE = path.join(SRC, "lib/deps.ts");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "") // strip block comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // strip line comments
}

const P = {
  draftsSend: /\bdrafts\s*\.\s*send\b/, // gmail.users.drafts.send
  messagesSend: /\bmessages\s*\.\s*send\b/, // gmail.users.messages.send
  sendDraft: /\bsendDraft\b/, // MailSender.sendDraft
  // Bare words, not call forms, so destructuring (`const { senders } = deps`) and optional
  // calls (`deps.senders?.()`) are caught too.
  senders: /\bsenders\b/, // deps.senders
  registry: /\bSenderRegistry\b/,
  executor: /\bDraftExecutor\b/,
  execute: /\bexecute\b/, // DraftExecutor.execute
  gmailSender: /\bGmailDraftSender\b/,
  googleExecutor: /\bgoogleEmailExecutor\b/,
  buildSenders: /\bbuildSenders\b/,
  importInsert: /\bmessages\s*\.\s*import\b|\bmessages\s*\.\s*insert\b/, // other ways to put mail into Gmail
  smtp: /nodemailer|smtp/i,
} as const;
type Prim = keyof typeof P;

/** EXACTLY which send primitives each file contains. Every other source file: none. */
const ALLOWED: Record<string, Prim[]> = {
  // `senders` here is its type-only `import type { DraftExecutor } from "../senders"`.
  [GOOGLE_SEND]: ["draftsSend", "sendDraft", "gmailSender", "googleExecutor", "executor", "execute", "senders"],
  [SENDER_REGISTRY]: ["googleExecutor", "buildSenders", "registry", "executor", "execute"],
  // The container constructs the registry (and declares `senders()`), but never calls a sender.
  [DEPS_MODULE]: ["gmailSender", "buildSenders", "registry", "senders"],
  [APPROVE_ROUTE]: ["senders", "execute"],
};

function hits(file: string): Prim[] {
  const c = code(file);
  return (Object.keys(P) as Prim[]).filter((k) => P[k].test(c));
}

/**
 * Every module specifier a file pulls in at runtime (import, export-from, dynamic import, require),
 * resolved to an absolute path without extension. `import type` / `export type` are skipped: they
 * vanish at compile time.
 */
function runtimeDeps(file: string, c: string = code(file)): string[] {
  const specs: string[] = [];
  const staticRe = /\b(import|export)(\s+type\b)?[^;'"`]*?\bfrom\s*["']([^"']+)["']/g;
  for (const m of c.matchAll(staticRe)) if (!m[2]) specs.push(m[3]!);
  for (const m of c.matchAll(/\bimport\s*["']([^"']+)["']/g)) specs.push(m[1]!); // side-effect import
  for (const m of c.matchAll(/\b(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]/g)) specs.push(m[1]!);
  return specs.map((s) => {
    const abs = s.startsWith("@/") ? path.join(SRC, s.slice(2)) : s.startsWith(".") ? path.resolve(path.dirname(file), s) : s;
    return abs.replace(/\.(js|ts|tsx|mjs)$/, "");
  });
}

function runtimeImporters(target: string): string[] {
  const t = target.replace(/\.ts$/, "");
  return walk(SRC)
    .filter((f) => runtimeDeps(f).includes(t))
    .map((f) => path.relative(SRC, f))
    .sort();
}

describe("no route other than draft-approve can send mail (static)", () => {
  const files = walk(SRC);

  it("finds the source tree", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain(APPROVE_ROUTE);
    expect(files).toContain(GOOGLE_SEND);
    expect(files).toContain(SENDER_REGISTRY);
  });

  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file);
    it(`${rel} contains no send primitives unless allowed`, () => {
      expect(hits(file).sort()).toEqual([...(ALLOWED[file] ?? [])].sort());
    });
  }

  it("the Google send module uses drafts.send only, never messages.send", () => {
    expect(code(GOOGLE_SEND)).toMatch(P.draftsSend);
    expect(code(GOOGLE_SEND)).not.toMatch(P.messagesSend);
  });


  it("the import scanner sees re-exports, dynamic imports, require, extensions and relative paths", () => {
    const fake = path.join(SRC, "lib/connectors/google/index.ts");
    const resolve = (c: string) => runtimeDeps(fake, c);
    const target = GOOGLE_SEND.replace(/\.ts$/, "");
    for (const c of [
      `export * from "./send";`,
      `export { GmailDraftSender } from "./send.js";`,
      `const m = await import("@/lib/connectors/google/send");`,
      `const m = require("./send");`,
      `import{GmailDraftSender}from"./send"`,
    ]) {
      expect(resolve(c), c).toContain(target);
    }
    expect(resolve(`import type { MailSender } from "./send";`)).toEqual([]);
  });

  it("only deps imports the sender registry; only the registry and deps import the Google send module", () => {
    expect(runtimeImporters(SENDER_REGISTRY)).toEqual(["lib/deps.ts"]);
    expect(runtimeImporters(GOOGLE_SEND)).toEqual(["lib/connectors/senders.ts", "lib/deps.ts"]);
  });

  it("the Workspace interface exposes no send method", () => {
    const ws = readFileSync(path.join(SRC, "lib/google/workspace.ts"), "utf8");
    const iface = /export interface Workspace \{([\s\S]*?)\n\}/.exec(ws)?.[1] ?? "";
    expect(iface).toBeTruthy();
    expect(iface).not.toMatch(/send/i);
  });
});

describe("no route other than draft-approve can send mail (behavioural)", () => {
  it("/api/ask creating a draft never sends, even if the user says 'send it'", async () => {
    const llm = new ScriptedLLM([
      () => msg([toolUse("create_email_draft", { to: ["dana@acme.com"], subject: "Proposal", body: "Hi Dana, attached." })]),
      () => msg([toolUse("respond", { reply: "Draft created for Dana. Approve to send.", spoken: "Draft to Dana is ready. Approve to send." })]),
    ]);
    const deps = makeDeps({ llm });
    setDeps(deps);
    const { token } = await pairDevice(deps, "glasses");
    const res = await ask(req("POST", "/api/ask", { token, body: { text: "email Dana the proposal and send it now", device: "glasses" } }), params({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actions: { type: string; id: string }[] };
    expect(body.actions[0]?.type).toBe("draft_created");
    expect(deps.ws.createDraft).toHaveBeenCalledOnce();
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
    expect((await deps.repos.drafts.get(body.actions[0]!.id))?.status).toBe("pending");
  });

  it("the model cannot invoke a send tool (unknown tool → error, nothing sent)", async () => {
    const llm = new ScriptedLLM([
      () => msg([toolUse("send_email", { to: "x@y.z" }), toolUse("gmail_send", {})]),
      (p) => {
        const last = p.messages.at(-1)!;
        const results = (last.content as { is_error?: boolean }[]).map((r) => r.is_error);
        expect(results).toEqual([true, true]);
        return msg([toolUse("respond", { reply: "I can't send email directly.", spoken: "I can only draft." })]);
      },
    ]);
    const deps = makeDeps({ llm });
    setDeps(deps);
    const { token } = await pairDevice(deps);
    const res = await ask(req("POST", "/api/ask", { token, body: { text: "send it", device: "watch" } }), params({}));
    expect(res.status).toBe(200);
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
    // and no tool definition offered to the model mentions sending as a capability
    const toolNames = (llm.calls[0]!.tools ?? []).map((t) => (t as { name: string }).name);
    expect(toolNames.some((n) => /send/i.test(n))).toBe(false);
  });

  it("discard never sends", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const { token } = await pairDevice(deps);
    const d = await deps.repos.drafts.create({ providerDraftId: "g1", to: ["a@b.co"], subject: "s", body: "b" });
    expect((await discard(req("POST", "/x", { token }), params({ id: d.id }))).status).toBe(200);
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
  });
});

describe("draft approve route", () => {
  async function setup() {
    const deps = makeDeps();
    setDeps(deps);
    const { token } = await pairDevice(deps);
    const g = await deps.ws.createDraft({ to: ["dana@acme.com"], subject: "Hi", body: "Body" });
    const fu = await deps.repos.followups.upsert({ person: "Dana", client: "ACME", reason: "waiting", importance: "HIGH" });
    const d = await deps.repos.drafts.create({ providerDraftId: g.gmailDraftId, to: ["dana@acme.com"], subject: "Hi", body: "Body", client: "ACME", followupId: fu.followUp.id });
    return { deps, token, d, fu };
  }

  it("requires auth", async () => {
    const { d } = await setup();
    expect((await approve(req("POST", "/x"), params({ id: d.id }))).status).toBe(401);
  });

  it("404s for unknown drafts and never sends", async () => {
    const { deps, token } = await setup();
    expect((await approve(req("POST", "/x", { token }), params({ id: "drf_nope" }))).status).toBe(404);
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
  });

  it("sends a pending draft exactly once, then refuses re-sends", async () => {
    const { deps, token, d, fu } = await setup();
    const res = await approve(req("POST", "/x", { token }), params({ id: d.id }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deps.sender.sendDraft).toHaveBeenCalledExactlyOnceWith(d.providerDraftId);
    expect((await deps.repos.drafts.get(d.id))?.status).toBe("sent");
    expect((await deps.repos.followups.get(fu.followUp.id))?.resolved).toBe(true);

    const again = await approve(req("POST", "/x", { token }), params({ id: d.id }));
    expect(again.status).toBe(409);
    expect(deps.sender.sendDraft).toHaveBeenCalledOnce();
  });

  it("refuses discarded drafts", async () => {
    const { deps, token, d } = await setup();
    await deps.repos.drafts.markDiscarded(d.id);
    expect((await approve(req("POST", "/x", { token }), params({ id: d.id }))).status).toBe(409);
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
  });

  it("refuses when the Gmail draft no longer exists", async () => {
    const { deps, token, d } = await setup();
    deps.ws.drafts.clear();
    expect((await approve(req("POST", "/x", { token }), params({ id: d.id }))).status).toBe(410);
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
    expect((await deps.repos.drafts.get(d.id))?.status).toBe("discarded");
  });

  it("concurrent double-tap sends only once", async () => {
    const { deps, token, d } = await setup();
    const [a, b] = await Promise.all([
      approve(req("POST", "/x", { token }), params({ id: d.id })),
      approve(req("POST", "/x", { token }), params({ id: d.id })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(deps.sender.sendDraft).toHaveBeenCalledOnce();
  });
});
