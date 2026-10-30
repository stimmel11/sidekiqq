import { describe, expect, it } from "vitest";
import { setDeps } from "@/lib/deps";
import { AskResponseSchema } from "@/lib/models";
import { runtimeContext } from "@/lib/assistant/prompt";
import { extractAddresses, KnownAddresses, normalizeAddress } from "@/lib/assistant/recipients";
import { executeTool, type ToolContext } from "@/lib/assistant/tools";
import { makeDeps, msg, pairDevice, params, req, ScriptedLLM, toolUse, type TestDeps } from "./fakes";
import { POST as ask } from "@/app/api/ask/route";

const NOW = new Date("2026-10-16T15:00:00Z");

const DANA = { id: "people/c1", name: "Dana Kim", emails: ["dana@acme.com"], phones: [], source: "google" as const, match: "name" as const };
const BODY = "Hi Dana,\n\nRunning ten minutes late. Start without me.\n\nStimmel";

function draftCall(to: string[], extra: Record<string, unknown> = {}) {
  return toolUse("create_email_draft", { to, subject: "Running late", body: BODY, ...extra });
}
const respond = () => msg([toolUse("respond", { reply: "Draft to Dana Kim is ready.", spoken: "Draft to Dana Kim is ready. Say send it when you're ready." })]);

/** The tool_result blocks fed back to the model on call `i`. */
function resultsOn(llm: ScriptedLLM, i: number): { content: string; is_error?: boolean }[] {
  return llm.calls[i]!.messages.at(-1)!.content as { content: string; is_error?: boolean }[];
}

async function run(deps: TestDeps, text: string, conversationId?: string) {
  setDeps(deps);
  const { token } = await pairDevice(deps);
  const res = await ask(req("POST", "/api/ask", { token, body: { text, device: "glasses", ...(conversationId ? { conversationId } : {}) } }), params({}));
  expect(res.status).toBe(200);
  return AskResponseSchema.strict().parse(await res.json());
}

