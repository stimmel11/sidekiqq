import { describe, expect, it } from "vitest";
import { setDeps } from "@/lib/deps";
import { AskResponseSchema } from "@/lib/models";
import { makeDeps, msg, pairDevice, params, req, ScriptedLLM, text, toolUse } from "./fakes";
import { POST as ask } from "@/app/api/ask/route";
import { loadOperatingSystem } from "@/lib/assistant/prompt";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("/api/ask tool loop", () => {
  it("uses the operating-system prompt verbatim, runs tools, and returns contract shape", async () => {
    const llm = new ScriptedLLM([
      () => msg([text("Let me check."), toolUse("list_commitments", { status: "overdue" })]),
      () =>
        msg([
          toolUse("add_commitment", { who: "Stimmel", what: "Send ACME pricing", dueAt: "2026-10-17", dueInferred: true, client: "ACME", confidence: "CONFIRMED" }),
        ]),
      () =>
        msg([
          toolUse("respond", {
            reply: "## Status\nNothing overdue. I logged **Send ACME pricing** due tomorrow (inferred).",
            spoken: "Nothing is overdue. I logged sending ACME pricing, due tomorrow, inferred. Anything else? Really anything?",
          }),
        ]),
    ]);
    const deps = makeDeps({ llm });
    setDeps(deps);
    const { token } = await pairDevice(deps);

    const res = await ask(req("POST", "/api/ask", { token, body: { text: "I'll get ACME pricing over. What's overdue?", device: "watch" } }), params({}));
    expect(res.status).toBe(200);
    const body = AskResponseSchema.strict().parse(await res.json());
    expect(body.spoken).toBe("Nothing is overdue. I logged sending ACME pricing, due tomorrow, inferred.");
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]).toMatchObject({ type: "commitment_added" });
    expect(body.conversationId).toMatch(/^conv_/);

    const first = llm.calls[0]!;
    expect(first.model).toBe("claude-test-model");
    const sys = first.system as { text: string }[];
    const osFile = readFileSync(path.resolve(__dirname, "../prompts/operating-system.md"), "utf8");
    expect(sys[0]!.text).toBe(osFile);
    expect(sys[0]!.text).toBe(await loadOperatingSystem());
    expect(sys[1]!.text).toContain("Device for this request: watch");
    expect((first.tools ?? []).map((t) => (t as { name: string }).name)).toEqual([
      "search_email", "get_email_thread", "list_calendar_events", "search_drive", "lookup_contact", "get_client_timeline", "list_commitments",
      "add_commitment", "update_commitment", "list_followups", "create_email_draft", "record_decision", "upsert_client_profile", "respond",
    ]);

    // tool results were fed back to the model
    const second = llm.calls[1]!;
    const toolResult = (second.messages.at(-1)!.content as { type: string; content: string }[])[0]!;
    expect(toolResult.type).toBe("tool_result");
    expect(JSON.parse(toolResult.content)).toEqual({ count: 0, items: [] });

    const stored = await deps.repos.commitments.list("open");
    expect(stored[0]).toMatchObject({ who: "Stimmel", client: "ACME", dueInferred: true, source: { kind: "voice" } });
  });

  it("persists conversation history and replays it", async () => {
    const llm = new ScriptedLLM([() => msg([toolUse("respond", { reply: "Hello.", spoken: "Hello." })])]);
    const deps = makeDeps({ llm });
    setDeps(deps);
    const { token } = await pairDevice(deps);
    const r1 = (await (await ask(req("POST", "/api/ask", { token, body: { text: "hi", device: "phone" } }), params({}))).json()) as { conversationId: string };
    await ask(req("POST", "/api/ask", { token, body: { text: "again", device: "phone", conversationId: r1.conversationId } }), params({}));
    const msgs = llm.calls[1]!.messages;
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ["user", "hi"],
      ["assistant", "Hello."],
      ["user", "again"],
    ]);
  });

  it("forces respond on the last iteration so the loop terminates", async () => {
    process.env.ASK_MAX_TOOL_ITERATIONS = "3";
    try {
      const llm = new ScriptedLLM([
        (p) =>
          p.tool_choice?.type === "tool"
            ? msg([toolUse("respond", { reply: "Here is what I found so far.", spoken: "Here is what I found." })])
            : msg([toolUse("list_followups", {})]),
      ]);
      const deps = makeDeps({ llm });
      setDeps(deps);
      const { token } = await pairDevice(deps);
      const res = await ask(req("POST", "/api/ask", { token, body: { text: "loop forever", device: "medallion" } }), params({}));
      const body = (await res.json()) as { reply: string };
      expect(llm.calls).toHaveLength(3);
      expect(llm.calls[2]!.tool_choice).toEqual({ type: "tool", name: "respond", disable_parallel_tool_use: true });
      expect(body.reply).toBe("Here is what I found so far.");
    } finally {
      delete process.env.ASK_MAX_TOOL_ITERATIONS;
    }
  });

  it("accepts a plain-text answer and derives spoken from it", async () => {
    const llm = new ScriptedLLM([() => msg([text("**You're clear.** No meetings today. Enjoy. Truly.")], "end_turn")]);
    const deps = makeDeps({ llm });
    setDeps(deps);
    const { token } = await pairDevice(deps);
    const body = (await (await ask(req("POST", "/api/ask", { token, body: { text: "today?", device: "watch" } }), params({}))).json()) as { spoken: string };
    expect(body.spoken).toBe("You're clear. No meetings today.");
  });

  it("reports Google-not-connected to the model as a tool error instead of failing", async () => {
    const llm = new ScriptedLLM([
      () => msg([toolUse("search_email", { query: "from:dana" })]),
      (p) => {
        const r = (p.messages.at(-1)!.content as { is_error?: boolean; content: string }[])[0]!;
        expect(r.is_error).toBe(true);
        expect(r.content).toMatch(/not connected/);
        return msg([toolUse("respond", { reply: "Google isn't connected.", spoken: "Google isn't connected yet." })]);
      },
    ]);
    const deps = makeDeps({ llm, googleConnected: false });
    setDeps(deps);
    const { token } = await pairDevice(deps);
    expect((await ask(req("POST", "/api/ask", { token, body: { text: "anything from dana?", device: "watch" } }), params({}))).status).toBe(200);
  });

  it("rejects invalid tool input and invalid request bodies", async () => {
    const llm = new ScriptedLLM([
      () => msg([toolUse("create_email_draft", { to: ["not-an-email"], subject: "x", body: "y" })]),
      (p) => {
        const r = (p.messages.at(-1)!.content as { is_error?: boolean; content: string }[])[0]!;
        expect(r.is_error).toBe(true);
        return msg([toolUse("respond", { reply: "Need an address.", spoken: "What's their email?" })]);
      },
    ]);
    const deps = makeDeps({ llm });
    setDeps(deps);
    const { token } = await pairDevice(deps);
    expect((await ask(req("POST", "/api/ask", { token, body: { text: "email bob", device: "watch" } }), params({}))).status).toBe(200);
    expect(deps.ws.createDraft).not.toHaveBeenCalled();
    expect((await ask(req("POST", "/api/ask", { token, body: { text: "", device: "watch" } }), params({}))).status).toBe(400);
    expect((await ask(req("POST", "/api/ask", { token, body: { text: "x", device: "toaster" } }), params({}))).status).toBe(400);
  });
});
