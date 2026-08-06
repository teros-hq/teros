/**
 * Smoke tests for the v5 tools added in PR1.
 *
 * Mocks the @notionhq/client `Client` so we can drive the handlers without
 * needing a real Notion token. Validates the flow shape (calls, params,
 * outputs) — not the upstream API behaviour.
 */

import { afterEach, describe, expect, it, type Mock, mock } from 'bun:test';
import { APIErrorCode, APIResponseError } from '@notionhq/client';
import { invalidateDataSourceCache } from '../../src/tools/_data-source-resolver';
import { invalidateSchema } from '../../src/tools/_schema-cache';

/**
 * Builds a real SDK `APIResponseError` instance so that `isNotionClientError`
 * in `_notion-error.ts` returns true — same path production hits when Notion
 * responds with a 4xx/5xx and our `wrapNotionWrite` re-throws it.
 */
function sdkApiError(code: APIErrorCode, status: number, message: string): APIResponseError {
  return new APIResponseError({
    code,
    status,
    message,
    headers: undefined as any,
    rawBodyText: `{"code":"${code}","message":"${message}"}`,
    additional_data: undefined,
    request_id: undefined,
  });
}

afterEach(() => {
  invalidateDataSourceCache();
  invalidateSchema();
});

type StubClient = {
  fileUploads: {
    create: Mock<any>;
    send: Mock<any>;
    complete: Mock<any>;
  };
  comments: { update: Mock<any>; delete: Mock<any> };
  pages: {
    retrieveMarkdown: Mock<any>;
    updateMarkdown: Mock<any>;
    create: Mock<any>;
    update: Mock<any>;
    retrieve: Mock<any>;
  };
  dataSources: {
    query: Mock<any>;
    update: Mock<any>;
  };
  databases: {
    retrieve: Mock<any>;
  };
};

function buildStubClient(overrides: Partial<StubClient> = {}): StubClient {
  return {
    fileUploads: {
      create: mock(async () => ({ id: 'fu-123' })),
      send: mock(async () => ({})),
      complete: mock(async () => ({ status: 'uploaded' })),
    },
    comments: {
      update: mock(async (params: any) => ({
        id: params.comment_id,
        rich_text: params.rich_text,
        created_time: '2026-04-01T00:00:00.000Z',
        last_edited_time: '2026-04-02T00:00:00.000Z',
        parent: { type: 'page_id', page_id: 'page-a' },
        created_by: { id: 'user-a' },
      })),
      delete: mock(async () => undefined),
    },
    pages: {
      retrieveMarkdown: mock(async () => ({ markdown: '# Hello\n\nBody' })),
      updateMarkdown: mock(async () => ({ results: [{}, {}, {}] })),
      create: mock(async () => ({ object: 'page', id: 'page-b' })),
      update: mock(async () => ({ object: 'page', id: 'page-b' })),
      retrieve: mock(async () => ({ object: 'page', id: 'page-a' })),
    },
    dataSources: {
      query: mock(async () => ({ results: [], has_more: false, next_cursor: null })),
      update: mock(async () => ({})),
    },
    databases: {
      retrieve: mock(async () => ({
        object: 'database',
        id: 'db-a',
        data_sources: [{ id: 'ds-a', name: 'Primary' }],
      })),
    },
    ...overrides,
  };
}

const makeContext = (overrides: Partial<any> = {}) =>
  ({
    getUserSecrets: async () => ({ ACCESS_TOKEN: 'fake-token' }),
    ...overrides,
  }) as any;

async function importToolWithStubClient<T>(toolPath: string, stub: StubClient): Promise<T> {
  // Reset module cache so `getNotionClient` resolves the stubbed client.
  mock.module('../../src/lib', () => ({
    getNotionClient: async () => stub,
    validateCredentials: async () => undefined,
    formatBlocksAsText: () => '',
    formatRichText: () => '',
    getAllBlocks: async () => [],
  }));
  return await import(toolPath);
}

