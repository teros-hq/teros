import { describe, expect, it } from 'bun:test';
import {
  extractBlockShape,
  extractCommentShape,
  extractCover,
  extractIcon,
  extractPageShape,
  extractParent,
  extractPlainText,
  extractProperties,
  extractPropertyValue,
  extractUserShape,
  trimBlocks,
  validateUuid,
} from '../../src/tools/_notion-helpers';

describe('extractPlainText', () => {
  it('returns empty string for undefined/null/non-array', () => {
    expect(extractPlainText(undefined)).toBe('');
    expect(extractPlainText(null)).toBe('');
    expect(extractPlainText('foo')).toBe('');
  });

  it('joins plain_text from each segment and drops annotations', () => {
    const richText = [
      { plain_text: 'Hello ', annotations: { bold: true, color: 'red' } },
      { plain_text: 'world', annotations: { italic: true } },
      { plain_text: '!' },
    ];
    expect(extractPlainText(richText)).toBe('Hello world!');
  });
});

describe('extractPropertyValue', () => {
  it('extracts title', () => {
    const prop = { type: 'title', title: [{ plain_text: 'Project X' }] };
    expect(extractPropertyValue(prop)).toBe('Project X');
  });

  it('extracts rich_text dropping annotations', () => {
    const prop = {
      type: 'rich_text',
      rich_text: [{ plain_text: 'Foo ', annotations: { bold: true } }, { plain_text: 'bar' }],
    };
    expect(extractPropertyValue(prop)).toBe('Foo bar');
  });

  it('extracts multi_select names only', () => {
    const prop = {
      type: 'multi_select',
      multi_select: [
        { id: 'a', name: 'Urgent' },
        { id: 'b', name: 'Blocked' },
      ],
    };
    expect(extractPropertyValue(prop)).toEqual(['Urgent', 'Blocked']);
  });

  it('extracts relation as array of ids', () => {
    const prop = { type: 'relation', relation: [{ id: 'page-a' }, { id: 'page-b' }] };
    expect(extractPropertyValue(prop)).toEqual(['page-a', 'page-b']);
  });

  it('flattens formula', () => {
    expect(extractPropertyValue({ type: 'formula', formula: { type: 'number', number: 42 } })).toBe(
      42,
    );
    expect(
      extractPropertyValue({ type: 'formula', formula: { type: 'string', string: 'hi' } }),
    ).toBe('hi');
    expect(
      extractPropertyValue({ type: 'formula', formula: { type: 'boolean', boolean: true } }),
    ).toBe(true);
  });

  it('extracts people with id + name', () => {
    const prop = {
      type: 'people',
      people: [{ id: 'u1', name: 'Alice', avatar_url: 'https://x/a.png' }],
    };
    expect(extractPropertyValue(prop)).toEqual([{ id: 'u1', name: 'Alice' }]);
  });

  it('extracts files with name + url', () => {
    const prop = {
      type: 'files',
      files: [
        { name: 'doc.pdf', external: { url: 'https://x/doc.pdf' } },
        { name: 'img.png', file: { url: 'https://notion/img.png?expiry=...' } },
      ],
    };
    expect(extractPropertyValue(prop)).toEqual([
      { name: 'doc.pdf', url: 'https://x/doc.pdf' },
      { name: 'img.png', url: 'https://notion/img.png?expiry=...' },
    ]);
  });

  it('extracts select/status as the .name only', () => {
    expect(extractPropertyValue({ type: 'select', select: { name: 'Active' } })).toBe('Active');
    expect(extractPropertyValue({ type: 'status', status: { name: 'In review' } })).toBe(
      'In review',
    );
  });

  it('unwraps date with start/end/timeZone', () => {
    const prop = {
      type: 'date',
      date: { start: '2026-04-22', end: null, time_zone: null },
    };
    expect(extractPropertyValue(prop)).toEqual({
      start: '2026-04-22',
      end: null,
      timeZone: null,
    });
  });

  it('returns null for unknown types', () => {
    expect(extractPropertyValue({ type: 'something_new' })).toBeNull();
  });
});

