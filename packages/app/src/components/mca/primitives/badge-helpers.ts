import type { BadgeVariant } from './Badge';

/**
 * Returns the badge variant for a count-based read operation.
 * Per renderer-ux-guide §4: gray when empty (count <= 0), success when > 0.
 *
 * Use as: <Badge text={formatCountBadge(count, 'event')} variant={countBadgeVariant(count)} />
 */
export function countBadgeVariant(count: number): BadgeVariant {
  return count <= 0 ? 'gray' : 'success';
}

/**
 * Returns formatted text for a count-based badge.
 *
 *   formatCountBadge(0, 'event')              → 'empty'
 *   formatCountBadge(1, 'event')              → '1 event'
 *   formatCountBadge(3, 'event')              → '3 events'
 *   formatCountBadge(2, 'person', 'people')   → '2 people'
 */
export function formatCountBadge(count: number, singular: string, plural?: string): string {
  if (count <= 0) return 'empty';
  if (count === 1) return `1 ${singular}`;
  return `${count} ${plural ?? `${singular}s`}`;
}
