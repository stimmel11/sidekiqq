import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { setDeps } from "@/lib/deps";
import { makeDeps, pairDevice, params, req, type TestDeps } from "./fakes";
import { GET as listCommands, POST as createCommand } from "@/app/api/commands/route";
import { POST as ackCommand } from "@/app/api/commands/[id]/ack/route";
import { cleanName, COMMAND_TTL_SECONDS, MAX_PENDING_PER_DEVICE, normalizeNumber, OPENED_ACK_GRACE_SECONDS, validateOpenUrl } from "@/lib/commands";
import { CommandsResponseSchema, CreateCommandResponseSchema, type DeviceCommand } from "@/lib/models";

async function create(token: string, body: unknown) {
  const res = await createCommand(req("POST", "/api/commands", { token, body }), params({}));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function list(token: string, query = ""): Promise<{ status: number; items: DeviceCommand[] }> {
  const res = await listCommands(req("GET", `/api/commands${query}`, { token }), params({}));
  const body = (await res.json()) as { items: DeviceCommand[] };
  if (res.status === 200) CommandsResponseSchema.parse(body);
  return { status: res.status, items: body.items };
}
async function ack(token: string, id: string, result: string) {
  const res = await ackCommand(req("POST", `/api/commands/${id}/ack`, { token, body: { result } }), params({ id }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let deps: TestDeps;
let watch: { token: string; device: { id: string } };
let phone: { token: string; device: { id: string } };

beforeEach(async () => {
  deps = makeDeps();
  setDeps(deps);
  watch = await pairDevice(deps, "watch");
  phone = await pairDevice(deps, "phone");
});

describe("POST /api/commands + GET /api/commands", () => {
  it("requires a device token", async () => {
    expect((await createCommand(req("POST", "/api/commands", { body: { kind: "open_url" } }), params({}))).status).toBe(401);
    expect((await listCommands(req("GET", "/api/commands"), params({}))).status).toBe(401);
  });

  it("routes a call started on the watch to the phone, with a code-built label", async () => {
    const res = await create(watch.token, { kind: "call_contact", number: "+1 (303) 555-0142", name: "Dana Lee" });
    expect(res.status).toBe(201);
    const parsed = CreateCommandResponseSchema.parse(res.body);
    expect(parsed).toMatchObject({ deviceId: phone.device.id, device: "phone" });
    expect(parsed.command).toMatchObject({
      kind: "call_contact",
      number: "+13035550142",
      name: "Dana Lee",
      app: "phone",
      from: "watch",
      label: "Call Dana Lee (+13035550142)",
    });

    const onPhone = await list(phone.token);
    expect(onPhone.items.map((c) => c.id)).toEqual([parsed.command.id]);
    // Routing/delivery state never leaves the brain.
    for (const k of ["targetDeviceId", "fromDeviceId", "status", "ackedAt"]) expect(onPhone.items[0]).not.toHaveProperty(k);
    // The watch has nothing queued for itself.
    expect((await list(watch.token)).items).toEqual([]);
  });

  it("labels WhatsApp calls and reachy wake-ups", async () => {
    const wa = await create(watch.token, { kind: "call_contact", number: "+1 303 555 0142", app: "whatsapp" });
    expect((wa.body.command as DeviceCommand).label).toBe("Call +13035550142 on WhatsApp");
    // WhatsApp needs an international number.
    expect((await create(watch.token, { kind: "call_contact", number: "303 555 0142", app: "whatsapp" })).status).toBe(400);
    const reachy = await pairDevice(deps, "reachy");
    const wake = await create(phone.token, { kind: "reachy_wake", activity: "dance" });
    expect(wake.status).toBe(201);
    expect(wake.body).toMatchObject({ deviceId: reachy.device.id, device: "reachy" });
    expect(wake.body.command).toMatchObject({ kind: "reachy_wake", activity: "dance", label: "Wake Reachy to dance", from: "phone" });
    const def = await create(phone.token, { kind: "reachy_wake" });
    expect(def.body.command).toMatchObject({ activity: "chat", label: "Wake Reachy to chat" });
  });

  it("opens only allowlisted https links", async () => {
    const ok = await create(watch.token, { kind: "open_url", url: "https://meet.google.com/abc-defg-hij" });
    expect(ok.status).toBe(201);
    expect(ok.body.command).toMatchObject({ url: "https://meet.google.com/abc-defg-hij", label: "Open meet.google.com link" });
    const bad = await create(watch.token, { kind: "open_url", url: "https://evil.example/x" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("url_not_allowed");
  });

  it("rejects fields that belong to another kind and missing required fields", async () => {
    expect((await create(watch.token, { kind: "open_url", url: "https://zoom.us/j/1", number: "123" })).status).toBe(400);
    expect((await create(watch.token, { kind: "open_url" })).status).toBe(400);
    expect((await create(watch.token, { kind: "call_contact", name: "Dana" })).status).toBe(400);
    expect((await create(watch.token, { kind: "call_contact", number: "123", url: "https://zoom.us/j/1" })).status).toBe(400);
    expect((await create(watch.token, { kind: "reachy_wake", number: "123" })).status).toBe(400);
    expect((await create(watch.token, { kind: "send_email", to: "x@y.z" })).status).toBe(400);
    expect((await create(watch.token, { kind: "call_contact", number: "*#06#" })).status).toBe(400);
  });

  it("resolves targets by device id or kind, and refuses devices that can't run the command", async () => {
    const phone2 = await pairDevice(deps, "phone");
    // Most recently seen phone wins by default.
    await deps.repos.devices.touch(phone2.device.id);
    deps.setNow(new Date("2026-10-16T15:10:00Z"));
    await deps.repos.devices.touch(phone2.device.id);
    const byDefault = await create(watch.token, { kind: "call_contact", number: "5550142" });
    expect(byDefault.body.deviceId).toBe(phone2.device.id);

    const byId = await create(watch.token, { kind: "call_contact", number: "5550142", target: { deviceId: phone.device.id } });
    expect(byId.body.deviceId).toBe(phone.device.id);

    const wrongKind = await create(phone.token, { kind: "call_contact", number: "5550142", target: { deviceId: watch.device.id } });
    expect(wrongKind.status).toBe(409);
    expect(wrongKind.body.code).toBe("wrong_target");
    expect((await create(phone.token, { kind: "call_contact", number: "5550142", target: { device: "watch" } })).status).toBe(409);

    expect((await create(watch.token, { kind: "call_contact", number: "5550142", target: { deviceId: "dev_nope" } })).status).toBe(404);
    await deps.repos.devices.revoke(phone.device.id);
    expect((await create(watch.token, { kind: "call_contact", number: "5550142", target: { deviceId: phone.device.id } })).status).toBe(404);

    const both = await create(watch.token, { kind: "call_contact", number: "5550142", target: { deviceId: phone2.device.id, device: "phone" } });
    expect(both.status).toBe(400);

    // No paired reachy at all.
    const noReachy = await create(watch.token, { kind: "reachy_wake" });
    expect(noReachy.status).toBe(409);
    expect(noReachy.body.code).toBe("no_target_device");
  });

  it("a name can't smuggle a second number into the label", async () => {
    const res = await create(watch.token, { kind: "call_contact", number: "+1 900 555 0000", name: "Bank (+1 303 555 0142) Fraud" });
    expect(res.status).toBe(201);
    const c = res.body.command as DeviceCommand;
    expect(c.label).toBe("Call Bank Fraud (+19005550000)");
    expect(c.name).toBe("Bank Fraud");
    // A name that is only digits is dropped.
    const digits = await create(watch.token, { kind: "call_contact", number: "5550142", name: "303-555-0142" });
    expect(digits.body.command).not.toHaveProperty("name");
    expect((digits.body.command as DeviceCommand).label).toBe("Call 5550142");
  });

  it("revoked devices can't list, and a revoked target id is refused", async () => {
    await create(watch.token, { kind: "call_contact", number: "5550142" });
    await deps.repos.devices.revoke(phone.device.id);
    expect((await list(phone.token)).status).toBe(401);
    expect((await create(watch.token, { kind: "call_contact", number: "5550142", target: { deviceId: phone.device.id } })).status).toBe(404);
  });

  it("rejects malformed limits", async () => {
    for (const q of ["?limit=abc", "?limit=1e1", "?limit=%205", "?limit=5.0", "?limit=-1", "?limit="]) {
      expect((await list(phone.token, q)).status, q).toBe(400);
    }
  });

  it("caps the pending queue per device", async () => {
    for (let i = 0; i < MAX_PENDING_PER_DEVICE; i++) {
      expect((await create(watch.token, { kind: "call_contact", number: `555010${i % 10}` })).status).toBe(201);
    }
    const full = await create(watch.token, { kind: "call_contact", number: "5550100" });
    expect(full.status).toBe(429);
    expect(full.body.code).toBe("queue_full");
    expect((await list(phone.token, "?limit=50")).items).toHaveLength(MAX_PENDING_PER_DEVICE);
    expect((await list(phone.token, "?limit=5")).items).toHaveLength(5);
    expect((await list(phone.token, "?limit=0")).status).toBe(400);
    expect((await list(phone.token, "?limit=51")).status).toBe(400);

    // Another device's queue is unaffected.
    const phone2 = await pairDevice(deps, "phone");
    expect((await create(watch.token, { kind: "call_contact", number: "5550100", target: { deviceId: phone2.device.id } })).status).toBe(201);

    // Acked and expired commands don't count toward the cap.
    const first = (await list(phone.token)).items[0]!;
    expect((await ack(phone.token, first.id, "dismissed")).status).toBe(200);
    expect((await create(watch.token, { kind: "call_contact", number: "5550100", target: { deviceId: phone.device.id } })).status).toBe(201);
    deps.setNow(new Date(Date.parse("2026-10-16T15:00:00Z") + (COMMAND_TTL_SECONDS + 1) * 1000));
    expect((await create(watch.token, { kind: "call_contact", number: "5550100", target: { deviceId: phone.device.id } })).status).toBe(201);
  });

  it("never sends mail or pushes an alert (only a silent nudge, covered in command-nudge.test.ts)", async () => {
    await create(watch.token, { kind: "call_contact", number: "5550142" });
    await create(watch.token, { kind: "open_url", url: "https://www.kroger.com/cart" });
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
    expect(deps.ws.createDraft).not.toHaveBeenCalled();
    expect(deps.pushFake.sent).toEqual([]);
    expect(await deps.repos.alerts.latestSeq()).toBe(0);
  });
});

describe("POST /api/commands/:id/ack", () => {
  async function queued() {
    const res = await create(watch.token, { kind: "call_contact", number: "5550142" });
    return (res.body.command as DeviceCommand).id;
  }

  it("only the target device can ack; an acked command leaves the queue", async () => {
    const id = await queued();
    expect((await ack(watch.token, id, "opened")).status).toBe(404);
    expect((await ack(phone.token, "cmd_missing", "opened")).status).toBe(404);
    expect((await ack(phone.token, "../x", "opened")).status).toBe(404);
    expect((await ack(phone.token, id, "sent")).status).toBe(400);

    expect(await ack(phone.token, id, "opened")).toEqual({ status: 200, body: { ok: true } });
    expect((await list(phone.token)).items).toEqual([]);
    expect((await ack(phone.token, id, "opened")).status).toBe(200); // idempotent
    const conflict = await ack(phone.token, id, "dismissed");
    expect(conflict.status).toBe(409);
    expect((await deps.repos.commands.get(id))?.status).toBe("opened");
  });

  it("expires commands: they leave the queue and can't be opened late (after a short grace)", async () => {
    const id = await queued();
    const id2 = await queued();
    const id3 = await queued();
    const t0 = Date.parse("2026-10-16T15:00:00Z");
    deps.setNow(new Date(t0 + (COMMAND_TTL_SECONDS + 1) * 1000));
    expect((await list(phone.token)).items).toEqual([]);
    // A tap made just in time whose ack arrives a little late is still accepted.
    expect((await ack(phone.token, id3, "opened")).status).toBe(200);
    deps.setNow(new Date(t0 + (COMMAND_TTL_SECONDS + OPENED_ACK_GRACE_SECONDS) * 1000));
    const late = await ack(phone.token, id, "opened");
    expect(late.status).toBe(410);
    expect(late.body.code).toBe("expired");
    expect((await ack(phone.token, id2, "dismissed")).status).toBe(200);
  });

  it("prunes rows older than a day", async () => {
    await queued();
    deps.setNow(new Date("2026-10-18T15:00:00Z"));
    await queued();
    expect(await deps.repos.commands.prune()).toBe(1);
  });
});

describe("command validation helpers", () => {
  it("validateOpenUrl", () => {
    for (const good of [
      "https://meet.google.com/abc-defg-hij",
      "https://us02web.zoom.us/j/123?pwd=x",
      "https://zoom.us/j/1",
      "https://www.kroger.com/cart",
      "https://www.kingsoopers.com/cart",
      "https://MEET.google.com/abc",
      "https://zoom.us:443/j/1",
    ]) expect(() => validateOpenUrl(good), good).not.toThrow();
    expect(validateOpenUrl("https:\\\\zoom.us/j/1").hostname).toBe("zoom.us");
    for (const bad of [
      "http://meet.google.com/abc",
      "javascript:alert(1)",
      "intent://scan/#Intent;scheme=zxing;end",
      "tel:5550142",
      "sms:5550142",
      "mailto:a@b.c",
      "https://wa.me/15550142",
      "https://meet.google.com.evil.com/x",
      "https://evilzoom.us/j/1",
      "https://user:pw@meet.google.com/x",
      "https://meet.google.com:8443/x",
      "https://kroger.com/cart",
      "https://zoom.us.evil.com/j/1",
      "https://zoom.us./j/1",
      "https://meet.google.com./x",
      "https://evil.com\\@zoom.us/j/1",
      "https://zoom.us%2eevil.com/j/1",
      "https://xn--mt-google-zzb.com/x",
      "https://[::1]/x",
      "not a url",
    ]) expect(() => validateOpenUrl(bad), bad).toThrow();
  });

  it("normalizeNumber", () => {
    expect(normalizeNumber("+1 (303) 555-0142")).toBe("+13035550142");
    expect(normalizeNumber("303.555.0142")).toBe("3035550142");
    expect(normalizeNumber("911")).toBe("911");
    for (const bad of ["*#06#", "#31#5550142", "12", "1234567890123456", "555-CALL", "+", "1+2", "５５５０１４２", "٥٥٥٠١٤٢", "5550142,1234", "5550142;1234"]) {
      expect(() => normalizeNumber(bad), bad).toThrow();
    }
  });

  it("cleanName strips control and bidi characters", () => {
    expect(cleanName("Dana‮ Lee\n")).toBe("Dana Lee");
    expect(cleanName("  A​  B ")).toBe("A B");
    expect(cleanName("x".repeat(200))).toHaveLength(80);
    expect(cleanName("Dana\u061c\u2066Lee")).toBe("DanaLee");
    expect(cleanName("(303) 555-0142")).toBe("");
    expect(cleanName("ë😀".repeat(50))).toBe("ë😀".repeat(40)); // no split surrogate pairs
  });
});

describe("only the commands route can queue commands (static)", () => {
  const SRC = path.resolve(__dirname, "../src");
  const ROUTE = path.join(SRC, "app/api/commands/route.ts");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });

  it("no other source file calls commands.enqueue", () => {
    const callers = walk(SRC).filter((f) => /\bcommands\s*\.\s*enqueue\b|\benqueue\s*\(/.test(readFileSync(f, "utf8")));
    expect(callers.map((f) => path.relative(SRC, f)).sort()).toEqual(["app/api/commands/route.ts", "lib/repos/commands.ts"]);
    expect(callers).toContain(ROUTE);
  });
});