describe('extractProperties', () => {
  it('returns only whitelisted properties + always the title', () => {
    const props = {
      Name: { type: 'title', title: [{ plain_text: 'X' }] },
      Status: { type: 'select', select: { name: 'Done' } },
      Secret: { type: 'rich_text', rich_text: [{ plain_text: 'hush' }] },
    };
    const result = extractProperties(props, ['Status']);
    expect(result).toEqual({ Name: 'X', Status: 'Done' });
    expect(result.Secret).toBeUndefined();
  });

  it('returns all when whitelist includes "*"', () => {
    const props = {
      Name: { type: 'title', title: [{ plain_text: 'X' }] },
      Status: { type: 'select', select: { name: 'Done' } },
    };
    const result = extractProperties(props, ['*']);
    expect(result.Name).toBe('X');
    expect(result.Status).toBe('Done');
  });

  it('returns only title when whitelist is undefined (default is tight)', () => {
    const props = {
      Name: { type: 'title', title: [{ plain_text: 'X' }] },
      N: { type: 'number', number: 42 },
    };
    const result = extractProperties(props);
    expect(result.Name).toBe('X');
    expect(result.N).toBeUndefined();
  });

  it('returns only title when whitelist is empty', () => {
    const props = {
      Name: { type: 'title', title: [{ plain_text: 'X' }] },
      N: { type: 'number', number: 42 },
    };
    const result = extractProperties(props, []);
    expect(result.Name).toBe('X');
    expect(result.N).toBeUndefined();
  });

  it('fills whitelisted keys with null when Notion omits them', () => {
    // Reproduces the case where a column was added after the row, so the
    // API response doesn't include that key. Callers should always get
    // `row.properties.Status` === null instead of undefined.
    const props = {
      Name: { type: 'title', title: [{ plain_text: 'X' }] },
    };
    const result = extractProperties(props, ['Status', 'Priority']);
    expect(result.Name).toBe('X');
    expect(result.Status).toBeNull();
    expect(result.Priority).toBeNull();
  });

  it('preserves explicit null from Notion when the column exists but empty', () => {
    const props = {
      Name: { type: 'title', title: [{ plain_text: 'X' }] },
      Status: { type: 'status', status: null, id: 'x' },
    };
    const result = extractProperties(props, ['Status']);
    expect(result.Status).toBeNull();
  });

  it('does not fill "*" as a literal key', () => {
    const props = {
      Name: { type: 'title', title: [{ plain_text: 'X' }] },
      N: { type: 'number', number: 42 },
    };
    const result = extractProperties(props, ['*']);
    expect(result['*']).toBeUndefined();
    expect(result.Name).toBe('X');
    expect(result.N).toBe(42);
  });
});

describe('extractIcon / extractCover', () => {
  it('normalises emoji icon', () => {
    expect(extractIcon({ type: 'emoji', emoji: '📝' })).toEqual({ type: 'emoji', value: '📝' });
  });
  it('normalises external icon', () => {
    expect(extractIcon({ type: 'external', external: { url: 'https://x.png' } })).toEqual({
      type: 'external',
      value: 'https://x.png',
    });
  });
  it('normalises file icon', () => {
    expect(extractIcon({ type: 'file', file: { url: 'https://n/x.png' } })).toEqual({
      type: 'file',
      value: 'https://n/x.png',
    });
  });
  it('returns null for absent icon', () => {
    expect(extractIcon(null)).toBeNull();
    expect(extractIcon(undefined)).toBeNull();
  });
  it('normalises covers the same way (no emoji variant)', () => {
    expect(extractCover({ type: 'external', external: { url: 'https://c.png' } })).toEqual({
      type: 'external',
      value: 'https://c.png',
    });
  });
});

describe('extractParent', () => {
  it('handles page_id parent', () => {
    expect(extractParent({ type: 'page_id', page_id: 'p1' })).toEqual({
      parentType: 'page',
      parentId: 'p1',
    });
  });
  it('handles database_id parent', () => {
    expect(extractParent({ type: 'database_id', database_id: 'd1' })).toEqual({
      parentType: 'database',
      parentId: 'd1',
    });
  });
  it('handles workspace parent', () => {
    expect(extractParent({ type: 'workspace' })).toEqual({
      parentType: 'workspace',
      parentId: null,
    });
  });
});

describe('extractPageShape', () => {
  it('collapses a full Notion page into a curated shape', () => {
    const raw = {
      object: 'page',
      id: 'p1',
      url: 'https://notion.so/x',
      icon: { type: 'emoji', emoji: '🚀' },
      cover: { type: 'external', external: { url: 'https://x.png' } },
      parent: { type: 'database_id', database_id: 'd1' },
      created_time: '2026-01-01T00:00:00Z',
      last_edited_time: '2026-04-22T00:00:00Z',
      archived: false,
      properties: {
        Name: { type: 'title', title: [{ plain_text: 'Hello' }] },
        Status: { type: 'select', select: { name: 'Active' } },
      },
    };
    const shape = extractPageShape(raw);
    expect(shape.id).toBe('p1');
    expect(shape.object).toBe('page');
    expect(shape.title).toBe('Hello');
    expect(shape.icon).toEqual({ type: 'emoji', value: '🚀' });
    expect(shape.cover).toEqual({ type: 'external', value: 'https://x.png' });
    expect(shape.parentType).toBe('database');
    expect(shape.parentId).toBe('d1');
    expect(shape.archived).toBe(false);
    expect(shape.properties).toEqual({ Name: 'Hello', Status: 'Active' });
  });
});

