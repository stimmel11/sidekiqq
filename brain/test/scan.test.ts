import { describe, expect, it } from "vitest";
import { setDeps } from "@/lib/deps";
import { makeDeps, msg, req, ScriptedLLM, toolUse } from "./fakes";
import { GET as scan } from "@/app/api/cron/scan/route";
import type { EmailMessage } from "@/lib/google/workspace";

function email(id: string, over: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id,
    threadId: `t_${id}`,
    from: "Dana Lee <dana@acme.com>",
    to: "stimmel@example.com",
    cc: "",
    subject: "Deposit",
    date: "2026-10-16T14:00:00.000Z",
    snippet: "",
    labels: ["INBOX"],
    body: "We'll send the deposit by Friday. I haven't heard back about the proposal.",
    ...over,
  };
}

describe("/api/cron/scan", () => {
  it("extracts, stores, pushes for HIGH/CRITICAL and overdue, and is idempotent", async () => {
    const llm = new ScriptedLLM([
      (p) => {
        expect(p.tool_choice).toMatchObject({ type: "tool", name: "record_email_analysis" });
        const user = p.messages[0]!.content as string;
        if (user.includes("Message-Id: m1"))
          return msg([
            toolUse("record_email_analysis", {
              summary: "Dana will send the deposit Friday and is waiting on the proposal.",
              categories: ["Payment", "Proposal", "Existing Client"],
              importance: "HIGH",
              client: "ACME",
              people: ["Dana Lee"],
              commitments: [
                { who: "Dana Lee", what: "Send deposit", dueAt: "2026-10-23", dueInferred: false, confidence: "CONFIRMED" },
              ],
              decisions: [],
              followups: [{ person: "Dana Lee", reason: "Waiting on proposal", importance: "HIGH", suggestedMessage: "Hi Dana, proposal coming today." }],
              alert: "ACME is waiting on the proposal; deposit promised Friday.",
            }),
          ]);
        return msg([
          toolUse("record_email_analysis", { summary: "Newsletter", categories: ["FYI"], importance: "FYI", people: [], commitments: [], decisions: [], followups: [] }),
        ]);
      },
    ]);
    const deps = makeDeps({ llm });
    setDeps(deps);
    deps.ws.messages = [email("m1"), email("m2", { from: "news@x.com", subject: "Weekly news" })];
    await deps.repos.devices.create("watch").then(({ device }) => deps.repos.devices.setFcmToken(device.id, "fcm-1", "watch"));
    await deps.repos.commitments.add({ who: "Stimmel", what: "Send revised agreement", dueAt: "2026-10-10T17:00:00Z", source: { kind: "voice" }, confidence: "CONFIRMED" });

    const res = await scan(req("GET", "/api/cron/scan", { token: "test-cron-secret" }));
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, number>;
    expect(out).toMatchObject({ processed: 2, failed: 0, commitmentsAdded: 1, followupsUpserted: 1, alertsSent: 1, overdueAlerts: 1 });

    const commitments = await deps.repos.commitments.list("open", { client: "ACME" });
    expect(commitments[0]).toMatchObject({ who: "Dana Lee", confidence: "CONFIRMED", dueInferred: false, source: { kind: "email", ref: "m1" } });
    expect((await deps.repos.followups.list())[0]).toMatchObject({ person: "Dana Lee", client: "ACME", importance: "HIGH" });
    expect(await deps.repos.timeline.forClient("ACME")).toHaveLength(1);
    expect(deps.pushFake.sent.map((s) => s.msg.data?.kind).sort()).toEqual(["commitment_overdue", "email"]);
    expect(deps.pushFake.sent[0]!.tokens).toEqual(["fcm-1"]);

    // Second run: no re-processing, no duplicate alerts.
    const again = (await (await scan(req("GET", "/api/cron/scan", { token: "test-cron-secret" }))).json()) as Record<string, number>;
    expect(again).toMatchObject({ processed: 0, skipped: 2, alertsSent: 0, overdueAlerts: 0 });
    expect(llm.calls).toHaveLength(2);
  });

  it("retries messages that failed", async () => {
    let fail = true;
    const llm = new ScriptedLLM([
      () => {
        if (fail) throw new Error("overloaded");
        return msg([toolUse("record_email_analysis", { summary: "ok", categories: ["FYI"], importance: "LOW", people: [], commitments: [], decisions: [], followups: [] })]);
      },
    ]);
    const deps = makeDeps({ llm });
    setDeps(deps);
    deps.ws.messages = [email("m1")];
    const r1 = (await (await scan(req("GET", "/api/cron/scan", { token: "test-cron-secret" }))).json()) as Record<string, number>;
    expect(r1).toMatchObject({ processed: 0, failed: 1 });
    fail = false;
    const r2 = (await (await scan(req("GET", "/api/cron/scan", { token: "test-cron-secret" }))).json()) as Record<string, number>;
    expect(r2).toMatchObject({ processed: 1, failed: 0 });
  });

  it("returns 409 when Google is not connected", async () => {
    const deps = makeDeps({ llm: new ScriptedLLM([]), googleConnected: false });
    setDeps(deps);
    expect((await scan(req("GET", "/api/cron/scan", { token: "test-cron-secret" }))).status).toBe(409);
  });
});
