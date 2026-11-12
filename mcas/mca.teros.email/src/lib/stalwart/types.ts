/**
 * Core JMAP wire types (ported from the verified stalwart-tools seed).
 */

export type JmapMethodCall = [name: string, args: Record<string, unknown>, tag: string];
export type JmapMethodResponse = [name: string, args: Record<string, unknown>, tag: string];

export interface JmapResult {
  methodResponses: JmapMethodResponse[];
  sessionState?: string;
}

/** Capability sets used by Stalwart. */
export const USING_CORE = ['urn:ietf:params:jmap:core'];
export const USING_ADMIN = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'];
export const USING_MAIL = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
export const USING_SUBMIT = [
  'urn:ietf:params:jmap:core',
  'urn:ietf:params:jmap:mail',
  'urn:ietf:params:jmap:submission',
];

/** Admin objects. */
export interface Domain {
  id: string;
  name: string;
  isEnabled?: boolean;
  description?: string;
}

export interface Account {
  id: string;
  name: string;
  emailAddress?: string;
  description?: string;
  type?: string;
  usedDiskQuota?: number;
}

/** Mail objects. */
export interface Mailbox {
  id: string;
  name: string;
  role?: string;
  parentId?: string | null;
  totalEmails?: number;
  unreadEmails?: number;
  sortOrder?: number;
}

export interface Identity {
  id: string;
  email?: string;
  name?: string;
}

export interface JmapSession {
  username?: string;
  apiUrl?: string;
  primaryAccounts?: Record<string, string>;
  accounts?: Record<string, {
    name?: string;
    isPersonal?: boolean;
    accountCapabilities?: Record<string, unknown>;
  }>;
}

export interface SendResult {
  emailId?: string;
  submissionId?: string;
  to: string[];
  subject: string;
}

/** Email/list summary shape returned by list-messages. */
export interface EmailSummary {
  id: string;
  from: string | null;
  fromName: string | null;
  to: string[];
  subject: string | null;
  receivedAt: string | null;
  seen: boolean;
  flagged: boolean;
  draft: boolean;
  size: number | null;
}
