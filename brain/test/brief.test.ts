import { describe, expect, it } from "vitest";
import { setDeps } from "@/lib/deps";
import { BriefSchema, TopItemSchema } from "@/lib/models";
import { makeDeps, msg, pairDevice, params, req, ScriptedLLM, toolUse } from "./fakes";
import { GET as brief } from "@/app/api/brief/route";
import { GET as top5 } from "@/app/api/top5/route";
import { GET as followups } from "@/app/api/followups/route";
import { z } from "zod";

async function seed(deps: ReturnType<typeof makeDeps>) {
  await deps.repos.commitments.add({ who: "Stimmel", what: "Send ACME proposal", dueAt: "2026-10-15T17:00:00Z", client: "ACME", source: { kind: "voice" }, confidence: "CONFIRMED" });
  await deps.repos.commitments.add({ who: "Dana", what: "Deposit", dueAt: "2026-10-30", dueInferred: true, client: "ACME", source: { kind: "email" }, confidence: "LIKELY" });
  await deps.repos.followups.upsert({ person: "Sam", client: "Globex", reason: "Quiet after demo", importance: "MEDIUM", lastContactAt: "2026-10-01T00:00:00Z" });
}

describe("brief / top5 / followups", () => {
  it("returns a model-written brief in contract shape with reconciled top5 ids", async () => {
    let candidateIds: string[] = [];
    const llm = new ScriptedLLM([
      (p) => {
        const data = JSON.parse((p.messages[0]!.content as string).split("\n").at(-1)!) as { top5Candidates: { id: string }[] };
        candidateIds = data.top5Candidates.map((c) => c.id);
        return msg([
          toolUse("publish_brief", {
            sections: [{ title: "today", items: ["No meetings."] }, { title: "COMMITMENTS", items: ["ACME proposal overdue."] }],
            top5: [{ id: candidateIds[0], title: "Send ACME proposal", why: "Overdue", importance: "HIGH" }, { id: "made_up", title: "x", why: "y", importance: "LOW" }],
          }),
        ]);
      },
    ]);
    const deps = makeDeps({ llm });
    setDeps(deps);
    await seed(deps);
    const { token } = await pairDevice(deps, "phone");
    const res = await brief(req("GET", "/api/brief?kind=daily", { token }), params({}));
    expect(res.status).toBe(200);
    const b = BriefSchema.parse(await res.json());
    expect(b.kind).toBe("daily");
    expect(b.sections[0]!.title).toBe("TODAY");
    expect(b.top5.map((t) => t.id)).toEqual([candidateIds[0]]);
    expect(b.top5[0]!.dueAt).toBeDefined();
  });

  it("falls back to a deterministic brief when the model fails", async () => {
    const llm = new ScriptedLLM([() => { throw new Error("529 overloaded"); }]);
    const deps = makeDeps({ llm });
    setDeps(deps);
    await seed(deps);
    const { token } = await pairDevice(deps);
    const b = BriefSchema.parse(await (await brief(req("GET", "/api/brief?kind=eod", { token }), params({}))).json());
    expect(b.kind).toBe("eod");
    expect(b.sections.find((s) => s.title === "OVERDUE")?.items[0]).toContain("Send ACME proposal");
    expect(b.top5[0]!.title).toContain("Send ACME proposal");
    expect((await brief(req("GET", "/api/brief?kind=monthly", { token }), params({}))).status).toBe(400);
  });

  it("top5 is contract-shaped, cached, and ranks overdue first", async () => {
    const deps = makeDeps({ llm: new ScriptedLLM([]) });
    setDeps(deps);
    await seed(deps);
    const { token } = await pairDevice(deps);
    const body = z.object({ items: z.array(TopItemSchema.strict()), updatedAt: z.string() }).parse(await (await top5(req("GET", "/api/top5", { token }), params({}))).json());
    expect(body.items[0]!.title).toContain("ACME proposal");
    expect(body.items.length).toBeLessThanOrEqual(5);
    expect(await deps.repos.state.getTop5()).toEqual(body);
  });

  it("followups route returns contract items", async () => {
    const deps = makeDeps();
    setDeps(deps);
    await seed(deps);
    const { token } = await pairDevice(deps);
    const body = (await (await followups(req("GET", "/api/followups", { token }), params({}))).json()) as { items: unknown[] };
    expect(body.items).toEqual([{ id: expect.any(String), person: "Sam", client: "Globex", reason: "Quiet after demo", importance: "MEDIUM", daysQuiet: 15 }]);
  });
});
