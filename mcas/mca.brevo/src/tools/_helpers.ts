/**
 * Pure boundary validation, request-body construction, response shaping and
 * argument coercion for the Brevo tools.
 *
 * Everything here is side-effect free and SDK-free so it can be unit-tested
 * directly with exact-payload assertions (no network / no McaServer). The
 * tool handlers in this directory are thin wrappers: validate → buildBody →
 * brevoRequest → shape.
 *
 * Validation rationale (Engineering Principle #5 "DB/External writes are
 * contracts"): we reject at the handler boundary what JSON Schema can't
 * express — non-empty/well-formed emails, `to` ≥ 1, a subject, and at least
 * one content body. Brevo does the authoritative validation server-side; this
 * layer turns obvious garbage into a precise error (with the offending index)
 * instead of an opaque 400.
 */

// ============================================================================
// Types — request bodies (exact Brevo shapes)
// ============================================================================

export interface BrevoContactRef {
  email: string;
  name?: string;
}

export interface SendEmailBody {
  sender: BrevoContactRef;
  to: BrevoContactRef[];
  subject: string;
  htmlContent?: string;
  textContent?: string;
  cc?: BrevoContactRef[];
  bcc?: BrevoContactRef[];
  replyTo?: BrevoContactRef;
  params?: Record<string, unknown>;
  tags?: string[];
}

export interface CreateContactBody {
  email: string;
  attributes?: Record<string, unknown>;
  listIds?: number[];
  updateEnabled?: boolean;
}

// ============================================================================
// Primitive guards
// ============================================================================

/**
 * Pragmatic email check. Requires `local@domain.tld` with no whitespace.
 * Not RFC-5322-complete by design — Brevo is the authoritative validator; this
 * only rejects obvious garbage (empty, whitespace, missing `@`, missing TLD)
 * at the boundary without false-rejecting real-world addresses.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isValidEmail(value: unknown): value is string {
  return isNonEmptyString(value) && EMAIL_RE.test(value.trim());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ============================================================================
// Coercion (list params)
// ============================================================================

/**
 * Coerce an arg to an integer clamped to [min, max]. Missing / non-numeric →
 * `fallback`. Floats are floored. Keeps Brevo's pagination bounds honest
 * regardless of what the LLM passes.
 */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Coerce an arg to a strict integer. Accepts a real integer or an integer-valued
 * numeric string (the LLM often serializes ids as strings). Anything else →
 * `null`. Used for Brevo ids (folderId, sender id) where "must be an integer"
 * is a hard contract but the transport may stringify the value.
 */
export function coerceInt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

/** Whitelist the URL protocol (http/https only) — rejects `javascript:`, `ftp:`, … */
function isHttpUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate that an optional enum arg is one of `allowed`. `undefined`/empty →
 * `undefined` (the param is simply omitted from the query). Anything else
 * throws a boundary error listing the allowed values.
 */
export function validateEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

// ============================================================================
// send-transactional-email
// ============================================================================

function normContact(raw: unknown, field: string): BrevoContactRef {
  if (!isPlainObject(raw) || !isValidEmail(raw.email)) {
    throw new Error(`${field}.email is required and must be a valid email address.`);
  }
  const out: BrevoContactRef = { email: String(raw.email).trim() };
  if (isNonEmptyString(raw.name)) out.name = raw.name;
  return out;
}

