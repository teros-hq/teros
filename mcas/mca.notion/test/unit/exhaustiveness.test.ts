/**
 * Exhaustiveness regression — guards against silent `null` returns when a
 * new prop.type or block.type is added to Notion's API/SDK without us
 * teaching the extractor about it.
 *
 * The lists below are the canonical types declared by the @notionhq/client
 * v5.20 type system (api-endpoints/common.d.ts and api-endpoints/blocks.d.ts).
 * If the SDK adds a new variant, this test will *not* fail automatically —
 * but the unknown variant fails inside the loop because extractPropertyValue
 * returns null for the synthetic payload, surfacing the gap.
 *
 * Update the lists when bumping @notionhq/client.
 */

import { describe, expect, it } from 'bun:test';
import { extractBlockShape, extractPropertyValue } from '../../src/tools/_notion-helpers';

const PROPERTY_TYPES = [
  'title',
  'rich_text',
  'number',
  'checkbox',
  'url',
  'email',
  'phone_number',
  'select',
  'status',
  'multi_select',
  'date',
  'people',
  'files',
  'relation',
  'rollup',
  'formula',
  'created_time',
  'last_edited_time',
  'created_by',
  'last_edited_by',
  'unique_id',
  'verification',
  'place',
  'button',
] as const;

const BLOCK_TYPES = [
  'audio',
  'bookmark',
  'breadcrumb',
  'bulleted_list_item',
  'callout',
  'child_database',
  'child_page',
  'code',
  'column',
  'column_list',
  'divider',
  'embed',
  'equation',
  'file',
  'heading_1',
  'heading_2',
  'heading_3',
  'heading_4',
  'image',
  'link_preview',
  'link_to_page',
  'meeting_notes',
  'numbered_list_item',
  'pdf',
  'quote',
  'synced_block',
  'table',
  'table_of_contents',
  'table_row',
  'template',
  'to_do',
  'toggle',
  'transcription',
  'unsupported',
  'video',
  'paragraph',
] as const;

/**
 * Build a minimum-shape payload for each property type so the extractor
 * doesn't choke on missing nested keys. This is intentionally permissive —
 * we just want non-null returns for non-button types.
 */
function buildPropertyFixture(type: string): Record<string, unknown> {
  const base: Record<string, unknown> = { type };
  switch (type) {
    case 'title':
    case 'rich_text':
      base[type] = [{ plain_text: 'sample' }];
      return base;
    case 'number':
      base.number = 42;
      return base;
    case 'checkbox':
      base.checkbox = true;
      return base;
    case 'url':
      base.url = 'https://example.com';
      return base;
    case 'email':
      base.email = 'team@example.com';
      return base;
    case 'phone_number':
      base.phone_number = '555-0100';
      return base;
    case 'select':
    case 'status':
      base[type] = { id: 'a', name: 'Sample', color: 'gray' };
      return base;
    case 'multi_select':
      base.multi_select = [{ id: 'a', name: 'One' }];
      return base;
    case 'date':
      base.date = { start: '2026-01-01', end: null, time_zone: null };
      return base;
    case 'people':
      base.people = [{ id: 'user-a', name: 'Alex' }];
      return base;
    case 'files':
      base.files = [{ name: 'spec.pdf', external: { url: 'https://x/spec.pdf' } }];
      return base;
    case 'relation':
      base.relation = [{ id: 'page-a' }];
      return base;
    case 'rollup':
      base.rollup = { type: 'number', number: 7 };
      return base;
    case 'formula':
      base.formula = { type: 'string', string: 'computed' };
      return base;
    case 'created_time':
    case 'last_edited_time':
      base[type] = '2026-04-01T00:00:00.000Z';
      return base;
    case 'created_by':
    case 'last_edited_by':
      base[type] = { id: 'user-a', name: 'Alex' };
      return base;
    case 'unique_id':
      base.unique_id = { number: 7, prefix: 'TER' };
      return base;
    case 'verification':
      base.verification = { state: 'verified', verified_by: { id: 'user-a' }, date: { start: '2026-01-01' } };
      return base;
    case 'place':
      base.place = { lat: 40.7, lon: -74, name: 'NYC', address: '5th Ave' };
      return base;
    case 'button':
      base.button = {};
      return base;
    default:
      return base;
  }
}

