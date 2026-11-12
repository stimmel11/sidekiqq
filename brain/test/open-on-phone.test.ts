import { describe, expect, it } from "vitest";
import { setDeps } from "@/lib/deps";
import { CommandError } from "@/lib/commands";
import { handoffCapability, HANDOFF_CAPABILITIES } from "@/lib/connectors/handoff";
import { invokeCapability } from "@/lib/connectors/invoke";
import { CapabilityDeniedError } from "@/lib/connectors/types";
import { executeTool, TOOL_NAMES } from "@/lib/assistant/tools";
import { CommandsResponseSchema, type DeviceCommand } from "@/lib/models";
import { makeDeps, msg, pairDevice, params, req, ScriptedLLM, toolUse } from "./fakes";
import { POST as ask } from "@/app/api/ask/route";
import { GET as listCommands } from "@/app/api/commands/route";

/**
 * Task layer slice 4b: `user_finishes` hand-offs through handoffCapability (docs/CONNECTORS.md
 * §4.3), first for `device.open_url` with links the brain created in the request, plus the
 * `open_on_phone` tool and the FCM token de-dup follow-up.
 */

const NOW = new Date("2026-11-05T15:00:00Z");
const JOIN = "https://us02web.zoom.us/j/810000001?pwd=abc";

async function world() {
  const deps = makeDeps({ now: NOW, zoom: true });
  setDeps(deps);
  const watch = await pairDevice(deps, "watch");
  const phone = await pairDevice(deps, "phone");
  return { deps, watch, phone };
}

async function onPhone(token: string): Promise<DeviceCommand[]> {
  const res = await listCommands(req("GET", "/api/commands", { token }), params({}));
  return CommandsResponseSchema.parse(await res.json()).items;
}