describe("recipient provenance helpers", () => {
  it("finds written addresses, case-insensitively, and strips display names", () => {
    expect(extractAddresses("mail Dana.Kim@ACME.com, or ops@acme.co.uk.")).toEqual(["dana.kim@acme.com", "ops@acme.co.uk"]);
    expect(normalizeAddress("Dana Kim <Dana@Acme.com>")).toBe("dana@acme.com");
    expect(normalizeAddress("  dana@acme.com ")).toBe("dana@acme.com");
  });

  it("finds addresses dictated through speech-to-text", () => {
    expect(extractAddresses("email dana at acme dot com that I'm late")).toEqual(["dana@acme.com"]);
    expect(extractAddresses("send it to dana dot kim at acme dot co dot uk please")).toEqual(["dana.kim@acme.co.uk"]);
    expect(extractAddresses("to j underscore lee at mail dash host dot io")).toContain("j_lee@mail-host.io");
    // "at" without a dotted domain is just English.
    expect(extractAddresses("meet Dana at noon at the office")).toEqual([]);
  });

  it("handles mixed spoken/written forms speech-to-text produces", () => {
    expect(extractAddresses("email dana at acme.com that I'm late")).toEqual(["dana@acme.com"]);
    expect(extractAddresses("dana.kim at acme dot com")).toEqual(["dana.kim@acme.com"]);
    expect(extractAddresses("ops at acme dash corp dot co dot uk")).toEqual(["ops@acme-corp.co.uk"]);
  });

  it("reads addresses after JSON-escaped newlines and tabs correctly", () => {
    const json = JSON.stringify({ body: "Thanks,\ndana@acme.com\r\ncc:\tops@acme.com" });
    const found = extractAddresses(json);
    expect(found).toEqual(expect.arrayContaining(["dana@acme.com", "ops@acme.com"]));
    expect(found).not.toContain("ndana@acme.com");
    expect(found).not.toContain("tops@acme.com");
  });

  it("stays fast on long hostile strings", () => {
    const t0 = performance.now();
    for (const s of ["a".repeat(16_000), "a.".repeat(8_000), "a@" + "b-".repeat(8_000), "x at ".repeat(3_000), "a dot ".repeat(2_500) + "at b"]) extractAddresses(s);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("KnownAddresses accepts only what it has seen", () => {
    const known = new KnownAddresses();
    known.addText('{"contacts":[{"emails":["dana@acme.com"]}]}');
    expect(known.has("DANA@acme.com")).toBe(true);
    expect(known.has("Dana Kim <dana@acme.com>")).toBe(true);
    expect(known.unknown(["dana@acme.com", "dana@acme.io"])).toEqual(["dana@acme.io"]);
    // A smuggled second recipient never rides along on a known one.
    known.addText("mallory@evil.example");
    expect(known.has("mallory@evil.example, Dana <dana@acme.com>")).toBe(false);
    expect(known.has("Dana <dana@acme.com>; mallory@evil.example")).toBe(false);
  });
});

describe("create_email_draft recipient guard", () => {
  const ctx = (deps: TestDeps, known?: KnownAddresses): ToolContext => ({ deps, now: NOW, device: "phone", actions: [], ...(known ? { knownAddresses: known } : {}) });

  it("rejects unseen to/cc addresses before anything reaches Gmail", async () => {
    const deps = makeDeps({ now: NOW });
    setDeps(deps);
    const known = new KnownAddresses();
    known.addText("dana@acme.com");
    for (const input of [
      { to: ["dana@acme.io"], subject: "s", body: "b" },
      { to: ["dana@acme.com"], cc: ["boss@acme.com"], subject: "s", body: "b" },
    ]) {
      const out = await executeTool("create_email_draft", input, ctx(deps, known));
      expect(out.isError).toBe(true);
      expect(out.content).toContain("No draft created");
      expect(out.content).toContain("lookup_contact");
    }
    expect(deps.ws.createDraft).not.toHaveBeenCalled();
    expect(await deps.repos.drafts.listPending()).toEqual([]);
  });

  it("gives a format error (not a provenance error) for list-like entries", async () => {
    const deps = makeDeps({ now: NOW });
    setDeps(deps);
    const known = new KnownAddresses();
    known.addText("dana@acme.com");
    const out = await executeTool("create_email_draft", { to: ['"Kim, Dana" <dana@acme.com>'], subject: "s", body: "b" }, ctx(deps, known));
    expect(out.isError).toBe(true);
    expect(out.content).toContain("one bare address per entry");
    expect(deps.ws.createDraft).not.toHaveBeenCalled();
  });

  it("guards the email stored on a client profile too", async () => {
    const deps = makeDeps({ now: NOW });
    setDeps(deps);
    const out = await executeTool("upsert_client_profile", { name: "Dana Kim", email: "dana@acme.com" }, ctx(deps, new KnownAddresses()));
    expect(out).toMatchObject({ isError: true });
    expect(out.content).toContain("Profile not saved.");
    expect(await deps.repos.clients.get("Dana Kim")).toBeFalsy();
  });

  it("is skipped when the caller tracks no provenance (non-ask callers)", async () => {
    const deps = makeDeps({ now: NOW });
    setDeps(deps);
    const out = await executeTool("create_email_draft", { to: ["dana@acme.com"], subject: "s", body: "b" }, ctx(deps));
    expect(out.isError).toBe(false);
  });
});

describe('"email this <dictated paragraph> to <contact>" through /api/ask', () => {
  it("looks the contact up, drafts the dictated words, and never sends", async () => {
    const llm = new ScriptedLLM([
      () => msg([toolUse("lookup_contact", { name: "Dana" })]),
      () => msg([draftCall(["dana@acme.com"])]),
      respond,
    ]);
    const deps = makeDeps({ llm, now: NOW });
    deps.contacts.result = { contacts: [DANA], ambiguous: false };

    const body = await run(deps, "Email this to Dana: running ten minutes late, start without me.");
    expect(resultsOn(llm, 2)[0]!.is_error).toBeUndefined();
    expect(deps.ws.createDraft).toHaveBeenCalledTimes(1);
    expect(deps.ws.createDraft.mock.calls[0]![0]).toMatchObject({ to: ["dana@acme.com"], body: BODY });
    expect(body.actions).toEqual([expect.objectContaining({ type: "draft_created" })]);
    const [draft] = await deps.repos.drafts.listPending();
    expect(draft).toMatchObject({ to: ["dana@acme.com"], status: "pending" });
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
  });

  it("rejects a guessed address, keeps rejecting it on retry, then accepts it after a lookup", async () => {
    const llm = new ScriptedLLM([
      () => msg([draftCall(["dana@acme.com"])]), // guessed from "Dana at ACME"
      () => msg([draftCall(["dana@acme.com"])]), // stubborn retry: the error text itself must not whitelist it
      () => msg([toolUse("lookup_contact", { name: "Dana" })]),
      () => msg([draftCall(["Dana Kim <dana@acme.com>"])]),
      respond,
    ]);
    const deps = makeDeps({ llm, now: NOW });
    deps.contacts.result = { contacts: [DANA], ambiguous: false };

    const body = await run(deps, "Tell Dana at ACME I'm running ten minutes late, start without me.");
    expect(resultsOn(llm, 1)[0]).toMatchObject({ is_error: true });
    expect(resultsOn(llm, 2)[0]).toMatchObject({ is_error: true });
    expect(resultsOn(llm, 2)[0]!.content).toContain("dana@acme.com");
    expect(resultsOn(llm, 4)[0]!.is_error).toBeUndefined();
    expect(deps.ws.createDraft).toHaveBeenCalledTimes(1);
    expect(body.actions).toHaveLength(1);
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
  });

  it("accepts an address the owner dictated aloud without a lookup", async () => {
    const llm = new ScriptedLLM([() => msg([draftCall(["dana@acme.com"])]), respond]);
    const deps = makeDeps({ llm, now: NOW });
    await run(deps, "email dana at acme dot com that I'm running ten minutes late");
    expect(resultsOn(llm, 1)[0]!.is_error).toBeUndefined();
    expect(deps.ws.createDraft).toHaveBeenCalledTimes(1);
    expect(deps.contacts.lookup).not.toHaveBeenCalled();
  });

  it("does not create a draft when the lookup is ambiguous and the model asks instead", async () => {
    const llm = new ScriptedLLM([
      () => msg([toolUse("lookup_contact", { name: "Dana" })]),
      () => msg([toolUse("respond", { reply: "Which Dana: Dana Kim (ACME) or Dana Ruiz (Beta)?", spoken: "Which Dana, Kim at ACME or Ruiz at Beta?" })]),
    ]);
    const deps = makeDeps({ llm, now: NOW });
    deps.contacts.result = {
      contacts: [DANA, { ...DANA, id: "people/c2", name: "Dana Ruiz", emails: ["dana@beta.io"] }],
      ambiguous: true,
    };
    const body = await run(deps, "Email this to Dana: running late.");
    expect(JSON.parse(resultsOn(llm, 1)[0]!.content)).toMatchObject({ ambiguous: true });
    expect(body.actions).toEqual([]);
    expect(deps.ws.createDraft).not.toHaveBeenCalled();
  });

  it("trusts the owner's earlier turns but not the assistant's own earlier replies", async () => {
    let turn = 0;
    const llm = new ScriptedLLM([
      // Turn 1: model mentions an address it never looked up.
      () => {
        turn = 1;
        return msg([toolUse("respond", { reply: "Dana is probably dana@acme.com. Bob is bob@beta.io, you said.", spoken: "Okay." })]);
      },
      // Turn 2: tries both.
      () => msg([draftCall(["bob@beta.io"])]),
      () => msg([draftCall(["dana@acme.com"])]),
      respond,
    ]);
    const deps = makeDeps({ llm, now: NOW });
    const first = await run(deps, "Bob's address is bob@beta.io. Who's Dana?");
    expect(turn).toBe(1);
    await run(deps, "Email both of them that I'm late.", first.conversationId);
    expect(resultsOn(llm, 2)[0]!.is_error).toBeUndefined(); // bob: owner said it
    expect(resultsOn(llm, 3)[0]).toMatchObject({ is_error: true }); // dana: only the model said it
    expect(deps.ws.createDraft).toHaveBeenCalledTimes(1);
  });

  it("does not launder a guessed address through a tool that echoes its input", async () => {
    const llm = new ScriptedLLM([
      () => msg([toolUse("get_client_timeline", { client: "dana@acme.com" })]),
      () => msg([toolUse("add_commitment", { who: "Stimmel", what: "Email dana@acme.com", confidence: "CONFIRMED" })]),
      () => msg([draftCall(["dana@acme.com"])]),
      respond,
    ]);
    const deps = makeDeps({ llm, now: NOW });
    await run(deps, "Tell Dana at ACME I'm running late.");
    expect(resultsOn(llm, 1)[0]!.content).not.toContain("dana@acme.com");
    expect(resultsOn(llm, 3)[0]).toMatchObject({ is_error: true });
    expect(deps.ws.createDraft).not.toHaveBeenCalled();
  });

  it("accepts thread-reply recipients that came from get_email_thread", async () => {
    const llm = new ScriptedLLM([
      () => msg([toolUse("get_email_thread", { threadId: "t1" })]),
      () => msg([draftCall(["dana@acme.com", "ops@acme.com"], { threadId: "t1", subject: "Re: Lunch" })]),
      respond,
    ]);
    const deps = makeDeps({ llm, now: NOW });
    deps.ws.messages = [
      { id: "m1", threadId: "t1", from: "Dana Kim <dana@acme.com>", to: "stimmel@example.com", subject: "Lunch", date: NOW.toISOString(), snippet: "", labels: [], cc: "", body: "Can we move it?\nCC my ops team:\tops@acme.com" },
    ];
    await run(deps, "Reply to Dana's lunch email and her ops team: running ten minutes late.");
    expect(resultsOn(llm, 2)[0]!.is_error).toBeUndefined();
    expect(deps.ws.createDraft).toHaveBeenCalledTimes(1);
  });

  it("after a 'which Dana?' question, needs a fresh lookup on the next turn", async () => {
    const two = {
      contacts: [DANA, { ...DANA, id: "people/c2", name: "Dana Ruiz", emails: ["dana@beta.io"] }],
      ambiguous: true,
    };
    const llm = new ScriptedLLM([
      () => msg([toolUse("lookup_contact", { name: "Dana" })]),
      () => msg([toolUse("respond", { reply: "Which Dana: Dana Kim (dana@acme.com) or Dana Ruiz (dana@beta.io)?", spoken: "Which Dana?" })]),
      // Turn 2: the address is only in the assistant's own earlier reply.
      () => msg([draftCall(["dana@acme.com"])]),
      () => msg([toolUse("lookup_contact", { name: "Dana Kim" })]),
      () => msg([draftCall(["dana@acme.com"])]),
      respond,
    ]);
    const deps = makeDeps({ llm, now: NOW });
    deps.contacts.result = two;
    const first = await run(deps, "Email this to Dana: running late.");
    expect(first.actions).toEqual([]);
    deps.contacts.result = { contacts: [DANA], ambiguous: false };
    const second = await run(deps, "Dana Kim.", first.conversationId);
    expect(resultsOn(llm, 3)[0]).toMatchObject({ is_error: true });
    expect(resultsOn(llm, 5)[0]!.is_error).toBeUndefined();
    expect(second.actions).toEqual([expect.objectContaining({ type: "draft_created" })]);
    expect(deps.ws.createDraft).toHaveBeenCalledTimes(1);
  });

  it("tells the model how to handle dictation and a spoken 'send it'", () => {
    const ctx = runtimeContext({ now: NOW, device: "glasses" });
    expect(ctx).toContain("DICTATED EMAIL");
    expect(ctx).toContain("the body is the owner's own words");
    expect(ctx).toMatch(/"send it".*you cannot send/s);
    expect(ctx).toContain("create_email_draft\n  rejects any other address");
    expect(ctx).toContain("call\n  lookup_contact again before drafting");
    expect(ctx).toMatch(/on phone or watch they tap Approve/);
  });
});
