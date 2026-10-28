import { z } from "zod";
import { buildReadback } from "./connectors/readback";

/**
 * Contract models (ARCHITECTURE.md). These are BINDING: Kotlin clients mirror them.
 * Stored records may carry extra internal fields; always serialise through the contract
 * schema (zod objects strip unknown keys) before returning to devices.
 */

export const IMPORTANCE = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "FYI"] as const;
export const ImportanceSchema = z.enum(IMPORTANCE);
export type Importance = z.infer<typeof ImportanceSchema>;

export const CONFIDENCE = ["CONFIRMED", "LIKELY", "INFERRED", "UNKNOWN"] as const;
export const ConfidenceSchema = z.enum(CONFIDENCE);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const DEVICE_KINDS = ["watch", "glasses", "medallion", "phone", "reachy"] as const;
export const DeviceKindSchema = z.enum(DEVICE_KINDS);
export type DeviceKind = z.infer<typeof DeviceKindSchema>;

export const CATEGORIES = [
  "New Lead", "Existing Client", "Prospect", "Sales Opportunity", "Booking", "Project", "Scheduling",
  "Pricing", "Proposal", "Contract", "Payment", "Invoice", "Customer Service", "Complaint", "Problem",
  "Urgent", "Decision", "Internal", "Vendor", "Partner", "Personal", "Administrative", "Legal",
  "Financial", "Marketing", "Follow-Up", "Completed", "FYI",
] as const;
export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

export const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO-8601 date");

export const CommitmentStatusSchema = z.enum(["open", "done", "overdue"]);
export type CommitmentStatus = z.infer<typeof CommitmentStatusSchema>;

export const SourceSchema = z.object({
  kind: z.enum(["email", "meeting", "voice"]),
  ref: z.string().optional(),
});

export const CommitmentSchema = z.object({
  id: z.string(),
  who: z.string(),
  what: z.string(),
  madeAt: isoDate,
  dueAt: isoDate.optional(),
  dueInferred: z.boolean(),
  status: CommitmentStatusSchema,
  client: z.string().optional(),
  project: z.string().optional(),
  source: SourceSchema,
  confidence: ConfidenceSchema,
});
export type Commitment = z.infer<typeof CommitmentSchema>;

export const FollowUpSchema = z.object({
  id: z.string(),
  person: z.string(),
  client: z.string().optional(),
  reason: z.string(),
  daysQuiet: z.number().int().nonnegative().optional(),
  importance: ImportanceSchema,
  suggestedMessage: z.string().optional(),
  draftId: z.string().optional(),
});
export type FollowUp = z.infer<typeof FollowUpSchema>;

export const TopItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  why: z.string(),
  importance: ImportanceSchema,
  dueAt: isoDate.optional(),
});
export type TopItem = z.infer<typeof TopItemSchema>;

export const ActionSchema = z.object({
  type: z.enum(["draft_created", "commitment_added", "event_proposed"]),
  id: z.string(),
  summary: z.string(),
});
export type Action = z.infer<typeof ActionSchema>;

export const BriefKindSchema = z.enum(["daily", "eod", "weekly"]);
export type BriefKind = z.infer<typeof BriefKindSchema>;

export const BriefSchema = z.object({
  kind: BriefKindSchema,
  generatedAt: isoDate,
  sections: z.array(z.object({ title: z.string(), items: z.array(z.string()) })),
  top5: z.array(TopItemSchema),
});
export type Brief = z.infer<typeof BriefSchema>;

// ---- API request/response bodies (contract) ----

export const AskRequestSchema = z.object({
  text: z.string().trim().min(1).max(8000),
  device: DeviceKindSchema,
  conversationId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
});
export type AskRequest = z.infer<typeof AskRequestSchema>;

export const AskResponseSchema = z.object({
  reply: z.string(),
  spoken: z.string(),
  conversationId: z.string(),
  actions: z.array(ActionSchema),
});
export type AskResponse = z.infer<typeof AskResponseSchema>;

/**
 * A proactive alert. Same content as the FCM data push (title, body, kind and the string data keys),
 * kept in a short log so devices without FCM (Reachy Mini) can poll GET /api/alerts.
 */
