import { describe, expect, it } from "vitest";
import { countSentences, enforceSpoken, MAX_SPOKEN_CHARS, splitSentences, stripForSpeech } from "@/lib/assistant/spoken";

describe("spoken reply guard", () => {
  it("keeps compliant replies unchanged", () => {
    expect(enforceSpoken("You have three open commitments. The ACME proposal is overdue.")).toBe(
      "You have three open commitments. The ACME proposal is overdue.",
    );
  });

  it("truncates to at most two sentences", () => {
    const out = enforceSpoken("One. Two! Three? Four.");
    expect(out).toBe("One. Two!");
    expect(countSentences(out)).toBeLessThanOrEqual(2);
  });

  it("does not split on abbreviations or decimals", () => {
    expect(splitSentences("Call Dr. Smith at 3.30 p.m. today. Then email Mr. Jones.")).toEqual([
      "Call Dr. Smith at 3.30 p.m. today.",
      "Then email Mr. Jones.",
    ]);
  });

  it("strips markdown, lists, links, urls and internal ids", () => {
    const s = stripForSpeech("## Status\n- **ACME** is [waiting](https://x.y) on `cmt_abc123`\n- see https://example.com");
    expect(s).not.toMatch(/[#*`\[\]]|https?:|cmt_/);
    expect(s).toContain("ACME is waiting on");
  });

  it("falls back to reply when spoken is empty and never returns empty", () => {
    expect(enforceSpoken("", "**Done.** Draft created for Dana. More detail here. And more.")).toBe("Done. Draft created for Dana.");
    expect(enforceSpoken(undefined, undefined)).toBe("Done.");
    expect(enforceSpoken("   ", "")).toBe("Done.");
  });

  it("enforces a character budget even for one very long sentence", () => {
    const long = `${"word ".repeat(200)}end.`;
    const out = enforceSpoken(long);
    expect(out.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });

  it("drops to one sentence if two exceed the budget", () => {
    const a = `${"a".repeat(150)}.`;
    const b = `${"b".repeat(150)}.`;
    expect(enforceSpoken(`${a} ${b}`)).toBe(a);
  });

  it("property: output always <= 2 sentences and <= budget", () => {
    const samples = [
      "Hi.",
      "1. First\n2. Second\n3. Third",
      "A! B? C. D.",
      "No punctuation at all just words",
      "Mixed: *one*. _two_. three. four.",
      "e.g. this is fine. i.e. also fine. third one.",
    ];
    for (const s of samples) {
      const out = enforceSpoken(s);
      expect(out.length).toBeGreaterThan(0);
      expect(out.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
      expect(countSentences(out)).toBeLessThanOrEqual(2);
    }
  });
});