function buildBlockFixture(type: string): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (
    type === 'paragraph' ||
    type === 'heading_1' ||
    type === 'heading_2' ||
    type === 'heading_3' ||
    type === 'heading_4' ||
    type === 'bulleted_list_item' ||
    type === 'numbered_list_item' ||
    type === 'to_do' ||
    type === 'toggle' ||
    type === 'quote' ||
    type === 'callout'
  ) {
    body.rich_text = [{ plain_text: 'sample' }];
  }
  if (type === 'meeting_notes') {
    body.summary = [{ plain_text: 'Sprint kickoff summary' }];
    body.transcript = [{ plain_text: 'Transcript line' }];
  }
  return {
    id: `block-${type}`,
    type,
    has_children: false,
    created_time: '2026-04-01T00:00:00.000Z',
    last_edited_time: '2026-04-02T00:00:00.000Z',
    archived: false,
    parent: { type: 'page_id', page_id: 'page-a' },
    [type]: body,
  };
}

describe('extractPropertyValue exhaustiveness', () => {
  it.each(PROPERTY_TYPES.map((t) => [t]))(
    'handles property type "%s"',
    (type) => {
      const fixture = buildPropertyFixture(type);
      const value = extractPropertyValue(fixture);
      // `button` is documented as a no-op (returns null). Every other type must
      // yield a non-null projection so we don't silently drop data.
      if (type === 'button') {
        expect(value).toBeNull();
      } else {
        expect(value).not.toBeNull();
      }
    },
  );
});

describe('extractBlockShape exhaustiveness', () => {
  it.each(BLOCK_TYPES.map((t) => [t]))(
    'handles block type "%s"',
    (type) => {
      const shape = extractBlockShape(buildBlockFixture(type));
      expect(shape.id).toBe(`block-${type}`);
      expect(shape.type).toBe(type);
      // inTrash is the canonical key post API 2026-03-11; assert its presence.
      expect('inTrash' in shape).toBe(true);
      if (type === 'meeting_notes') {
        expect(typeof shape.summary === 'string').toBe(true);
        expect(shape.hasTranscript).toBe(true);
      }
    },
  );
});

describe('extractPropertyValue regression — place property', () => {
  it('returns lat/lon/name/address (was silently null before SDK v5 bump)', () => {
    const fixture = buildPropertyFixture('place');
    expect(extractPropertyValue(fixture)).toEqual({
      lat: 40.7,
      lon: -74,
      name: 'NYC',
      address: '5th Ave',
    });
  });
});

describe('extractParent — data_source_id variant', () => {
  // Imported lazily to keep the file shape consistent with the rest.
  it('exposes parentType="data_source" with parentId + databaseId', async () => {
    const { extractParent } = await import('../../src/tools/_notion-helpers');
    const parent = extractParent({
      type: 'data_source_id',
      data_source_id: 'ds-a',
      database_id: 'db-a',
    });
    expect(parent.parentType).toBe('data_source');
    expect(parent.parentId).toBe('ds-a');
    expect(parent.databaseId).toBe('db-a');
  });
});

describe('readInTrash compatibility', () => {
  it('extractPageShape reads in_trash (new) over archived (legacy)', () => {
    // @ts-expect-error — looking up local helper via dynamic import for parity.
    const { extractPageShape } = require('../../src/tools/_notion-helpers');
    const shape = extractPageShape({
      object: 'page',
      id: 'page-a',
      properties: { Name: { type: 'title', title: [{ plain_text: 'X' }] } },
      parent: { type: 'page_id', page_id: 'p' },
      in_trash: true,
      archived: false,
    });
    expect(shape.inTrash).toBe(true);
    expect(shape.archived).toBe(true); // legacy alias mirrors inTrash post-bump
  });

  it('falls back to archived when in_trash absent', () => {
    // @ts-expect-error — same dynamic import.
    const { extractPageShape } = require('../../src/tools/_notion-helpers');
    const shape = extractPageShape({
      object: 'page',
      id: 'page-b',
      properties: {},
      parent: { type: 'workspace' },
      archived: true,
    });
    expect(shape.inTrash).toBe(true);
  });
});
