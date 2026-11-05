import { describe, expect, it } from "vitest";
import { setDeps } from "@/lib/deps";
import { recordLookup, resolveCallNumber, spokenNumbers, type LookedUpContacts } from "@/lib/commands/call";
import { CommandError, MAX_PENDING_PER_DEVICE } from "@/lib/commands";
import { invokeCapability } from "@/lib/connectors/invoke";
import { CapabilityDeniedError } from "@/lib/connectors/types";
import { executeTool, TOOL_NAMES } from "@/lib/assistant/tools";
import type { Contact, ContactLookup } from "@/lib/google/contacts";
import { CommandsResponseSchema, type DeviceCommand } from "@/lib/models";
import { makeDeps, msg, pairDevice, params, req, ScriptedLLM, toolUse } from "./fakes";
import { POST as ask } from "@/app/api/ask/route";
import { GET as listCommands } from "@/app/api/commands/route";

/**
 * Task layer slice 2b: "call Dana on my phone" said to the watch → /api/ask → call_on_phone →
 * a call_contact hand-off on the phone. The number may come only from a lookup_contact result in
 * the same request or digits the owner spoke in it (docs/CONNECTORS.md §2 `device.call`).
 */

const NOW = new Date("2026-10-28T15:00:00Z");

const person = (id: string, name: string, phones: string[], extra: Partial<Contact> = {}): Contact => ({
  id,
  name,
  emails: [],
  phones,
  source: "google",
  match: "exact",
  ...extra,
});
const DANA = person("people/c1", "Dana Kim", ["+13035550142"]);
const DANA_O = person("people/c2", "Dana Ortiz", ["+17205550199"]);

function seen(...lookups: ContactLookup[]): LookedUpContacts {
  const m: LookedUpContacts = new Map();
  for (const l of lookups) recordLookup(m, l);
  return m;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CommandError);
    return (e as CommandError).code ?? "";
  }
  throw new Error("expected a CommandError");
}

describe("spokenNumbers", () => {
  it("finds a number the owner said, joined across number punctuation", () => {
    expect(spokenNumbers("call 303 555 0142 on my phone")).toContain("3035550142");
    expect(spokenNumbers("call (303) 555-0142")).toContain("3035550142");
    expect(spokenNumbers("call 303.555.0142 please")).toContain("3035550142");
  });

  it("keeps a + only when the owner said it", () => {
    const s = spokenNumbers("call +1 303 555 0142 on WhatsApp");
    expect(s).toContain("+13035550142");
    expect(s).toContain("3035550142"); // national form: country code dropped
    expect(s).not.toContain("+3035550142");
    expect(spokenNumbers("call 1 303 555 0142")).toEqual(new Set(["13035550142"]));
  });

  it("only whole spans: two numbers said back to back are refused, never mashed or split", () => {
    const s = spokenNumbers("call 303 555 0142 720 555 0199");
    expect(s).toEqual(new Set()); // 20 digits: too long, the assistant asks
    expect(s).not.toContain("01427205550199");
    expect(spokenNumbers("call 303 555 0142 or 720 555 0199")).toEqual(new Set(["3035550142", "7205550199"]));
  });

  it("ISO dates are not numbers", () => {
    expect(spokenNumbers("call Dana on 2026-10-28")).toEqual(new Set());
    expect(spokenNumbers("on 2026-10-28 call 303 555 0142")).toEqual(new Set(["3035550142"]));
  });

  it("+CC (0): trunk prefix dropped in international form; national form kept", () => {
    const s = spokenNumbers("call +44 (0) 20 7946 0958");
    expect(s).toEqual(new Set(["+442079460958", "02079460958"]));
    expect(s).not.toContain("+4402079460958");
  });

  it("en and em dashes separate groups", () => {
    expect(spokenNumbers("call 303–555—0142")).toContain("3035550142");
  });

  it("never joins across words or cuts digits out of the middle of a group", () => {
    const s = spokenNumbers("call 303 or 720, the 2026 invoice 13035550142");
    expect(s).not.toContain("303720");
    expect(s).not.toContain("3035550142");
    expect(s).toContain("13035550142");
    expect(s).toContain("2026");
  });

  it("ignores runs under 3 or over 15 digits", () => {
    expect(spokenNumbers("call 12")).toEqual(new Set());
    expect([...spokenNumbers("1234567890123456")]).toEqual([]);
  });
});

