import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { people_v1 } from "googleapis";
import {
  cleanEmail,
  cleanPhone,
  cleanText,
  ContactQueryError,
  ContactsAccessError,
  GoogleContacts,
  isAmbiguous,
  normalizeName,
  parseContactQuery,
  scoreName,
  type PeopleApi,
} from "@/lib/google/contacts";
import { GOOGLE_SCOPES } from "@/lib/google/auth";

type Call = { kind: "saved" | "other"; query: string; readMask: string; pageSize: number };

function person(
  resourceName: string,
  name: string | undefined,
  emails: string[] = [],
  phones: { value?: string; canonicalForm?: string }[] = [],
  org?: string,
): people_v1.Schema$Person {
  return {
    resourceName,
    ...(name ? { names: [{ displayName: name, givenName: name.split(" ")[0], familyName: name.split(" ").slice(1).join(" ") || undefined, metadata: { primary: true } }] } : {}),
    emailAddresses: emails.map((value) => ({ value })),
    phoneNumbers: phones,
    ...(org ? { organizations: [{ name: org }] } : {}),
  };
}

class FakePeople implements PeopleApi {
  calls: Call[] = [];
  savedErr: unknown;
  otherErr: unknown;
  constructor(
    private saved: people_v1.Schema$Person[] = [],
    private other: people_v1.Schema$Person[] = [],
  ) {}
  async searchContacts(p: { query: string; readMask: string; pageSize: number }) {
    this.calls.push({ kind: "saved", ...p });
    if (p.query && this.savedErr) throw this.savedErr;
    return { data: { results: p.query ? this.saved.map((person) => ({ person })) : [] } };
  }
  async searchOtherContacts(p: { query: string; readMask: string; pageSize: number }) {
    this.calls.push({ kind: "other", ...p });
    if (p.query && this.otherErr) throw this.otherErr;
    return { data: { results: p.query ? this.other.map((person) => ({ person })) : [] } };
  }
}

describe("contacts.lookup query validation", () => {
  it("accepts names with accents, apostrophes and hyphens", () => {
    expect(parseContactQuery({ name: "  Zoë  O'Neil-Park " })).toEqual({ name: "Zoë O'Neil-Park", max: 5 });
  });

  it.each(["", "   ", "dana@acme.com", "Dana 555", "Dana; DROP", "<Dana>", "x".repeat(81)])("rejects %j", (name) => {
    expect(() => parseContactQuery({ name })).toThrow(ContactQueryError);
  });

  it("strips bidi/control characters before validating", () => {
    expect(parseContactQuery({ name: "Da‮na\u0007" }).name).toBe("Da na");
  });

  it.each([0, 11, 2.5, -1])("rejects max=%s", (max) => {
    expect(() => parseContactQuery({ name: "Dana", max })).toThrow(ContactQueryError);
  });
});

describe("name matching", () => {
  it("normalises diacritics and punctuation", () => {
    expect(normalizeName("Zoë O’Neil")).toBe("zoe oneil");
  });

  it("scores exact > name > partial > other", () => {
    expect(scoreName("dana kim", "Dana Kim")).toBe("exact");
    expect(scoreName("Dana", "Dana Kim")).toBe("name");
    expect(scoreName("kim d", "Dana Kim")).toBe("name");
    expect(scoreName("dana smith", "Dana Kim")).toBe("partial");
    expect(scoreName("bob", "Dana Kim")).toBe("other");
  });

  it("does not let one name word satisfy two query words", () => {
    expect(scoreName("dan dana", "Dana Kim")).toBe("partial");
  });
});

