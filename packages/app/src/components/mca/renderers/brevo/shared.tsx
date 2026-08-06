/**
 * Brevo renderer — constants, types and pure helpers ONLY.
 *
 * Zero components are defined here (TER-281). Brand identity is conveyed
 * through 3 mechanisms, none of which require a local component:
 *
 *  1. Logo:    `iconUri={appIcon}` on the ToolCallCard header — `appIcon` is
 *              resolved from `manifest.icon` by the catalog.
 *  2. Palette: `BREVO_BRAND` below — the OFFICIAL Brevo colours (Fun Green
 *              `#006A43` + Royal Blue `#6358DE`), NOT Tailwind defaults.
 *              `green` is the lighter Brevo logo green, used for accents so
 *              icons/strokes stay legible on the dark theme.
 *  3. Backend status fields → passed straight to `IconChip` accents.
 */

import { colors, useColors } from '../../primitives';

// ============================================================================
// Brand palette — official Brevo colours (validated against brevo.com brand)
// ============================================================================
//
// These three hexes are Brevo's own brand identity (green, greenDeep,
// royalBlue). They are intentionally kept as hardcoded constants because they
// must remain identical in both light and dark themes. Every other colour used
// by the Brevo renderer (surface, text, border, semantic status tints) should
// come from the Design System via useBrevoColors() below.

export const BREVO_BRAND = {
  /** Brevo logo green — primary accent. Legible on the dark theme. */
  green: '#0B996E',
  /** Official "Fun Green". */
  greenDeep: '#006A43',
  /** Official secondary "Royal Blue". */
  royalBlue: '#6358DE',
} as const;

// ============================================================================
// Colors — Renderer UX Guide v2 §5 (theme-adaptive).
// ============================================================================

export function useBrevoColors() {
  const c = useColors();
  return {
    // Brevo brand (theme-agnostic)
    green: BREVO_BRAND.green,
    greenDeep: BREVO_BRAND.greenDeep,
    royalBlue: BREVO_BRAND.royalBlue,

    // Semantic status tints (theme-agnostic)
    success: colors.green,
    running: colors.indigo,
    failed: colors.red,
    warning: colors.amber,

    // Badges (theme-adaptive)
    badgeSuccess: c.badges.ok,
    badgeError: c.badges.err,
    badgeInfo: c.badges.info,
    badgeWarning: c.badges.warn,
    badgeGray: c.badges.gray,

    // Text (theme-adaptive)
    primary: c.text,
    secondary: c.text2,
    muted: c.text3,
    bright: c.text,

    // Backgrounds (theme-adaptive)
    bgDark: c.bgInner,

    // Chevron (theme-adaptive)
    chevron: c.text3,
    ...c,
  };
}

// ============================================================================
// Curated output shapes (mirror the backend handlers' return data)
// ============================================================================

export interface BrevoContactRef {
  email: string;
  name?: string;
}

export interface SendEmailResult {
  messageId: string | null;
  messageIds?: string[];
  subject: string;
  sender: BrevoContactRef;
  recipients: BrevoContactRef[];
  recipientCount: number;
}

export interface ContactItem {
  id: number | null;
  email: string | null;
  emailBlacklisted: boolean | null;
  smsBlacklisted: boolean | null;
  listIds: number[];
  attributes: Record<string, unknown> | null;
  createdAt: string | null;
  modifiedAt: string | null;
}

export interface ListContactsResult {
  contacts: ContactItem[];
  count: number;
  limit: number;
  offset: number;
}

export interface CreateContactResult {
  id: number | null;
  email: string;
  listIds: number[];
  updated: boolean;
}

export interface CampaignItem {
  id: number | null;
  name: string | null;
  subject: string | null;
  type: string | null;
  status: string | null;
  scheduledAt: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
}

export interface ListCampaignsResult {
  campaigns: CampaignItem[];
  count: number;
  type: string | null;
  status: string | null;
  limit: number;
  offset: number;
}

export interface FolderItem {
  id: number | null;
  name: string | null;
  totalSubscribers: number | null;
  uniqueSubscribers: number | null;
  totalBlacklisted: number | null;
}

export interface ListFoldersResult {
  folders: FolderItem[];
  count: number;
  limit: number;
  offset: number;
}

export interface ListItem {
  id: number | null;
  name: string | null;
  folderId: number | null;
  totalSubscribers: number | null;
  uniqueSubscribers: number | null;
  totalBlacklisted: number | null;
}

export interface ListListsResult {
  lists: ListItem[];
  count: number;
  limit: number;
  offset: number;
}

export interface CreateListResult {
  id: number | null;
  name: string;
  folderId: number;
}

export interface TemplateSenderRef {
  email: string | null;
  name: string | null;
  id: string | null;
}

