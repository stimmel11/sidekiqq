import { z } from "zod";

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

export const DraftSchema = z.object({
  id: z.string(),
  gmailDraftId: z.string(),
  to: z.array(z.string()).min(1),
  cc: z.array(z.string()).default([]),
  subject: z.string(),
  body: z.string(),
  threadId: z.string().optional(),
  client: z.string().optional(),
  followupId: z.string().optional(),
  status: z.enum(["pending", "sent", "discarded"]),
  createdAt: isoDate,
  sentAt: isoDate.optional(),
  gmailMessageId: z.string().optional(),
});
export type Draft = z.infer<typeof DraftSchema>;

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
