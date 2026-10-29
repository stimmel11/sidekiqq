import { beforeEach, describe, expect, it, vi } from "vitest";
import { setDeps } from "@/lib/deps";
import { makeDeps, pairDevice, params, req, type TestDeps } from "./fakes";
import { POST as createCommand } from "@/app/api/commands/route";
import { nudgeCommandTarget, NUDGE_TIMEOUT_MS } from "@/lib/commands/nudge";
import { buildDataMulticast, NoopPushSender } from "@/lib/push";
import { CreateCommandResponseSchema } from "@/lib/models";

async function create(token: string, body: unknown) {
  const res = await createCommand(req("POST", "/api/commands", { token, body }), params({}));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let deps: TestDeps;
let watch: Awaited<ReturnType<typeof pairDevice>>;
let phone: Awaited<ReturnType<typeof pairDevice>>;

beforeEach(async () => {
  deps = makeDeps();
  setDeps(deps);
  watch = await pairDevice(deps, "watch");
  phone = await pairDevice(deps, "phone");
  await deps.repos.devices.setFcmToken(watch.device.id, "tok-watch", "watch");
  await deps.repos.devices.setFcmToken(phone.device.id, "tok-phone", "phone");
});

describe("FCM nudge after POST /api/commands", () => {
  it("sends one silent, id-only nudge to the target device's token only", async () => {
    const res = await create(watch.token, { kind: "call_contact", number: "+1 303 555 0142", name: "Dana Lee" });
    expect(res.status).toBe(201);
    const { command } = CreateCommandResponseSchema.parse(res.body);

    expect(deps.pushFake.dataSent).toEqual([{ tokens: ["tok-phone"], data: { kind: "command", commandId: command.id }, priority: "high" }]);
    // Nothing from the command itself rides in the push: it's read only from GET /api/commands.
    const payload = JSON.stringify(deps.pushFake.dataSent);
    for (const leak of ["Dana", "0142", "Call", "label", "title", "body"]) expect(payload).not.toContain(leak);
    // Not an alert: no visible push and nothing in the alert log.
    expect(deps.pushFake.sent).toEqual([]);
    expect(await deps.repos.alerts.latestSeq()).toBe(0);
  });

  it("nudges the explicitly chosen target, not the most recent device of that kind", async () => {
    const phone2 = await pairDevice(deps, "phone");
    await deps.repos.devices.setFcmToken(phone2.device.id, "tok-phone2", "phone");
    expect((await create(watch.token, { kind: "open_url", url: "https://zoom.us/j/1", target: { deviceId: phone.device.id } })).status).toBe(201);
    expect(deps.pushFake.dataSent.map((d) => d.tokens)).toEqual([["tok-phone"]]);
  });

  it("skips targets without a push token (Reachy polls) and still queues the command", async () => {
    await pairDevice(deps, "reachy");
    expect((await create(phone.token, { kind: "reachy_wake", activity: "dance" })).status).toBe(201);
    expect(deps.pushFake.dataSent).toEqual([]);
  });

  it("a failed or slow nudge never fails the request; polling is the fallback", async () => {
    deps.pushFake.dataError = new Error("FCM down");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await create(watch.token, { kind: "call_contact", number: "5550142" });
    expect(res.status).toBe(201);
    warn.mockRestore();
  });

  it("a never-answering FCM call still returns 201 after the timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      deps.pushFake.sendData = () => new Promise(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const p = create(watch.token, { kind: "call_contact", number: "5550142" });
      await vi.advanceTimersByTimeAsync(NUDGE_TIMEOUT_MS + 1);
      expect((await p).status).toBe(201);
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends no nudge when the command is refused", async () => {
    expect((await create(watch.token, { kind: "open_url", url: "https://evil.example/x" })).status).toBe(400);
    expect((await create(watch.token, { kind: "call_contact", number: "5550142", target: { deviceId: watch.device.id } })).status).toBe(409);
    expect((await create(phone.token, { kind: "reachy_wake" })).status).toBe(409); // no reachy paired
    expect(deps.pushFake.dataSent).toEqual([]);
  });

  it("forgets a token FCM reports as invalid", async () => {
    deps.pushFake.invalidOnData = ["tok-phone"];
    expect((await create(watch.token, { kind: "call_contact", number: "5550142" })).status).toBe(201);
    expect((await deps.repos.devices.get(phone.device.id))?.fcmToken).toBeUndefined();
    expect((await deps.repos.devices.get(watch.device.id))?.fcmToken).toBe("tok-watch");
  });
});

describe("nudgeCommandTarget", () => {
  it("returns no_token for revoked or token-less devices, push_disabled without FCM", async () => {
    const d = (await deps.repos.devices.get(phone.device.id))!;
    expect(await nudgeCommandTarget(deps, { ...d, revoked: true }, "cmd_1")).toBe("no_token");
    const { fcmToken: _t, ...noToken } = d;
    expect(await nudgeCommandTarget(deps, noToken, "cmd_1")).toBe("no_token");
    const noop = new NoopPushSender();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect(await nudgeCommandTarget({ ...deps, push: () => noop }, d, "cmd_1")).toBe("push_disabled");
    info.mockRestore();
    expect(await nudgeCommandTarget(deps, d, "cmd_1")).toBe("sent");
  });

  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const d = (await deps.repos.devices.get(phone.device.id))!;
      deps.pushFake.sendData = () => new Promise(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const p = nudgeCommandTarget(deps, d, "cmd_1");
      await vi.advanceTimersByTimeAsync(NUDGE_TIMEOUT_MS + 1);
      expect(await p).toBe("failed");
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("buildDataMulticast", () => {
  it("is data-only and never carries title/body", () => {
    expect(buildDataMulticast(["t"], { kind: "command", commandId: "cmd_1", title: "x", body: "y" }, "high")).toEqual({
      tokens: ["t"],
      data: { kind: "command", commandId: "cmd_1" },
      android: { priority: "high" },
    });
    expect(buildDataMulticast(["t"], { kind: "command", commandId: "c" }).android.priority).toBe("normal");
  });
});