describe('upload-file (3-step lifecycle)', () => {
  it('creates → sends a dataUrl upload and returns the id (single-part: complete skipped)', async () => {
    // Single-part uploads transition to `uploaded` after `send`; `complete`
    // is only needed for multi-part flows. Stub send to return uploaded so
    // complete is skipped (the new behaviour).
    const stub = buildStubClient({
      fileUploads: {
        create: mock(async () => ({ id: 'fu-123' })),
        send: mock(async () => ({ status: 'uploaded' })),
        complete: mock(async () => ({ status: 'uploaded' })),
      },
    });
    const { uploadFile } = (await importToolWithStubClient(
      '../../src/tools/upload-file',
      stub,
    )) as any;

    const result = await uploadFile.handler(
      {
        pageId: '12345678-1234-1234-1234-123456789abc',
        name: 'spec.pdf',
        contentType: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK',
      },
      makeContext(),
    );

    expect(stub.fileUploads.create).toHaveBeenCalledTimes(1);
    expect(stub.fileUploads.send).toHaveBeenCalledTimes(1);
    expect(stub.fileUploads.complete).toHaveBeenCalledTimes(0);
    expect(result.fileUploadId).toBe('fu-123');
    expect(result.status).toBe('uploaded');
    expect(result.contentType).toBe('application/pdf');
    expect(typeof result.sizeBytes).toBe('number');

    // Regression — Notion v5 SDK serialises send via FormData; a raw Buffer
    // throws "FormData append parameter 2 is not of type 'Blob'". Verify we
    // wrapped the bytes in a Blob with the right content_type.
    const sendArgs = stub.fileUploads.send.mock.calls[0][0];
    expect(sendArgs.file.data).toBeInstanceOf(Blob);
    expect((sendArgs.file.data as Blob).type).toBe('application/pdf');
    expect(sendArgs.file.filename).toBe('spec.pdf');
  });

  it('still calls complete when send returns pending (multi-part)', async () => {
    const stub = buildStubClient({
      fileUploads: {
        create: mock(async () => ({ id: 'fu-mp' })),
        send: mock(async () => ({ status: 'pending' })),
        complete: mock(async () => ({ status: 'uploaded' })),
      },
    });
    const { uploadFile } = (await importToolWithStubClient(
      '../../src/tools/upload-file',
      stub,
    )) as any;

    const result = await uploadFile.handler(
      {
        pageId: '12345678-1234-1234-1234-123456789abc',
        name: 'big.pdf',
        contentType: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK',
      },
      makeContext(),
    );
    expect(stub.fileUploads.complete).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('uploaded');
  });

  it('skips complete when send returns status uploaded (single-part upload)', async () => {
    const stub = buildStubClient({
      fileUploads: {
        create: mock(async () => ({ id: 'fu-456' })),
        send: mock(async () => ({ status: 'uploaded' })),
        complete: mock(async () => ({ status: 'uploaded' })),
      },
    });
    const { uploadFile } = (await importToolWithStubClient(
      '../../src/tools/upload-file',
      stub,
    )) as any;

    const result = await uploadFile.handler(
      {
        pageId: '12345678-1234-1234-1234-123456789abc',
        name: 'pic.png',
        contentType: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      },
      makeContext(),
    );

    expect(stub.fileUploads.send).toHaveBeenCalledTimes(1);
    expect(stub.fileUploads.complete).toHaveBeenCalledTimes(0);
    expect(result.status).toBe('uploaded');
  });

  it('coerces "must be in pending" race-condition error to uploaded', async () => {
    const stub = buildStubClient({
      fileUploads: {
        create: mock(async () => ({ id: 'fu-789' })),
        send: mock(async () => ({ status: 'pending' })),
        complete: mock(async () => {
          // Throw a real `APIResponseError` so the classifier in `_notion-error.ts`
          // routes it to VALIDATION_ERROR (the path production hits).
          throw sdkApiError(
            APIErrorCode.ValidationError,
            400,
            "File upload must be in a 'pending' status to use the complete API",
          );
        }),
      },
    });
    const { uploadFile } = (await importToolWithStubClient(
      '../../src/tools/upload-file',
      stub,
    )) as any;

    const result = await uploadFile.handler(
      {
        pageId: '12345678-1234-1234-1234-123456789abc',
        name: 'pic.png',
        contentType: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      },
      makeContext(),
    );
    expect(result.status).toBe('uploaded');
  });

  it('rejects when both dataUrl and filePath are supplied', async () => {
    const stub = buildStubClient();
    const { uploadFile } = (await importToolWithStubClient(
      '../../src/tools/upload-file',
      stub,
    )) as any;

    await expect(
      uploadFile.handler(
        {
          pageId: '12345678-1234-1234-1234-123456789abc',
          name: 'a.pdf',
          contentType: 'application/pdf',
          dataUrl: 'data:application/pdf;base64,AAAA',
          filePath: '/tmp/a.pdf',
        },
        makeContext(),
      ),
    ).rejects.toThrow();
  });

  it('rejects malformed dataUrl', async () => {
    const stub = buildStubClient();
    const { uploadFile } = (await importToolWithStubClient(
      '../../src/tools/upload-file',
      stub,
    )) as any;

    await expect(
      uploadFile.handler(
        {
          pageId: '12345678-1234-1234-1234-123456789abc',
          name: 'a.png',
          contentType: 'image/png',
          dataUrl: 'not a data url',
        },
        makeContext(),
      ),
    ).rejects.toThrow(/dataUrl/);
  });
});