function validateRecipientList(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of { email, name? } recipients.`);
  }
  value.forEach((item, i) => {
    if (!isPlainObject(item) || !isValidEmail(item.email)) {
      throw new Error(`${field}[${i}].email must be a valid email address.`);
    }
  });
}

export function validateSendEmailArgs(args: unknown): void {
  if (!isPlainObject(args)) throw new Error('Invalid arguments: expected an object.');

  // sender
  if (!isPlainObject(args.sender) || !isNonEmptyString(args.sender.email)) {
    throw new Error('sender.email is required and must be a non-empty email address.');
  }
  if (!isValidEmail(args.sender.email)) {
    throw new Error(`sender.email is not a valid email address: "${args.sender.email}".`);
  }

  // to (≥ 1)
  if (!Array.isArray(args.to) || args.to.length === 0) {
    throw new Error('to must be a non-empty array of { email, name? } recipients.');
  }
  args.to.forEach((item, i) => {
    if (!isPlainObject(item) || !isNonEmptyString(item.email)) {
      throw new Error(`to[${i}].email is required and must be a non-empty email address.`);
    }
    if (!isValidEmail(item.email)) {
      throw new Error(`to[${i}].email is not a valid email address: "${item.email}".`);
    }
  });

  // subject
  if (!isNonEmptyString(args.subject)) {
    throw new Error('subject is required and must be a non-empty string.');
  }

  // content — at least one of htmlContent / textContent
  if (!isNonEmptyString(args.htmlContent) && !isNonEmptyString(args.textContent)) {
    throw new Error('At least one of htmlContent or textContent is required.');
  }

  // optional recipient lists + replyTo
  validateRecipientList(args.cc, 'cc');
  validateRecipientList(args.bcc, 'bcc');
  if (args.replyTo !== undefined) {
    if (!isPlainObject(args.replyTo) || !isValidEmail(args.replyTo.email)) {
      throw new Error('replyTo.email must be a valid email address when replyTo is provided.');
    }
  }
}

/**
 * Build the exact `POST /smtp/email` body. Only well-formed, present optional
 * fields are included — no `undefined`/`null` keys reach Brevo (it accepts
 * null on reads but rejects it on writes).
 *
 * Assumes `validateSendEmailArgs(args)` already passed.
 */
export function buildSendEmailBody(args: Record<string, unknown>): SendEmailBody {
  const body: SendEmailBody = {
    sender: normContact(args.sender, 'sender'),
    to: (args.to as unknown[]).map((r, i) => normContact(r, `to[${i}]`)),
    subject: String(args.subject),
  };

  if (isNonEmptyString(args.htmlContent)) body.htmlContent = args.htmlContent;
  if (isNonEmptyString(args.textContent)) body.textContent = args.textContent;
  if (Array.isArray(args.cc) && args.cc.length > 0) {
    body.cc = (args.cc as unknown[]).map((r, i) => normContact(r, `cc[${i}]`));
  }
  if (Array.isArray(args.bcc) && args.bcc.length > 0) {
    body.bcc = (args.bcc as unknown[]).map((r, i) => normContact(r, `bcc[${i}]`));
  }
  if (isPlainObject(args.replyTo)) body.replyTo = normContact(args.replyTo, 'replyTo');
  if (isPlainObject(args.params)) body.params = args.params;
  if (Array.isArray(args.tags)) {
    // Filter FIRST, then attach only when something survives. `tags: ['', '  ']`
    // has length > 0 but filters to []; setting `body.tags = []` would leave an
    // empty-array key (violates "omit empty arrays" — Brevo wants no write noise).
    const tags = (args.tags as unknown[]).filter(isNonEmptyString).map((t) => t.trim());
    if (tags.length > 0) body.tags = tags;
  }

  return body;
}

// ============================================================================
// create-contact
// ============================================================================

export function validateCreateContactArgs(args: unknown): void {
  if (!isPlainObject(args)) throw new Error('Invalid arguments: expected an object.');
  if (!isNonEmptyString(args.email)) {
    throw new Error('email is required and must be a non-empty email address.');
  }
  if (!isValidEmail(args.email)) {
    throw new Error(`email is not a valid email address: "${args.email}".`);
  }
  if (args.listIds !== undefined) {
    if (!Array.isArray(args.listIds) || !args.listIds.every((n) => Number.isInteger(n))) {
      throw new Error('listIds must be an array of integers (Brevo list ids).');
    }
  }
  if (args.attributes !== undefined && !isPlainObject(args.attributes)) {
    throw new Error('attributes must be an object (e.g. { FIRSTNAME, LASTNAME, SMS }).');
  }
}

/**
 * Build the exact `POST /contacts` body. Assumes validation passed.
 */
export function buildCreateContactBody(args: Record<string, unknown>): CreateContactBody {
  const body: CreateContactBody = { email: String(args.email).trim() };
  if (isPlainObject(args.attributes)) body.attributes = args.attributes;
  if (Array.isArray(args.listIds) && args.listIds.length > 0) {
    body.listIds = (args.listIds as number[]).map((n) => Number(n));
  }
  if (typeof args.updateEnabled === 'boolean') body.updateEnabled = args.updateEnabled;
  return body;
}

// ============================================================================
// Response shaping (whitelist visual + identifying fields — criterion 13)
// ============================================================================

export interface ShapedContact {
  id: number | null;
  email: string | null;
  emailBlacklisted: boolean | null;
  smsBlacklisted: boolean | null;
  listIds: number[];
  attributes: Record<string, unknown> | null;
  createdAt: string | null;
  modifiedAt: string | null;
}

export function shapeContact(raw: unknown): ShapedContact {
  const c = isPlainObject(raw) ? raw : {};
  return {
    id: typeof c.id === 'number' ? c.id : null,
    email: typeof c.email === 'string' ? c.email : null,
    emailBlacklisted: typeof c.emailBlacklisted === 'boolean' ? c.emailBlacklisted : null,
    smsBlacklisted: typeof c.smsBlacklisted === 'boolean' ? c.smsBlacklisted : null,
    listIds: Array.isArray(c.listIds) ? (c.listIds as number[]) : [],
    attributes: isPlainObject(c.attributes) ? c.attributes : null,
    createdAt: typeof c.createdAt === 'string' ? c.createdAt : null,
    modifiedAt: typeof c.modifiedAt === 'string' ? c.modifiedAt : null,
  };
}

export interface ShapedCampaign {
  id: number | null;
  name: string | null;
  subject: string | null;
  type: string | null;
  status: string | null;
  scheduledAt: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
}

export function shapeCampaign(raw: unknown): ShapedCampaign {
  const c = isPlainObject(raw) ? raw : {};
  return {
    id: typeof c.id === 'number' ? c.id : null,
    name: typeof c.name === 'string' ? c.name : null,
    subject: typeof c.subject === 'string' ? c.subject : null,
    type: typeof c.type === 'string' ? c.type : null,
    status: typeof c.status === 'string' ? c.status : null,
    scheduledAt: typeof c.scheduledAt === 'string' ? c.scheduledAt : null,
    createdAt: typeof c.createdAt === 'string' ? c.createdAt : null,
    modifiedAt: typeof c.modifiedAt === 'string' ? c.modifiedAt : null,
  };
}

// ============================================================================
// create-list (POST /contacts/lists)
// ============================================================================

export interface CreateListBody {
  name: string;
  folderId: number;
}

/**
 * Both `name` and `folderId` are REQUIRED by Brevo (verified against the
 * getbrevo/brevo-node `CreateListRequest`: `folderId: number` is non-optional).
 * A list cannot exist outside a folder — the agent discovers folder ids with
 * `list-folders`.
 */
export function validateCreateListArgs(args: unknown): void {
  if (!isPlainObject(args)) throw new Error('Invalid arguments: expected an object.');
  if (!isNonEmptyString(args.name)) {
    throw new Error('name is required and must be a non-empty string.');
  }
  if (coerceInt(args.folderId) == null) {
    throw new Error(
      'folderId is required and must be an integer (a Brevo folder id — call list-folders to find one).',
    );
  }
}

/** Build the exact `POST /contacts/lists` body. Assumes validation passed. */
export function buildCreateListBody(args: Record<string, unknown>): CreateListBody {
  return {
    name: String(args.name).trim(),
    folderId: coerceInt(args.folderId) as number,
  };
}

// ============================================================================
// create-email-template (POST /smtp/templates)
// ============================================================================

export interface CreateTemplateBody {
  templateName: string;
  subject: string;
  sender: SenderRef;
  htmlContent?: string;
  htmlUrl?: string;
  isActive?: boolean;
  replyTo?: string;
  toField?: string;
  tag?: string;
  attachmentUrl?: string;
}

/**
 * Shared sender reference used by templates and campaigns: EITHER a verified
 * `email` OR a Brevo sender `id`, never both (Brevo rejects both; the SDK doc:
 * "Only one of either Sender's email or Sender's ID shall be passed"), plus an
 * optional display name.
 */
export interface SenderRef {
  email?: string;
  id?: number;
  name?: string;
}

/**
 * Enforce the sender mutex at the boundary so the agent gets a precise message
 * instead of an opaque 400.
 */
export function assertSenderEmailXorId(raw: unknown): void {
  if (!isPlainObject(raw)) {
    throw new Error('sender is required and must be an object with either { email } or { id }.');
  }
  const hasEmail = isNonEmptyString(raw.email);
  const hasId = coerceInt(raw.id) != null;
  if (hasEmail && hasId) {
    throw new Error('sender must have exactly one of { email } or { id }, not both.');
  }
  if (!hasEmail && !hasId) {
    throw new Error('sender requires either a verified { email } or a Brevo sender { id }.');
  }
  if (hasEmail && !isValidEmail(raw.email)) {
    throw new Error(`sender.email is not a valid email address: "${raw.email}".`);
  }
}

/** Build the exact sender body. Assumes `assertSenderEmailXorId` passed. */
export function buildSenderRef(raw: Record<string, unknown>): SenderRef {
  const sender: SenderRef = {};
  if (isNonEmptyString(raw.email)) sender.email = String(raw.email).trim();
  const id = coerceInt(raw.id);
  if (id != null) sender.id = id;
  if (isNonEmptyString(raw.name)) sender.name = String(raw.name).trim();
  return sender;
}

export function validateCreateTemplateArgs(args: unknown): void {
  if (!isPlainObject(args)) throw new Error('Invalid arguments: expected an object.');

  if (!isNonEmptyString(args.templateName)) {
    throw new Error('templateName is required and must be a non-empty string.');
  }
  if (!isNonEmptyString(args.subject)) {
    throw new Error('subject is required and must be a non-empty string.');
  }

  assertSenderEmailXorId(args.sender);

  // content — at least one of htmlContent / htmlUrl
  const hasHtml = isNonEmptyString(args.htmlContent);
  const hasUrl = isNonEmptyString(args.htmlUrl);
  if (!hasHtml && !hasUrl) {
    throw new Error('At least one of htmlContent or htmlUrl is required.');
  }
  if (hasHtml && (args.htmlContent as string).trim().length < 10) {
    throw new Error('htmlContent must be at least 10 characters (Brevo requirement).');
  }
  if (hasUrl && !isHttpUrl(args.htmlUrl)) {
    throw new Error('htmlUrl must be a valid http(s) URL.');
  }

  if (args.attachmentUrl !== undefined && !isHttpUrl(args.attachmentUrl)) {
    throw new Error('attachmentUrl must be a valid http(s) URL.');
  }
  if (args.replyTo !== undefined && !isValidEmail(args.replyTo)) {
    throw new Error('replyTo must be a valid email address.');
  }
}

/** Build the exact `POST /smtp/templates` body. Assumes validation passed. */
export function buildCreateTemplateBody(args: Record<string, unknown>): CreateTemplateBody {
  const body: CreateTemplateBody = {
    templateName: String(args.templateName).trim(),
    subject: String(args.subject).trim(),
    sender: buildSenderRef(args.sender as Record<string, unknown>),
  };
  if (isNonEmptyString(args.htmlContent)) body.htmlContent = args.htmlContent;
  if (isNonEmptyString(args.htmlUrl)) body.htmlUrl = String(args.htmlUrl).trim();
  if (typeof args.isActive === 'boolean') body.isActive = args.isActive;
  if (isNonEmptyString(args.replyTo)) body.replyTo = String(args.replyTo).trim();
  if (isNonEmptyString(args.toField)) body.toField = args.toField;
  if (isNonEmptyString(args.tag)) body.tag = String(args.tag).trim();
  if (isNonEmptyString(args.attachmentUrl)) body.attachmentUrl = String(args.attachmentUrl).trim();
  return body;
}

// ============================================================================
// Response shaping — lists, folders, templates (criterion 13 whitelist)
// ============================================================================

export interface ShapedList {
  id: number | null;
  name: string | null;
  folderId: number | null;
  totalSubscribers: number | null;
  uniqueSubscribers: number | null;
  totalBlacklisted: number | null;
}

export function shapeList(raw: unknown): ShapedList {
  const l = isPlainObject(raw) ? raw : {};
  return {
    id: typeof l.id === 'number' ? l.id : null,
    name: typeof l.name === 'string' ? l.name : null,
    folderId: typeof l.folderId === 'number' ? l.folderId : null,
    totalSubscribers: typeof l.totalSubscribers === 'number' ? l.totalSubscribers : null,
    uniqueSubscribers: typeof l.uniqueSubscribers === 'number' ? l.uniqueSubscribers : null,
    totalBlacklisted: typeof l.totalBlacklisted === 'number' ? l.totalBlacklisted : null,
  };
}

export interface ShapedFolder {
  id: number | null;
  name: string | null;
  totalSubscribers: number | null;
  uniqueSubscribers: number | null;
  totalBlacklisted: number | null;
}

export function shapeFolder(raw: unknown): ShapedFolder {
  const f = isPlainObject(raw) ? raw : {};
  return {
    id: typeof f.id === 'number' ? f.id : null,
    name: typeof f.name === 'string' ? f.name : null,
    totalSubscribers: typeof f.totalSubscribers === 'number' ? f.totalSubscribers : null,
    uniqueSubscribers: typeof f.uniqueSubscribers === 'number' ? f.uniqueSubscribers : null,
    totalBlacklisted: typeof f.totalBlacklisted === 'number' ? f.totalBlacklisted : null,
  };
}

export interface ShapedTemplateSender {
  email: string | null;
  name: string | null;
  id: string | null;
}

export interface ShapedTemplate {
  id: number | null;
  name: string | null;
  subject: string | null;
  isActive: boolean | null;
  testSent: boolean | null;
  sender: ShapedTemplateSender | null;
  replyTo: string | null;
  toField: string | null;
  tag: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
}

/** Shape a template sender. Brevo's overview types `id` as a string. */
function shapeTemplateSender(raw: unknown): ShapedTemplateSender | null {
  if (!isPlainObject(raw)) return null;
  const id =
    typeof raw.id === 'string' ? raw.id : typeof raw.id === 'number' ? String(raw.id) : null;
  return {
    email: typeof raw.email === 'string' ? raw.email : null,
    name: typeof raw.name === 'string' ? raw.name : null,
    id,
  };
}

/**
 * Shape a template overview. `htmlContent` is deliberately DROPPED — a template
 * body can be thousands of characters; listing it would bloat the model context
 * for no gain. A future `get-email-template` detail tool can surface it.
 */
export function shapeTemplate(raw: unknown): ShapedTemplate {
  const t = isPlainObject(raw) ? raw : {};
  return {
    id: typeof t.id === 'number' ? t.id : null,
    name: typeof t.name === 'string' ? t.name : null,
    subject: typeof t.subject === 'string' ? t.subject : null,
    isActive: typeof t.isActive === 'boolean' ? t.isActive : null,
    testSent: typeof t.testSent === 'boolean' ? t.testSent : null,
    sender: shapeTemplateSender(t.sender),
    replyTo: typeof t.replyTo === 'string' ? t.replyTo : null,
    toField: typeof t.toField === 'string' ? t.toField : null,
    tag: typeof t.tag === 'string' ? t.tag : null,
    createdAt: typeof t.createdAt === 'string' ? t.createdAt : null,
    modifiedAt: typeof t.modifiedAt === 'string' ? t.modifiedAt : null,
  };
}

// ============================================================================
// email campaigns — create / update (POST/PUT /emailCampaigns) + send-test
// ============================================================================

export interface CampaignRecipients {
  listIds?: number[];
  exclusionListIds?: number[];
  segmentIds?: number[];
}

export interface CampaignBody {
  name: string;
  subject?: string;
  sender: SenderRef;
  htmlContent?: string;
  htmlUrl?: string;
  templateId?: number;
  recipients?: CampaignRecipients;
  scheduledAt?: string;
  replyTo?: string;
  toField?: string;
  tag?: string;
  previewText?: string;
}

function validateIntArray(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every((n) => Number.isInteger(n))) {
    throw new Error(`${field} must be an array of integers (Brevo ids).`);
  }
}

function validateCampaignRecipients(raw: unknown): void {
  if (raw === undefined) return;
  if (!isPlainObject(raw)) {
    throw new Error('recipients must be an object { listIds?, exclusionListIds?, segmentIds? }.');
  }
  validateIntArray(raw.listIds, 'recipients.listIds');
  validateIntArray(raw.exclusionListIds, 'recipients.exclusionListIds');
  validateIntArray(raw.segmentIds, 'recipients.segmentIds');
}

/**
 * Exactly one of htmlContent (≥10 chars) / htmlUrl (http) / templateId (int) —
 * Brevo rejects more than one and requires at least one for the content.
 */
function validateCampaignContent(args: Record<string, unknown>): void {
  const hasHtml = isNonEmptyString(args.htmlContent);
  const hasUrl = isNonEmptyString(args.htmlUrl);
  const hasTemplate = coerceInt(args.templateId) != null;
  const count = [hasHtml, hasUrl, hasTemplate].filter(Boolean).length;
  if (count === 0) {
    throw new Error('Provide exactly one of htmlContent, htmlUrl or templateId.');
  }
  if (count > 1) {
    throw new Error(
      'htmlContent, htmlUrl and templateId are mutually exclusive — provide only one.',
    );
  }
  if (hasHtml && (args.htmlContent as string).trim().length < 10) {
    throw new Error('htmlContent must be at least 10 characters (Brevo requirement).');
  }
  if (hasUrl && !isHttpUrl(args.htmlUrl)) {
    throw new Error('htmlUrl must be a valid http(s) URL.');
  }
}

export function validateCreateCampaignArgs(args: unknown): void {
  if (!isPlainObject(args)) throw new Error('Invalid arguments: expected an object.');
  if (!isNonEmptyString(args.name)) {
    throw new Error('name is required and must be a non-empty string.');
  }
  if (!isNonEmptyString(args.subject)) {
    throw new Error('subject is required and must be a non-empty string.');
  }
  assertSenderEmailXorId(args.sender);
  validateCampaignContent(args);
  validateCampaignRecipients(args.recipients);
  if (args.replyTo !== undefined && !isValidEmail(args.replyTo)) {
    throw new Error('replyTo must be a valid email address.');
  }
  // Brevo requires listIds once the campaign is scheduled.
  if (isNonEmptyString(args.scheduledAt)) {
    const listIds = isPlainObject(args.recipients) ? args.recipients.listIds : undefined;
    if (!Array.isArray(listIds) || listIds.length === 0) {
      throw new Error('recipients.listIds is required when scheduledAt is set.');
    }
  }
}

/** Build the exact `POST /emailCampaigns` body. Assumes validation passed. */
export function buildCampaignBody(args: Record<string, unknown>): CampaignBody {
  const body: CampaignBody = {
    name: String(args.name).trim(),
    sender: buildSenderRef(args.sender as Record<string, unknown>),
  };
  if (isNonEmptyString(args.subject)) body.subject = String(args.subject).trim();
  if (isNonEmptyString(args.htmlContent)) body.htmlContent = args.htmlContent;
  if (isNonEmptyString(args.htmlUrl)) body.htmlUrl = String(args.htmlUrl).trim();
  const templateId = coerceInt(args.templateId);
  if (templateId != null) body.templateId = templateId;

  if (isPlainObject(args.recipients)) {
    const r = args.recipients as Record<string, unknown>;
    const recipients: CampaignRecipients = {};
    if (Array.isArray(r.listIds) && r.listIds.length > 0) {
      recipients.listIds = (r.listIds as number[]).map(Number);
    }
    if (Array.isArray(r.exclusionListIds) && r.exclusionListIds.length > 0) {
      recipients.exclusionListIds = (r.exclusionListIds as number[]).map(Number);
    }
    if (Array.isArray(r.segmentIds) && r.segmentIds.length > 0) {
      recipients.segmentIds = (r.segmentIds as number[]).map(Number);
    }
    if (Object.keys(recipients).length > 0) body.recipients = recipients;
  }

  if (isNonEmptyString(args.scheduledAt)) body.scheduledAt = String(args.scheduledAt).trim();
  if (isNonEmptyString(args.replyTo)) body.replyTo = String(args.replyTo).trim();
  if (isNonEmptyString(args.toField)) body.toField = args.toField;
  if (isNonEmptyString(args.tag)) body.tag = String(args.tag).trim();
  if (isNonEmptyString(args.previewText)) body.previewText = args.previewText;
  return body;
}

export interface SendTestBody {
  emailTo: string[];
}

export function validateSendTestArgs(args: unknown): void {
  if (!isPlainObject(args)) throw new Error('Invalid arguments: expected an object.');
  if (coerceInt(args.campaignId) == null) {
    throw new Error('campaignId is required and must be an integer.');
  }
  if (!Array.isArray(args.emailTo) || args.emailTo.length === 0) {
    throw new Error('emailTo is required and must be a non-empty array of email addresses.');
  }
  args.emailTo.forEach((e, i) => {
    if (!isValidEmail(e)) throw new Error(`emailTo[${i}] is not a valid email address.`);
  });
  if (args.emailTo.length > 99) {
    throw new Error('emailTo accepts at most 99 recipients.');
  }
}

export function buildSendTestBody(args: Record<string, unknown>): SendTestBody {
  return { emailTo: (args.emailTo as string[]).map((e) => String(e).trim()) };
}

// ============================================================================
// contact CRUD — get / update / delete + list membership (add / remove)
// ============================================================================

/**
 * The contact identifier for get/update/delete goes in the URL path. Brevo
 * accepts an email, a numeric id or an EXT_ID — we pass it through verbatim
 * (the handler URL-encodes it) and only reject empty input at the boundary.
 */
export function validateContactIdentifier(value: unknown): string {
  if (!isNonEmptyString(value)) {
    throw new Error('identifier is required (the contact email or id).');
  }
  return value.trim();
}

export interface UpdateContactBody {
  attributes?: Record<string, unknown>;
  emailBlacklisted?: boolean;
  smsBlacklisted?: boolean;
  listIds?: number[];
  unlinkListIds?: number[];
}

export function validateUpdateContactArgs(args: unknown): void {
  if (!isPlainObject(args)) throw new Error('Invalid arguments: expected an object.');
  validateContactIdentifier(args.identifier);
  if (args.attributes !== undefined && !isPlainObject(args.attributes)) {
    throw new Error('attributes must be an object (e.g. { FIRSTNAME, LASTNAME }).');
  }
  validateIntArray(args.listIds, 'listIds');
  validateIntArray(args.unlinkListIds, 'unlinkListIds');
  const hasChange =
    args.attributes !== undefined ||
    typeof args.emailBlacklisted === 'boolean' ||
    typeof args.smsBlacklisted === 'boolean' ||
    (Array.isArray(args.listIds) && args.listIds.length > 0) ||
    (Array.isArray(args.unlinkListIds) && args.unlinkListIds.length > 0);
  if (!hasChange) {
    throw new Error(
      'Provide at least one field to update (attributes, emailBlacklisted, smsBlacklisted, listIds or unlinkListIds).',
    );
  }
}

export function buildUpdateContactBody(args: Record<string, unknown>): UpdateContactBody {
  const body: UpdateContactBody = {};
  if (isPlainObject(args.attributes)) body.attributes = args.attributes;
  if (typeof args.emailBlacklisted === 'boolean') body.emailBlacklisted = args.emailBlacklisted;
  if (typeof args.smsBlacklisted === 'boolean') body.smsBlacklisted = args.smsBlacklisted;
  if (Array.isArray(args.listIds) && args.listIds.length > 0) {
    body.listIds = (args.listIds as number[]).map(Number);
  }
  if (Array.isArray(args.unlinkListIds) && args.unlinkListIds.length > 0) {
    body.unlinkListIds = (args.unlinkListIds as number[]).map(Number);
  }
  return body;
}

export interface MembershipBody {
  emails?: string[];
  ids?: number[];
}

/** Shared validation for add/remove contact ↔ list (POST .../contacts/{add,remove}). */
export function validateMembershipArgs(args: unknown): void {
  if (!isPlainObject(args)) throw new Error('Invalid arguments: expected an object.');
  if (coerceInt(args.listId) == null) {
    throw new Error('listId is required and must be an integer.');
  }
  if (args.emails !== undefined) {
    if (!Array.isArray(args.emails)) {
      throw new Error('emails must be an array of email addresses.');
    }
    args.emails.forEach((e, i) => {
      if (!isValidEmail(e)) throw new Error(`emails[${i}] is not a valid email address.`);
    });
  }
  validateIntArray(args.ids, 'ids');
  const hasEmails = Array.isArray(args.emails) && args.emails.length > 0;
  const hasIds = Array.isArray(args.ids) && args.ids.length > 0;
  if (!hasEmails && !hasIds) {
    throw new Error('Provide at least one of emails[] or ids[] to identify the contacts.');
  }
}

export function buildMembershipBody(args: Record<string, unknown>): MembershipBody {
  const body: MembershipBody = {};
  if (Array.isArray(args.emails) && args.emails.length > 0) {
    body.emails = (args.emails as string[]).map((e) => String(e).trim());
  }
  if (Array.isArray(args.ids) && args.ids.length > 0) {
    body.ids = (args.ids as number[]).map(Number);
  }
  return body;
}

/**
 * Brevo returns `{ contacts: { success: [...], failure: [...] } }` for
 * add/remove-to-list. Shape it to flat success/failure arrays.
 */
export interface ShapedMembership {
  success: Array<string | number>;
  failure: Array<string | number>;
}

export function shapeMembershipResult(raw: unknown): ShapedMembership {
  const contacts = isPlainObject(raw) && isPlainObject(raw.contacts) ? raw.contacts : {};
  return {
    success: Array.isArray(contacts.success) ? (contacts.success as Array<string | number>) : [],
    failure: Array.isArray(contacts.failure) ? (contacts.failure as Array<string | number>) : [],
  };
}

// ============================================================================
// import-contacts (POST /contacts/import)
// ============================================================================

export interface ImportContactEntry {
  email: string;
  attributes?: Record<string, unknown>;
}

export interface ImportContactsBody {
  jsonBody?: ImportContactEntry[];
  fileUrl?: string;
  listIds: number[];
  updateExistingContacts?: boolean;
}

/**
 * Import contacts in bulk. We expose a deliberately narrow slice of Brevo's
 * `ImportContactsRequest`:
 *   - the payload is EITHER inline `jsonBody` (an array of { email, attributes? })
 *     XOR a remote `fileUrl` (.csv/.json/.txt) — exactly one, never both.
 *   - `listIds` is REQUIRED. Brevo mandates it "if newList is not defined", and
 *     we never send `newList` (creating a list mid-import is out of scope — use
 *     create-list first), so an import without a target list is always a 400.
 *
 * Not exposed on purpose: `fileBody` (inline CSV — huge, error-prone; use
 * fileUrl), `newList` (see above), `notifyUrl` (webhook — no MCA surface for it).
 */
export function validateImportContactsArgs(args: unknown): void {
  if (!isPlainObject(args)) throw new Error('Invalid arguments: expected an object.');

  const hasJson = Array.isArray(args.jsonBody) && args.jsonBody.length > 0;
  const hasFile = isNonEmptyString(args.fileUrl);
  if (hasJson && hasFile) {
    throw new Error('Provide exactly one of jsonBody or fileUrl, not both.');
  }
  if (!hasJson && !hasFile) {
    throw new Error('Provide the contacts to import via jsonBody[] or fileUrl.');
  }

  if (hasJson) {
    (args.jsonBody as unknown[]).forEach((item, i) => {
      if (!isPlainObject(item) || !isValidEmail(item.email)) {
        throw new Error(`jsonBody[${i}].email must be a valid email address.`);
      }
      if (item.attributes !== undefined && !isPlainObject(item.attributes)) {
        throw new Error(`jsonBody[${i}].attributes must be an object (e.g. { FIRSTNAME, LASTNAME }).`);
      }
    });
  }
  if (hasFile && !isHttpUrl(args.fileUrl)) {
    throw new Error('fileUrl must be a valid http(s) URL to a .csv/.json/.txt file.');
  }

  // listIds — required, non-empty array of integers.
  if (!Array.isArray(args.listIds) || args.listIds.length === 0) {
    throw new Error('listIds is required and must be a non-empty array of integer Brevo list ids.');
  }
  if (!args.listIds.every((n) => Number.isInteger(n))) {
    throw new Error('listIds must contain only integers (Brevo list ids).');
  }
}

/** Build the exact `POST /contacts/import` body. Assumes validation passed. */
export function buildImportContactsBody(args: Record<string, unknown>): ImportContactsBody {
  const body: ImportContactsBody = {
    listIds: (args.listIds as number[]).map(Number),
  };
  if (Array.isArray(args.jsonBody) && args.jsonBody.length > 0) {
    body.jsonBody = (args.jsonBody as Record<string, unknown>[]).map((item) => {
      const entry: ImportContactEntry = { email: String(item.email).trim() };
      if (isPlainObject(item.attributes)) entry.attributes = item.attributes;
      return entry;
    });
  }
  if (isNonEmptyString(args.fileUrl)) body.fileUrl = String(args.fileUrl).trim();
  if (typeof args.updateExistingContacts === 'boolean') {
    body.updateExistingContacts = args.updateExistingContacts;
  }
  return body;
}

// ============================================================================
// list-attributes (GET /contacts/attributes) — response shaping
// ============================================================================

export interface ShapedAttribute {
  name: string | null;
  category: string | null;
  type: string | null;
}

/**
 * Shape one contact attribute. `type` is optional in Brevo (category-type
 * attributes carry no `type`), so it stays nullable. `calculatedValue`,
 * `enumeration` and `multiCategoryOptions` are dropped — noise for the model.
 */
export function shapeAttribute(raw: unknown): ShapedAttribute {
  const a = isPlainObject(raw) ? raw : {};
  return {
    name: typeof a.name === 'string' ? a.name : null,
    category: typeof a.category === 'string' ? a.category : null,
    type: typeof a.type === 'string' ? a.type : null,
  };
}

// ============================================================================
// list-segments (GET /contacts/segments) — response shaping
// ============================================================================

export interface ShapedSegment {
  id: number | null;
  segmentName: string | null;
  categoryName: string | null;
  updatedAt: string | null;
}

export function shapeSegment(raw: unknown): ShapedSegment {
  const s = isPlainObject(raw) ? raw : {};
  return {
    id: typeof s.id === 'number' ? s.id : null,
    segmentName: typeof s.segmentName === 'string' ? s.segmentName : null,
    categoryName: typeof s.categoryName === 'string' ? s.categoryName : null,
    updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : null,
  };
}

// ============================================================================
// SMTP statistics reports — shared date-range validation
// (get-email-event-report + get-aggregated-smtp-report)
// ============================================================================

const YYYY_MM_DD_RE = /^\d{4}-\d{2}-\d{2}$/;

export const EMAIL_EVENT_TYPES = [
  'bounces',
  'hardBounces',
  'softBounces',
  'delivered',
  'spam',
  'requests',
  'opened',
  'clicks',
  'invalid',
  'deferred',
  'blocked',
  'unsubscribed',
  'error',
  'loadedByProxy',
] as const;

export const REPORT_SORT = ['asc', 'desc'] as const;

/**
 * Both report endpoints share the same timeframe contract:
 *   - `days` (1-90) is mutually exclusive with an explicit `startDate`/`endDate`.
 *   - `startDate` and `endDate` must be provided together (Brevo mandates each
 *     "if the other is used") and be well-formed YYYY-MM-DD with start ≤ end.
 * Lexicographic comparison is valid because both are validated to YYYY-MM-DD.
 */
export function validateReportDateRange(args: Record<string, unknown>): void {
  const hasStart = isNonEmptyString(args.startDate);
  const hasEnd = isNonEmptyString(args.endDate);
  const hasDays = args.days !== undefined && args.days !== null && args.days !== '';

  if (hasDays && (hasStart || hasEnd)) {
    throw new Error(
      'days is not compatible with startDate/endDate — provide either days or a startDate+endDate range.',
    );
  }
  if (hasStart !== hasEnd) {
    throw new Error('startDate and endDate must be provided together (a full date range).');
  }
  if (hasStart && !YYYY_MM_DD_RE.test(String(args.startDate).trim())) {
    throw new Error('startDate must be in YYYY-MM-DD format.');
  }
  if (hasEnd && !YYYY_MM_DD_RE.test(String(args.endDate).trim())) {
    throw new Error('endDate must be in YYYY-MM-DD format.');
  }
  if (hasStart && hasEnd && String(args.startDate).trim() > String(args.endDate).trim()) {
    throw new Error('startDate must be less than or equal to endDate.');
  }
  if (hasDays) {
    const d = coerceInt(args.days);
    if (d == null || d < 1 || d > 90) {
      throw new Error('days must be an integer between 1 and 90.');
    }
  }
}

// ============================================================================
// get-email-event-report (GET /smtp/statistics/events)
// ============================================================================

export interface EmailEventQuery {
  limit: number;
  offset: number;
  startDate?: string;
  endDate?: string;
  days?: number;
  email?: string;
  event?: string;
  messageId?: string;
  templateId?: number;
  sort?: string;
}

export function validateEmailEventReportArgs(args: unknown): void {
  if (!isPlainObject(args)) throw new Error('Invalid arguments: expected an object.');
  validateReportDateRange(args);
  if (args.email !== undefined && !isValidEmail(args.email)) {
    throw new Error('email must be a valid email address.');
  }
  // validateEnum throws with the allowed list when the value is present but invalid.
  validateEnum(args.event, EMAIL_EVENT_TYPES, 'event');
  validateEnum(args.sort, REPORT_SORT, 'sort');
  if (args.messageId !== undefined && !isNonEmptyString(args.messageId)) {
    throw new Error('messageId must be a non-empty string.');
  }
  if (args.templateId !== undefined && coerceInt(args.templateId) == null) {
    throw new Error('templateId must be an integer.');
  }
}

/** Build the exact query for `GET /smtp/statistics/events`. Assumes validation passed. */
export function buildEmailEventQuery(args: Record<string, unknown>): EmailEventQuery {
  const q: EmailEventQuery = {
    limit: clampInt(args.limit, 1, 5000, 100),
    offset: clampInt(args.offset, 0, Number.MAX_SAFE_INTEGER, 0),
  };
  if (isNonEmptyString(args.startDate)) q.startDate = String(args.startDate).trim();
  if (isNonEmptyString(args.endDate)) q.endDate = String(args.endDate).trim();
  const days = coerceInt(args.days);
  if (days != null) q.days = days;
  if (isValidEmail(args.email)) q.email = String(args.email).trim();
  if (isNonEmptyString(args.event)) q.event = String(args.event).trim();
  if (isNonEmptyString(args.messageId)) q.messageId = String(args.messageId).trim();
  const templateId = coerceInt(args.templateId);
  if (templateId != null) q.templateId = templateId;
  if (isNonEmptyString(args.sort)) q.sort = String(args.sort).trim();
  return q;
}

export interface ShapedEmailEvent {
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

/** Shape one email event. `ip` is dropped (noise); everything else is optional upstream. */
export function shapeEmailEvent(raw: unknown): ShapedEmailEvent {
  const e = isPlainObject(raw) ? raw : {};
  return {
    date: typeof e.date === 'string' ? e.date : null,
    email: typeof e.email === 'string' ? e.email : null,
    event: typeof e.event === 'string' ? e.event : null,
    messageId: typeof e.messageId === 'string' ? e.messageId : null,
    subject: typeof e.subject === 'string' ? e.subject : null,
    tag: typeof e.tag === 'string' ? e.tag : null,
    reason: typeof e.reason === 'string' ? e.reason : null,
    link: typeof e.link === 'string' ? e.link : null,
    from: typeof e.from === 'string' ? e.from : null,
    templateId: typeof e.templateId === 'number' ? e.templateId : null,
  };
}

// ============================================================================
// get-aggregated-smtp-report (GET /smtp/statistics/aggregatedReport)
// ============================================================================

export interface AggregatedReportQuery {
  startDate?: string;
  endDate?: string;
  days?: number;
  tag?: string;
}

export function validateAggregatedReportArgs(args: unknown): void {
  if (!isPlainObject(args)) throw new Error('Invalid arguments: expected an object.');
  validateReportDateRange(args);
  if (args.tag !== undefined && !isNonEmptyString(args.tag)) {
    throw new Error('tag must be a non-empty string.');
  }
}

/** Build the exact query for `GET /smtp/statistics/aggregatedReport`. Assumes validation passed. */
export function buildAggregatedReportQuery(args: Record<string, unknown>): AggregatedReportQuery {
  const q: AggregatedReportQuery = {};
  if (isNonEmptyString(args.startDate)) q.startDate = String(args.startDate).trim();
  if (isNonEmptyString(args.endDate)) q.endDate = String(args.endDate).trim();
  const days = coerceInt(args.days);
  if (days != null) q.days = days;
  if (isNonEmptyString(args.tag)) q.tag = String(args.tag).trim();
  return q;
}

export interface AggregatedSmtpReport {
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

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

export function shapeAggregatedReport(raw: unknown): AggregatedSmtpReport {
  const r = isPlainObject(raw) ? raw : {};
  return {
    range: typeof r.range === 'string' ? r.range : null,
    requests: numOrNull(r.requests),
    delivered: numOrNull(r.delivered),
    opens: numOrNull(r.opens),
    uniqueOpens: numOrNull(r.uniqueOpens),
    clicks: numOrNull(r.clicks),
    uniqueClicks: numOrNull(r.uniqueClicks),
    hardBounces: numOrNull(r.hardBounces),
    softBounces: numOrNull(r.softBounces),
    blocked: numOrNull(r.blocked),
    invalid: numOrNull(r.invalid),
    spamReports: numOrNull(r.spamReports),
    unsubscribed: numOrNull(r.unsubscribed),
  };
}