describe('extractBlockShape', () => {
  it('extracts paragraph plain text', () => {
    const raw = {
      id: 'b1',
      type: 'paragraph',
      has_children: false,
      created_time: '2026-01-01T00:00:00Z',
      last_edited_time: '2026-04-22T00:00:00Z',
      archived: false,
      parent: { type: 'page_id', page_id: 'p1' },
      paragraph: {
        rich_text: [{ plain_text: 'Hello ', annotations: { bold: true } }, { plain_text: 'world' }],
      },
    };
    const shape = extractBlockShape(raw);
    expect(shape.id).toBe('b1');
    expect(shape.type).toBe('paragraph');
    expect(shape.plainText).toBe('Hello world');
    expect(shape.parentType).toBe('page');
  });

  it('captures to_do.checked', () => {
    const raw = {
      id: 'b2',
      type: 'to_do',
      has_children: false,
      parent: { type: 'page_id', page_id: 'p1' },
      to_do: { rich_text: [{ plain_text: 'task' }], checked: true },
    };
    const shape = extractBlockShape(raw);
    expect(shape.checked).toBe(true);
  });

  it('captures code.language', () => {
    const raw = {
      id: 'b3',
      type: 'code',
      has_children: false,
      parent: { type: 'page_id', page_id: 'p1' },
      code: { rich_text: [{ plain_text: 'console.log(1)' }], language: 'javascript' },
    };
    const shape = extractBlockShape(raw);
    expect(shape.language).toBe('javascript');
  });
});

describe('extractUserShape', () => {
  it('normalises a person user', () => {
    const raw = {
      id: 'u1',
      name: 'Alice',
      type: 'person',
      avatar_url: 'https://x/a.png',
      person: { email: 'a@x.com' },
    };
    const shape = extractUserShape(raw);
    expect(shape).toEqual({
      id: 'u1',
      name: 'Alice',
      type: 'person',
      avatarUrl: 'https://x/a.png',
      email: 'a@x.com',
      bot: false,
    });
  });

  it('flags bot users', () => {
    const raw = { id: 'b1', name: 'Bot', type: 'bot' };
    const shape = extractUserShape(raw);
    expect(shape.bot).toBe(true);
    expect(shape.email).toBeNull();
  });
});

describe('extractCommentShape', () => {
  it('collapses rich_text to plainText', () => {
    const raw = {
      id: 'c1',
      parent: { type: 'page_id', page_id: 'p1' },
      discussion_id: 'd1',
      created_by: { id: 'u1' },
      rich_text: [{ plain_text: 'Nice ', annotations: { bold: true } }, { plain_text: 'work' }],
      created_time: '2026-04-22T00:00:00Z',
      last_edited_time: '2026-04-22T00:00:00Z',
    };
    const shape = extractCommentShape(raw);
    expect(shape.plainText).toBe('Nice work');
    expect(shape.pageId).toBe('p1');
    expect(shape.discussionId).toBe('d1');
    expect(shape.authorId).toBe('u1');
  });
});

describe('validateUuid', () => {
  it('accepts dashed and undashed UUIDs', () => {
    expect(validateUuid('12345678-1234-1234-1234-123456789012', 'id')).toBe(
      '12345678-1234-1234-1234-123456789012',
    );
    expect(validateUuid('12345678123412341234123456789012', 'id')).toBe(
      '12345678123412341234123456789012',
    );
  });

  it('throws on malformed', () => {
    expect(() => validateUuid('not-a-uuid', 'pageId')).toThrow(/Invalid pageId/);
  });
});

describe('trimBlocks', () => {
  it('caps recursion depth', () => {
    const deep = [
      {
        id: 'a',
        children: [
          {
            id: 'b',
            children: [
              {
                id: 'c',
                children: [{ id: 'd' }],
              },
            ],
          },
        ],
      },
    ];
    const trimmed = trimBlocks(deep, { maxDepth: 1, maxChars: 100_000 });
    expect(trimmed[0].id).toBe('a');
    expect(trimmed[0].children[0].id).toBe('b');
    expect(trimmed[0].children[0].children).toEqual([]);
  });

  it('caps total serialised size', () => {
    const big = Array.from({ length: 1000 }, (_, i) => ({
      id: `b${i}`,
      content: 'x'.repeat(100),
    }));
    const trimmed = trimBlocks(big, { maxDepth: 2, maxChars: 1_000 });
    expect(trimmed.length).toBeLessThan(20);
  });
});