const ctxFor = (w: Awaited<ReturnType<typeof world>>, allowed: string[] = [JOIN], caller: "ask" | "cron" | "brief" | "task" = "ask") => ({
  caller,
  device: "watch" as const,
  origin: { deviceId: w.watch.device.id, deviceKind: "watch" as const },
  allowedUrls: new Set(allowed),
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CommandError) return e.code ?? "";
    if (e instanceof CapabilityDeniedError) return "denied";
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("handoffCapability", () => {
  it("only device.open_url is handed off here today", () => {
    expect(HANDOFF_CAPABILITIES).toEqual(["device.open_url"]);
  });

  it("queues a tap-to-open hand-off on the phone from the asking device, nudges it, audits host only", async () => {
    const w = await world();
    await w.deps.repos.devices.setFcmToken(w.phone.device.id, "tok-phone", "phone");
    const r = await handoffCapability(w.deps, "device.open_url", { url: JOIN }, ctxFor(w));
    expect(r).toMatchObject({ queued: true, url: JOIN, label: "Open us02web.zoom.us link" });

    const items = await onPhone(w.phone.token);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: r.commandId, kind: "open_url", url: JOIN, from: "watch" });
    expect((await w.deps.repos.commands.get(r.commandId))?.fromDeviceId).toBe(w.watch.device.id);
    expect(w.deps.pushFake.dataSent).toEqual([{ tokens: ["tok-phone"], data: { kind: "command", commandId: r.commandId }, priority: "high" }]);
    expect(w.deps.pushFake.sent).toEqual([]);

    const rows = (await w.deps.repos.audit.recent()).filter((a) => a.capability === "device.open_url");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ connector: "device", tier: "user_finishes", caller: "ask", device: "watch", ok: true, summary: "hand-off to phone: us02web.zoom.us" });
    expect(JSON.stringify(rows[0])).not.toContain("pwd");
  });

  it("refuses a link the brain didn't create in this request, even an allowlisted Zoom link", async () => {
    const w = await world();
    expect(await codeOf(handoffCapability(w.deps, "device.open_url", { url: "https://zoom.us/j/999?pwd=evil" }, ctxFor(w)))).toBe("link_not_created");
    expect(await codeOf(handoffCapability(w.deps, "device.open_url", { url: JOIN }, ctxFor(w, [])))).toBe("link_not_created");
    expect(await onPhone(w.phone.token)).toEqual([]);
    const rows = (await w.deps.repos.audit.recent()).filter((a) => a.capability === "device.open_url");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.ok === false && r.error?.startsWith("link_not_created"))).toBe(true);
  });

  it("only meeting hosts: cart pages, other hosts and non-https links are refused even when 'created'", async () => {
    const w = await world();
    for (const [url, code] of [
      ["https://www.kroger.com/cart", "url_not_allowed"],
      ["https://evil.example/j/1", "url_not_allowed"],
      ["http://zoom.us/j/1", "bad_url"],
      ["https://user:pw@zoom.us/j/1", "bad_url"],
      ["https://zoom.us.evil.example/j/1", "url_not_allowed"],
      ["javascript:alert(1)", "bad_url"],
    ] as const) {
      expect(await codeOf(handoffCapability(w.deps, "device.open_url", { url }, ctxFor(w, [url]))), url).toBe(code);
    }
    expect(await onPhone(w.phone.token)).toEqual([]);
  });

  it("accepts a Meet link the brain created", async () => {
    const w = await world();
    const url = "https://meet.google.com/abc-defg-hij";
    await handoffCapability(w.deps, "device.open_url", { url }, ctxFor(w, [url]));
    expect((await onPhone(w.phone.token))[0]).toMatchObject({ url });
  });

  it("matches after URL normalisation, but any change to the link is refused", async () => {
    const w = await world();
    expect(await codeOf(handoffCapability(w.deps, "device.open_url", { url: `${JOIN}#x` }, ctxFor(w)))).toBe("link_not_created");
    expect(await codeOf(handoffCapability(w.deps, "device.open_url", { url: `${JOIN}&x=1` }, ctxFor(w)))).toBe("link_not_created");
    const r = await handoffCapability(w.deps, "device.open_url", { url: `  ${JOIN.replace("us02web.zoom.us", "US02WEB.Zoom.us")}  ` }, ctxFor(w));
    expect(r.url).toBe(JOIN);
    const rows = (await w.deps.repos.audit.recent()).filter((a) => a.capability === "device.open_url");
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toContain("pwd");
  });

  it("task and dashboard callers may hand off a created link too", async () => {
    const w = await world();
    await handoffCapability(w.deps, "device.open_url", { url: JOIN }, ctxFor(w, [JOIN], "task"));
    await handoffCapability(w.deps, "device.open_url", { url: JOIN }, { ...ctxFor(w), caller: "dashboard" });
    expect(await onPhone(w.phone.token)).toHaveLength(2);
  });

  it("background callers fail closed, audited", async () => {
    const w = await world();
    for (const caller of ["cron", "brief"] as const) {
      expect(await codeOf(handoffCapability(w.deps, "device.open_url", { url: JOIN }, ctxFor(w, [JOIN], caller)))).toBe("denied");
    }
    expect(await onPhone(w.phone.token)).toEqual([]);
    expect((await w.deps.repos.audit.recent()).filter((a) => a.capability === "device.open_url" && !a.ok)).toHaveLength(2);
  });

  it("needs the owner request's device and a well-formed input", async () => {
    const w = await world();
    const noOrigin = { ...ctxFor(w), origin: undefined } as unknown as Parameters<typeof handoffCapability>[3];
    expect(await codeOf(handoffCapability(w.deps, "device.open_url", { url: JOIN }, noOrigin))).toBe("denied");
    expect(await codeOf(handoffCapability(w.deps, "device.open_url", { url: JOIN, number: "+1900" }, ctxFor(w)))).toBe("denied");
    expect(await codeOf(handoffCapability(w.deps, "device.open_url", "https://zoom.us", ctxFor(w)))).toBe("denied");
    expect(await onPhone(w.phone.token)).toEqual([]);
  });

  it("other capabilities are never handed off here", async () => {
    const w = await world();
    for (const cap of ["device.call", "grocery.checkout", "email.send", "video.create_room", "email.draft", "nope"]) {
      await expect(handoffCapability(w.deps, cap, { url: JOIN }, ctxFor(w)), cap).rejects.toBeInstanceOf(CapabilityDeniedError);
    }
    expect(await onPhone(w.phone.token)).toEqual([]);
  });

  it("with no paired phone nothing is queued", async () => {
    const deps = makeDeps({ now: NOW });
    setDeps(deps);
    const watch = await pairDevice(deps, "watch");
    const ctx = { caller: "ask" as const, origin: { deviceId: watch.device.id, deviceKind: "watch" as const }, allowedUrls: new Set([JOIN]) };
    expect(await codeOf(handoffCapability(deps, "device.open_url", { url: JOIN }, ctx))).toBe("no_target_device");
  });

  it("invokeCapability still refuses device.open_url and points at the hand-off path", async () => {
    const w = await world();
    await expect(invokeCapability(w.deps, "device.open_url", { url: JOIN }, { caller: "ask" })).rejects.toThrow(/handoffCapability/);
  });
});

// ---------------------------------------------------------------------------------------
// open_on_phone through /api/ask
// ---------------------------------------------------------------------------------------

type Step = Parameters<typeof ScriptedLLM.prototype.create>[0];

function results(p: Step): { content: string; is_error?: boolean }[] {
  const last = p.messages[p.messages.length - 1]!;
  return (Array.isArray(last.content) ? last.content : []).filter((b) => b.type === "tool_result") as { content: string; is_error?: boolean }[];
}

const respond = () => msg([toolUse("respond", { reply: "ok", spoken: "ok" })]);

async function askWith(script: ((p: Step) => ReturnType<typeof msg>)[], text = "start a zoom and put it on my phone") {
  const llm = new ScriptedLLM(script);
  const deps = makeDeps({ llm, now: NOW, zoom: true });
  setDeps(deps);
  const watch = await pairDevice(deps, "watch");
  const phone = await pairDevice(deps, "phone");
  const res = await ask(req("POST", "/api/ask", { token: watch.token, body: { text, device: "watch" } }), params({}));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { actions: unknown[] };
  return { deps, llm, watch, phone, body };
}

