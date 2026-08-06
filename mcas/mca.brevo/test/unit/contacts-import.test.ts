import { describe, expect, it } from 'bun:test';
import {
  buildImportContactsBody,
  shapeAttribute,
  shapeSegment,
  validateImportContactsArgs,
} from '../../src/tools/_helpers';

// ============================================================================
// import-contacts — validation (jsonBody XOR fileUrl, listIds required)
// ============================================================================

describe('validateImportContactsArgs', () => {
  it('passes with jsonBody + listIds', () => {
    expect(() =>
      validateImportContactsArgs({ jsonBody: [{ email: 'a@b.com' }], listIds: [1] }),
    ).not.toThrow();
  });

  it('passes with fileUrl + listIds', () => {
    expect(() =>
      validateImportContactsArgs({ fileUrl: 'https://x.com/c.csv', listIds: [1, 2] }),
    ).not.toThrow();
  });

  it('rejects providing BOTH jsonBody and fileUrl', () => {
    expect(() =>
      validateImportContactsArgs({
        jsonBody: [{ email: 'a@b.com' }],
        fileUrl: 'https://x.com/c.csv',
        listIds: [1],
      }),
    ).toThrow(/exactly one of jsonBody or fileUrl/);
  });

  it('rejects providing NEITHER jsonBody nor fileUrl', () => {
    expect(() => validateImportContactsArgs({ listIds: [1] })).toThrow(
      /via jsonBody\[\] or fileUrl/,
    );
    // an empty jsonBody array does not count as a source
    expect(() => validateImportContactsArgs({ jsonBody: [], listIds: [1] })).toThrow(
      /via jsonBody\[\] or fileUrl/,
    );
  });

  it('rejects a missing / empty / non-integer listIds', () => {
    expect(() => validateImportContactsArgs({ jsonBody: [{ email: 'a@b.com' }] })).toThrow(
      /listIds is required/,
    );
    expect(() =>
      validateImportContactsArgs({ jsonBody: [{ email: 'a@b.com' }], listIds: [] }),
    ).toThrow(/listIds is required/);
    expect(() =>
      validateImportContactsArgs({ jsonBody: [{ email: 'a@b.com' }], listIds: [1, 'x'] }),
    ).toThrow(/listIds must contain only integers/);
  });

  it('reports the offending jsonBody index for a bad email', () => {
    expect(() =>
      validateImportContactsArgs({
        jsonBody: [{ email: 'ok@x.com' }, { email: 'nope' }],
        listIds: [1],
      }),
    ).toThrow(/jsonBody\[1\]\.email/);
  });

  it('rejects non-object attributes inside a jsonBody entry (with index)', () => {
    expect(() =>
      validateImportContactsArgs({
        jsonBody: [{ email: 'a@b.com', attributes: ['nope'] }],
        listIds: [1],
      }),
    ).toThrow(/jsonBody\[0\]\.attributes/);
  });

  it('rejects a non-http(s) fileUrl (SSRF / bad protocol)', () => {
    expect(() =>
      validateImportContactsArgs({ fileUrl: 'javascript:alert(1)', listIds: [1] }),
    ).toThrow(/fileUrl must be a valid http\(s\) URL/);
  });
});

// ============================================================================
// import-contacts — exact body construction
// ============================================================================

describe('buildImportContactsBody', () => {
  it('builds the exact inline body, mapping attributes + updateExistingContacts', () => {
    const body = buildImportContactsBody({
      jsonBody: [{ email: '  a@b.com  ', attributes: { FIRSTNAME: 'Ana' } }],
      listIds: [1, 2],
      updateExistingContacts: true,
    });
    expect(body).toEqual({
      listIds: [1, 2],
      jsonBody: [{ email: 'a@b.com', attributes: { FIRSTNAME: 'Ana' } }],
      updateExistingContacts: true,
    });
  });

  it('omits attributes when absent and omits updateExistingContacts when not a boolean', () => {
    const body = buildImportContactsBody({
      jsonBody: [{ email: 'a@b.com' }],
      listIds: [3],
    });
    expect(body).toEqual({ listIds: [3], jsonBody: [{ email: 'a@b.com' }] });
    expect('updateExistingContacts' in body).toBe(false);
    expect('fileUrl' in body).toBe(false);
  });

  it('builds the exact file body (trimmed fileUrl, no jsonBody)', () => {
    const body = buildImportContactsBody({
      fileUrl: '  https://x.com/c.csv  ',
      listIds: [7],
      updateExistingContacts: false,
    });
    expect(body).toEqual({
      listIds: [7],
      fileUrl: 'https://x.com/c.csv',
      updateExistingContacts: false,
    });
    expect('jsonBody' in body).toBe(false);
  });
});

// ============================================================================
// list-attributes — response shaping
// ============================================================================

describe('shapeAttribute', () => {
  it('maps name / category / type', () => {
    expect(shapeAttribute({ name: 'FIRSTNAME', category: 'normal', type: 'text' })).toEqual({
      name: 'FIRSTNAME',
      category: 'normal',
      type: 'text',
    });
  });

  it('keeps a missing type null (category-type attributes carry no type)', () => {
    expect(shapeAttribute({ name: 'PLAN', category: 'category' })).toEqual({
      name: 'PLAN',
      category: 'category',
      type: null,
    });
  });

  it('drops noise fields (enumeration, calculatedValue) and defaults garbage to nulls', () => {
    expect(
      shapeAttribute({ name: 'X', category: 'calculated', type: 'text', calculatedValue: 'x', enumeration: [] }),
    ).toEqual({ name: 'X', category: 'calculated', type: 'text' });
    expect(shapeAttribute(null)).toEqual({ name: null, category: null, type: null });
    expect(shapeAttribute({ name: 42 })).toEqual({ name: null, category: null, type: null });
  });
});

// ============================================================================
// list-segments — response shaping
// ============================================================================

describe('shapeSegment', () => {
  it('maps id / segmentName / categoryName / updatedAt', () => {
    expect(
      shapeSegment({
        id: 5,
        segmentName: 'Active buyers',
        categoryName: 'Sales',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toEqual({
      id: 5,
      segmentName: 'Active buyers',
      categoryName: 'Sales',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('keeps a missing updatedAt null and defaults garbage to nulls', () => {
    expect(shapeSegment({ id: 1, segmentName: 'S', categoryName: 'C' })).toEqual({
      id: 1,
      segmentName: 'S',
      categoryName: 'C',
      updatedAt: null,
    });
    expect(shapeSegment(null)).toEqual({
      id: null,
      segmentName: null,
      categoryName: null,
      updatedAt: null,
    });
  });
});
