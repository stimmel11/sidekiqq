import { describe, expect, it } from "vitest";
import { setDeps } from "@/lib/deps";
import { buildCommand, CommandError, COMMAND_TARGETS } from "@/lib/commands";
import { executeTool, TOOL_NAMES } from "@/lib/assistant/tools";
import { CommandsResponseSchema, CreateCommandResponseSchema, type DeviceCommand } from "@/lib/models";
import { makeDeps, msg, pairDevice, params, req, ScriptedLLM, toolUse } from "./fakes";
import { POST as ask } from "@/app/api/ask/route";
import { GET as listCommands, POST as createCommand } from "@/app/api/commands/route";

/**
 * Start-up-Reachy slice 2: "start up Reachy" said to any device → /api/ask → start_reachy →
 * a `reachy_start` hand-off on the phone. The phone runs the LAN start only after the owner taps
 * Start, then queues the reachy_wake itself (slice 1 flow). The brain never reaches the robot.
 */

const NOW = new Date("2026-11-09T15:00:00Z");

type Step = Parameters<typeof ScriptedLLM.prototype.create>[0];

function results(p: Step): { content: string; is_error?: boolean }[] {
  const last = p.messages[p.messages.length - 1]!;
  return (Array.isArray(last.content) ? last.content : []).filter((b) => b.type === "tool_result") as { content: string; is_error?: boolean }[];
}

async function setup(script: ((p: Step) => ReturnType<typeof msg>)[], opts: { phone?: boolean; reachy?: boolean } = {}) {
  const llm = new ScriptedLLM(script.map((f) => (p: Step) => f(p)));
  const deps = makeDeps({ llm, now: NOW });
  setDeps(deps);
  const watch = await pairDevice(deps, "watch");
  const phone = opts.phone === false ? undefined : await pairDevice(deps, "phone");
  const reachy = opts.reachy ? await pairDevice(deps, "reachy") : undefined;
  return { llm, deps, watch, phone, reachy };
}

async function askAs(token: string, text: string, device = "watch") {
  const res = await ask(req("POST", "/api/ask", { token, body: { text, device } }), params({}));
  expect(res.status).toBe(200);
  return (await res.json()) as { reply: string; actions: unknown[] };
}

async function queued(token: string): Promise<DeviceCommand[]> {
  const res = await listCommands(req("GET", "/api/commands", { token }), params({}));
  return CommandsResponseSchema.parse(await res.json()).items;
}

const respond = () => msg([toolUse("respond", { reply: "ok", spoken: "ok" })]);

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CommandError);
    return (e as CommandError).code ?? "";
  }
  throw new Error("expected a CommandError");
}

describe("reachy_start command", () => {
  it("targets the phone (the robot's LAN is only reachable from home)", () => {
    expect(COMMAND_TARGETS.reachy_start).toEqual(["phone"]);
  });

  it("builds a code-made label; chat is the default", () => {
    expect(buildCommand({ kind: "reachy_start" })).toEqual({ kind: "reachy_start", activity: "chat", label: "Start Reachy to chat" });
    expect(buildCommand({ kind: "reachy_start", activity: "brief" })).toMatchObject({ label: "Start Reachy to read your brief" });
    expect(buildCommand({ kind: "reachy_start", activity: "dance" })).toMatchObject({ label: "Start Reachy to dance" });
  });

  it("refuses game (Reachy has no game yet) and fields of other kinds", () => {
    expect(codeOf(() => buildCommand({ kind: "reachy_start", activity: "game" }))).toBe("bad_activity");
    for (const extra of [{ url: "https://zoom.us/j/1" }, { number: "3035550142" }, { name: "Dana" }, { app: "phone" as const }]) {
      expect(codeOf(() => buildCommand({ kind: "reachy_start", ...extra }))).toBe("bad_command");
    }
  });

  it("POST /api/commands from the watch queues it on the phone, not on Reachy", async () => {
    const { watch, phone, reachy } = await setup([], { reachy: true });
    const res = await createCommand(req("POST", "/api/commands", { token: watch.token, body: { kind: "reachy_start", activity: "dance" } }), params({}));
    expect(res.status).toBe(201);
    const body = CreateCommandResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ deviceId: phone!.device.id, device: "phone" });
    expect(body.command).toMatchObject({ kind: "reachy_start", activity: "dance", from: "watch", label: "Start Reachy to dance" });
    expect(await queued(reachy!.token)).toEqual([]);
    // A reachy can't be the target of a start (it would have to be running already).
    const wrong = await createCommand(
      req("POST", "/api/commands", { token: watch.token, body: { kind: "reachy_start", target: { device: "reachy" } } }),
      params({}),
    );
    expect(wrong.status).toBe(409);
  });
});

