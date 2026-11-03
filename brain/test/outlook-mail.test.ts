import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanBody,
  cleanSearchQuery,
  formatAddress,
  isGraphUrl,
  labelsFor,
  OUTLOOK_READ_SCOPES,
  OutlookAccessError,
  OutlookAuthError,
  OutlookInputError,
  OutlookMail,
  OutlookNotFoundError,
  OutlookRateLimitError,
  OutlookUnavailableError,
  toMessage,
  type FetchLike,
  type GraphMessage,
} from "@/lib/microsoft/mail";

type Call = { url: URL; method: string; headers: Record<string, string>; redirect: string };
type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; raw?: string };

class FakeGraph {
  calls: Call[] = [];
  constructor(private readonly route: (url: URL) => Reply | Promise<Reply>) {}
  fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    this.calls.push({ url: u, method: init.method, headers: init.headers, redirect: init.redirect });
    const r = await this.route(u);
    const text = r.raw ?? JSON.stringify(r.body ?? {});
    return new Response(text, { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  };
}

class Tokens {
  n = 0;
  invalidated = 0;
  async accessToken() {
    return `tok${++this.n}`;
  }
  invalidate() {
    this.invalidated++;
  }
}

function gm(id: string, extra: Partial<GraphMessage> = {}): GraphMessage {
  return {
    id,
    conversationId: "conv1",
    subject: `Subject ${id}`,
    from: { emailAddress: { name: "Dana Kim", address: "Dana@Acme.com" } },
    toRecipients: [{ emailAddress: { name: "Chris", address: "chris@example.com" } }],
    receivedDateTime: "2026-10-30T15:00:00Z",
    bodyPreview: "preview",
    isRead: true,
    importance: "normal",
    ...extra,
  };
}

function mail(graph: FakeGraph, tokens = new Tokens(), timeoutMs?: number) {
  return new OutlookMail(tokens, { fetch: graph.fetch, ...(timeoutMs ? { timeoutMs } : {}) });
}

describe("OutlookMail.search", () => {
  it("runs a KQL $search with the selected fields, bearer token and plain-text bodies", async () => {
    const g = new FakeGraph(() => ({ body: { value: [gm("m1"), gm("m2", { isRead: false, importance: "high" })] } }));
    const out = await mail(g).search('from:dana "proposal"', 5);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: "m1",
      threadId: "conv1",
      from: "Dana Kim <dana@acme.com>",
      to: "Chris <chris@example.com>",
      subject: "Subject m1",
      date: "2026-10-30T15:00:00.000Z",
      snippet: "preview",
      labels: [],
    });
    expect(out[1]!.labels).toEqual(["UNREAD", "IMPORTANT"]);
    const c = g.calls[0]!;
    expect(c.url.origin + c.url.pathname).toBe("https://graph.microsoft.com/v1.0/me/messages");
    expect(c.url.searchParams.get("$search")).toBe('"from:dana proposal"');
    expect(c.url.searchParams.get("$top")).toBe("5");
    expect(c.url.searchParams.get("$select")).toContain("conversationId");
    expect(c.headers.Authorization).toBe("Bearer tok1");
    expect(c.headers.Prefer).toBe('outlook.body-content-type="text"');
    expect(c.redirect).toBe("error");
  });

  it("caps results at max and drops rows with unusable ids", async () => {
    const g = new FakeGraph(() => ({ body: { value: [gm("m1"), gm("bad id!"), gm("m3", { conversationId: undefined }), gm("m4"), gm("m5")] } }));
    const out = await mail(g).search("x", 2);
    expect(out.map((m) => m.id)).toEqual(["m1", "m4"]);
  });

  it("rejects empty, over-long and out-of-range input before calling Graph", async () => {
    const g = new FakeGraph(() => ({ body: { value: [] } }));
    const m = mail(g);
    await expect(m.search('  "" \\ ', 5)).rejects.toBeInstanceOf(OutlookInputError);
    await expect(m.search("a".repeat(501), 5)).rejects.toBeInstanceOf(OutlookInputError);
    await expect(m.search("x", 0)).rejects.toBeInstanceOf(OutlookInputError);
    await expect(m.search("x", 26)).rejects.toBeInstanceOf(OutlookInputError);
    await expect(m.search("x", 1.5)).rejects.toBeInstanceOf(OutlookInputError);
    expect(g.calls).toHaveLength(0);
  });
});