describe("resolveCallNumber", () => {
  const owner = "call Dana on my phone";

  it("uses the clear match of a lookup in this request", () => {
    const r = resolveCallNumber({ contactId: "people/c1" }, { ownerText: owner, lookedUp: seen({ contacts: [DANA, DANA_O], ambiguous: false }) });
    expect(r).toEqual({ number: "+13035550142", name: "Dana Kim", via: "contact", contactId: "people/c1" });
  });

  it("refuses an id no lookup returned (e.g. one read in an email)", () => {
    expect(codeOf(() => resolveCallNumber({ contactId: "people/c9" }, { ownerText: owner, lookedUp: seen() }))).toBe("unknown_contact");
  });

  it("refuses any candidate of an ambiguous lookup, and the runner-up of a clear one", () => {
    const amb = seen({ contacts: [DANA, DANA_O], ambiguous: true });
    expect(codeOf(() => resolveCallNumber({ contactId: "people/c1" }, { ownerText: owner, lookedUp: amb }))).toBe("ambiguous_contact");
    const clear = seen({ contacts: [DANA, DANA_O], ambiguous: false });
    expect(codeOf(() => resolveCallNumber({ contactId: "people/c2" }, { ownerText: owner, lookedUp: clear }))).toBe("ambiguous_contact");
  });

  it("a later clear lookup makes the contact callable; an ambiguous one never revokes that", () => {
    const m = seen({ contacts: [DANA, DANA_O], ambiguous: true }, { contacts: [DANA_O], ambiguous: false }, { contacts: [DANA_O, DANA], ambiguous: true });
    expect(resolveCallNumber({ contactId: "people/c2" }, { ownerText: owner, lookedUp: m }).number).toBe("+17205550199");
  });

  it("needs a phone on the contact and, with several, the owner's pick from them", () => {
    const none = seen({ contacts: [person("people/c3", "Lee", [])], ambiguous: false });
    expect(codeOf(() => resolveCallNumber({ contactId: "people/c3" }, { ownerText: owner, lookedUp: none }))).toBe("no_phone");

    const two = seen({ contacts: [person("people/c4", "Sam", ["+13035550100", "+13035550101"])], ambiguous: false });
    expect(codeOf(() => resolveCallNumber({ contactId: "people/c4" }, { ownerText: owner, lookedUp: two }))).toBe("which_phone");
    expect(resolveCallNumber({ contactId: "people/c4", phone: "+1 303 555 0101" }, { ownerText: owner, lookedUp: two }).number).toBe("+13035550101");
    // A phone that isn't the contact's (from an email, say) is refused.
    expect(codeOf(() => resolveCallNumber({ contactId: "people/c4", phone: "+19005550199" }, { ownerText: owner, lookedUp: two }))).toBe(
      "phone_not_on_contact",
    );
    // Same for a single-phone contact: a different phone is refused, not swapped in.
    const one = seen({ contacts: [DANA], ambiguous: false });
    expect(codeOf(() => resolveCallNumber({ contactId: "people/c1", phone: "+19005550199" }, { ownerText: owner, lookedUp: one }))).toBe(
      "phone_not_on_contact",
    );
  });

  it("refuses a Google 'Other contact' (auto-saved from email), even as a clear match", () => {
    const other = seen({ contacts: [person("otherContacts/c5", "Dana Bank", ["+19005550199"], { source: "google_other" })], ambiguous: false });
    expect(codeOf(() => resolveCallNumber({ contactId: "otherContacts/c5" }, { ownerText: owner, lookedUp: other }))).toBe("not_saved_contact");
  });

  it("an international number with a (0) trunk prefix resolves to the dialable form", () => {
    const lookedUp = seen();
    const ownerText = "call +44 (0) 20 7946 0958 on WhatsApp";
    expect(resolveCallNumber({ spokenNumber: "+44 20 7946 0958" }, { ownerText, lookedUp }).number).toBe("+442079460958");
    expect(codeOf(() => resolveCallNumber({ spokenNumber: "+4402079460958" }, { ownerText, lookedUp }))).toBe("number_not_spoken");
  });

  it("accepts spoken digits only when they are in the owner's words", () => {
    const lookedUp = seen();
    expect(resolveCallNumber({ spokenNumber: "303-555-0142" }, { ownerText: "call 303 555 0142 on my phone", lookedUp })).toEqual({
      number: "3035550142",
      via: "spoken",
    });
    // The owner said "+1": the model dropping the + still gets the owner's form.
    expect(resolveCallNumber({ spokenNumber: "13035550142" }, { ownerText: "call +1 303 555 0142", lookedUp }).number).toBe("+13035550142");
    // The model adding a country code the owner didn't say is refused.
    expect(codeOf(() => resolveCallNumber({ spokenNumber: "+13035550142" }, { ownerText: "call 1 303 555 0142", lookedUp }))).toBe("number_not_spoken");
    expect(codeOf(() => resolveCallNumber({ spokenNumber: "+19005550199" }, { ownerText: "call the number in Dana's email", lookedUp }))).toBe(
      "number_not_spoken",
    );
    expect(codeOf(() => resolveCallNumber({ spokenNumber: "*#06#" }, { ownerText: "call *#06#", lookedUp }))).toBe("bad_number");
  });
});

