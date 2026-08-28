import { z } from 'zod';
import {
  ACTIVITY_CHANNELS,
  ACTIVITY_DIRECTIONS,
  BUCKETS,
  DEAL_STAGES,
  DECISION_MAKER_LEVELS,
  DRAFT_TYPES,
  RELEVANCE_LEVELS,
  REVIEW_STATUSES,
  TRUST_LEVELS,
  USER_ROLES,
} from './enums.js';

/** API-Contracts. Werden serverseitig zur Validierung und clientseitig als Typquelle benutzt. */

export const dealStageSchema = z.enum(DEAL_STAGES);
export const draftTypeSchema = z.enum(DRAFT_TYPES);
export const bucketSchema = z.enum(BUCKETS);

export const sessionUserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  displayName: z.string(),
  role: z.enum(USER_ROLES),
  hasMailboxConnected: z.boolean(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const dealSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  stage: dealStageSchema,
  serviceArea: z.string().nullable(),
  relevance: z.enum(RELEVANCE_LEVELS).nullable(),
  nextAction: z.string().nullable(),
  dueDate: z.string().datetime().nullable(),
  followUpDate: z.string().datetime().nullable(),
  lastContactAt: z.string().datetime().nullable(),
  ownerId: z.string(),
  ownerName: z.string(),
  companyId: z.string().nullable(),
  companyName: z.string().nullable(),
  contactId: z.string().nullable(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  hasDraft: z.boolean(),
  openReasons: z.array(z.string()),
});
export type DealSummary = z.infer<typeof dealSummarySchema>;

export const draftSchema = z.object({
  id: z.string(),
  dealId: z.string(),
  type: draftTypeSchema,
  status: z.string(),
  subject: z.string(),
  body: z.string(),
  toEmail: z.string(),
  toName: z.string().nullable(),
  ccEmails: z.array(z.string()),
  model: z.string().nullable(),
  rationale: z.string().nullable(),
  meetingProposalIds: z.array(z.string()),
  createdAt: z.string().datetime(),
  sentAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
});
export type EmailDraftDto = z.infer<typeof draftSchema>;

export const reviewItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.enum(REVIEW_STATUSES),
  title: z.string(),
  detail: z.string(),
  dealId: z.string().nullable(),
  contactId: z.string().nullable(),
  companyId: z.string().nullable(),
  relatedContactId: z.string().nullable(),
  relatedCompanyId: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type ReviewItemDto = z.infer<typeof reviewItemSchema>;

export const dailyOverviewSchema = z.object({
  date: z.string(),
  generatedAt: z.string().datetime(),
  buckets: z.object({
    A_FOLLOW_UP: z.array(dealSummarySchema),
    B_REACTIVATION: z.array(dealSummarySchema),
    C_COLD_OUTREACH: z.array(dealSummarySchema),
  }),
  conflicts: z.array(reviewItemSchema),
  counts: z.object({
    followUp: z.number(),
    reactivation: z.number(),
    coldOutreach: z.number(),
    conflicts: z.number(),
    draftsPending: z.number(),
  }),
});
export type DailyOverview = z.infer<typeof dailyOverviewSchema>;

export const activitySchema = z.object({
  id: z.string(),
  occurredAt: z.string().datetime(),
  direction: z.enum(ACTIVITY_DIRECTIONS),
  channel: z.enum(ACTIVITY_CHANNELS),
  subject: z.string().nullable(),
  summary: z.string().nullable(),
  bodyPreview: z.string().nullable(),
  replyPending: z.boolean(),
  hasPdfAttachment: z.boolean(),
  attachmentNames: z.array(z.string()),
});
export type ActivityDto = z.infer<typeof activitySchema>;

