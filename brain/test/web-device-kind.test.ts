import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { setDeps } from "@/lib/deps";
import { ASK_DEVICE_RELAYS, AskRequestSchema, DEVICE_KINDS, DeviceKindSchema, PAIRABLE_DEVICE_KINDS } from "@/lib/models";
import { POST as ask } from "@/app/api/ask/route";
import { POST as pair } from "@/app/api/devices/pair/route";
import { POST as createCommand } from "@/app/api/commands/route";
import { draftFingerprint } from "@/lib/confirmation";
import { approveDraft } from "@/lib/dashboard/browser-api";
import { sessionFetch } from "./session-fetch";
import { encrypt } from "@/lib/crypto";
import { config } from "@/lib/env";
import { DASHBOARD_DEVICE_NAME, dashboardDeviceToken } from "@/lib/dashboard/device-bridge";
import { makeDeps, msg, pairDevice, params, req, ScriptedLLM, toolUse } from "./fakes";

/** Web app slice 2a (docs/WEBAPP.md §4.2, §6.2, §6.3): the `web` device kind. */

const respond = () => msg([toolUse("respond", { reply: "ok", spoken: "ok" })]);
const key = randomBytes(32);

describe("contract: web device kind", () => {
  it("is a device kind and an /api/ask device", () => {
    expect(DEVICE_KINDS).toContain("web");
    expect(DeviceKindSchema.parse("web")).toBe("web");
    expect(AskRequestSchema.parse({ text: "hi", device: "web" }).device).toBe("web");
  });

  it("can't be paired with a code, and the code is not used up by the attempt", async () => {
    expect(PAIRABLE_DEVICE_KINDS).not.toContain("web");
    const deps = makeDeps();
    setDeps(deps);
    const { code } = await deps.repos.pairing.issue(600);
    const refused = await pair(req("POST", "/api/devices/pair", { body: { code, device: "web" } }));
    expect(refused.status).toBe(400);
    expect(await deps.repos.devices.list()).toEqual([]);
    const ok = await pair(req("POST", "/api/devices/pair", { body: { code, device: "phone" } }));
    expect(ok.status).toBe(200);
  });

  it("every kind has an ask relay rule that includes itself, and only the phone relays", () => {
    for (const k of DEVICE_KINDS) expect(ASK_DEVICE_RELAYS[k]).toContain(k);
    for (const k of DEVICE_KINDS) if (k !== "phone") expect(ASK_DEVICE_RELAYS[k]).toEqual([k]);
    expect([...ASK_DEVICE_RELAYS.phone].sort()).toEqual(["glasses", "medallion", "phone", "watch"]);
    for (const k of DEVICE_KINDS) if (k !== "web") expect(ASK_DEVICE_RELAYS[k]).not.toContain("web");
  });
});

describe("/api/ask: body device must match the authenticated device", () => {
  async function askWith(kind: (typeof DEVICE_KINDS)[number], device: string) {
    const llm = new ScriptedLLM([respond]);
    const deps = makeDeps({ llm });
    setDeps(deps);
    const { token } = await pairDevice(deps, kind);
    const res = await ask(req("POST", "/api/ask", { token, body: { text: "hi", device } }), params({}));
    return { res, llm };
  }

  it("a web device asks as web, and the prompt says so", async () => {
    const { res, llm } = await askWith("web", "web");
    expect(res.status).toBe(200);
    expect((llm.calls[0]!.system as { text: string }[])[1]!.text).toContain("Device for this request: web");
  });

  it("the phone may relay for its medallion and glasses", async () => {
    expect((await askWith("phone", "medallion")).res.status).toBe(200);
    expect((await askWith("phone", "glasses")).res.status).toBe(200);
    expect((await askWith("phone", "phone")).res.status).toBe(200);
    // A Galaxy Watch set up from the phone uses the phone's token (android/README.md).
    expect((await askWith("phone", "watch")).res.status).toBe(200);
  });

  it.each([
    ["phone", "web"],
    ["watch", "web"],
    ["reachy", "web"],
    ["web", "phone"],
    ["web", "watch"],
    ["phone", "reachy"],
    ["watch", "phone"],
    ["reachy", "phone"],
  ] as const)("a %s can't ask as %s (400, the model is never called)", async (kind, device) => {
    const { res, llm } = await askWith(kind, device);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("device_mismatch");
    expect(llm.calls).toHaveLength(0);
  });
});