export const AlertKindSchema = z.enum(["email", "commitment_overdue"]);
export const AlertSchema = z.object({
  /** Monotonic sequence number as a string; also usable as a cursor. */
  id: z.string(),
  at: isoDate,
  title: z.string(),
  body: z.string(),
  kind: AlertKindSchema,
  importance: ImportanceSchema.optional(),
  priority: z.enum(["high", "normal"]),
  client: z.string().optional(),
  messageId: z.string().optional(),
  threadId: z.string().optional(),
  commitmentId: z.string().optional(),
});
export type Alert = z.infer<typeof AlertSchema>;

export const AlertsResponseSchema = z.object({
  items: z.array(AlertSchema),
  cursor: z.string(),
  more: z.boolean(),
});
export type AlertsResponse = z.infer<typeof AlertsResponseSchema>;

/**
 * Device commands (task layer + device routing). A command is started on one device and runs on
 * another (for example "call Dana" said to the watch opens the dialer on the phone).
 *
 * Every command is a hand-off (`user_finishes` in docs/CONNECTORS.md): the target device shows the
 * label and the owner taps to act. A device NEVER auto-launches a command, dials with ACTION_CALL,
 * or sends anything because of one. Fields are flat and optional per kind so clients that don't
 * know a new kind can still parse (and ignore) it.
 */
export const COMMAND_KINDS = ["open_url", "call_contact", "reachy_wake"] as const;
export const CommandKindSchema = z.enum(COMMAND_KINDS);
export type CommandKind = z.infer<typeof CommandKindSchema>;

export const CALL_APPS = ["phone", "whatsapp"] as const;
export const REACHY_ACTIVITIES = ["chat", "brief", "dance", "game"] as const;
export const COMMAND_RESULTS = ["opened", "dismissed", "failed"] as const;
export const CommandResultSchema = z.enum(COMMAND_RESULTS);
export type CommandResult = z.infer<typeof CommandResultSchema>;

export const DeviceCommandSchema = z.object({
  id: z.string(),
  at: isoDate,
  expiresAt: isoDate,
  kind: CommandKindSchema,
  /** One line built by the brain from the structured fields; what the target shows before the owner taps. */
  label: z.string(),
  /** Device kind the command was started from (for "from your watch"). */
  from: DeviceKindSchema,
  /** open_url: https URL on the allowlist. */
  url: z.string().optional(),
  /** call_contact: normalised number, digits with an optional leading "+". */
  number: z.string().optional(),
  /** call_contact: display name the owner gave. */
  name: z.string().optional(),
  /** call_contact: which app's dialer to open. */
  app: z.enum(CALL_APPS).optional(),
  /** reachy_wake: what Reachy should offer once awake. */
  activity: z.enum(REACHY_ACTIVITIES).optional(),
});
export type DeviceCommand = z.infer<typeof DeviceCommandSchema>;

/** Device-side target: a specific paired device id, or a device kind (most recently seen device of that kind). */
export const CommandTargetSchema = z
  .object({
    deviceId: z.string().trim().min(1).max(64).optional(),
    device: DeviceKindSchema.optional(),
  })
  .refine((t) => !(t.deviceId && t.device), "give deviceId or device, not both");

export const CreateCommandRequestSchema = z.object({
  kind: CommandKindSchema,
  target: CommandTargetSchema.optional(),
  url: z.string().trim().min(1).max(2048).optional(),
  number: z.string().trim().min(1).max(32).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  app: z.enum(CALL_APPS).optional(),
  activity: z.enum(REACHY_ACTIVITIES).optional(),
});
export type CreateCommandRequest = z.infer<typeof CreateCommandRequestSchema>;

export const CreateCommandResponseSchema = z.object({
  command: DeviceCommandSchema,
  /** The device the command was queued for. */
  deviceId: z.string(),
  device: DeviceKindSchema,
});

export const CommandsResponseSchema = z.object({ items: z.array(DeviceCommandSchema) });

export const AckCommandRequestSchema = z.object({ result: CommandResultSchema });

