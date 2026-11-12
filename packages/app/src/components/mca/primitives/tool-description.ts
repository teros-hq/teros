/**
 * Tool-call header descriptions — the single standard every renderer uses
 * (docs/mcas/05-RENDERER.md §2 "Description standard").
 *
 * A description says WHAT the call does and ON WHAT / FOR WHOM, with human
 * names ("Gave Alice access to Gmail"), never raw ids. Copy lives in i18n
 * under `mca.tools.<mca>.<tool>` with one string per phase:
 *
 *   pending   — imperative, what it will do      "Give {{agent}} access to {{app}}"
 *   running   — progressive                      "Giving {{agent}} access to {{app}}"
 *   completed — past tense, what it did          "Gave {{agent}} access to {{app}}"
 *   failed    — what could not be done           "Couldn't give {{agent}} access to {{app}}"
 *
 * When a phase string interpolates names, the tool also carries the
 * `<phase>Generic` variants with no placeholders ("Give an agent access to
 * an app"). They are used whenever any of the names is unknown or looks like
 * an id, so a header never shows `{{agent}}`, an empty slot or `agent_9f3a…`.
 *
 * Pure module (no React) so it can be unit-tested under bun; renderers use
 * the `useToolDescription` hook.
 */

import type { McaStatusType } from './colors';

export type DescriptionPhase = 'pending' | 'running' | 'completed' | 'failed';

/** Minimal `t` shape — matches i18next's TFunction for our usage. */
export type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

export type DescriptionVars = Record<string, string | number | null | undefined>;

/**
 * Maps the 6 card statuses onto the 4 description phases. Approval and
 * user-input waits read like `pending`: the call has not happened yet.
 */
export function descriptionPhase(status: McaStatusType): DescriptionPhase {
  switch (status) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Teros ids: `<prefix>_<random>` (agent_…, app_…, work_…, task_…, ch_…).
const PREFIXED_ID = /^[a-z]{1,10}_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{8,}$/;
const HEX = /^[0-9a-f]{16,}$/i;
// Opaque tokens: long, no separators, letters AND digits (Mongo ids, Outlook
// AAMk…, Slack C0123ABCD, Drive file ids).
const OPAQUE = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_-]{20,}$/;
const SLACK_ID = /^[CDGUWT][A-Z0-9]{8,}$/;
const RESOURCE_NAME = /^[a-z]+\/[A-Za-z0-9_-]{6,}$/; // people/c123…, contactGroups/…
const SHORT_ID = /…/; // already truncated by shortId()

/** True when a value is an identifier rather than something a person reads. */
export function looksLikeId(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  if (/\s/.test(v)) return false;
  return (
    UUID.test(v) ||
    PREFIXED_ID.test(v) ||
    HEX.test(v) ||
    OPAQUE.test(v) ||
    SLACK_ID.test(v) ||
    RESOURCE_NAME.test(v) ||
    SHORT_ID.test(v)
  );
}

/**
 * Normalises a candidate display name: trims it and drops it when empty or
 * id-shaped. Use it on every value that reaches a header.
 */
export function displayName(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v.length === 0 || looksLikeId(v)) return undefined;
  return v;
}

/** First usable display name among the candidates. */
export function firstName(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    const name = displayName(c);
    if (name) return name;
  }
  return undefined;
}

/**
 * Resolves the header text for a tool call.
 *
 * @param key  i18n group, e.g. `mca.tools.terosCore.grantAppAccess`
 * @param vars names interpolated into the phase string. Every declared var
 *             must resolve to a display name; otherwise the `<phase>Generic`
 *             variant is used.
 */
export function describeToolCall(
  t: TranslateFn,
  key: string,
  status: McaStatusType,
  vars: DescriptionVars = {},
): string {
  const phase = descriptionPhase(status);
  const clean: Record<string, string> = {};
  let complete = true;
  for (const [name, value] of Object.entries(vars)) {
    const v = displayName(value);
    if (v === undefined) complete = false;
    else clean[name] = v;
  }

  if (!complete) {
    const generic = t(`${key}.${phase}Generic`, { defaultValue: '' });
    if (generic) return generic;
  }
  return t(`${key}.${phase}`, clean);
}
