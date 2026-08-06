/**
 * TER-369 — regression tests for the Notion write/UX fixes:
 *
 *   - resolveNotionId: accept Notion share URLs (not just bare UUIDs).
 *   - normaliseRelationSchema: rewrite legacy `relation.database_id` →
 *     `relation.data_source_id` + default the single_property envelope.
 *   - create-database: send the required `parent.type` discriminator.
 *   - update-database-schema: relation columns are normalised before the
 *     dataSources.update call.
 *
 * Mocks the @notionhq/client `Client` (same pattern as tools-new.test.ts) so
 * the handlers run without a real token.
 */

import { afterEach, describe, expect, it, type Mock, mock } from 'bun:test';
import {
  invalidateDataSourceCache,
  normaliseRelationSchema,
} from '../../src/tools/_data-source-resolver';
import { resolveNotionId } from '../../src/tools/_notion-helpers';

afterEach(() => {
  invalidateDataSourceCache();
});

// ============================================================================
// resolveNotionId (bug D)
// ============================================================================

describe('resolveNotionId', () => {
  const DASHED = '1a2b3c4d-5e6f-7890-1234-567890abcdef';
  const BARE = '1a2b3c4d5e6f78901234567890abcdef';

  it('passes through a dashed UUID', () => {
    expect(resolveNotionId(DASHED, 'id')).toBe(DASHED);
  });

  it('re-hyphenates a bare 32-hex id', () => {
    expect(resolveNotionId(BARE, 'id')).toBe(DASHED);
  });

  it('extracts the id from a page share URL with a title slug', () => {
    const url = `https://www.notion.so/My-Spec-Page-${BARE}`;
    expect(resolveNotionId(url, 'pageId')).toBe(DASHED);
  });

  it('extracts the database id from a table URL, NOT the ?v= view id', () => {
    const viewId = 'fedcba0987654321fedcba0987654321';
    const url = `https://www.notion.so/workspace/${BARE}?v=${viewId}&pvs=4`;
    // The path id (database) wins; the query holds a different id (the view).
    expect(resolveNotionId(url, 'databaseId')).toBe(DASHED);
  });

  it('throws a helpful error on garbage input', () => {
    expect(() => resolveNotionId('not-a-notion-link', 'databaseId')).toThrow(
      /Notion id or share URL/,
    );
  });

  it('throws on empty / non-string input', () => {
    expect(() => resolveNotionId('', 'pageId')).toThrow();
    expect(() => resolveNotionId(undefined as any, 'pageId')).toThrow();
  });
});

// ============================================================================
// normaliseRelationSchema (bug C)
// ============================================================================

function dsStubClient(dataSourceId = 'ds-resolved'): { databases: { retrieve: Mock<any> } } {
  return {
    databases: {
      retrieve: mock(async () => ({
        object: 'database',
        id: 'db-x',
        data_sources: [{ id: dataSourceId, name: 'Primary' }],
      })),
    },
  };
}

describe('normaliseRelationSchema', () => {
  const RELATED_DB = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  it('rewrites relation.database_id → resolved data_source_id + default envelope', async () => {
    const client = dsStubClient('ds-resolved') as any;
    const out = await normaliseRelationSchema(client, {
      Integrantes: { relation: { database_id: RELATED_DB } },
    });
    expect(out.Integrantes.relation.data_source_id).toBe('ds-resolved');
    expect(out.Integrantes.relation.database_id).toBeUndefined();
    expect(out.Integrantes.relation.type).toBe('single_property');
    expect(out.Integrantes.relation.single_property).toEqual({});
  });

  it('accepts a Notion URL in relation.database_id', async () => {
    const client = dsStubClient('ds-from-url') as any;
    const out = await normaliseRelationSchema(client, {
      Rel: { relation: { database_id: `https://www.notion.so/db-${RELATED_DB}` } },
    });
    expect(out.Rel.relation.data_source_id).toBe('ds-from-url');
  });

  it('leaves an already-correct data_source_id untouched (only fills envelope)', async () => {
    const client = dsStubClient() as any;
    const out = await normaliseRelationSchema(client, {
      Rel: {
        relation: { data_source_id: 'ds-explicit', type: 'dual_property', dual_property: {} },
      },
    });
    expect(out.Rel.relation.data_source_id).toBe('ds-explicit');
    expect(out.Rel.relation.type).toBe('dual_property');
    // No DB lookup needed when data_source_id is already present.
    expect(client.databases.retrieve).not.toHaveBeenCalled();
  });

  it('passes non-relation columns and removals (null) through untouched', async () => {
    const client = dsStubClient() as any;
    const out = await normaliseRelationSchema(client, {
      Name: { title: {} },
      Old: null,
    });
    expect(out.Name).toEqual({ title: {} });
    expect(out.Old).toBeNull();
    expect(client.databases.retrieve).not.toHaveBeenCalled();
  });
});

// ============================================================================
// create-database (bug B + C) and update-database-schema (bug C) handlers
// ============================================================================

async function importToolWithStubClient<T>(toolPath: string, stub: unknown): Promise<T> {
  mock.module('../../src/lib', () => ({
    getNotionClient: async () => stub,
    validateCredentials: async () => undefined,
    formatBlocksAsText: () => '',
    formatRichText: () => '',
    getAllBlocks: async () => [],
  }));
  return (await import(toolPath)) as T;
}

const makeContext = () => ({ getUserSecrets: async () => ({ ACCESS_TOKEN: 'fake' }) }) as any;

describe('create-database (parent.type discriminator — bug B)', () => {
  it('sends parent.type=page_id so the API does not 400 on undefined type', async () => {
    const create = mock(async () => ({
      object: 'database',
      id: 'db-new',
      title: [{ plain_text: 'T' }],
      parent: { type: 'page_id', page_id: 'page-1' },
    }));
    const stub = { databases: { create, retrieve: mock(async () => ({})) } };
    const { createDatabase } = await importToolWithStubClient<any>(
      '../../src/tools/create-database',
      stub,
    );

    await createDatabase.handler(
      {
        parentPageId: '1a2b3c4d5e6f78901234567890abcdef',
        title: 'Roadmap',
        properties: { Name: { title: {} } },
      },
      makeContext(),
    );

    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0];
    expect(arg.parent).toEqual({
      type: 'page_id',
      page_id: '1a2b3c4d-5e6f-7890-1234-567890abcdef',
    });
  });
});

describe('update-database-schema (relation normalisation — bug C)', () => {
  it('rewrites relation.database_id to data_source_id before dataSources.update', async () => {
    const update = mock(async () => ({}));
    const stub = {
      databases: {
        retrieve: mock(async () => ({
          object: 'database',
          id: 'db-a',
          data_sources: [{ id: 'ds-a', name: 'Primary' }],
        })),
      },
      dataSources: { update },
    };
    const { updateDatabaseSchema } = await importToolWithStubClient<any>(
      '../../src/tools/update-database-schema',
      stub,
    );

    await updateDatabaseSchema.handler(
      {
        databaseId: '1a2b3c4d5e6f78901234567890abcdef',
        properties: {
          Integrantes: { relation: { database_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } },
        },
      },
      makeContext(),
    );

    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0];
    expect(arg.properties.Integrantes.relation.data_source_id).toBe('ds-a');
    expect(arg.properties.Integrantes.relation.database_id).toBeUndefined();
    expect(arg.properties.Integrantes.relation.type).toBe('single_property');
  });
});
