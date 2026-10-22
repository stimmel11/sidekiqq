import { describe, expect, it } from "vitest";
import { normalizeDue, parseCommitment, parseExtraction } from "@/lib/scan/extract";

describe("commitment extraction parsing", () => {
  it("parses a well-formed extraction", () => {
    const x = parseExtraction({
      summary: "Dana says ACME will send the deposit by Friday.",
      categories: ["Payment", "Existing Client"],
      importance: "HIGH",
      client: "ACME",
      people: ["Dana Lee"],
      commitments: [{ who: "Dana Lee", what: "Send deposit", dueAt: "2026-10-23", dueInferred: false, confidence: "CONFIRMED" }],
      decisions: [{ what: "Proceed with phase 1", people: ["Dana Lee", "Stimmel"], confidence: "CONFIRMED" }],
      followups: [],
      alert: "ACME deposit promised by Friday.",
    });
    expect(x.importance).toBe("HIGH");
    expect(x.categories).toEqual(["Payment", "Existing Client"]);
    expect(x.commitments).toEqual([{ who: "Dana Lee", what: "Send deposit", dueAt: "2026-10-23T23:59:00.000Z", dueInferred: false, confidence: "CONFIRMED" }]);
    expect(x.decisions[0]?.people).toEqual(["Dana Lee", "Stimmel"]);
  });

  it("normalises casing, drops unknown categories to FYI and bad items", () => {
    const x = parseExtraction({
      summary: "x",
      categories: ["payment", "NotACategory"],
      importance: "critical",
      commitments: [{ who: "", what: "nothing" }, { who: "Stimmel", what: "Call back", confidence: "inferred" }, "garbage"],
      followups: [{ person: "Sam", reason: "Asked twice", importance: "urgent!!" }, { person: "No reason" }],
      decisions: [{ people: ["x"] }],
      client: "N/A",
    });
    expect(x.importance).toBe("CRITICAL");
    expect(x.categories).toEqual(["Payment", "FYI"]);
    expect(x.commitments).toEqual([{ who: "Stimmel", what: "Call back", dueInferred: false, confidence: "INFERRED" }]);
    expect(x.followups).toEqual([{ person: "Sam", reason: "Asked twice", importance: "MEDIUM" }]);
    expect(x.decisions).toEqual([]);
    expect(x.client).toBeUndefined();
  });

  it("is total: garbage input yields a safe empty extraction", () => {
    for (const junk of [null, undefined, 42, "text", [], { importance: 5 }]) {
      const x = parseExtraction(junk);
      expect(x.importance).toBe("LOW");
      expect(x.categories).toEqual(["FYI"]);
      expect(x.commitments).toEqual([]);
    }
  });

  it("labels confidence conservatively and handles dueInferred", () => {
    // Missing confidence → LIKELY (never silently CONFIRMED)
    expect(parseCommitment({ who: "A", what: "B" })?.confidence).toBe("LIKELY");
    // Date present but flag missing → treated as inferred
    expect(parseCommitment({ who: "A", what: "B", dueAt: "2026-10-20", confidence: "CONFIRMED" })?.dueInferred).toBe(true);
    // Flag set but no usable date → no due date and not inferred
    expect(parseCommitment({ who: "A", what: "B", dueAt: "next week", dueInferred: true, confidence: "LIKELY" })).toEqual({ who: "A", what: "B", dueInferred: false, confidence: "LIKELY" });
    // String booleans accepted
    expect(parseCommitment({ who: "A", what: "B", dueAt: "2026-10-20T09:00:00-06:00", dueInferred: "false", confidence: "CONFIRMED" })?.dueInferred).toBe(false);
  });

  it("normalizeDue only accepts ISO dates", () => {
    expect(normalizeDue("2026-10-20")).toBe("2026-10-20T23:59:00.000Z");
    expect(normalizeDue("2026-10-20T09:00:00-06:00")).toBe("2026-10-20T15:00:00.000Z");
    expect(normalizeDue("Friday")).toBeUndefined();
    expect(normalizeDue("10/20/2026")).toBeUndefined();
    expect(normalizeDue("")).toBeUndefined();
  });
});
