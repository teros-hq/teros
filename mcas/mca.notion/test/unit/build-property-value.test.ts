/**
 * buildPropertyValue — covers the 14 writable property types and rejects
 * read-only ones (formula, rollup, button, ...). Exhaustive: each switch
 * branch is exercised at least once with both happy and edge cases.
 */

import { describe, expect, it } from 'bun:test';
import {
  buildPropertiesFromSimple,
  buildPropertyValue,
  PropertyConversionError,
} from '../../src/tools/_build-property-value';

describe('buildPropertyValue — happy path', () => {
  it('title from string', () => {
    expect(buildPropertyValue('Name', 'title', 'Hello')).toEqual({
      title: [{ text: { content: 'Hello' } }],
    });
  });

  it('rich_text', () => {
    expect(buildPropertyValue('Notes', 'rich_text', 'Body')).toEqual({
      rich_text: [{ text: { content: 'Body' } }],
    });
  });

  it('number', () => {
    expect(buildPropertyValue('Score', 'number', 42)).toEqual({ number: 42 });
  });

  it('checkbox true / false', () => {
    expect(buildPropertyValue('Done', 'checkbox', true)).toEqual({ checkbox: true });
    expect(buildPropertyValue('Done', 'checkbox', false)).toEqual({ checkbox: false });
  });

  it('url / email / phone_number', () => {
    expect(buildPropertyValue('Website', 'url', 'https://x')).toEqual({ url: 'https://x' });
    expect(buildPropertyValue('Email', 'email', 'a@b.c')).toEqual({ email: 'a@b.c' });
    expect(buildPropertyValue('Phone', 'phone_number', '555-0100')).toEqual({
      phone_number: '555-0100',
    });
  });

  it('select / status as { name }', () => {
    expect(buildPropertyValue('Priority', 'select', 'High')).toEqual({
      select: { name: 'High' },
    });
    expect(buildPropertyValue('Status', 'status', 'Done')).toEqual({
      status: { name: 'Done' },
    });
  });

  it('multi_select from array of strings', () => {
    expect(buildPropertyValue('Tags', 'multi_select', ['urgent', 'mca'])).toEqual({
      multi_select: [{ name: 'urgent' }, { name: 'mca' }],
    });
  });

  it('date from ISO string', () => {
    expect(buildPropertyValue('Due', 'date', '2026-05-06')).toEqual({
      date: { start: '2026-05-06' },
    });
  });

  it('date from object with start + end + tz', () => {
    expect(
      buildPropertyValue('Window', 'date', {
        start: '2026-05-06T09:00:00.000Z',
        end: '2026-05-06T10:00:00.000Z',
        timeZone: 'Europe/Madrid',
      }),
    ).toEqual({
      date: {
        start: '2026-05-06T09:00:00.000Z',
        end: '2026-05-06T10:00:00.000Z',
        time_zone: 'Europe/Madrid',
      },
    });
  });

  it('people from array of UUIDs', () => {
    expect(
      buildPropertyValue('Assignee', 'people', ['user-a', 'user-b']),
    ).toEqual({ people: [{ id: 'user-a' }, { id: 'user-b' }] });
  });

  it('files from array of URLs', () => {
    expect(buildPropertyValue('Attachments', 'files', ['https://x/a.pdf'])).toEqual({
      files: [{ name: 'https://x/a.pdf', external: { url: 'https://x/a.pdf' } }],
    });
  });

  it('files from { name, fileUploadId } shape', () => {
    expect(
      buildPropertyValue('Attachments', 'files', [
        { name: 'spec.pdf', fileUploadId: 'fu-1' },
      ]),
    ).toEqual({ files: [{ name: 'spec.pdf', file_upload: { id: 'fu-1' } }] });
  });

  it('relation from array of page IDs', () => {
    expect(buildPropertyValue('Related', 'relation', ['page-a'])).toEqual({
      relation: [{ id: 'page-a' }],
    });
  });
});