describe("open_on_phone via /api/ask", () => {
  it("is offered to Claude", () => {
    expect(TOOL_NAMES).toContain("open_on_phone");
  });

  it("hands off the join link start_video_room created in this request, with no new action type", async () => {
    let joinUrl = "";
    const { llm, phone, body, deps } = await askWith([
      () => msg([toolUse("start_video_room", { topic: "Dana" })]),
      (p) => {
        joinUrl = JSON.parse(results(p)[0]!.content).joinUrl;
        return msg([toolUse("open_on_phone", { url: joinUrl })]);
      },
      respond,
    ]);
    expect(body.actions).toEqual([]); // CONNECTORS.md §4.3: no hand-off Action type yet
    const out = JSON.parse(results(llm.calls[2]!)[0]!.content);
    expect(out).toMatchObject({ queued: true, label: "Open us02web.zoom.us link" });
    expect(out.note).toMatch(/Nothing was opened/);
    const items = await onPhone(phone.token);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "open_url", url: joinUrl, from: "watch" });
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
  });

  it("refuses a link that wasn't created in this request (e.g. one read in an email)", async () => {
    const { llm, phone } = await askWith(
      [() => msg([toolUse("open_on_phone", { url: "https://zoom.us/j/999?pwd=fromemail" })]), respond],
      "open the zoom link from Dana's email on my phone",
    );
    expect(results(llm.calls[1]!)[0]).toMatchObject({ is_error: true });
    expect(results(llm.calls[1]!)[0]!.content).toMatch(/created in this request/);
    expect(await onPhone(phone.token)).toEqual([]);
  });

  it("a Zoom link returned by an email search can't be handed off", async () => {
    const { llm, phone, deps } = await askWith(
      [
        (p) => msg([toolUse("search_email", { query: "from:dana zoom" })]),
        () => msg([toolUse("open_on_phone", { url: "https://zoom.us/j/999?pwd=fromemail" })]),
        respond,
      ],
      "open Dana's zoom link on my phone",
    );
    void deps;
    expect(results(llm.calls[2]!)[0]).toMatchObject({ is_error: true });
    expect(await onPhone(phone.token)).toEqual([]);
  });

  it("refuses outside an owner request (no request context)", async () => {
    const { deps } = await world();
    const r = await executeTool("open_on_phone", { url: JOIN }, { deps, now: NOW, device: "watch", actions: [] });
    expect(r.isError).toBe(true);
  });

  it("one link per request", async () => {
    let joinUrl = "";
    const { llm, phone } = await askWith([
      () => msg([toolUse("start_video_room", { topic: "Dana" })]),
      (p) => {
        joinUrl = JSON.parse(results(p)[0]!.content).joinUrl;
        return msg([toolUse("open_on_phone", { url: joinUrl })]);
      },
      () => msg([toolUse("open_on_phone", { url: joinUrl })]),
      respond,
    ]);
    expect(results(llm.calls[3]!)[0]).toMatchObject({ is_error: true });
    expect(results(llm.calls[3]!)[0]!.content).toMatch(/already waiting/);
    expect(await onPhone(phone.token)).toHaveLength(1);
  });

  it("a refused hand-off doesn't use up the request's one link", async () => {
    let joinUrl = "";
    const { llm, phone } = await askWith([
      () => msg([toolUse("open_on_phone", { url: "https://zoom.us/j/999" })]),
      () => msg([toolUse("start_video_room", { topic: "Dana" })]),
      (p) => {
        joinUrl = JSON.parse(results(p)[0]!.content).joinUrl;
        return msg([toolUse("open_on_phone", { url: joinUrl })]);
      },
      respond,
    ]);
    expect(results(llm.calls[1]!)[0]).toMatchObject({ is_error: true });
    expect(results(llm.calls[3]!)[0]).not.toMatchObject({ is_error: true });
    expect(await onPhone(phone.token)).toHaveLength(1);
  });
});

describe("setFcmToken de-dup (4a follow-up)", () => {
  it("moving a token to a new device record clears it from the stale one", async () => {
    const { deps, phone } = await world();
    const old = phone.device.id;
    await deps.repos.devices.setFcmToken(old, "tok-1", "phone");
    const fresh = await pairDevice(deps, "phone");
    await deps.repos.devices.setFcmToken(fresh.device.id, "tok-1", "phone");
    expect((await deps.repos.devices.get(old))?.fcmToken).toBeUndefined();
    expect((await deps.repos.devices.get(fresh.device.id))?.fcmToken).toBe("tok-1");
    expect(await deps.repos.devices.pushTokens()).toEqual(["tok-1"]);
  });

  it("re-registering the same device keeps its token", async () => {
    const { deps, phone } = await world();
    await deps.repos.devices.setFcmToken(phone.device.id, "tok-1", "phone");
    await deps.repos.devices.setFcmToken(phone.device.id, "tok-1", "phone");
    expect((await deps.repos.devices.get(phone.device.id))?.fcmToken).toBe("tok-1");
  });
});
