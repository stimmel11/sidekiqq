import { describe, expect, it } from "vitest";
import { setDeps } from "@/lib/deps";
import { authenticateDevice, isOwnerSecret, requireCron } from "@/lib/auth";
import { HttpError } from "@/lib/http";
import { makeDeps, pairDevice, req, params } from "./fakes";
import { GET as getCommitments } from "@/app/api/commitments/route";
import { POST as pairCode } from "@/app/api/devices/pair-code/route";
import { POST as pair } from "@/app/api/devices/pair/route";
import { POST as register } from "@/app/api/devices/register/route";
import { POST as complete } from "@/app/api/commitments/[id]/complete/route";
import { GET as scan } from "@/app/api/cron/scan/route";

describe("device bearer auth", () => {
  it("accepts a paired device token and rejects missing/unknown/revoked tokens", async () => {
    const deps = makeDeps();
    const { token, device } = await pairDevice(deps);

    await expect(authenticateDevice(req("GET", "/api/top5", { token }), deps)).resolves.toMatchObject({ id: device.id });
    await expect(authenticateDevice(req("GET", "/api/top5"), deps)).rejects.toMatchObject({ status: 401 });
    await expect(authenticateDevice(req("GET", "/api/top5", { token: "skq_nope" }), deps)).rejects.toBeInstanceOf(HttpError);

    await deps.repos.devices.revoke(device.id);
    await expect(authenticateDevice(req("GET", "/api/top5", { token }), deps)).rejects.toMatchObject({ status: 401 });
  });

  it("never stores the plaintext token", async () => {
    const deps = makeDeps();
    const { token } = await pairDevice(deps);
    const dump = JSON.stringify(await Promise.all(deps.kv.keys().map(async (k) => [k, await deps.kv.get(k), await deps.kv.hgetall(k)])));
    expect(dump).not.toContain(token);
  });

  it("protects routes: 401 without token, 200 with token", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const { token } = await pairDevice(deps);
    expect((await getCommitments(req("GET", "/api/commitments"), params({}))).status).toBe(401);
    const ok = await getCommitments(req("GET", "/api/commitments?status=all", { token }), params({}));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ items: [] });
  });

  it("validates query parameters", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const { token } = await pairDevice(deps);
    expect((await getCommitments(req("GET", "/api/commitments?status=bogus", { token }), params({}))).status).toBe(400);
  });

  it("returns 404 for completing an unknown commitment", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const { token } = await pairDevice(deps);
    const res = await complete(req("POST", "/api/commitments/x/complete", { token }), params({ id: "cmt_missing" }));
    expect(res.status).toBe(404);
  });
});

describe("owner secret + pairing flow", () => {
  it("compares the owner secret in constant time semantics", () => {
    expect(isOwnerSecret("test-owner-secret-0123456789")).toBe(true);
    expect(isOwnerSecret("test-owner-secret-012345678")).toBe(false);
    expect(isOwnerSecret(null)).toBe(false);
  });

  it("pair-code requires OWNER_SECRET; code pairs exactly once; token then works", async () => {
    const deps = makeDeps();
    setDeps(deps);

    expect((await pairCode(req("POST", "/api/devices/pair-code"))).status).toBe(401);
    expect((await pairCode(req("POST", "/api/devices/pair-code", { token: "wrong-secret-wrong-secret" }))).status).toBe(401);

    const codeRes = await pairCode(req("POST", "/api/devices/pair-code", { headers: { "x-owner-secret": "test-owner-secret-0123456789" }, body: { label: "Galaxy Watch" } }));
    expect(codeRes.status).toBe(200);
    const { code } = (await codeRes.json()) as { code: string };
    expect(code).toMatch(/^\d{6}$/);

    const first = await pair(req("POST", "/api/devices/pair", { body: { code, device: "watch" } }));
    expect(first.status).toBe(200);
    const { token, deviceId } = (await first.json()) as { token: string; deviceId: string };
    expect(token).toMatch(/^skq_/);
    expect((await deps.repos.devices.get(deviceId))?.name).toBe("Galaxy Watch");

    const second = await pair(req("POST", "/api/devices/pair", { body: { code, device: "watch" } }));
    expect(second.status).toBe(401);

    const reg = await register(req("POST", "/api/devices/register", { token, body: { fcmToken: "fcm-abc", device: "watch" } }), params({}));
    expect(reg.status).toBe(200);
    expect(await deps.repos.devices.pushTokens()).toEqual(["fcm-abc"]);
  });

  it("pairing codes expire", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const { code } = await deps.repos.pairing.issue(600);
    deps.setNow(new Date(deps.clock().getTime() + 601_000));
    const res = await pair(req("POST", "/api/devices/pair", { body: { code, device: "phone" } }));
    expect(res.status).toBe(401);
  });

  it("rate-limits pairing attempts per IP", async () => {
    const deps = makeDeps();
    setDeps(deps);
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await pair(req("POST", "/api/devices/pair", { body: { code: "000000", device: "phone" }, headers: { "x-forwarded-for": "9.9.9.9" } }))).status;
    }
    expect(last).toBe(429);
  });
});

describe("cron guard", () => {
  it("requires CRON_SECRET", async () => {
    expect(() => requireCron(req("GET", "/api/cron/scan"))).toThrow(HttpError);
    expect(() => requireCron(req("GET", "/api/cron/scan", { token: "test-cron-secret" }))).not.toThrow();
    setDeps(makeDeps());
    expect((await scan(req("GET", "/api/cron/scan", { token: "nope" }))).status).toBe(401);
  });
});