describe('buildPropertyValue — null clearing', () => {
  it('null clears single-value props', () => {
    expect(buildPropertyValue('S', 'select', null)).toEqual({ select: null });
    expect(buildPropertyValue('U', 'url', null)).toEqual({ url: null });
    expect(buildPropertyValue('D', 'date', null)).toEqual({ date: null });
    expect(buildPropertyValue('N', 'number', null)).toEqual({ number: null });
  });

  it('null/undefined empties array-valued props', () => {
    expect(buildPropertyValue('T', 'multi_select', null)).toEqual({ multi_select: [] });
    expect(buildPropertyValue('A', 'people', null)).toEqual({ people: [] });
    expect(buildPropertyValue('F', 'files', null)).toEqual({ files: [] });
    expect(buildPropertyValue('R', 'relation', null)).toEqual({ relation: [] });
  });
});

describe('buildPropertyValue — read-only types', () => {
  it.each([
    ['created_time'],
    ['last_edited_time'],
    ['formula'],
    ['rollup'],
    ['unique_id'],
    ['button'],
  ])('rejects %s as read-only', (type) => {
    expect(() => buildPropertyValue('X', type, 'whatever')).toThrowError(PropertyConversionError);
  });
});

describe('buildPropertyValue — type errors', () => {
  it('checkbox with non-boolean', () => {
    expect(() => buildPropertyValue('Done', 'checkbox', 'yes')).toThrowError(
      /expected boolean/,
    );
  });

  it('number with NaN', () => {
    expect(() => buildPropertyValue('Score', 'number', Number.NaN)).toThrowError(/finite/);
  });

  it('multi_select with non-string element', () => {
    expect(() => buildPropertyValue('Tags', 'multi_select', [123])).toThrowError();
  });

  it('date with non-ISO string', () => {
    expect(() => buildPropertyValue('Due', 'date', 'tomorrow')).toThrowError(/ISO/);
  });

  it('files with malformed item', () => {
    expect(() => buildPropertyValue('A', 'files', [{ no: 'good' }])).toThrowError();
  });

  it('unknown type produces a typed error', () => {
    expect(() => buildPropertyValue('X', 'place', 'foo')).toThrowError(PropertyConversionError);
  });
});

describe('buildPropertiesFromSimple', () => {
  const schema = {
    Name: { type: 'title' },
    Status: { type: 'status' },
    Priority: { type: 'select' },
    Tags: { type: 'multi_select' },
    Due: { type: 'date' },
    Assignee: { type: 'people' },
  } as const;

  it('serialises a typical agent payload', () => {
    const result = buildPropertiesFromSimple(schema as any, {
      Name: 'Spec',
      Status: 'In review',
      Priority: 'High',
      Tags: ['urgent', 'mca'],
      Due: '2026-05-06',
      Assignee: ['user-a'],
    });

    expect(result.Name).toEqual({ title: [{ text: { content: 'Spec' } }] });
    expect(result.Status).toEqual({ status: { name: 'In review' } });
    expect(result.Priority).toEqual({ select: { name: 'High' } });
    expect(result.Tags).toEqual({ multi_select: [{ name: 'urgent' }, { name: 'mca' }] });
    expect(result.Due).toEqual({ date: { start: '2026-05-06' } });
    expect(result.Assignee).toEqual({ people: [{ id: 'user-a' }] });
  });

  it('throws PropertyConversionError when the column does not exist', () => {
    expect(() =>
      buildPropertiesFromSimple(schema as any, { NotARealColumn: 'X' }),
    ).toThrowError(/does not exist/);
  });

  it('error mentions the failing property name + type', () => {
    try {
      buildPropertiesFromSimple(schema as any, { Status: 123 });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PropertyConversionError);
      const e = err as PropertyConversionError;
      expect(e.propertyName).toBe('Status');
      expect(e.notionType).toBe('status');
    }
  });
});