// ---------------------------------------------------------------------------------------
// Through /api/ask
// ---------------------------------------------------------------------------------------

type Step = Parameters<typeof ScriptedLLM.prototype.create>[0];

/** The tool_result contents the brain sent back in this model call (i.e. results of the previous step). */
function results(p: Step): { content: string; is_error?: boolean }[] {
  const last = p.messages[p.messages.length - 1]!;
  return (Array.isArray(last.content) ? last.content : []).filter((b) => b.type === "tool_result") as { content: string; is_error?: boolean }[];
}

async function setup(script: ((p: Step) => ReturnType<typeof msg>)[], opts: { phone?: boolean } = {}) {
  const llm = new ScriptedLLM(script.map((f) => (p: Step) => f(p)));
  const deps = makeDeps({ llm, now: NOW });
  setDeps(deps);
  const watch = await pairDevice(deps, "watch");
  const phone = opts.phone === false ? undefined : await pairDevice(deps, "phone");
  return { llm, deps, watch, phone };
}

async function askAs(token: string, text: string, device = "watch") {
  const res = await ask(req("POST", "/api/ask", { token, body: { text, device } }), params({}));
  expect(res.status).toBe(200);
  return (await res.json()) as { reply: string; actions: unknown[] };
}

async function onPhone(token: string): Promise<DeviceCommand[]> {
  const res = await listCommands(req("GET", "/api/commands", { token }), params({}));
  return CommandsResponseSchema.parse(await res.json()).items;
}

const respond = () => msg([toolUse("respond", { reply: "ok", spoken: "ok" })]);