export const TTS_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"] as const;
export const SpeakRequestSchema = z.object({
  text: z.string().trim().min(1),
  voice: z.enum(TTS_VOICES).optional(),
});
export type SpeakRequest = z.infer<typeof SpeakRequestSchema>;

export const RegisterDeviceSchema = z.object({
  fcmToken: z.string().trim().min(1).max(4096),
  device: z.string().trim().min(1).max(64),
});

// ---- Internal (server-side) records ----

export const StoredCommitmentSchema = CommitmentSchema.extend({
  status: z.enum(["open", "done"]), // "overdue" is derived on read from dueAt
  createdAt: isoDate,
  updatedAt: isoDate,
  completedAt: isoDate.optional(),
  notes: z.string().optional(),
});
export type StoredCommitment = z.infer<typeof StoredCommitmentSchema>;

export const StoredFollowUpSchema = FollowUpSchema.omit({ daysQuiet: true }).extend({
  lastContactAt: isoDate.optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
  resolved: z.boolean().default(false),
  source: SourceSchema.optional(),
});
export type StoredFollowUp = z.infer<typeof StoredFollowUpSchema>;

export const RELATIONSHIP_HEALTH = ["Excellent", "Healthy", "Developing", "At Risk", "Dormant", "Lost"] as const;

export const ClientProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  organization: z.string().optional(),
  role: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  location: z.string().optional(),
  relationshipType: z.string().optional(),
  relationshipHealth: z.enum(RELATIONSHIP_HEALTH).optional(),
  healthReason: z.string().optional(),
  howWeMet: z.string().optional(),
  needs: z.string().optional(),
  goals: z.string().optional(),
  budget: z.string().optional(),
  decisionMakers: z.string().optional(),
  timeline: z.string().optional(),
  preferences: z.string().optional(),
  currentStage: z.string().optional(),
  currentOpportunity: z.string().optional(),
  nextAction: z.string().optional(),
  notes: z.string().optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type ClientProfile = z.infer<typeof ClientProfileSchema>;