describe("dashboard device is kind web", () => {
  it("mints a web device, which gets call/link hand-offs only when no phone is paired (WEBAPP.md §7)", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const token = await dashboardDeviceToken(deps, key);
    const dev = await deps.repos.devices.findByToken(token);
    expect(dev).toMatchObject({ kind: "web", name: DASHBOARD_DEVICE_NAME });

    // A watch asks for a call while only the dashboard exists: it waits in the browser.
    const watch = await pairDevice(deps, "watch");
    const body = { kind: "call_contact", number: "303 555 0142" };
    const toWeb = await createCommand(req("POST", "/api/commands", { token: watch.token, body }), params({}));
    expect(toWeb.status).toBe(201);
    expect(await toWeb.json()).toMatchObject({ deviceId: dev!.id, device: "web" });

    // reachy_start stays phone-only: an https page can't reach the robot's LAN daemon.
    const reachy = { kind: "reachy_start" };
    for (const target of [undefined, { deviceId: dev!.id }, { device: "web" }]) {
      const r = await createCommand(req("POST", "/api/commands", { token: watch.token, body: { ...reachy, ...(target ? { target } : {}) } }), params({}));
      expect(r.status).toBe(409);
    }

    // Once a phone is paired it is the default again, even if the browser was seen more recently.
    const phone = await pairDevice(deps, "phone");
    await deps.repos.devices.touch(dev!.id);
    const toPhone = await createCommand(req("POST", "/api/commands", { token: watch.token, body }), params({}));
    expect(await toPhone.json()).toMatchObject({ deviceId: phone.device.id, device: "phone" });
    // ...and the browser can still be picked explicitly.
    const byKind = await createCommand(req("POST", "/api/commands", { token: watch.token, body: { ...body, target: { device: "web" } } }), params({}));
    expect(await byKind.json()).toMatchObject({ deviceId: dev!.id, device: "web" });
    expect(await deps.repos.commands.pendingFor(dev!.id)).toHaveLength(2);
  });

  it("retires a legacy phone-kind dashboard device and replaces it with a web one", async () => {
    const deps = makeDeps();
    setDeps(deps);
    // What earlier builds stored: a "phone" device and its encrypted token.
    const legacy = await deps.repos.devices.create("phone", DASHBOARD_DEVICE_NAME);
    await deps.kv.set(`${config.redisPrefix()}:dashboard:device-token`, encrypt(legacy.token, key, "dashboard-device-token"));

    const token = await dashboardDeviceToken(deps, key);
    expect(token).not.toBe(legacy.token);
    expect(await deps.repos.devices.findByToken(legacy.token)).toBeNull();
    expect((await deps.repos.devices.get(legacy.device.id))?.revoked).toBe(true);
    expect(await deps.repos.devices.findByToken(token)).toMatchObject({ kind: "web" });
    // Stable afterwards.
    expect(await dashboardDeviceToken(deps, key)).toBe(token);
    const live = (await deps.repos.devices.list()).filter((d) => !d.revoked);
    expect(live).toHaveLength(1);
  });

  it("also retires a legacy device whose stored token can't be decrypted (key rotated)", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const legacy = await deps.repos.devices.create("phone", DASHBOARD_DEVICE_NAME);
    await deps.repos.devices.touch(legacy.device.id);
    await deps.kv.set(`${config.redisPrefix()}:dashboard:device-token`, encrypt(legacy.token, randomBytes(32), "dashboard-device-token"));
    const realPhone = await pairDevice(deps, "phone");

    const token = await dashboardDeviceToken(deps, key);
    expect(await deps.repos.devices.findByToken(token)).toMatchObject({ kind: "web" });
    expect((await deps.repos.devices.get(legacy.device.id))?.revoked).toBe(true);
    // A real phone is untouched.
    expect(await deps.repos.devices.findByToken(realPhone.token)).not.toBeNull();
  });

  it("approving from the dashboard records 'approved on web' and still sends exactly once", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const g = await deps.ws.createDraft({ to: ["dana@acme.com"], subject: "Proposal", body: "Hi Dana, attached." });
    const d = await deps.repos.drafts.create({ providerDraftId: g.gmailDraftId, to: ["dana@acme.com"], subject: "Proposal", body: "Hi Dana, attached.", client: "ACME" });
    process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef";
    process.env.TOKEN_ENCRYPTION_KEY = key.toString("base64");
    try {
      expect(await approveDraft(d.id, draftFingerprint(d), await sessionFetch())).toEqual({ ok: true });
    } finally {
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
    expect(deps.sender.sendDraft).toHaveBeenCalledOnce();
    const events = await deps.repos.timeline.forClient("ACME");
    expect(events.some((e) => e.event.includes("(approved on web)"))).toBe(true);
  });
});