describe("start_reachy via /api/ask", () => {
  it("is offered to Claude", () => {
    expect(TOOL_NAMES).toContain("start_reachy");
  });

  it("watch: 'start up Reachy and let's dance' queues a tap-to-start hand-off on the phone, audited, nudged", async () => {
    const { deps, watch, phone, llm } = await setup([() => msg([toolUse("start_reachy", { activity: "dance" })]), respond]);
    await deps.repos.devices.setFcmToken(phone!.device.id, "tok-phone", "phone");
    const body = await askAs(watch.token, "Start up Reachy and let's dance");
    expect(body.actions).toEqual([]);

    const out = JSON.parse(results(llm.calls[1]!)[0]!.content);
    expect(out).toMatchObject({ queued: true, label: "Start Reachy to dance" });
    expect(out.note).toMatch(/Nothing has started yet/);

    const items = await queued(phone!.token);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "reachy_start", activity: "dance", from: "watch" });
    expect((await deps.repos.commands.get(items[0]!.id))?.fromDeviceId).toBe(watch.device.id);

    expect(deps.pushFake.dataSent).toEqual([{ tokens: ["tok-phone"], data: { kind: "command", commandId: items[0]!.id }, priority: "high" }]);
    expect(deps.pushFake.sent).toEqual([]);

    const audit = (await deps.repos.audit.recent()).find((a) => a.capability === "device.reachy_start");
    expect(audit).toMatchObject({ connector: "device", tier: "user_finishes", caller: "ask", device: "watch", ok: true });
    expect(audit?.summary).toBe("hand-off to phone: start Reachy (dance)");
  });

  it("defaults to chat", async () => {
    const { phone } = await setup([() => msg([toolUse("start_reachy", {})]), respond]);
    await askAs(phone!.token, "turn on Reachy", "phone");
    expect(await queued(phone!.token)).toMatchObject([{ kind: "reachy_start", activity: "chat", from: "phone" }]);
  });

  it("one start per request", async () => {
    const { phone, llm, watch } = await setup([
      () => msg([toolUse("start_reachy", { activity: "chat" })]),
      () => msg([toolUse("start_reachy", { activity: "dance" })]),
      respond,
    ]);
    await askAs(watch.token, "start Reachy");
    expect(results(llm.calls[2]!)[0]).toMatchObject({ is_error: true });
    expect(results(llm.calls[2]!)[0]!.content).toMatch(/already waiting/);
    expect(await queued(phone!.token)).toHaveLength(1);
  });

  it("game isn't accepted by the tool schema", async () => {
    const { phone, llm, watch } = await setup([() => msg([toolUse("start_reachy", { activity: "game" })]), respond]);
    await askAs(watch.token, "start Reachy and play a game");
    expect(results(llm.calls[1]!)[0]).toMatchObject({ is_error: true });
    expect(await queued(phone!.token)).toEqual([]);
  });

  it("no paired phone → a plain error, audited as a refusal", async () => {
    const { deps, watch, llm } = await setup([() => msg([toolUse("start_reachy", {})]), respond], { phone: false });
    await askAs(watch.token, "start Reachy");
    expect(results(llm.calls[1]!)[0]).toMatchObject({ is_error: true });
    expect(results(llm.calls[1]!)[0]!.content).toMatch(/no paired phone/);
    const row = (await deps.repos.audit.recent()).find((a) => a.capability === "device.reachy_start");
    expect(row).toMatchObject({ ok: false });
    expect(row?.error).toMatch(/^no_target_device/);
  });

  it("refuses outside an owner request", async () => {
    const deps = makeDeps({ now: NOW });
    await pairDevice(deps, "phone");
    const r = await executeTool("start_reachy", {}, { deps, now: NOW, device: "watch", actions: [] });
    expect(r).toMatchObject({ isError: true });
    expect(r.content).toMatch(/only be started from an owner request/);
  });
});
