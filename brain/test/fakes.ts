import { randomBytes } from "node:crypto";
import { vi } from "vitest";
import { NextRequest } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";
import type { KV } from "@/lib/kv";
import { createRepos } from "@/lib/repos";
import type { Deps } from "@/lib/deps";
import { GoogleTokenStore } from "@/lib/google/auth";
import { ConnectionStore } from "@/lib/connectors/store";
import type { CalendarEvent, DraftInput, EmailMessage, Workspace } from "@/lib/google/workspace";
import type { MailSender } from "@/lib/connectors/google/send";
import { GoogleConnector, type ContactsLookup } from "@/lib/connectors/google";
import { ZoomConnector } from "@/lib/connectors/zoom";
import type { ZoomRooms } from "@/lib/connectors/zoom/meetings";
import type { In, VideoRoom } from "@/lib/connectors/capabilities";
import type { ContactLookup, ContactQuery } from "@/lib/google/contacts";
import { buildSenders } from "@/lib/connectors/senders";
import type { CreateParams, LLM } from "@/lib/assistant/llm";
import type { PushMessage, PushSender } from "@/lib/push";
import type { Transcriber } from "@/lib/transcribe";
import type { SpeechSynthesizer } from "@/lib/tts";
import { pcm16ToWav } from "@/lib/tts";

/** In-memory Redis stand-in honouring TTL, NX and GETDEL semantics. */
export class MemoryKV implements KV {
  private strings = new Map<string, { v: string; exp?: number }>();
  private hashes = new Map<string, Map<string, string>>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  private live(key: string) {
    const e = this.strings.get(key);
    if (e && e.exp !== undefined && e.exp <= this.now()) {
      this.strings.delete(key);
      return undefined;
    }
    return e;
  }
  async get(key: string) {
    return this.live(key)?.v ?? null;
  }
  async set(key: string, value: string, opts?: { exSeconds?: number; nx?: boolean }) {
    if (opts?.nx && this.live(key)) return false;
    this.strings.set(key, { v: value, ...(opts?.exSeconds ? { exp: this.now() + opts.exSeconds * 1000 } : {}) });
    return true;
  }
  async getdel(key: string) {
    const v = this.live(key)?.v ?? null;
    this.strings.delete(key);
    return v;
  }
  async del(key: string) {
    const had = this.strings.delete(key) || this.hashes.delete(key);
    return had ? 1 : 0;
  }
  async incrWithTtl(key: string, ttlSeconds: number) {
    const cur = this.live(key);
    const n = (cur ? Number(cur.v) : 0) + 1;
    this.strings.set(key, { v: String(n), exp: cur?.exp ?? this.now() + ttlSeconds * 1000 });
    return n;
  }
  async hget(key: string, field: string) {
    return this.hashes.get(key)?.get(field) ?? null;
  }
  async hset(key: string, field: string, value: string) {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    this.hashes.get(key)!.set(field, value);
  }
  async hgetall(key: string) {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }
  async hdel(key: string, field: string) {
    return this.hashes.get(key)?.delete(field) ? 1 : 0;
  }
  /** Test helper: raw keys. */
  keys() {
    return [...this.strings.keys(), ...this.hashes.keys()];
  }
}

/** Workspace fake. Intentionally mirrors the real interface, which has NO send capability. */
export class FakeWorkspace implements Workspace {
  messages: EmailMessage[] = [];
  events: CalendarEvent[] = [];
  drafts = new Map<string, DraftInput>();
  owner = "stimmel@example.com";
  createDraft = vi.fn(async (input: DraftInput) => {
    const id = `gdraft_${this.drafts.size + 1}`;
    this.drafts.set(id, input);
    return { gmailDraftId: id, ...(input.threadId ? { threadId: input.threadId } : {}) };
  });
  async searchGmail(_q: string, max: number) {
    return this.messages.slice(0, max);
  }
  async getThread(threadId: string) {
    return this.messages.filter((m) => m.threadId === threadId);
  }
  async getMessage(id: string) {
    const m = this.messages.find((x) => x.id === id);
    if (!m) throw new Error(`no message ${id}`);
    return m;
  }
  async listMessageIds(_q: string, max: number) {
    return this.messages.slice(0, max).map((m) => ({ id: m.id, threadId: m.threadId }));
  }
  async listCalendarEvents() {
    return this.events;
  }
  async searchDrive() {
    return [];
  }
  async draftExists(id: string) {
    return this.drafts.has(id);
  }
  async ownerEmail() {
    return this.owner;
  }
}

/** contacts.lookup fake. Set `result` or `error`; calls are recorded on `lookup`. */
export class FakeContacts implements ContactsLookup {
  result: ContactLookup = { contacts: [], ambiguous: false };
  error: unknown;
  lookup = vi.fn(async (_q: ContactQuery): Promise<ContactLookup> => {
    if (this.error) throw this.error;
    return this.result;
  });
}

export class SpyMailSender implements MailSender {
  sendDraft = vi.fn(async (gmailDraftId: string) => ({ messageId: `msg_for_${gmailDraftId}` }));
}

export class FakePush implements PushSender {
  readonly enabled = true;
  sent: { tokens: string[]; msg: PushMessage }[] = [];
  async send(tokens: string[], msg: PushMessage) {
    this.sent.push({ tokens, msg });
    return { sent: tokens.length, failed: 0, invalidTokens: [] };
  }
}