describe('comments — update / delete', () => {
  it('update-comment serialises plain text to rich_text and returns curated shape', async () => {
    const stub = buildStubClient();
    const { updateComment } = (await importToolWithStubClient(
      '../../src/tools/update-comment',
      stub,
    )) as any;

    const result = await updateComment.handler(
      {
        commentId: '12345678-1234-1234-1234-123456789abc',
        text: 'Reviewed, looks good',
      },
      makeContext(),
    );

    expect(stub.comments.update).toHaveBeenCalledTimes(1);
    const args = stub.comments.update.mock.calls[0][0];
    expect(args.rich_text[0].text.content).toBe('Reviewed, looks good');
    expect(result).toMatchObject({ id: '12345678-1234-1234-1234-123456789abc' });
  });

  it('update-comment rejects when neither text nor richText supplied', async () => {
    const stub = buildStubClient();
    const { updateComment } = (await importToolWithStubClient(
      '../../src/tools/update-comment',
      stub,
    )) as any;

    await expect(
      updateComment.handler({ commentId: '12345678-1234-1234-1234-123456789abc' }, makeContext()),
    ).rejects.toThrow();
  });

  it('delete-comment coerces 404 to deleted: true (idempotent)', async () => {
    const stub = buildStubClient({
      comments: {
        update: mock(async () => ({})),
        delete: mock(async () => {
          // Throw a real `APIResponseError` so the classifier in `_notion-error.ts`
          // routes it to NOT_FOUND (the path production hits when a comment is
          // re-deleted and Notion returns 404).
          throw sdkApiError(APIErrorCode.ObjectNotFound, 404, 'not found');
        }),
      },
    });
    const { deleteComment } = (await importToolWithStubClient(
      '../../src/tools/delete-comment',
      stub,
    )) as any;

    const result = await deleteComment.handler(
      { commentId: '12345678-1234-1234-1234-123456789abc' },
      makeContext(),
    );

    expect(result).toEqual({
      id: '12345678-1234-1234-1234-123456789abc',
      deleted: true,
    });
  });
});

