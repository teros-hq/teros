/**
 * HUBSPOT_DEFINED association typeIds for the v4 Associations API.
 *
 * Source: official HubSpot docs table "Association type ID values"
 * (developers.hubspot.com, CRM Associations API v4 — verified 2026-09-28).
 * TypeIds are per (fromObjectType, toObjectType) pair AND direction — e.g.
 * typeId 1 is ONLY contact→primary company. Sending typeId 1 for any other
 * pair (task→deal, note→deal, …) is rejected with HTTP 400, which is exactly
 * the support report of 2026-09-11 ("error 400 al crear notes/tasks
 * asociados a deals").
 *
 * Engagement pairs (tasks/notes/calls/emails/meetings → CRM objects) have a
 * single HUBSPOT_DEFINED typeId each. CRM↔CRM pairs have unlabeled and
 * "primary" variants; the primary one is used as the default because it
 * matches the semantics of the old v1 default table (1, 2, 3, 4, 5, 6, 15,
 * 16, 25, 26, 27, 28).
 *
 * If HubSpot adds new pairs, resolveAssociationTypeId returns undefined and
 * callers must surface the failure instead of guessing a typeId.
 */

// From engagement object → to CRM object (single typeId per pair).
const ENGAGEMENT_PAIRS: Record<string, Record<string, number>> = {
  tasks: { contacts: 204, companies: 192, deals: 216, tickets: 230 },
  notes: { contacts: 202, companies: 190, deals: 214, tickets: 228 },
  calls: { contacts: 194, companies: 182, deals: 206, tickets: 220 },
  emails: { contacts: 198, companies: 186, deals: 210, tickets: 224 },
  meetings: { contacts: 200, companies: 188, deals: 212, tickets: 226 },
};

// From CRM object → to CRM object (primary association as default).
const CRM_PAIRS: Record<string, Record<string, number>> = {
  contacts: { companies: 1, deals: 4, tickets: 15 },
  companies: { contacts: 2, deals: 6, tickets: 25 },
  deals: { contacts: 3, companies: 5, tickets: 27 },
  tickets: { contacts: 16, companies: 26, deals: 28 },
};

/** Verified HUBSPOT_DEFINED typeIds, keyed fromObjectType → toObjectType → typeId. */
export const ASSOCIATION_TYPE_IDS: Record<string, Record<string, number>> = {
  ...ENGAGEMENT_PAIRS,
  ...CRM_PAIRS,
};

/** All object types that can appear as the `from` side of a known pair. */
export const ASSOCIATION_FROM_TYPES = Object.keys(ASSOCIATION_TYPE_IDS);

/**
 * Resolve the default HUBSPOT_DEFINED associationTypeId for a pair.
 * Returns undefined for unknown pairs — do NOT fall back to a hardcoded id.
 */
export function resolveAssociationTypeId(
  fromObjectType: string,
  toObjectType: string,
): number | undefined {
  return ASSOCIATION_TYPE_IDS[fromObjectType]?.[toObjectType];
}