describe("value cleaning", () => {
  it("validates emails", () => {
    expect(cleanEmail(" Dana@Acme.COM ")).toBe("dana@acme.com");
    expect(cleanEmail("Dana <dana@acme.com>")).toBeUndefined();
    expect(cleanEmail("dana@localhost")).toBeUndefined();
    expect(cleanEmail("a,b@acme.com")).toBeUndefined();
  });

  it("validates phones and rejects MMI/post-dial characters", () => {
    expect(cleanPhone({ canonicalForm: "+13035550100", value: "(303) 555-0100" })).toBe("+13035550100");
    expect(cleanPhone({ value: "(303) 555-0100" })).toBe("(303) 555-0100");
    expect(cleanPhone({ value: "*#06#" })).toBeUndefined();
    expect(cleanPhone({ value: "303-555-0100,,1234" })).toBeUndefined();
    expect(cleanPhone({ value: "call me" })).toBeUndefined();
    expect(cleanPhone({ value: "12" })).toBeUndefined();
    expect(cleanPhone({ value: "+1234567890123456" })).toBeUndefined();
  });

  it("strips control and bidi characters from text", () => {
    expect(cleanText("Dana‮ moc.evil\u0000 Kim")).toBe("Dana moc.evil Kim");
  });
});

describe("GoogleContacts.lookup", () => {
  it("warms up once with an empty query, then searches both sources", async () => {
    const api = new FakePeople([person("people/c1", "Dana Kim", ["dana@acme.com"])]);
    const c = new GoogleContacts(api);
    await c.lookup({ name: "Dana" });
    await c.lookup({ name: "Dana" });
    const warmups = api.calls.filter((x) => x.query === "");
    expect(warmups.map((x) => x.kind).sort()).toEqual(["other", "saved"]);
    const searches = api.calls.filter((x) => x.query === "Dana");
    expect(searches).toHaveLength(4);
    expect(searches.every((x) => x.pageSize === 30)).toBe(true);
    expect(searches.find((x) => x.kind === "other")!.readMask).not.toContain("organizations");
  });

  it("returns both Danas (ambiguity is returned, not resolved)", async () => {
    const api = new FakePeople([
      person("people/c1", "Dana Kim", ["dana.kim@acme.com"], [], "Acme"),
      person("people/c2", "Dana Ortiz", ["dana@ortiz.co"]),
    ]);
    const res = await new GoogleContacts(api).lookup({ name: "Dana" });
    expect(res.map((r) => r.name)).toEqual(["Dana Kim", "Dana Ortiz"]);
    expect(res[0]).toEqual({ id: "people/c1", name: "Dana Kim", emails: ["dana.kim@acme.com"], phones: [], org: "Acme", source: "google", match: "name" });
    expect(isAmbiguous(res)).toBe(true);
  });

  it("is not ambiguous when one result is a clearly better match", async () => {
    const api = new FakePeople([person("people/c2", "Dana Kimball", ["dk@x.com"]), person("people/c1", "Dana Kim", ["dana@acme.com"])]);
    const res = await new GoogleContacts(api).lookup({ name: "dana kim" });
    expect(res[0]!.name).toBe("Dana Kim");
    expect(res[0]!.match).toBe("exact");
    expect(isAmbiguous(res)).toBe(false);
  });

  it("ranks saved contacts above Other contacts at the same match level", async () => {
    const api = new FakePeople(
      [person("people/c1", "Dana Kim", ["dana@acme.com"])],
      [person("otherContacts/o1", "Dana Kim", ["dana-kim@evil.example"])],
    );
    const res = await new GoogleContacts(api).lookup({ name: "Dana Kim" });
    expect(res.map((r) => [r.source, r.emails[0]])).toEqual([
      ["google", "dana@acme.com"],
      ["google_other", "dana-kim@evil.example"],
    ]);
    // A lookalike from a stranger's display name forces the assistant to ask, never to pick.
    expect(isAmbiguous(res)).toBe(true);
  });

  it("drops an Other contact that duplicates a saved contact's address", async () => {
    const api = new FakePeople(
      [person("people/c1", "Dana Kim", ["dana@acme.com"])],
      [person("otherContacts/o1", "Dana K", ["DANA@acme.com"]), person("otherContacts/o2", "Dana Lee", ["dana@lee.io"])],
    );
    const res = await new GoogleContacts(api).lookup({ name: "Dana" });
    expect(res.map((r) => r.id)).toEqual(["people/c1", "otherContacts/o2"]);
  });

  it("drops contacts with no usable email or phone, and never invents an address", async () => {
    const api = new FakePeople([
      person("people/c1", "Dana NoInfo"),
      person("people/c2", "Dana Bad", ["not-an-email"], [{ value: "*21*" }]),
      person("people/c3", "Dana Phone", [], [{ value: "+1 303 555 0100" }]),
    ]);
    const res = await new GoogleContacts(api).lookup({ name: "Dana" });
    expect(res).toEqual([{ id: "people/c3", name: "Dana Phone", emails: [], phones: ["+1 303 555 0100"], source: "google", match: "name" }]);
  });

  it("falls back to the email when a contact has no name", async () => {
    const api = new FakePeople([], [person("otherContacts/o1", undefined, ["dana@acme.com"])]);
    const res = await new GoogleContacts(api).lookup({ name: "Dana" });
    expect(res[0]!.name).toBe("dana@acme.com");
  });

  it("cleans bidi tricks out of names", async () => {
    const api = new FakePeople([], [person("otherContacts/o1", "Dana‮moc.lca", ["x@evil.example"])]);
    const res = await new GoogleContacts(api).lookup({ name: "Dana" });
    expect(res[0]!.name).toBe("Dana moc.lca");
  });

  it("dedupes emails and phones and respects max", async () => {
    const many = Array.from({ length: 12 }, (_, i) => person(`people/c${i}`, `Dana ${String.fromCharCode(65 + i)}`, [`d${i}@x.com`, `D${i}@x.com`]));
    const res = await new GoogleContacts(new FakePeople(many)).lookup({ name: "Dana", max: 3 });
    expect(res).toHaveLength(3);
    expect(res[0]!.emails).toEqual(["d0@x.com"]);
  });

  it("throws ContactsAccessError when the contacts scope was never granted", async () => {
    const api = new FakePeople();
    api.savedErr = Object.assign(new Error("insufficient scopes"), { code: 403 });
    await expect(new GoogleContacts(api).lookup({ name: "Dana" })).rejects.toBeInstanceOf(ContactsAccessError);
  });

  it("still returns saved contacts when only Other contacts access is missing", async () => {
    const api = new FakePeople([person("people/c1", "Dana Kim", ["dana@acme.com"])]);
    api.otherErr = Object.assign(new Error("forbidden"), { response: { status: 403 } });
    const res = await new GoogleContacts(api).lookup({ name: "Dana" });
    expect(res.map((r) => r.id)).toEqual(["people/c1"]);
  });

  it("propagates non-access errors", async () => {
    const api = new FakePeople();
    api.otherErr = Object.assign(new Error("backend"), { code: 500 });
    await expect(new GoogleContacts(api).lookup({ name: "Dana" })).rejects.toThrow("backend");
  });

  it("validates before calling Google", async () => {
    const api = new FakePeople();
    await expect(new GoogleContacts(api).lookup({ name: "dana@acme.com" })).rejects.toBeInstanceOf(ContactQueryError);
    expect(api.calls).toHaveLength(0);
  });
});

describe("contacts safety", () => {
  it("requests only read-only contacts scopes", () => {
    const contactScopes = GOOGLE_SCOPES.filter((s) => s.includes("contacts"));
    expect(contactScopes).toEqual([
      "https://www.googleapis.com/auth/contacts.readonly",
      "https://www.googleapis.com/auth/contacts.other.readonly",
    ]);
  });

  it("the contacts module only calls the two search endpoints", () => {
    const src = readFileSync(join(__dirname, "../src/lib/google/contacts.ts"), "utf8");
    const calls = [...src.matchAll(/people\.(\w+)\.(\w+)\(/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(new Set(calls)).toEqual(new Set(["people.searchContacts", "otherContacts.search"]));
    expect(src).not.toMatch(/createContact|updateContact|deleteContact|batchCreate|batchUpdate|batchDelete|copyOtherContact/);
  });
});
