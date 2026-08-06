/**
 * Pin contracts for the count-badge helpers and the MAX_ITEMS constant.
 *
 * These are pure helpers. The whole reason they exist is to remove the
 * "every renderer reinvents how to handle count=0" inconsistency that
 * the audit revealed (some used `variant="info"` always, some used
 * `count > 0 ? success : warning`, etc.). Tests here pin the canonical
 * behavior so that future drift is caught immediately.
 */
import { describe, expect, it } from 'bun:test';

import {
  countBadgeVariant,
  formatCountBadge,
} from '../../../../packages/app/src/components/mca/primitives/badge-helpers';
import { MAX_ITEMS } from '../../../../packages/app/src/components/mca/primitives/constants';

describe('countBadgeVariant', () => {
  it('returns "gray" when count is exactly zero', () => {
    expect(countBadgeVariant(0)).toBe('gray');
  });

  it('returns "success" for any positive count', () => {
    expect(countBadgeVariant(1)).toBe('success');
    expect(countBadgeVariant(99)).toBe('success');
    expect(countBadgeVariant(1000)).toBe('success');
  });

  it('treats negative as gray (defensive — should never happen but harmless)', () => {
    expect(countBadgeVariant(-1)).toBe('gray');
  });
});

describe('formatCountBadge', () => {
  it('returns "empty" when count is zero', () => {
    expect(formatCountBadge(0, 'event')).toBe('empty');
  });

  it('returns singular when count is exactly 1', () => {
    expect(formatCountBadge(1, 'event')).toBe('1 event');
    expect(formatCountBadge(1, 'file')).toBe('1 file');
  });

  it('appends "s" by default for the plural form', () => {
    expect(formatCountBadge(3, 'event')).toBe('3 events');
    expect(formatCountBadge(12, 'file')).toBe('12 files');
  });

  it('uses the explicit plural when provided (irregular plurals)', () => {
    expect(formatCountBadge(2, 'person', 'people')).toBe('2 people');
    expect(formatCountBadge(5, 'child', 'children')).toBe('5 children');
  });

  it('uses singular even when explicit plural is provided (count === 1)', () => {
    expect(formatCountBadge(1, 'person', 'people')).toBe('1 person');
  });

  it('treats negative count as empty', () => {
    expect(formatCountBadge(-1, 'event')).toBe('empty');
  });
});

describe('MAX_ITEMS', () => {
  it('is exactly 50 per guide §7', () => {
    // Pinned. If a future change wants to alter this, it must do so
    // intentionally — bridge perf regressions in RN past 50 are well
    // documented and the guide is explicit.
    expect(MAX_ITEMS).toBe(50);
  });
});
