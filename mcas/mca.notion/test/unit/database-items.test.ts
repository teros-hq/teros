/**
 * Smoke tests for create-database-item and update-database-item.
 *
 * Mock the Notion client + lib so the handlers run without a real token.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { invalidateDataSourceCache } from '../../src/tools/_data-source-resolver';
import { invalidateSchema } from '../../src/tools/_schema-cache';

afterEach(() => {
  invalidateDataSourceCache();
  invalidateSchema();
});

function makeStubClient(overrides: Partial<any> = {}) {
  return {
    pages: {
      create: mock(async (params: any) => ({
        object: 'page',
        id: 'page-new',
        url: 'https://notion.so/x',
        properties: params.properties ?? {},
        parent: params.parent,
        in_trash: false,
        created_time: '2026-05-06T12:00:00.000Z',
        last_edited_time: '2026-05-06T12:00:00.000Z',
      })),
      update: mock(async (params: any) => ({
        object: 'page',
        id: params.page_id,
        url: 'https://notion.so/x',
        properties: params.properties ?? {},
        parent: { type: 'data_source_id', data_source_id: 'ds-a', database_id: 'db-a' },
        in_trash: !!params.in_trash,
        created_time: '2026-05-01T00:00:00.000Z',
        last_edited_time: '2026-05-06T12:00:00.000Z',
      })),
      retrieve: mock(async () => ({
        object: 'page',
        id: 'page-existing',
        parent: { type: 'data_source_id', data_source_id: 'ds-a', database_id: 'db-a' },
      })),
    },
    databases: {
      retrieve: mock(async () => ({
        object: 'database',
        id: 'db-a',
        data_sources: [{ id: 'ds-a' }],
      })),
    },
    dataSources: {
      retrieve: mock(async () => ({
        object: 'data_source',
        id: 'ds-a',
        properties: {
          Name: { type: 'title' },
          Status: { type: 'status' },
          Priority: { type: 'select' },
          Tags: { type: 'multi_select' },
          Due: { type: 'date' },
          Assignee: { type: 'people' },
          Related: { type: 'relation' },
        },
      })),
      query: mock(async () => ({ results: [], has_more: false, next_cursor: null })),
    },
    ...overrides,
  };
}

const makeContext = () =>
  ({ getUserSecrets: async () => ({ ACCESS_TOKEN: 'fake' }) }) as any;

async function importTool(toolPath: string, stub: any) {
  mock.module('../../src/lib', () => ({
    getNotionClient: async () => stub,
    validateCredentials: async () => undefined,
    formatBlocksAsText: () => '',
    formatRichText: () => '',
    getAllBlocks: async () => [],
  }));
  return await import(toolPath);
}

describe('create-database-item', () => {
  it('serialises a typical agent payload to Notion property shapes', async () => {
    const stub = makeStubClient();
    const { createDatabaseItem } = (await importTool(
      '../../src/tools/create-database-item',
      stub,
    )) as any;

    await createDatabaseItem.handler(
      {
        databaseId: '12345678-1234-1234-1234-123456789abc',
        properties: {
          Name: 'Fix migration',
          Status: 'In review',
          Tags: ['urgent'],
          Assignee: ['12345678-1234-1234-1234-aaaaaaaaaaaa'],
          Due: '2026-05-08',
        },
      },
      makeContext(),
    );

    expect(stub.pages.create).toHaveBeenCalledTimes(1);
    const args = stub.pages.create.mock.calls[0][0];
    expect(args.parent.data_source_id).toBe('ds-a');
    expect(args.properties.Status).toEqual({ status: { name: 'In review' } });
    expect(args.properties.Tags).toEqual({ multi_select: [{ name: 'urgent' }] });
    expect(args.properties.Assignee).toEqual({
      people: [{ id: '12345678-1234-1234-1234-aaaaaaaaaaaa' }],
    });
    expect(args.properties.Due).toEqual({ date: { start: '2026-05-08' } });
  });

  it('error mentions the failing column when it does not exist', async () => {
    const stub = makeStubClient();
    const { createDatabaseItem } = (await importTool(
      '../../src/tools/create-database-item',
      stub,
    )) as any;

    await expect(
      createDatabaseItem.handler(
        {
          databaseId: '12345678-1234-1234-1234-123456789abc',
          properties: { NotARealColumn: 'X' },
        },
        makeContext(),
      ),
    ).rejects.toThrow(/NotARealColumn/);
  });

  it('error mentions the failing column for a type mismatch', async () => {
    const stub = makeStubClient();
    const { createDatabaseItem } = (await importTool(
      '../../src/tools/create-database-item',
      stub,
    )) as any;

    await expect(
      createDatabaseItem.handler(
        {
          databaseId: '12345678-1234-1234-1234-123456789abc',
          properties: { Status: 123 },
        },
        makeContext(),
      ),
    ).rejects.toThrow(/Status/);
  });
});

describe('update-database-item', () => {
  it('looks up the parent database, resolves the schema, and updates', async () => {
    const stub = makeStubClient();
    const { updateDatabaseItem } = (await importTool(
      '../../src/tools/update-database-item',
      stub,
    )) as any;

    await updateDatabaseItem.handler(
      {
        pageId: '12345678-1234-1234-1234-123456789abc',
        properties: { Status: 'Done' },
      },
      makeContext(),
    );

    expect(stub.pages.retrieve).toHaveBeenCalledTimes(1);
    const args = stub.pages.update.mock.calls[0][0];
    expect(args.properties.Status).toEqual({ status: { name: 'Done' } });
  });

  it('archived: true → in_trash: true (no schema lookup)', async () => {
    const stub = makeStubClient();
    const { updateDatabaseItem } = (await importTool(
      '../../src/tools/update-database-item',
      stub,
    )) as any;

    await updateDatabaseItem.handler(
      { pageId: '12345678-1234-1234-1234-123456789abc', archived: true },
      makeContext(),
    );

    expect(stub.pages.retrieve).not.toHaveBeenCalled();
    const args = stub.pages.update.mock.calls[0][0];
    expect(args.in_trash).toBe(true);
  });
});

describe('create-page propertiesSimple', () => {
  it('passes shape through buildPropertiesFromSimple when only propertiesSimple is supplied', async () => {
    const stub = makeStubClient();
    const { createPage } = (await importTool('../../src/tools/create-page', stub)) as any;

    await createPage.handler(
      {
        parentId: '12345678-1234-1234-1234-123456789abc',
        parentType: 'database',
        propertiesSimple: { Name: 'Demo', Status: 'Done' },
      },
      makeContext(),
    );

    const args = stub.pages.create.mock.calls[0][0];
    expect(args.properties.Status).toEqual({ status: { name: 'Done' } });
    expect(args.properties.Name).toEqual({ title: [{ text: { content: 'Demo' } }] });
  });

  it('rejects propertiesSimple when parentType=page', async () => {
    const stub = makeStubClient();
    const { createPage } = (await importTool('../../src/tools/create-page', stub)) as any;

    await expect(
      createPage.handler(
        {
          parentId: '12345678-1234-1234-1234-123456789abc',
          parentType: 'page',
          propertiesSimple: { Name: 'X' },
        },
        makeContext(),
      ),
    ).rejects.toThrow(/parentType=database/);
  });
});