export const meetingSchema = z.object({
  id: z.string(),
  dealId: z.string().nullable(),
  subject: z.string(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  status: z.string(),
  joinUrl: z.string().nullable(),
  attendees: z.array(z.string()),
  summary: z.string().nullable(),
  transcriptFetchedAt: z.string().datetime().nullable(),
});
export type MeetingDto = z.infer<typeof meetingSchema>;

export const dealDetailSchema = dealSummarySchema.extend({
  description: z.string().nullable(),
  source: z.string().nullable(),
  company: z
    .object({
      id: z.string(),
      name: z.string(),
      website: z.string().nullable(),
      industry: z.string().nullable(),
      size: z.string().nullable(),
      profile: z.string().nullable(),
      trustLevel: z.enum(TRUST_LEVELS),
    })
    .nullable(),
  contact: z
    .object({
      id: z.string(),
      firstName: z.string().nullable(),
      lastName: z.string().nullable(),
      email: z.string(),
      phone: z.string().nullable(),
      position: z.string().nullable(),
      decisionMakerLevel: z.enum(DECISION_MAKER_LEVELS),
    })
    .nullable(),
  activities: z.array(activitySchema),
  drafts: z.array(draftSchema),
  meetings: z.array(meetingSchema),
});
export type DealDetail = z.infer<typeof dealDetailSchema>;

/* ---------- Request-Bodies ---------- */

export const updateDealSchema = z.object({
  stage: dealStageSchema.optional(),
  nextAction: z.string().max(500).nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  followUpDate: z.string().datetime().nullable().optional(),
  relevance: z.enum(RELEVANCE_LEVELS).nullable().optional(),
  serviceArea: z.string().max(200).nullable().optional(),
  ownerId: z.string().optional(),
});
export type UpdateDealInput = z.infer<typeof updateDealSchema>;

export const updateDraftSchema = z.object({
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20000),
  toEmail: z.string().email(),
  ccEmails: z.array(z.string().email()).max(10).default([]),
});
export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;

/**
 * Freigabe eines Entwurfs. `confirmedSubject` muss exakt dem Betreff entsprechen,
 * den der Benutzer im Dashboard gesehen hat – so kann ein veralteter Tab keinen
 * inzwischen geänderten Entwurf versenden (Absicherung nach Kapitel 16).
 */
export const approveDraftSchema = z.object({
  confirmedSubject: z.string().min(1),
  confirmedToEmail: z.string().email(),
  updatedAt: z.string().datetime(),
});
export type ApproveDraftInput = z.infer<typeof approveDraftSchema>;

export const generateDraftSchema = z.object({
  dealId: z.string(),
  type: draftTypeSchema,
  instructions: z.string().max(2000).optional(),
  includeMeetingProposals: z.boolean().default(false),
});
export type GenerateDraftInput = z.infer<typeof generateDraftSchema>;

export const createMeetingSchema = z.object({
  dealId: z.string(),
  subject: z.string().min(1).max(300),
  startsAt: z.string().datetime(),
  durationMinutes: z.number().int().min(15).max(480).default(30),
  attendeeEmails: z.array(z.string().email()).min(1).max(20),
  agenda: z.string().max(5000).optional(),
  sendInvitation: z.boolean().default(true),
});
export type CreateMeetingInput = z.infer<typeof createMeetingSchema>;

export const meetingSlotSchema = z.object({
  start: z.string().datetime(),
  end: z.string().datetime(),
  confidence: z.number().min(0).max(100),
});
export type MeetingSlot = z.infer<typeof meetingSlotSchema>;

export const bookingLinkSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  durationMinutes: z.number(),
  active: z.boolean(),
  ownerName: z.string(),
  url: z.string(),
});
export type BookingLinkDto = z.infer<typeof bookingLinkSchema>;

export const createBookingSchema = z.object({
  start: z.string().datetime(),
  name: z.string().min(1).max(200),
  email: z.string().email(),
  company: z.string().max(200).optional(),
  note: z.string().max(2000).optional(),
});
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const resolveReviewSchema = z.object({
  action: z.enum(['MERGE', 'KEEP_BOTH', 'DISMISS', 'RESOLVE']),
  /** Bei MERGE: welcher Datensatz bleibt bestehen. */
  keepId: z.string().optional(),
  note: z.string().max(1000).optional(),
});
export type ResolveReviewInput = z.infer<typeof resolveReviewSchema>;