export const TimelineEventSchema = z.object({
  id: z.string(),
  client: z.string().optional(),
  project: z.string().optional(),
  at: isoDate,
  event: z.string(),
  people: z.array(z.string()).default([]),
  categories: z.array(CategorySchema).default([]),
  importance: ImportanceSchema.default("LOW"),
  decision: z.string().optional(),
  commitment: z.string().optional(),
  nextAction: z.string().optional(),
  source: SourceSchema.optional(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const DecisionSchema = z.object({
  id: z.string(),
  what: z.string(),
  decidedAt: isoDate,
  people: z.array(z.string()).default([]),
  why: z.string().optional(),
  impact: z.string().optional(),
  followUp: z.string().optional(),
  client: z.string().optional(),
  project: z.string().optional(),
  confidence: ConfidenceSchema.default("CONFIRMED"),
  source: SourceSchema.optional(),
  createdAt: isoDate,
});
export type Decision = z.infer<typeof DecisionSchema>;

export const DRAFT_KINDS = ["email", "calendar_invite", "calendar_hold"] as const;
export const DraftKindSchema = z.enum(DRAFT_KINDS);
export type DraftKind = z.infer<typeof DraftKindSchema>;

export const DraftWhenSchema = z.object({ start: isoDate, end: isoDate });
export type DraftWhen = z.infer<typeof DraftWhenSchema>;

/**
 * Stored records written before the connector framework (slice 3) have `gmailDraftId` /
 * `gmailMessageId` and no `kind`, `connectorId` or `readback`. Map them on read so pending drafts
 * created before the change still list and approve (docs/CONNECTORS.md §5).
 */
function upgradeLegacyDraft(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { gmailDraftId, gmailMessageId, ...rest } = raw as Record<string, unknown>;
  const d: Record<string, unknown> = { ...rest };
  if (d.providerDraftId === undefined && typeof gmailDraftId === "string") d.providerDraftId = gmailDraftId;
  if (d.providerMessageId === undefined && typeof gmailMessageId === "string") d.providerMessageId = gmailMessageId;
  if (typeof d.readback !== "string" || !d.readback) {
    // The same code-built template new drafts get (legacy drafts are always email).
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const kind = DraftKindSchema.safeParse(d.kind ?? "email");
    const when = DraftWhenSchema.safeParse(d.when);
    d.readback = buildReadback({
      kind: kind.success ? kind.data : "email",
      to: strs(d.to),
      cc: strs(d.cc),
      subject: typeof d.subject === "string" ? d.subject : "",
      ...(when.success ? { when: when.data } : {}),
    });
  }
  return d;
}

/**
 * A pending action the owner must confirm (docs/CONNECTORS.md §5). Every confirm-tier action is a
 * Draft, so `POST /api/drafts/:id/approve` stays the only executor. `readback` is built in code by
 * DraftsRepo.create (lib/connectors/readback.ts), never by the model.
 */
export const DraftSchema = z.preprocess(
  upgradeLegacyDraft,
  z
    .object({
      id: z.string(),
      status: z.enum(["pending", "sent", "discarded"]),
      createdAt: isoDate,
      sentAt: isoDate.optional(),
      /** Absent on old records = "email". */
      kind: DraftKindSchema.default("email"),
      /** Absent on old records = "google". */
      connectorId: z.string().min(1).default("google"),
      /** Email only: the provider's draft id (the Gmail draft id). Replaces `gmailDraftId`. */
      providerDraftId: z.string().min(1).optional(),
      /** Set once sent. Replaces `gmailMessageId`. */
      providerMessageId: z.string().optional(),
      /** Recipients (email) or attendees (calendar_invite); empty for calendar_hold. */
      to: z.array(z.string()),
      cc: z.array(z.string()).default([]),
      /** Email subject, or the event title for calendar kinds. */
      subject: z.string(),
      /** Email body, or the event description for calendar kinds. */
      body: z.string(),
      /** ONE sentence the device speaks before asking for "send it". Built in code, never by the model. */
      readback: z.string().min(1),
      /** Calendar kinds only. */
      when: DraftWhenSchema.optional(),
      threadId: z.string().optional(),
      client: z.string().optional(),
      followupId: z.string().optional(),
    })
    .superRefine((d, ctx) => {
      const issue = (message: string, path: string) => ctx.addIssue({ code: "custom", message, path: [path] });
      if (d.kind === "email") {
        if (d.to.length < 1) issue("an email needs at least one recipient", "to");
        if (d.when) issue("an email has no time", "when");
      } else {
        if (!d.when) issue("a calendar draft needs a start and end", "when");
        else if (Date.parse(d.when.end) <= Date.parse(d.when.start)) issue("end must be after start", "when");
        if (d.kind === "calendar_invite" && d.to.length < 1) issue("an invite needs at least one attendee", "to");
        if (d.kind === "calendar_hold" && (d.to.length > 0 || d.cc.length > 0)) issue("a hold has no attendees", "to");
        if (d.providerDraftId) issue("only email drafts have a provider draft", "providerDraftId");
      }
    }),
);
export type Draft = z.output<typeof DraftSchema>;

/** One item of `GET /api/drafts` (ARCHITECTURE.md). Pending drafts only, so no status. */
export const DraftListItemSchema = z.object({
  id: z.string(),
  kind: DraftKindSchema,
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  readback: z.string(),
  when: DraftWhenSchema.optional(),
  client: z.string().optional(),
  createdAt: isoDate,
});
export type DraftListItem = z.infer<typeof DraftListItemSchema>;

/** A queued command as stored: the contract fields plus routing and delivery state (never returned as-is). */
export const StoredCommandSchema = DeviceCommandSchema.extend({
  targetDeviceId: z.string(),
  fromDeviceId: z.string(),
  status: z.enum(["pending", ...COMMAND_RESULTS]),
  ackedAt: isoDate.optional(),
});
export type StoredCommand = z.infer<typeof StoredCommandSchema>;

export const DeviceRecordSchema = z.object({
  id: z.string(),
  kind: DeviceKindSchema,
  name: z.string().optional(),
  tokenHash: z.string(),
  fcmToken: z.string().optional(),
  fcmDevice: z.string().optional(),
  createdAt: isoDate,
  lastSeenAt: isoDate.optional(),
  revoked: z.boolean().default(false),
});
export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;
