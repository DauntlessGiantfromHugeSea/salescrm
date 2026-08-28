/** Ausschnitte der Graph-Antworten, die wir tatsächlich auswerten. */

export interface GraphEmailAddress {
  name?: string;
  address?: string;
}

export interface GraphRecipient {
  emailAddress?: GraphEmailAddress;
}

export interface GraphMessage {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: GraphRecipient;
  sender?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  hasAttachments?: boolean;
  isDraft?: boolean;
  isRead?: boolean;
  parentFolderId?: string;
  '@removed'?: { reason: string };
}

export interface GraphAttachmentMeta {
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
}

export interface GraphContact {
  id: string;
  displayName?: string;
  givenName?: string;
  surname?: string;
  jobTitle?: string;
  companyName?: string;
  emailAddresses?: GraphEmailAddress[];
  businessPhones?: string[];
  mobilePhone?: string;
  '@removed'?: { reason: string };
}

export interface GraphEvent {
  id: string;
  subject?: string;
  start?: { dateTime: string; timeZone: string };
  end?: { dateTime: string; timeZone: string };
  attendees?: Array<{ emailAddress?: GraphEmailAddress; status?: { response?: string } }>;
  isOnlineMeeting?: boolean;
  onlineMeeting?: { joinUrl?: string };
  onlineMeetingUrl?: string;
  isCancelled?: boolean;
  bodyPreview?: string;
  webLink?: string;
  '@removed'?: { reason: string };
}

export interface GraphOnlineMeeting {
  id: string;
  joinWebUrl?: string;
  subject?: string;
  startDateTime?: string;
  endDateTime?: string;
}

export interface GraphTranscript {
  id: string;
  meetingId?: string;
  createdDateTime?: string;
  transcriptContentUrl?: string;
}

export interface GraphPlannerTask {
  id: string;
  planId?: string;
  bucketId?: string;
  title?: string;
  dueDateTime?: string | null;
  completedDateTime?: string | null;
  percentComplete?: number;
}

export interface GraphMeetingTimeSuggestion {
  confidence?: number;
  meetingTimeSlot?: {
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
  };
}

export interface GraphScheduleInformation {
  scheduleId?: string;
  scheduleItems?: Array<{
    status?: string;
    start?: { dateTime: string; timeZone: string };
    end?: { dateTime: string; timeZone: string };
  }>;
}

export interface GraphUser {
  id: string;
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
  preferredLanguage?: string;
  mailboxSettings?: { timeZone?: string };
}