/** Scripted LLM: each call returns the next response (or computes it from params). */
export class ScriptedLLM implements LLM {
  calls: CreateParams[] = [];
  constructor(private readonly script: ((p: CreateParams, i: number) => Anthropic.Message)[]) {}
  async create(p: CreateParams): Promise<Anthropic.Message> {
    // Deep-copy so later mutation of the messages array doesn't rewrite history.
    this.calls.push(JSON.parse(JSON.stringify(p)));
    const step = this.script[Math.min(this.calls.length - 1, this.script.length - 1)];
    if (!step) throw new Error("ScriptedLLM: no script");
    return step(p, this.calls.length - 1);
  }
}

let toolSeq = 0;
export function msg(content: (Anthropic.TextBlock | Anthropic.ToolUseBlock)[], stop: Anthropic.StopReason = "tool_use"): Anthropic.Message {
  return {
    id: `msg_${++toolSeq}`,
    type: "message",
    role: "assistant",
    model: "claude-test-model",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}
export function toolUse(name: string, input: unknown): Anthropic.ToolUseBlock {
  return { type: "tool_use", id: `toolu_${++toolSeq}`, name, input, caller: { type: "direct" } } as unknown as Anthropic.ToolUseBlock;
}
export function text(t: string): Anthropic.TextBlock {
  return { type: "text", text: t, citations: null } as unknown as Anthropic.TextBlock;
}

export interface TestDeps extends Deps {
  kv: MemoryKV;
  ws: FakeWorkspace;
  contacts: FakeContacts;
  sender: SpyMailSender;
  pushFake: FakePush;
  zoom: FakeZoomRooms;
  setNow(d: Date): void;
}

/** Records Zoom room requests instead of calling Zoom. */
export class FakeZoomRooms implements ZoomRooms {
  created: In<"video.create_room">[] = [];
  error: Error | null = null;
  async create(input: In<"video.create_room">): Promise<VideoRoom> {
    if (this.error) throw this.error;
    this.created.push(input);
    const n = this.created.length;
    return { meetingId: `8${n}0000000${n}`, joinUrl: `https://us02web.zoom.us/j/8${n}0000000${n}?pwd=abc`, passcode: "123456", ...(input.start ? { start: input.start } : {}) };
  }
}

export function makeDeps(
  opts: { llm?: LLM; now?: Date; transcriber?: Transcriber; tts?: SpeechSynthesizer; googleConnected?: boolean; zoom?: boolean } = {},
): TestDeps {
  let now = opts.now ?? new Date("2026-10-16T15:00:00Z");
  const clock = () => now;
  const kv = new MemoryKV(() => now.getTime());
  const repos = createRepos(kv, { prefix: "t", clock, conversationTtlSeconds: 3600, conversationMaxMessages: 20 });
  const key = randomBytes(32);
  const connections = new ConnectionStore(kv, "t", () => ({ current: key }));
  const ws = new FakeWorkspace();
  const contacts = new FakeContacts();
  const sender = new SpyMailSender();
  const pushFake = new FakePush();
  const zoom = new FakeZoomRooms();
  const connected = opts.googleConnected ?? true;
  const workspace = async (): Promise<Workspace> => {
    if (!connected) {
      const { GoogleNotConnectedError } = await import("@/lib/google/auth");
      throw new GoogleNotConnectedError();
    }
    return ws;
  };
  const contactsFactory = async (): Promise<ContactsLookup> => {
    if (!connected) {
      const { GoogleNotConnectedError } = await import("@/lib/google/auth");
      throw new GoogleNotConnectedError();
    }
    return contacts;
  };
  return {
    kv,
    repos,
    clock,
    llm: () => {
      if (!opts.llm) throw new Error("no LLM configured for this test");
      return opts.llm;
    },
    connections,
    googleTokens: new GoogleTokenStore(connections),
    connectors: () => [new GoogleConnector(workspace, contactsFactory), ...(opts.zoom ? [new ZoomConnector(async () => zoom)] : [])],
    senders: () => buildSenders({ google: { workspace, mailer: async () => sender } }),
    push: () => pushFake,
    transcriber: () =>
      opts.transcriber ?? {
        name: "fake",
        transcribe: async () => "fake transcript",
      },
    tts: () =>
      opts.tts ?? {
        name: "fake",
        synthesize: async () => ({ wav: pcm16ToWav(new Uint8Array(4800), 24000), sampleRate: 24000 }),
      },
    ws,
    contacts,
    sender,
    pushFake,
    zoom,
    setNow: (d: Date) => {
      now = d;
    },
  };
}

export function req(
  method: string,
  path: string,
  init: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: BodyInit } = {},
): NextRequest {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  let body: BodyInit | undefined = init.raw;
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.body);
  }
  return new NextRequest(new URL(path, "http://localhost:3000"), { method, headers, ...(body !== undefined ? { body } : {}) });
}

export function params<P>(p: P) {
  return { params: Promise.resolve(p) };
}

export async function pairDevice(deps: TestDeps, kind: "watch" | "phone" | "glasses" | "medallion" | "reachy" = "watch") {
  const { token, device } = await deps.repos.devices.create(kind);
  return { token, device };
}