describe("OutlookMail.getMessage / getThread / account", () => {
  it("maps a full message: cc, Message-ID, References and the cleaned text body", async () => {
    const g = new FakeGraph(() => ({
      body: gm("AAMk+ab/c=", {
        ccRecipients: [{ emailAddress: { name: "Ops", address: "ops@acme.com" } }, { emailAddress: { address: "not-an-address" } }],
        internetMessageId: "<abc@acme.com>",
        internetMessageHeaders: [{ name: "References", value: "<x@acme.com> <y@acme.com>" }],
        body: { contentType: "text", content: "Hi Chris,\r\nCan you send pricing?\r\n\r\nFrom: Chris\r\nSent: Monday\r\nold quoted text" },
      }),
    }));
    const msg = await mail(g).getMessage("AAMk+ab/c=");
    expect(g.calls[0]!.url.pathname).toBe("/v1.0/me/messages/AAMk%2Bab%2Fc%3D");
    expect(msg.cc).toBe("Ops <ops@acme.com>");
    expect(msg.messageIdHeader).toBe("<abc@acme.com>");
    expect(msg.references).toBe("<x@acme.com> <y@acme.com>");
    expect(msg.body).toBe("Hi Chris,\nCan you send pricing?");
  });

  it("refuses ids that aren't Graph ids (no path or query injection)", async () => {
    const g = new FakeGraph(() => ({ body: {} }));
    const m = mail(g);
    for (const bad of ["../me/sendMail", "a?b=c", "a b", "", "x".repeat(600), "a'b"]) {
      await expect(m.getMessage(bad)).rejects.toBeInstanceOf(OutlookInputError);
      await expect(m.getThread(bad)).rejects.toBeInstanceOf(OutlookInputError);
    }
    expect(g.calls).toHaveLength(0);
  });

  it("returns a conversation oldest first and drops messages from other conversations", async () => {
    const g = new FakeGraph(() => ({
      body: {
        value: [
          gm("m2", { receivedDateTime: "2026-10-30T12:00:00Z" }),
          gm("m1", { receivedDateTime: "2026-10-29T12:00:00Z" }),
          gm("mX", { conversationId: "other" }),
        ],
      },
    }));
    const msgs = await mail(g).getThread("conv1");
    expect(msgs.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(g.calls[0]!.url.searchParams.get("$filter")).toBe("conversationId eq 'conv1'");
  });

  it("an empty conversation is not found", async () => {
    const g = new FakeGraph(() => ({ body: { value: [] } }));
    await expect(mail(g).getThread("conv1")).rejects.toBeInstanceOf(OutlookNotFoundError);
  });

  it("account prefers mail, falls back to userPrincipalName, and drops junk", async () => {
    expect(await mail(new FakeGraph(() => ({ body: { mail: "Chris@Contoso.com", userPrincipalName: "c@x.onmicrosoft.com" } }))).account()).toEqual({ email: "chris@contoso.com" });
    expect(await mail(new FakeGraph(() => ({ body: { mail: null, userPrincipalName: "c@x.onmicrosoft.com" } }))).account()).toEqual({ email: "c@x.onmicrosoft.com" });
    expect(await mail(new FakeGraph(() => ({ body: { mail: "nope" } }))).account()).toEqual({});
  });
});

describe("OutlookMail.listRecentIds", () => {
  it("lists Inbox and Sent Items since a date, merges newest first, dedupes and caps", async () => {
    const g = new FakeGraph((u) => {
      if (u.pathname.includes("/inbox/")) {
        if (u.searchParams.get("page") === "2") return { body: { value: [gm("i3", { receivedDateTime: "2026-10-30T09:00:00Z" })] } };
        return {
          body: {
            value: [gm("i1", { receivedDateTime: "2026-10-30T12:00:00Z" }), gm("dup", { receivedDateTime: "2026-10-30T10:00:00Z" })],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?page=2",
          },
        };
      }
      return { body: { value: [gm("s1", { receivedDateTime: undefined, sentDateTime: "2026-10-30T11:00:00Z" }), gm("dup", { sentDateTime: "2026-10-30T10:00:00Z" })] } };
    });
    const out = await mail(g).listRecentIds(new Date("2026-10-30T00:00:00Z"), 10);
    expect(out.map((r) => r.id)).toEqual(["i1", "s1", "dup", "i3"]);
    const inbox = g.calls.find((c) => c.url.pathname === "/v1.0/me/mailFolders/inbox/messages" && !c.url.searchParams.get("page"))!;
    expect(inbox.url.searchParams.get("$filter")).toBe("receivedDateTime ge 2026-10-30T00:00:00.000Z");
    expect(inbox.url.searchParams.get("$orderby")).toBe("receivedDateTime desc");
    const sent = g.calls.find((c) => c.url.pathname === "/v1.0/me/mailFolders/sentitems/messages")!;
    expect(sent.url.searchParams.get("$filter")).toBe("sentDateTime ge 2026-10-30T00:00:00.000Z");
    expect((await mail(g).listRecentIds(new Date("2026-10-30T00:00:00Z"), 2)).map((r) => r.id)).toEqual(["i1", "s1"]);
  });

  it("never follows a nextLink off Graph or outside /me", async () => {
    for (const next of ["https://evil.example/v1.0/me/messages", "https://graph.microsoft.com/beta/me/messages", "https://graph.microsoft.com/v1.0/users/x/messages", "http://graph.microsoft.com/v1.0/me/messages"]) {
      const g = new FakeGraph((u) => (u.pathname.includes("/inbox/") ? { body: { value: [gm("i1")], "@odata.nextLink": next } } : { body: { value: [] } }));
      expect((await mail(g).listRecentIds(new Date("2026-10-01"), 10)).map((r) => r.id)).toEqual(["i1"]);
      expect(g.calls).toHaveLength(2);
    }
  });

  it("stops following pages after 20 even if Graph keeps linking", async () => {
    let n = 0;
    const g = new FakeGraph((u) => (u.pathname.includes("/inbox/") ? { body: { value: [gm(`i${n++}`)], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?more=1" } } : { body: { value: [] } }));
    const out = await mail(g).listRecentIds(new Date("2026-10-01"), 500);
    expect(out).toHaveLength(20);
  });

  it("rejects a bad date or max", async () => {
    const g = new FakeGraph(() => ({ body: { value: [] } }));
    await expect(mail(g).listRecentIds(new Date("nope"), 10)).rejects.toBeInstanceOf(OutlookInputError);
    await expect(mail(g).listRecentIds(new Date(), 501)).rejects.toBeInstanceOf(OutlookInputError);
  });
});

describe("errors", () => {
  it("401 drops the cached token and retries once; a second 401 is an auth error", async () => {
    const tokens = new Tokens();
    let n = 0;
    const g = new FakeGraph(() => (n++ === 0 ? { status: 401 } : { body: { value: [gm("m1")] } }));
    expect(await mail(g, tokens).search("x", 1)).toHaveLength(1);
    expect(tokens.invalidated).toBe(1);
    expect(g.calls.map((c) => c.headers.Authorization)).toEqual(["Bearer tok1", "Bearer tok2"]);

    const always = new FakeGraph(() => ({ status: 401 }));
    await expect(mail(always).search("x", 1)).rejects.toBeInstanceOf(OutlookAuthError);
    expect(always.calls).toHaveLength(2);
  });

  it("maps 403, 404, 429 (with Retry-After), 400 and 5xx", async () => {
    await expect(mail(new FakeGraph(() => ({ status: 403 }))).search("x", 1)).rejects.toBeInstanceOf(OutlookAccessError);
    await expect(mail(new FakeGraph(() => ({ status: 404 }))).getMessage("m1")).rejects.toBeInstanceOf(OutlookNotFoundError);
    const rl = await mail(new FakeGraph(() => ({ status: 429, headers: { "retry-after": "7" } }))).search("x", 1).catch((e: unknown) => e);
    expect(rl).toBeInstanceOf(OutlookRateLimitError);
    expect((rl as OutlookRateLimitError).retryAfterSec).toBe(7);
    await expect(mail(new FakeGraph(() => ({ status: 400 }))).search("x", 1)).rejects.toBeInstanceOf(OutlookInputError);
    await expect(mail(new FakeGraph(() => ({ status: 502 }))).search("x", 1)).rejects.toBeInstanceOf(OutlookUnavailableError);
    await expect(mail(new FakeGraph(() => ({ raw: "not json" }))).search("x", 1)).rejects.toBeInstanceOf(OutlookUnavailableError);
  });

  it("times out, maps network errors and refuses oversized replies", async () => {
    const slow: FetchLike = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    await expect(new OutlookMail(new Tokens(), { fetch: slow, timeoutMs: 20 }).search("x", 1)).rejects.toThrow(/timed out/);
    const down: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(new OutlookMail(new Tokens(), { fetch: down }).search("x", 1)).rejects.toThrow(/network error/);
    const big = new FakeGraph(() => ({ raw: "x".repeat(4_000_001) }));
    await expect(mail(big).search("x", 1)).rejects.toThrow(/too large/);
  });
});

describe("cleaning third-party text", () => {
  it("strips bidi and control characters from names, subjects and bodies", () => {
    const m = toMessage(
      gm("m1", {
        from: { emailAddress: { name: "Dana‮ <evil@x.com>", address: "dana@acme.com" } },
        subject: "Pay\u0000ment​ due",
        body: { contentType: "text", content: "Line‮one\nLine two" },
      }),
    );
    expect(m.from).toBe("Dana evil@x.com <dana@acme.com>");
    expect(m.subject).toBe("Pay ment due");
    expect(m.body).toBe("Line one\nLine two");
  });

  it("formats addresses without duplicate names and drops invalid ones", () => {
    expect(formatAddress({ emailAddress: { name: "dana@acme.com", address: "dana@acme.com" } })).toBe("dana@acme.com");
    expect(formatAddress({ emailAddress: { name: "Dana", address: "bad address" } })).toBe("");
    expect(formatAddress(null)).toBe("");
  });

  it("strips HTML when Graph ignores the text Prefer header, and caps the body", () => {
    expect(cleanBody({ body: { contentType: "html", content: "<p>Hello&nbsp;<b>there</b></p><script>x()</script>" } })).toBe("Hello there");
    expect(cleanBody({ body: { contentType: "text", content: "a".repeat(9000) } }).length).toBeLessThanOrEqual(8000);
    expect(cleanBody({ body: { contentType: "text", content: "New\n\nOn Mon, Dana wrote:\n> old" } })).toBe("New");
  });

  it("labels follow Gmail names", () => {
    expect(labelsFor({ isRead: false, importance: "high", flag: { flagStatus: "flagged" }, isDraft: true })).toEqual(["UNREAD", "IMPORTANT", "STARRED", "DRAFT"]);
    expect(labelsFor({ isRead: true, importance: "low" })).toEqual([]);
  });

  it("search queries lose quotes and backslashes", () => {
    expect(cleanSearchQuery('subject:"q3 \\ plan"')).toBe("subject: q3 plan");
  });
});

describe("read-only safety", () => {
  it("every request in this file's tests is a GET on graph.microsoft.com/v1.0/me", async () => {
    const g = new FakeGraph((u) => ({ body: u.pathname === "/v1.0/me" ? { mail: "c@x.com" } : u.pathname.startsWith("/v1.0/me/messages/") ? gm("m1") : { value: [gm("m1")] } }));
    const m = mail(g);
    await m.search("x", 3);
    await m.getMessage("m1");
    await m.getThread("conv1");
    await m.listRecentIds(new Date("2026-10-01"), 5);
    await m.account();
    expect(g.calls.length).toBeGreaterThanOrEqual(6);
    for (const c of g.calls) {
      expect(c.method).toBe("GET");
      expect(isGraphUrl(c.url.toString())).toBe(true);
    }
  });

  it("the module source has no write method and no Graph send, reply, forward or draft endpoint", () => {
    const src = readFileSync(join(__dirname, "../src/lib/microsoft/mail.ts"), "utf8");
    expect(src).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
    expect(src).not.toMatch(/sendMail|\/send\b|\/reply|replyAll|\/forward|createReply|createForward|\/move\b|\/copy\b|mailboxSettings|messageRules/i);
  });

  it("asks only for read scopes", () => {
    expect([...OUTLOOK_READ_SCOPES]).toEqual(["offline_access", "User.Read", "Mail.Read"]);
    expect(OUTLOOK_READ_SCOPES.join(" ")).not.toMatch(/Send|ReadWrite/);
  });
});
