/**
 * Shared helpers for ActiveCampaign tools.
 *
 * - `wrap<T>` — every tool returns `{ content, structuredContent }` (criterion 15).
 * - `withRaw` — `includeRaw` escape hatch (criterion 10).
 * - parsers map raw API shapes to curated MCA shapes.
 */

interface AcContact {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  cdate: string;
  udate: string;
}

interface AcList {
  id: string;
  name: string;
  stringid: string;
  subscriberCount: number | null;
  cdate: string;
}

interface AcCampaign {
  id: string;
  name: string;
  type: string;
  status: string;
  sendDate: string | null;
  fromName: string;
  fromEmail: string;
  subject: string;
  totalRecipients: number;
  totalOpens: number;
  totalLinks: number;
  uniqueOpens: number;
  uniqueLinks: number;
  cdate: string;
}

interface AcDeal {
  id: string;
  title: string;
  description: string;
  value: number;
  currency: string;
  status: number;
  contact: string | null;
  account: string | null;
  pipeline: string | null;
  stage: string | null;
  owner: string | null;
  cdate: string;
  udate: string;
}

interface AcTag {
  id: string;
  name: string;
  description: string;
  tagType: string;
  cdate: string;
}

export function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

export function asNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : fallback;
}

export function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

export function parseContact(raw: unknown): AcContact {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: asString(r.id),
    email: asString(r.email),
    firstName: asString(r.firstName),
    lastName: asString(r.lastName),
    phone: asString(r.phone),
    cdate: asString(r.cdate),
    udate: asString(r.udate),
  };
}

export function parseList(raw: unknown): AcList {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: asString(r.id),
    name: asString(r.name),
    stringid: asString(r.stringid),
    subscriberCount: asNullableNumber(r.subscriber_count ?? r.subscriberCount),
    cdate: asString(r.cdate),
  };
}

export function parseCampaign(raw: unknown): AcCampaign {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: asString(r.id),
    name: asString(r.name),
    type: asString(r.type),
    status: asString(r.status),
    sendDate: asNullableString(r.sdate ?? r.send_date),
    fromName: asString(r.fromname ?? r.fromName),
    fromEmail: asString(r.fromemail ?? r.fromEmail),
    subject: asString(r.subject),
    // AC v3 reports the number of sends as `send_amt`; `total_amt` is the
    // monetary/aggregate total, not a recipient count. Prefer `send_amt`,
    // falling back to the older fields so curated open/click rates stay correct.
    totalRecipients: asNumber(r.send_amt ?? r.total_amt ?? r.totalRecipients),
    totalOpens: asNumber(r.opens),
    totalLinks: asNumber(r.linkclicks ?? r.totalLinks),
    uniqueOpens: asNumber(r.uniqueopens ?? r.uniqueOpens),
    uniqueLinks: asNumber(r.uniquelinkclicks ?? r.uniqueLinks),
    cdate: asString(r.cdate),
  };
}

export function parseDeal(raw: unknown): AcDeal {
  const r = (raw ?? {}) as Record<string, unknown>;
  // ActiveCampaign returns deal value in cents.
  const valueRaw = asNumber(r.value);
  return {
    id: asString(r.id),
    title: asString(r.title),
    description: asString(r.description),
    value: valueRaw / 100,
    currency: asString(r.currency, 'usd').toUpperCase(),
    status: asNumber(r.status),
    contact: asNullableString(r.contact),
    account: asNullableString(r.account),
    pipeline: asNullableString(r.group),
    stage: asNullableString(r.stage),
    owner: asNullableString(r.owner),
    cdate: asString(r.cdate),
    udate: asString(r.udate),
  };
}

export function parseTag(raw: unknown): AcTag {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: asString(r.id),
    name: asString(r.tag ?? r.name),
    description: asString(r.description),
    tagType: asString(r.tagType ?? r.tag_type, 'contact'),
    cdate: asString(r.cdate),
  };
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number | null;
  nextOffset: number | null;
}

export function buildPaginated<T>(
  items: T[],
  meta: unknown,
  offset: number,
  limit: number,
): PaginatedResponse<T> {
  const total =
    meta && typeof meta === 'object'
      ? asNullableNumber((meta as Record<string, unknown>).total)
      : null;
  // No items returned → nothing more to page through, even if `total` (which can
  // overcount under server-side filters) still exceeds `offset`. Returning
  // `offset` here would make a paging agent re-fetch the same empty page forever.
  const nextOffset =
    items.length > 0 && total !== null && offset + items.length < total
      ? offset + items.length
      : null;
  return { items, total, nextOffset };
}

export function wrap<T>(data: T, raw?: unknown) {
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  if (raw !== undefined) out.raw = raw;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }],
    structuredContent: out,
  };
}

export type { AcCampaign, AcContact, AcDeal, AcList, AcTag };