export interface TemplateItem {
  id: number | null;
  name: string | null;
  subject: string | null;
  isActive: boolean | null;
  testSent: boolean | null;
  sender: TemplateSenderRef | null;
  replyTo: string | null;
  toField: string | null;
  tag: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
}

export interface ListTemplatesResult {
  templates: TemplateItem[];
  count: number;
  templateStatus: boolean | null;
  limit: number;
  offset: number;
}

export interface CreateTemplateResult {
  id: number | null;
  templateName: string;
  subject: string;
  isActive: boolean;
}

export interface CreateCampaignResult {
  id: number | null;
  name: string;
  subject: string | null;
  scheduledAt: string | null;
}

export interface SendCampaignResult {
  campaignId: number;
  sent: boolean;
}

export interface SendTestResult {
  campaignId: number;
  emailTo: string[];
}

export interface UpdateContactResult {
  identifier: string;
  updated: boolean;
  listIds: number[];
  unlinkListIds: number[];
}

export interface DeleteContactResult {
  identifier: string;
  deleted: boolean;
}

export interface MembershipResult {
  listId: number;
  success: Array<string | number>;
  failure: Array<string | number>;
}

export interface ImportContactsResult {
  processId: number | null;
  listIds: number[];
  contactCount: number | null;
  source: 'inline' | 'file';
}

export interface AttributeItem {
  name: string | null;
  category: string | null;
  type: string | null;
}

export interface ListAttributesResult {
  attributes: AttributeItem[];
  count: number;
}

export interface SegmentItem {
  id: number | null;
  segmentName: string | null;
  categoryName: string | null;
  updatedAt: string | null;
}

export interface ListSegmentsResult {
  segments: SegmentItem[];
  count: number;
  limit: number;
  offset: number;
  sort: string | null;
}

export interface EmailEventItem {
  date: string | null;
  email: string | null;
  event: string | null;
  messageId: string | null;
  subject: string | null;
  tag: string | null;
  reason: string | null;
  link: string | null;
  from: string | null;
  templateId: number | null;
}

export interface EmailEventReportResult {
  events: EmailEventItem[];
  count: number;
  limit: number;
  offset: number;
}

export interface AggregatedSmtpReportResult {
  range: string | null;
  requests: number | null;
  delivered: number | null;
  opens: number | null;
  uniqueOpens: number | null;
  clicks: number | null;
  uniqueClicks: number | null;
  hardBounces: number | null;
  softBounces: number | null;
  blocked: number | null;
  invalid: number | null;
  spamReports: number | null;
  unsubscribed: number | null;
}

// ============================================================================
// Tool labels
// ============================================================================

const TOOL_LABELS: Record<string, string> = {
  'send-transactional-email': 'Send email',
  'list-contacts': 'List contacts',
  'create-contact': 'Create contact',
  'get-contact': 'Get contact',
  'update-contact': 'Update contact',
  'delete-contact': 'Delete contact',
  'add-contact-to-list': 'Add to list',
  'remove-contact-from-list': 'Remove from list',
  'import-contacts': 'Import contacts',
  'list-attributes': 'List attributes',
  'list-segments': 'List segments',
  'get-email-event-report': 'Email events',
  'get-aggregated-smtp-report': 'Email stats',
  'list-folders': 'List folders',
  'list-lists': 'List lists',
  'create-list': 'Create list',
  'list-email-templates': 'List templates',
  'create-email-template': 'Create template',
  'list-email-campaigns': 'List campaigns',
  'get-email-campaign': 'Get campaign',
  'create-email-campaign': 'Create campaign',
  'send-test-email': 'Send test',
  'send-email-campaign': 'Send campaign',
  '-health-check': 'Health check',
};

/**
 * Active/inactive chip for a template. Templates are inactive by default, so the
 * distinction matters. `null` status (upstream didn't populate it) → no chip.
 */
export function templateStatusChipProps(
  isActive: boolean | null,
): { text: string; accent: string } | null {
  const c = useBrevoColors();
  if (isActive == null) return null;
  return isActive
    ? { text: 'active', accent: colors.green }
    : { text: 'inactive', accent: c.text3 };
}

// ============================================================================
// Contact-attribute type palette (theme-agnostic semantic accents)
// ============================================================================

export const ATTRIBUTE_TYPE_ACCENT: Record<string, string> = {
  text: colors.indigo,
  date: colors.violet,
  float: colors.amber,
  id: colors.amber,
  boolean: colors.green,
  'multiple-choice': colors.orange,
  user: BREVO_BRAND.royalBlue,
};

/**
 * Chip for a contact attribute's data type. `null` type (category-type
 * attributes carry no `type`) → no chip. Unknown types fall to the neutral
 * accent rather than being dropped.
 */
export function attributeTypeChipProps(
  type: string | null,
): { text: string; accent: string } | null {
  const c = useBrevoColors();
  if (!type) return null;
  return { text: type, accent: ATTRIBUTE_TYPE_ACCENT[type] ?? c.text3 };
}

