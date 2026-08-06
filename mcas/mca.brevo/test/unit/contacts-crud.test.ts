import { describe, expect, it } from 'bun:test';
import {
  buildMembershipBody,
  buildUpdateContactBody,
  shapeMembershipResult,
  validateContactIdentifier,
  validateMembershipArgs,
  validateUpdateContactArgs,
} from '../../src/tools/_helpers';

// ============================================================================
// contact identifier (get / update / delete path)
// ============================================================================

describe('validateContactIdentifier', () => {
  it('trims and returns a non-empty identifier', () => {
    expect(validateContactIdentifier('x@y.com')).toBe('x@y.com');
    expect(validateContactIdentifier('  123  ')).toBe('123');
  });
  it('rejects empty / non-string', () => {
    expect(() => validateContactIdentifier('')).toThrow(/identifier is required/);
    expect(() => validateContactIdentifier('   ')).toThrow(/identifier is required/);
    expect(() => validateContactIdentifier(123)).toThrow(/identifier is required/);
  });
});

// ============================================================================
// update-contact
// ============================================================================

describe('validateUpdateContactArgs', () => {
  it('passes with a mutable field present', () => {
    expect(() =>
      validateUpdateContactArgs({ identifier: 'x@y.com', attributes: { FIRSTNAME: 'X' } }),
    ).not.toThrow();
    expect(() =>
      validateUpdateContactArgs({ identifier: 'x@y.com', listIds: [1] }),
    ).not.toThrow();
    expect(() =>
      validateUpdateContactArgs({ identifier: 'x@y.com', emailBlacklisted: true }),
    ).not.toThrow();
  });
  it('rejects a missing identifier', () => {
    expect(() => validateUpdateContactArgs({ attributes: { A: 1 } })).toThrow(/identifier is required/);
  });
  it('rejects an update with no mutable field', () => {
    expect(() => validateUpdateContactArgs({ identifier: 'x@y.com' })).toThrow(
      /at least one field to update/,
    );
    // empty listIds does not count as a change
    expect(() => validateUpdateContactArgs({ identifier: 'x@y.com', listIds: [] })).toThrow(
      /at least one field to update/,
    );
  });
  it('rejects non-object attributes and non-integer list ids', () => {
    expect(() => validateUpdateContactArgs({ identifier: 'x@y.com', attributes: [1] })).toThrow(
      /attributes/,
    );
    expect(() =>
      validateUpdateContactArgs({ identifier: 'x@y.com', unlinkListIds: [1, 'z'] }),
    ).toThrow(/unlinkListIds/);
  });
});

describe('buildUpdateContactBody', () => {
  it('builds the exact body and omits absent fields', () => {
    const body = buildUpdateContactBody({
      identifier: 'x@y.com',
      attributes: { FIRSTNAME: 'Ana' },
      emailBlacklisted: false,
      listIds: [1, 2],
      unlinkListIds: [9],
    });
    expect(body).toEqual({
      attributes: { FIRSTNAME: 'Ana' },
      emailBlacklisted: false,
      listIds: [1, 2],
      unlinkListIds: [9],
    });
    // identifier is a path param, never part of the body
    expect('identifier' in body).toBe(false);
  });
  it('omits empty list arrays', () => {
    const body = buildUpdateContactBody({ identifier: 'x@y.com', attributes: { A: 1 }, listIds: [] });
    expect(body).toEqual({ attributes: { A: 1 } });
    expect('listIds' in body).toBe(false);
  });
});

// ============================================================================
// add / remove contact to list (shared validation)
// ============================================================================

describe('validateMembershipArgs', () => {
  it('passes with emails or ids', () => {
    expect(() => validateMembershipArgs({ listId: 3, emails: ['a@b.com'] })).not.toThrow();
    expect(() => validateMembershipArgs({ listId: 3, ids: [1, 2] })).not.toThrow();
  });
  it('rejects a missing listId', () => {
    expect(() => validateMembershipArgs({ emails: ['a@b.com'] })).toThrow(/listId is required/);
  });
  it('rejects when neither emails nor ids are provided', () => {
    expect(() => validateMembershipArgs({ listId: 3 })).toThrow(/at least one of emails\[\] or ids\[\]/);
    expect(() => validateMembershipArgs({ listId: 3, emails: [], ids: [] })).toThrow(
      /at least one of emails\[\] or ids\[\]/,
    );
  });
  it('reports the offending email index and rejects non-integer ids', () => {
    expect(() => validateMembershipArgs({ listId: 3, emails: ['ok@x.com', 'bad'] })).toThrow(
      /emails\[1\]/,
    );
    expect(() => validateMembershipArgs({ listId: 3, ids: [1, 'x'] })).toThrow(/ids/);
  });
});

describe('buildMembershipBody', () => {
  it('trims emails and maps ids, omitting empty', () => {
    expect(buildMembershipBody({ listId: 3, emails: ['  a@b.com  '], ids: [1] })).toEqual({
      emails: ['a@b.com'],
      ids: [1],
    });
    expect(buildMembershipBody({ listId: 3, ids: [5] })).toEqual({ ids: [5] });
  });
});

// ============================================================================
// membership response shaping
// ============================================================================

describe('shapeMembershipResult', () => {
  it('flattens contacts.success/failure', () => {
    expect(
      shapeMembershipResult({ contacts: { success: ['a@b.com'], failure: ['c@d.com'] } }),
    ).toEqual({ success: ['a@b.com'], failure: ['c@d.com'] });
  });
  it('defaults to empty arrays when contacts is missing', () => {
    expect(shapeMembershipResult({})).toEqual({ success: [], failure: [] });
    expect(shapeMembershipResult(null)).toEqual({ success: [], failure: [] });
  });
});
