-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "DealStage" AS ENUM ('NEW', 'OPEN', 'AWAITING_REPLY', 'FOLLOW_UP_DUE', 'IN_CLARIFICATION', 'MEETING_SCHEDULED', 'PROPOSAL_IN_PROGRESS', 'PROPOSAL_SENT', 'WON', 'LOST', 'ON_HOLD', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "TrustLevel" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "RelevanceLevel" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "DecisionMakerLevel" AS ENUM ('DECISION_MAKER', 'INFLUENCER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ActivityDirection" AS ENUM ('INBOUND', 'OUTBOUND', 'INTERNAL');

-- CreateEnum
CREATE TYPE "ActivityChannel" AS ENUM ('EMAIL', 'PHONE', 'MEETING', 'NOTE', 'TASK');

-- CreateEnum
CREATE TYPE "DraftType" AS ENUM ('FOLLOW_UP', 'REACTIVATION', 'COLD_OUTREACH');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('DRAFT', 'EDITED', 'APPROVED', 'SENDING', 'SENT', 'FAILED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "ReviewType" AS ENUM ('DUPLICATE_CONTACT', 'DUPLICATE_COMPANY', 'UNCLEAR_ASSIGNMENT', 'UNASSIGNED_PROJECT_MAIL', 'AMBIGUOUS_PROJECT_MAIL', 'PLANNER_TASK_ORPHANED', 'PLANNER_TASK_MISSING', 'PLANNER_TASK_OVERDUE', 'MEETING_WITHOUT_DEAL', 'STALE_DEAL');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "MeetingStatus" AS ENUM ('SCHEDULED', 'HELD', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "Source" AS ENUM ('OUTLOOK', 'MANUAL', 'BOOKING', 'IMPORT', 'LINKEDIN');

-- CreateEnum
CREATE TYPE "ProjectStage" AS ENUM ('LEAD', 'ACQUISITION', 'QUOTED', 'AWARDED', 'PLANNING', 'EXECUTION', 'COMPLETED', 'ON_HOLD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProjectContactRole" AS ENUM ('CLIENT', 'ARCHITECT', 'STRUCTURAL_ENGINEER', 'SITE_MANAGER', 'PROJECT_MANAGER', 'GENERAL_CONTRACTOR', 'SUBCONTRACTOR', 'SURVEYOR', 'AUTHORITY', 'SUPPLIER', 'OTHER');

-- CreateEnum
CREATE TYPE "ProjectMemberRole" AS ENUM ('LEAD', 'ENGINEER', 'SALES', 'SUPPORT', 'OBSERVER');

-- CreateEnum
CREATE TYPE "MailboxKind" AS ENUM ('USER', 'SHARED');

-- CreateEnum
CREATE TYPE "MailboxAuthMode" AS ENUM ('DELEGATED', 'APP_ONLY');

-- CreateEnum
CREATE TYPE "LinkMethod" AS ENUM ('PROJECT_NUMBER', 'CONVERSATION', 'PARTICIPANTS', 'DEAL', 'MANUAL', 'AI_SUGGESTION');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "msObjectId" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Berlin',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MsAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "homeAccountId" TEXT NOT NULL,
    "refreshTokenCipher" TEXT NOT NULL,
    "scopes" TEXT[],
    "accessTokenExpiresAt" TIMESTAMP(3),
    "mailboxAddress" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRefreshAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MsAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameNormalized" TEXT NOT NULL,
    "website" TEXT,
    "emailDomain" TEXT,
    "industry" TEXT,
    "size" TEXT,
    "profile" TEXT,
    "source" "Source" NOT NULL DEFAULT 'OUTLOOK',
    "trustLevel" "TrustLevel" NOT NULL DEFAULT 'UNVERIFIED',
    "ownerId" TEXT,
    "mergedIntoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "displayName" TEXT,
    "phone" TEXT,
    "position" TEXT,
    "decisionMakerLevel" "DecisionMakerLevel" NOT NULL DEFAULT 'UNKNOWN',
    "companyId" TEXT,
    "source" "Source" NOT NULL DEFAULT 'OUTLOOK',
    "trustLevel" "TrustLevel" NOT NULL DEFAULT 'UNVERIFIED',
    "ownerId" TEXT,
    "emailCount" INTEGER NOT NULL DEFAULT 0,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "mergedIntoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "stage" "DealStage" NOT NULL DEFAULT 'NEW',
    "serviceArea" TEXT,
    "relevance" "RelevanceLevel",
    "source" "Source" NOT NULL DEFAULT 'OUTLOOK',
    "nextAction" TEXT,
    "dueDate" TIMESTAMP(3),
    "followUpDate" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "lastContactAt" TIMESTAMP(3),
    "ownerId" TEXT NOT NULL,
    "projectId" TEXT,
    "companyId" TEXT,
    "contactId" TEXT,
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "openReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastEvaluatedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "direction" "ActivityDirection" NOT NULL,
    "channel" "ActivityChannel" NOT NULL,
    "subject" TEXT,
    "bodyPreview" TEXT,
    "summary" TEXT,
    "replyPending" BOOLEAN NOT NULL DEFAULT false,
    "attachmentNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hasPdfAttachment" BOOLEAN NOT NULL DEFAULT false,
    "graphMessageId" TEXT,
    "internetMessageId" TEXT,
    "conversationId" TEXT,
    "userId" TEXT,
    "dealId" TEXT,
    "contactId" TEXT,
    "meetingId" TEXT,
    "projectId" TEXT,
    "mailboxId" TEXT,
    "projectLinkMethod" "LinkMethod",
    "projectLinkScore" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailDraft" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "DraftType" NOT NULL,
    "status" "DraftStatus" NOT NULL DEFAULT 'DRAFT',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "toName" TEXT,
    "ccEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "model" TEXT,
    "rationale" TEXT,
    "proposedSlots" JSONB,
    "approvedAt" TIMESTAMP(3),
    "approvedByIp" TEXT,
    "sentAt" TIMESTAMP(3),
    "sentMessageId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Meeting" (
    "id" TEXT NOT NULL,
    "dealId" TEXT,
    "projectId" TEXT,
    "organizerId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "MeetingStatus" NOT NULL DEFAULT 'SCHEDULED',
    "attendeeEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agenda" TEXT,
    "graphEventId" TEXT,
    "graphOnlineMeetingId" TEXT,
    "joinUrl" TEXT,
    "transcriptFetchedAt" TIMESTAMP(3),
    "transcriptText" TEXT,
    "summary" TEXT,
    "nextActionSuggestion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingLink" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "durationMinutes" INTEGER NOT NULL DEFAULT 30,
    "minNoticeHours" INTEGER NOT NULL DEFAULT 12,
    "maxDaysAhead" INTEGER NOT NULL DEFAULT 21,
    "workdayStart" TEXT NOT NULL DEFAULT '09:00',
    "workdayEnd" TEXT NOT NULL DEFAULT '17:00',
    "weekdays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "meetingId" TEXT,
    "dealId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "companyName" TEXT,
    "note" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "requesterIp" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlannerTask" (
    "id" TEXT NOT NULL,
    "graphTaskId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "bucketId" TEXT,
    "userId" TEXT NOT NULL,
    "dealId" TEXT,
    "title" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "percentComplete" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlannerTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewItem" (
    "id" TEXT NOT NULL,
    "type" "ReviewType" NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "userId" TEXT,
    "dealId" TEXT,
    "projectId" TEXT,
    "contactId" TEXT,
    "companyId" TEXT,
    "relatedContactId" TEXT,
    "relatedCompanyId" TEXT,
    "resolutionNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "mailboxId" TEXT,
    "resource" TEXT NOT NULL,
    "deltaLink" TEXT,
    "backfillCursor" TIMESTAMP(3),
    "backfillDone" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "itemsSynced" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mailbox" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "kind" "MailboxKind" NOT NULL DEFAULT 'USER',
    "authMode" "MailboxAuthMode" NOT NULL DEFAULT 'APP_ONLY',
    "graphUserId" TEXT,
    "ownerUserId" TEXT,
    "folders" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "syncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "initialImportDone" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "messagesSynced" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "detail" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyRun" (
    "id" TEXT NOT NULL,
    "runDate" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "dealsEvaluated" INTEGER NOT NULL DEFAULT 0,
    "followUpCount" INTEGER NOT NULL DEFAULT 0,
    "reactivationCount" INTEGER NOT NULL DEFAULT 0,
    "coldOutreachCount" INTEGER NOT NULL DEFAULT 0,
    "conflictCount" INTEGER NOT NULL DEFAULT 0,
    "draftsCreated" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "DailyRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "stage" "ProjectStage" NOT NULL DEFAULT 'LEAD',
    "siteAddress" TEXT,
    "city" TEXT,
    "postalCode" TEXT,
    "country" TEXT DEFAULT 'DE',
    "companyId" TEXT,
    "leadUserId" TEXT NOT NULL,
    "serviceArea" TEXT,
    "budgetCents" BIGINT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "startsOn" TIMESTAMP(3),
    "endsOn" TIMESTAMP(3),
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastActivityAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectMember" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ProjectMemberRole" NOT NULL DEFAULT 'ENGINEER',
    "canEdit" BOOLEAN NOT NULL DEFAULT true,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectContact" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "companyId" TEXT,
    "role" "ProjectContactRole" NOT NULL DEFAULT 'OTHER',
    "roleDetail" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "autoDetected" BOOLEAN NOT NULL DEFAULT false,
    "lastContactAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_msObjectId_key" ON "User"("msObjectId");

-- CreateIndex
CREATE INDEX "User_active_idx" ON "User"("active");

-- CreateIndex
CREATE UNIQUE INDEX "MsAccount_userId_key" ON "MsAccount"("userId");

-- CreateIndex
CREATE INDEX "Company_nameNormalized_idx" ON "Company"("nameNormalized");

-- CreateIndex
CREATE INDEX "Company_emailDomain_idx" ON "Company"("emailDomain");

-- CreateIndex
CREATE INDEX "Company_ownerId_idx" ON "Company"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_email_key" ON "Contact"("email");

-- CreateIndex
CREATE INDEX "Contact_companyId_idx" ON "Contact"("companyId");

-- CreateIndex
CREATE INDEX "Contact_ownerId_idx" ON "Contact"("ownerId");

-- CreateIndex
CREATE INDEX "Contact_lastOutboundAt_idx" ON "Contact"("lastOutboundAt");

-- CreateIndex
CREATE INDEX "Deal_ownerId_stage_idx" ON "Deal"("ownerId", "stage");

-- CreateIndex
CREATE INDEX "Deal_isOpen_ownerId_idx" ON "Deal"("isOpen", "ownerId");

-- CreateIndex
CREATE INDEX "Deal_companyId_idx" ON "Deal"("companyId");

-- CreateIndex
CREATE INDEX "Deal_contactId_idx" ON "Deal"("contactId");

-- CreateIndex
CREATE INDEX "Deal_projectId_idx" ON "Deal"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Activity_graphMessageId_key" ON "Activity"("graphMessageId");

-- CreateIndex
CREATE INDEX "Activity_dealId_occurredAt_idx" ON "Activity"("dealId", "occurredAt");

-- CreateIndex
CREATE INDEX "Activity_contactId_occurredAt_idx" ON "Activity"("contactId", "occurredAt");

-- CreateIndex
CREATE INDEX "Activity_conversationId_idx" ON "Activity"("conversationId");

-- CreateIndex
CREATE INDEX "Activity_occurredAt_idx" ON "Activity"("occurredAt");

-- CreateIndex
CREATE INDEX "Activity_projectId_occurredAt_idx" ON "Activity"("projectId", "occurredAt");

-- CreateIndex
CREATE INDEX "Activity_mailboxId_occurredAt_idx" ON "Activity"("mailboxId", "occurredAt");

-- CreateIndex
CREATE INDEX "EmailDraft_dealId_status_idx" ON "EmailDraft"("dealId", "status");

-- CreateIndex
CREATE INDEX "EmailDraft_userId_status_idx" ON "EmailDraft"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Meeting_graphEventId_key" ON "Meeting"("graphEventId");

-- CreateIndex
CREATE INDEX "Meeting_dealId_idx" ON "Meeting"("dealId");

-- CreateIndex
CREATE INDEX "Meeting_organizerId_startsAt_idx" ON "Meeting"("organizerId", "startsAt");

-- CreateIndex
CREATE INDEX "Meeting_status_startsAt_idx" ON "Meeting"("status", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingLink_slug_key" ON "BookingLink"("slug");

-- CreateIndex
CREATE INDEX "BookingLink_ownerId_active_idx" ON "BookingLink"("ownerId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_meetingId_key" ON "Booking"("meetingId");

-- CreateIndex
CREATE INDEX "Booking_linkId_startsAt_idx" ON "Booking"("linkId", "startsAt");

-- CreateIndex
CREATE INDEX "Booking_email_idx" ON "Booking"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PlannerTask_graphTaskId_key" ON "PlannerTask"("graphTaskId");

-- CreateIndex
CREATE INDEX "PlannerTask_userId_completedAt_idx" ON "PlannerTask"("userId", "completedAt");

-- CreateIndex
CREATE INDEX "PlannerTask_dealId_idx" ON "PlannerTask"("dealId");

-- CreateIndex
CREATE INDEX "PlannerTask_dueAt_idx" ON "PlannerTask"("dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewItem_dedupeKey_key" ON "ReviewItem"("dedupeKey");

-- CreateIndex
CREATE INDEX "ReviewItem_status_userId_idx" ON "ReviewItem"("status", "userId");

-- CreateIndex
CREATE INDEX "ReviewItem_type_status_idx" ON "ReviewItem"("type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SyncState_userId_resource_key" ON "SyncState"("userId", "resource");

-- CreateIndex
CREATE UNIQUE INDEX "SyncState_mailboxId_resource_key" ON "SyncState"("mailboxId", "resource");

-- CreateIndex
CREATE UNIQUE INDEX "Mailbox_address_key" ON "Mailbox"("address");

-- CreateIndex
CREATE INDEX "Mailbox_syncEnabled_authMode_idx" ON "Mailbox"("syncEnabled", "authMode");

-- CreateIndex
CREATE INDEX "Mailbox_ownerUserId_idx" ON "Mailbox"("ownerUserId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_action_idx" ON "AuditLog"("userId", "action");

-- CreateIndex
CREATE UNIQUE INDEX "DailyRun_runDate_userId_key" ON "DailyRun"("runDate", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_number_key" ON "Project"("number");

-- CreateIndex
CREATE INDEX "Project_stage_leadUserId_idx" ON "Project"("stage", "leadUserId");

-- CreateIndex
CREATE INDEX "Project_companyId_idx" ON "Project"("companyId");

-- CreateIndex
CREATE INDEX "Project_lastActivityAt_idx" ON "Project"("lastActivityAt");

-- CreateIndex
CREATE INDEX "ProjectMember_userId_idx" ON "ProjectMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_projectId_userId_key" ON "ProjectMember"("projectId", "userId");

-- CreateIndex
CREATE INDEX "ProjectContact_contactId_idx" ON "ProjectContact"("contactId");

-- CreateIndex
CREATE INDEX "ProjectContact_projectId_role_idx" ON "ProjectContact"("projectId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectContact_projectId_contactId_key" ON "ProjectContact"("projectId", "contactId");

-- AddForeignKey
ALTER TABLE "MsAccount" ADD CONSTRAINT "MsAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDraft" ADD CONSTRAINT "EmailDraft_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDraft" ADD CONSTRAINT "EmailDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingLink" ADD CONSTRAINT "BookingLink_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "BookingLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannerTask" ADD CONSTRAINT "PlannerTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannerTask" ADD CONSTRAINT "PlannerTask_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewItem" ADD CONSTRAINT "ReviewItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewItem" ADD CONSTRAINT "ReviewItem_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewItem" ADD CONSTRAINT "ReviewItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_leadUserId_fkey" FOREIGN KEY ("leadUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectContact" ADD CONSTRAINT "ProjectContact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectContact" ADD CONSTRAINT "ProjectContact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectContact" ADD CONSTRAINT "ProjectContact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

