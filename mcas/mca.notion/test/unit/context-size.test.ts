/**
 * Regression test for the main audit goal (TER-272): Notion responses
 * must not destroy the context window.
 *
 * We simulate a realistic database query result (50 rows, 10 properties each,
 * rich_text with annotations in a handful of columns) and compare:
 *   - baseline: the raw Notion API response as JSON
 *   - curated: the same response after extractPageShape + whitelist
 *
 * The assert is that the curated payload is at most 40 % of the raw payload
 * (= reduction ≥60 %). The actual measured number is logged so it can be
 * copied into the assessment doc.
 */

import { describe, expect, it } from 'bun:test';
import { PAGE_COMPACT_FIELDS } from '../../src/tools/_fields';
import { extractPageShape, extractProperties } from '../../src/tools/_notion-helpers';
import { pickFieldsList } from '../../src/tools/utils';

function makeRichText(text: string) {
  return [
    {
      type: 'text',
      text: { content: text, link: null },
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: 'default',
      },
      plain_text: text,
      href: null,
    },
  ];
}

function makeRow(i: number) {
  return {
    object: 'page',
    id: `12345678-1234-1234-1234-${String(i).padStart(12, '0')}`,
    url: `https://notion.so/page-${i}`,
    created_time: '2026-01-01T00:00:00Z',
    last_edited_time: '2026-04-22T10:00:00Z',
    created_by: { object: 'user', id: 'creator-id' },
    last_edited_by: { object: 'user', id: 'editor-id' },
    archived: false,
    in_trash: false,
    icon: { type: 'emoji', emoji: '📝' },
    cover: { type: 'external', external: { url: `https://pic/${i}.jpg` } },
    parent: { type: 'database_id', database_id: 'db-1' },
    properties: {
      Name: {
        id: 'title',
        type: 'title',
        title: makeRichText(`Task ${i}: review the quarterly roadmap proposal`),
      },
      Status: {
        id: 'prop-status',
        type: 'select',
        select: { id: 's1', name: 'In Progress', color: 'blue' },
      },
      Priority: {
        id: 'prop-prio',
        type: 'multi_select',
        multi_select: [
          { id: 'p1', name: 'Urgent', color: 'red' },
          { id: 'p2', name: 'Q2', color: 'orange' },
        ],
      },
      Description: {
        id: 'prop-desc',
        type: 'rich_text',
        rich_text: makeRichText(
          'This is a longer description with plenty of filler text so the response has realistic verbose payload similar to production.',
        ),
      },
      DueDate: {
        id: 'prop-due',
        type: 'date',
        date: { start: '2026-05-15', end: null, time_zone: null },
      },
      Owner: {
        id: 'prop-owner',
        type: 'people',
        people: [
          { object: 'user', id: 'u1', name: 'Alice', avatar_url: 'https://a', type: 'person' },
        ],
      },
      Relation: {
        id: 'prop-rel',
        type: 'relation',
        relation: [{ id: 'p100' }, { id: 'p101' }, { id: 'p102' }],
        has_more: false,
      },
      Checkbox: { id: 'prop-cb', type: 'checkbox', checkbox: i % 2 === 0 },
      Number: { id: 'prop-n', type: 'number', number: i * 3.14 },
      URL: { id: 'prop-url', type: 'url', url: `https://external/${i}` },
    },
  };
}

describe('context-size regression', () => {
  it('curated response is ≥60 % smaller than raw (whitelist only)', () => {
    const rawResults = Array.from({ length: 50 }, (_, i) => makeRow(i));
    const shaped = rawResults.map((page) => {
      const base = extractPageShape(page);
      // Query default: title only + visual fields
      base.properties = extractProperties(page.properties, []);
      return base;
    });
    const curated = pickFieldsList(shaped as any, [...PAGE_COMPACT_FIELDS, 'properties']);

    const rawSize = JSON.stringify(rawResults).length;
    const curatedSize = JSON.stringify(curated).length;
    const ratio = curatedSize / rawSize;

    // eslint-disable-next-line no-console
    console.log(
      `[context-size] raw=${rawSize}B curated=${curatedSize}B ratio=${ratio.toFixed(3)} reduction=${((1 - ratio) * 100).toFixed(1)}%`,
    );

    expect(ratio).toBeLessThanOrEqual(0.4);
  });

  it('curated with propertyNames=["Status"] is even smaller', () => {
    const rawResults = Array.from({ length: 50 }, (_, i) => makeRow(i));
    const shaped = rawResults.map((page) => {
      const base = extractPageShape(page);
      base.properties = extractProperties(page.properties, ['Status']);
      return base;
    });
    const curated = pickFieldsList(shaped as any, [...PAGE_COMPACT_FIELDS, 'properties']);
    const rawSize = JSON.stringify(rawResults).length;
    const curatedSize = JSON.stringify(curated).length;
    const ratio = curatedSize / rawSize;

    // eslint-disable-next-line no-console
    console.log(
      `[context-size] (Status only) raw=${rawSize}B curated=${curatedSize}B ratio=${ratio.toFixed(3)} reduction=${((1 - ratio) * 100).toFixed(1)}%`,
    );

    expect(ratio).toBeLessThanOrEqual(0.25);
  });
});