// ============================================================================
// Email event palette (theme-agnostic semantic accents by delivery outcome)
// ============================================================================

export const EMAIL_EVENT_ACCENT: Record<string, string> = {
  delivered: colors.green,
  opened: colors.green,
  clicks: colors.green,
  requests: "#6b7280",
  loadedByProxy: colors.indigo,
  deferred: colors.amber,
  softBounces: colors.amber,
  bounces: colors.orange,
  unsubscribed: colors.orange,
  hardBounces: colors.red,
  blocked: colors.red,
  invalid: colors.red,
  spam: colors.red,
  error: colors.red,
};

export function emailEventAccent(event: string | null | undefined): string {
  const c = useBrevoColors();
  if (!event) return c.text3;
  return EMAIL_EVENT_ACCENT[event] ?? c.text3;
}

// ============================================================================
// Aggregated SMTP report — ordered stat rows (positive → negative outcomes)
// ============================================================================

export interface AggregatedStatRow {
  label: string;
  value: number;
  accent: string;
}

/**
 * Flatten the aggregated report into an ordered list of { label, value, accent }
 * for the renderer. Null (upstream didn't populate) is coerced to 0 — Brevo
 * returns 0 for an empty timeframe, so a full dashboard is the honest view.
 */
export function aggregatedReportStats(r: AggregatedSmtpReportResult): AggregatedStatRow[] {
  const c = colors;
  return [
    { label: 'requests', value: r.requests ?? 0, accent: c.text3 },
    { label: 'delivered', value: r.delivered ?? 0, accent: c.green },
    { label: 'opens', value: r.opens ?? 0, accent: c.green },
    { label: 'unique opens', value: r.uniqueOpens ?? 0, accent: c.green },
    { label: 'clicks', value: r.clicks ?? 0, accent: c.green },
    { label: 'unique clicks', value: r.uniqueClicks ?? 0, accent: c.green },
    { label: 'soft bounces', value: r.softBounces ?? 0, accent: c.amber },
    { label: 'hard bounces', value: r.hardBounces ?? 0, accent: c.red },
    { label: 'blocked', value: r.blocked ?? 0, accent: c.red },
    { label: 'invalid', value: r.invalid ?? 0, accent: c.red },
    { label: 'spam reports', value: r.spamReports ?? 0, accent: c.red },
    { label: 'unsubscribed', value: r.unsubscribed ?? 0, accent: c.orange },
  ];
}

export function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

export function getToolLabel(toolName: string): string {
  const short = getShortToolName(toolName);
  return TOOL_LABELS[short] ?? short.replace(/-/g, ' ').replace(/^./, (ch) => ch.toUpperCase());
}

// ============================================================================
// Campaign status palette (theme-agnostic semantic accents)
// ============================================================================

export const CAMPAIGN_STATUS_ACCENT: Record<string, string> = {
  sent: colors.green,
  draft: "#6b7280",
  queued: colors.amber,
  // Both casings on purpose: the campaign RESPONSE `status` is snake_case
  // `in_process`, but the echoed FILTER value (`data.status`) is the camelCase
  // Brevo query-param `inProcess` — colour both so neither chip falls to gray.
  in_process: colors.indigo,
  inProcess: colors.indigo,
  suspended: colors.amber,
  archive: "#6b7280",
};

export function campaignStatusAccent(status: string | null | undefined): string {
  const c = useBrevoColors();
  if (!status) return c.text3;
  return CAMPAIGN_STATUS_ACCENT[status] ?? c.text3;
}

// ============================================================================
// Pure formatting helpers
// ============================================================================

/** "Ana <ana@x.com>" when a name is present, else just the email. */
export function recipientLabel(r: BrevoContactRef): string {
  return r?.name ? `${r.name} <${r.email}>` : (r?.email ?? '');
}

/** Derive a display name from Brevo contact attributes (FIRSTNAME/LASTNAME). */
export function contactDisplayName(attributes: Record<string, unknown> | null): string | null {
  if (!attributes) return null;
  const first = typeof attributes.FIRSTNAME === 'string' ? attributes.FIRSTNAME : '';
  const last = typeof attributes.LASTNAME === 'string' ? attributes.LASTNAME : '';
  const full = `${first} ${last}`.trim();
  return full.length > 0 ? full : null;
}

/** ISO date/epoch → YYYY-MM-DD (or null). */
export function formatDate(value: string | number | null | undefined): string | null {
  if (value == null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Narrow `parseOutput`'s `T | string | null` to a non-array object or null.
 * `parseOutput` returns the raw string on a parse failure; this guards against
 * treating that string as the curated shape.
 */
export function narrowObject<T>(value: unknown): T | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as T;
}