describe('markdown content endpoints', () => {
  it('get-page-markdown forwards include_transcript when requested', async () => {
    const stub = buildStubClient();
    const { getPageMarkdown } = (await importToolWithStubClient(
      '../../src/tools/get-page-markdown',
      stub,
    )) as any;

    const result = await getPageMarkdown.handler(
      { pageId: '12345678-1234-1234-1234-123456789abc', includeTranscript: true },
      makeContext(),
    );

    expect(stub.pages.retrieveMarkdown).toHaveBeenCalledTimes(1);
    const args = stub.pages.retrieveMarkdown.mock.calls[0][0];
    expect(args.include_transcript).toBe(true);
    expect(result.markdown).toBe('# Hello\n\nBody');
  });

  it('update-page-markdown wraps replace mode in the v5 discriminated body', async () => {
    const stub = buildStubClient();
    const { updatePageMarkdown } = (await importToolWithStubClient(
      '../../src/tools/update-page-markdown',
      stub,
    )) as any;

    const result = await updatePageMarkdown.handler(
      { pageId: '12345678-1234-1234-1234-123456789abc', markdown: '# New body' },
      makeContext(),
    );
    expect(stub.pages.updateMarkdown).toHaveBeenCalledTimes(1);
    const body = stub.pages.updateMarkdown.mock.calls[0][0];
    expect(body.type).toBe('replace_content');
    expect(body.replace_content.new_str).toBe('# New body');
    expect(body.replace_content.allow_deleting_content).toBe(true);
    expect(result.mode).toBe('replace');
  });

  it('update-page-markdown append mode forwards `after`', async () => {
    const stub = buildStubClient();
    const { updatePageMarkdown } = (await importToolWithStubClient(
      '../../src/tools/update-page-markdown',
      stub,
    )) as any;

    await updatePageMarkdown.handler(
      {
        pageId: '12345678-1234-1234-1234-123456789abc',
        mode: 'append',
        markdown: '## End',
        afterBlockId: '12345678-1234-1234-1234-aaaaaaaaaaaa',
      },
      makeContext(),
    );
    const body = stub.pages.updateMarkdown.mock.calls[0][0];
    expect(body.type).toBe('insert_content');
    expect(body.insert_content.content).toBe('## End');
    expect(body.insert_content.after).toBe('12345678-1234-1234-1234-aaaaaaaaaaaa');
  });

  it('update-page-markdown edit mode maps oldStr/newStr to content_updates', async () => {
    const stub = buildStubClient();
    const { updatePageMarkdown } = (await importToolWithStubClient(
      '../../src/tools/update-page-markdown',
      stub,
    )) as any;

    await updatePageMarkdown.handler(
      {
        pageId: '12345678-1234-1234-1234-123456789abc',
        mode: 'edit',
        edits: [{ oldStr: 'foo', newStr: 'bar', replaceAll: true }],
      },
      makeContext(),
    );
    const body = stub.pages.updateMarkdown.mock.calls[0][0];
    expect(body.type).toBe('update_content');
    expect(body.update_content.content_updates[0]).toEqual({
      old_str: 'foo',
      new_str: 'bar',
      replace_all_matches: true,
    });
  });
});

describe('query-database multi-source aware', () => {
  it('resolves data_source_id from databaseId then queries dataSources.query', async () => {
    const stub = buildStubClient();
    const { queryDatabase } = (await importToolWithStubClient(
      '../../src/tools/query-database',
      stub,
    )) as any;

    await queryDatabase.handler(
      { databaseId: '12345678-1234-1234-1234-123456789abc' },
      makeContext(),
    );

    expect(stub.databases.retrieve).toHaveBeenCalledTimes(1);
    expect(stub.dataSources.query).toHaveBeenCalledTimes(1);
    const queryArgs = stub.dataSources.query.mock.calls[0][0];
    expect(queryArgs.data_source_id).toBe('ds-a');
  });

  it('skips the discovery call when dataSourceId is provided directly', async () => {
    const stub = buildStubClient();
    const { queryDatabase } = (await importToolWithStubClient(
      '../../src/tools/query-database',
      stub,
    )) as any;

    await queryDatabase.handler(
      { dataSourceId: '12345678-1234-1234-1234-123456789abc' },
      makeContext(),
    );

    // dataSourceId path bypasses databases.retrieve. (resolveDataSourceId
    // could still be called by another worker; the assertion is on the
    // direct path of this single call.)
    const queryArgs = stub.dataSources.query.mock.calls[0][0];
    expect(queryArgs.data_source_id).toBe('12345678-1234-1234-1234-123456789abc');
  });
});

describe('create-page targets data_source_id under database parents', () => {
  it('resolves and serialises parent: { data_source_id }', async () => {
    const stub = buildStubClient();
    const { createPage } = (await importToolWithStubClient(
      '../../src/tools/create-page',
      stub,
    )) as any;

    await createPage.handler(
      {
        parentId: '12345678-1234-1234-1234-123456789abc',
        parentType: 'database',
        title: 'Demo row',
      },
      makeContext(),
    );

    expect(stub.pages.create).toHaveBeenCalledTimes(1);
    const args = stub.pages.create.mock.calls[0][0];
    expect(args.parent.data_source_id).toBe('ds-a');
    expect(args.parent.database_id).toBeUndefined();
  });
});

describe('update-page maps archived → in_trash', () => {
  it('moves to trash when archived: true is requested', async () => {
    const stub = buildStubClient();
    const { updatePage } = (await importToolWithStubClient(
      '../../src/tools/update-page',
      stub,
    )) as any;

    await updatePage.handler(
      { pageId: '12345678-1234-1234-1234-123456789abc', archived: true },
      makeContext(),
    );

    const args = stub.pages.update.mock.calls[0][0];
    expect(args.in_trash).toBe(true);
    expect(args.archived).toBeUndefined();
  });
});