describe("call_on_phone via /api/ask", () => {
  it("is offered to Claude", () => {
    expect(TOOL_NAMES).toContain("call_on_phone");
  });

  it("watch: 'call Dana on my phone' queues a tap-to-dial hand-off on the phone, audited, with no new action type", async () => {
    const { deps, watch, phone, llm } = await setup([
      () => msg([toolUse("lookup_contact", { name: "Dana" })]),
      () => msg([toolUse("call_on_phone", { contactId: "people/c1" })]),
      respond,
    ]);
    deps.contacts.result = { contacts: [DANA], ambiguous: false };
    const body = await askAs(watch.token, "Call Dana on my phone");
    expect(body.actions).toEqual([]); // CONNECTORS.md §4.3: no hand-off Action type yet

    const out = JSON.parse(results(llm.calls[2]!)[0]!.content);
    expect(out).toMatchObject({ queued: true, number: "+13035550142", label: "Call Dana Kim (+13035550142)" });
    expect(out.note).toMatch(/Nothing was dialled/);

    const items = await onPhone(phone!.token);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "call_contact", number: "+13035550142", name: "Dana Kim", app: "phone", from: "watch" });
    const row = await deps.repos.commands.get(items[0]!.id);
    expect(row?.fromDeviceId).toBe(watch.device.id);

    const audit = (await deps.repos.audit.recent()).find((a) => a.capability === "device.call");
    expect(audit).toMatchObject({ connector: "device", tier: "user_finishes", caller: "ask", device: "watch", ok: true });
    expect(audit?.summary).toBe("hand-off to phone: contact people/c1");
  });

  it("the hand-off's origin is the authenticated device, not the body's device field", async () => {
    const { deps, phone, llm } = await setup([() => msg([toolUse("call_on_phone", { spokenNumber: "303 555 0142" })]), respond]);
    await askAs(phone!.token, "call 303 555 0142", "watch");
    expect(results(llm.calls[1]!)[0]).not.toMatchObject({ is_error: true });
    const [c] = await onPhone(phone!.token);
    expect(c).toMatchObject({ from: "phone" });
    expect((await deps.repos.audit.recent()).find((a) => a.capability === "device.call")?.device).toBe("phone");
  });

  it("a number injected via email text can't reach the phone (spokenNumber or a made-up contact id)", async () => {
    const { deps, watch, phone, llm } = await setup([
      () => msg([toolUse("search_gmail", { query: "from:dana" })]),
      () => msg([toolUse("call_on_phone", { spokenNumber: "+1 900 555 0199" })]),
      () => msg([toolUse("call_on_phone", { contactId: "people/attacker" })]),
      () => msg([toolUse("call_on_phone", { contactId: "people/c1", phone: "+1 900 555 0199" })]),
      respond,
    ]);
    deps.contacts.result = { contacts: [DANA], ambiguous: false };
    await askAs(watch.token, "Call Dana back about her email");
    expect(results(llm.calls[2]!)[0]).toMatchObject({ is_error: true });
    expect(results(llm.calls[2]!)[0]!.content).toMatch(/isn't in what the owner said/);
    expect(results(llm.calls[3]!)[0]!.content).toMatch(/Unknown contactId/);
    expect(results(llm.calls[4]!)[0]!.content).toMatch(/Unknown contactId/); // no lookup in this request
    expect(await onPhone(phone!.token)).toEqual([]);

    // Every refusal leaves a trace in the audit log, and the injected number is never written there.
    const rows = (await deps.repos.audit.recent()).filter((a) => a.capability === "device.call");
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.ok === false && r.tier === "user_finishes" && r.caller === "ask")).toBe(true);
    expect(rows.map((r) => r.error?.split(":")[0]).sort()).toEqual(["number_not_spoken", "unknown_contact", "unknown_contact"]);
    expect(rows.map((r) => r.summary).sort()).toEqual([
      "hand-off to phone: contact people/attacker",
      "hand-off to phone: contact people/c1",
      "hand-off to phone: spoken number",
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/900|0199/);
  });

  it("a failed enqueue (queue full) is audited as failed and nothing more is queued", async () => {
    const { deps, watch, phone, llm } = await setup([() => msg([toolUse("call_on_phone", { spokenNumber: "303 555 0142" })]), respond]);
    for (let i = 0; i < MAX_PENDING_PER_DEVICE; i++) {
      await deps.repos.commands.enqueue({ kind: "reachy_wake", activity: "chat", label: "x" }, { id: watch.device.id, kind: "watch" }, phone!.device.id);
    }
    await askAs(watch.token, "call 303 555 0142");
    expect(results(llm.calls[1]!)[0]!.content).toMatch(/too many commands/);
    const [row] = (await deps.repos.audit.recent()).filter((a) => a.capability === "device.call");
    expect(row).toMatchObject({ ok: false, summary: "hand-off to phone: spoken number" });
    expect(row?.error).toMatch(/^queue_full/);
    expect((await onPhone(phone!.token)).filter((c) => c.kind === "call_contact")).toEqual([]);
  });

  it("ambiguous lookup → refused, nothing queued; the model must ask", async () => {
    const { deps, watch, phone, llm } = await setup([
      () => msg([toolUse("lookup_contact", { name: "Dana" })]),
      () => msg([toolUse("call_on_phone", { contactId: "people/c1" })]),
      respond,
    ]);
    deps.contacts.result = { contacts: [DANA, DANA_O], ambiguous: true };
    await askAs(watch.token, "Call Dana on my phone");
    expect(results(llm.calls[2]!)[0]).toMatchObject({ is_error: true });
    expect(results(llm.calls[2]!)[0]!.content).toMatch(/Ask the owner which one/);
    expect(await onPhone(phone!.token)).toEqual([]);
  });

  it("lookups don't carry over from an earlier request", async () => {
    const { deps, watch, phone, llm } = await setup([
      () => msg([toolUse("lookup_contact", { name: "Dana" })]),
      respond,
      () => msg([toolUse("call_on_phone", { contactId: "people/c1" })]),
      respond,
    ]);
    deps.contacts.result = { contacts: [DANA], ambiguous: false };
    await askAs(watch.token, "Who is Dana?");
    await askAs(watch.token, "Call her on my phone");
    expect(results(llm.calls[3]!)[0]!.content).toMatch(/Unknown contactId/);
    expect(await onPhone(phone!.token)).toEqual([]);
  });

  it("digits the owner spoke are queued; only one call per request", async () => {
    const { watch, phone, llm } = await setup([
      () => msg([toolUse("call_on_phone", { spokenNumber: "303 555 0142" })]),
      () => msg([toolUse("call_on_phone", { spokenNumber: "303 555 0142" })]),
      respond,
    ]);
    await askAs(watch.token, "Call 303 555 0142 on my phone");
    expect(results(llm.calls[2]!)[0]!.content).toMatch(/already waiting/);
    const items = await onPhone(phone!.token);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ number: "3035550142", label: "Call 3035550142" });
    expect(items[0]).not.toHaveProperty("name");
  });

  it("WhatsApp needs the owner to have said an international number", async () => {
    const { deps, watch, phone, llm } = await setup([
      () => msg([toolUse("call_on_phone", { spokenNumber: "303 555 0142", app: "whatsapp" })]),
      respond,
    ]);
    await askAs(watch.token, "WhatsApp call 303 555 0142");
    expect(results(llm.calls[1]!)[0]).toMatchObject({ is_error: true });
    expect(results(llm.calls[1]!)[0]!.content).toMatch(/WhatsApp needs an international number/);
    expect(await onPhone(phone!.token)).toEqual([]);
    const [row] = (await deps.repos.audit.recent()).filter((a) => a.capability === "device.call");
    expect(row).toMatchObject({ ok: false });
    expect(row?.error).toMatch(/^bad_number/);
  });

  it("no paired phone → a plain error the model can relay", async () => {
    const { deps, watch, llm } = await setup(
      [() => msg([toolUse("call_on_phone", { spokenNumber: "303 555 0142" })]), respond],
      { phone: false },
    );
    await askAs(watch.token, "call 303 555 0142");
    expect(results(llm.calls[1]!)[0]).toMatchObject({ is_error: true });
    expect(results(llm.calls[1]!)[0]!.content).toMatch(/no paired phone/);
    const [row] = (await deps.repos.audit.recent()).filter((a) => a.capability === "device.call");
    expect(row).toMatchObject({ ok: false });
    expect(row?.error).toMatch(/^no_target_device/);
  });

  it("rejects malformed input before anything else", async () => {
    const deps = makeDeps({ now: NOW });
    const ctx = { deps, now: NOW, device: "watch" as const, actions: [], request: { text: "call 303 555 0142", deviceId: "d", deviceKind: "watch" as const }, lookedUp: new Map() };
    for (const bad of [{}, { contactId: "people/c1", spokenNumber: "3035550142" }, { spokenNumber: "3035550142", phone: "3035550142" }]) {
      const r = await executeTool("call_on_phone", bad, ctx);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/Invalid input/);
    }
  });

  it("invokeCapability('device.call') still fails closed and points at call_on_phone", async () => {
    const deps = makeDeps({ now: NOW });
    await expect(invokeCapability(deps, "device.call", { spokenNumber: "3035550142" }, { caller: "ask" })).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(invokeCapability(deps, "device.call", {}, { caller: "ask" })).rejects.toThrow(/call_on_phone/);
  });

  it("refuses outside an owner request (no request context, e.g. a future background caller)", async () => {
    const deps = makeDeps({ now: NOW });
    await pairDevice(deps, "phone");
    const r = await executeTool("call_on_phone", { spokenNumber: "3035550142" }, { deps, now: NOW, device: "watch", actions: [] });
    expect(r).toMatchObject({ isError: true });
    expect(r.content).toMatch(/only be handed off from an owner request/);
  });
});
