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
const SENDER_MODULE = path.join(SRC, "lib/google/sender.ts");
const DEPS_MODULE = path.join(SRC, "lib/deps.ts");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const SEND_PRIMITIVES = [
  /\bdrafts\s*\.\s*send\b/, // gmail.users.drafts.send
  /\bmessages\s*\.\s*send\b/, // gmail.users.messages.send
  /\bsendDraft\s*\(/, // MailSender.sendDraft(...)
  /\bmailSender\s*\(/, // deps.mailSender()
  /\bGmailDraftSender\b/,
  /\bmessages\s*\.\s*import\b|\bmessages\s*\.\s*insert\b/, // other ways to put mail into Gmail
  /nodemailer|smtp/i,
];

describe("no route other than draft-approve can send mail (static)", () => {
  const files = walk(SRC);

  it("finds the source tree", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain(APPROVE_ROUTE);
  });

  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file);
    it(`${rel} contains no send primitives unless allowed`, () => {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "") // strip block comments
        .replace(/(^|[^:])\/\/.*$/gm, "$1"); // strip line comments
      const hits = SEND_PRIMITIVES.filter((re) => re.test(code)).map(String);
      if (file === SENDER_MODULE) {
        expect(code).toMatch(/drafts\s*\.\s*send/);
        expect(code).not.toMatch(/messages\s*\.\s*send/);
        return;
      }
      if (file === APPROVE_ROUTE) {
        expect(hits.sort()).toEqual([String(/\bmailSender\s*\(/), String(/\bsendDraft\s*\(/)].sort());
        return;
      }
      if (file === DEPS_MODULE) {
        // The container constructs the sender but must not call it.
        expect(code).not.toMatch(/\bsendDraft\s*\(|drafts\s*\.\s*send|messages\s*\.\s*send/);
        return;
      }
      expect(hits).toEqual([]);
    });
  }

  it("only the approve route and deps reference the sender module", () => {
    const importers = walk(SRC).filter((f) => /google\/sender/.test(readFileSync(f, "utf8")));
    expect(importers.map((f) => path.relative(SRC, f)).sort()).toEqual(["lib/deps.ts"]);
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
    const d = await deps.repos.drafts.create({ gmailDraftId: "g1", to: ["a@b.co"], subject: "s", body: "b" });
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
    const d = await deps.repos.drafts.create({ gmailDraftId: g.gmailDraftId, to: ["dana@acme.com"], subject: "Hi", body: "Body", client: "ACME", followupId: fu.followUp.id });
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
    expect(deps.sender.sendDraft).toHaveBeenCalledExactlyOnceWith(d.gmailDraftId);
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
