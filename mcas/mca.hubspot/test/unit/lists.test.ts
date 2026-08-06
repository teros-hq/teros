/**
 * Lists tools — CRM Lists v3 migration guard.
 *
 * The v1 Contact Lists API (/contacts/v1/lists) was SUNSET on 2026-04-30. These
 * tests pin the v3 contract: list-lists POSTs to /crm/lists/2026-03/search with
 * an empty query, get-list GETs /crm/lists/2026-03/{id} and unwraps { list }.
 * If anyone reverts to a v1 path, the URL assertions turn red.
 *
 * Mock fiel del boundary: globalThis.fetch (lo que hubspotRequest acaba llamando).
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { listLists } from '../../src/tools/list-lists';
import { getList } from '../../src/tools/get-list';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(json: any): { url?: string; method?: string; body?: any } {
  const captured: { url?: string; method?: string; body?: any } = {};
  globalThis.fetch = mock(async (url: any, init: any) => {
    captured.url = String(url);
    captured.method = init?.method ?? 'GET';
    captured.body = init?.body ? JSON.parse(init.body) : undefined;
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
  return captured;
}

const ctx = {
  getUserSecrets: async () => ({ ACCESS_TOKEN: 'tok', REFRESH_TOKEN: 'refresh' }),
} as any;

describe('list-lists (CRM Lists v3)', () => {
  it('POSTs to /crm/lists/2026-03/search with an empty query + paging', async () => {
    const cap = mockFetch({
      lists: [
        {
          listId: 'L1',
          name: 'VIP',
          processingType: 'DYNAMIC',
          objectTypeId: '0-1',
          additionalProperties: { hs_list_size: '5' },
        },
      ],
      total: 1,
      offset: 0,
      hasMore: false,
    });

    const res = (await listLists.handler({ limit: 10 }, ctx)) as any;

    expect(cap.url).toContain('/crm/lists/2026-03/search');
    expect(cap.url).not.toContain('/contacts/v1/'); // the dead v1 API
    expect(cap.method).toBe('POST');
    expect(cap.body.query).toBe('');
    expect(cap.body.count).toBe(10);
    expect(cap.body.processingTypes).toEqual([]);
    // Must request hs_list_size or memberCount comes back null in production.
    expect(cap.body.additionalProperties).toEqual(['hs_list_size']);
    // Curated row (formatList): listId string, size coerced from hs_list_size.
    expect(res.lists[0]).toEqual({
      id: 'L1',
      name: 'VIP',
      processingType: 'DYNAMIC',
      dynamic: true,
      objectTypeId: '0-1',
      createdAt: null,
      updatedAt: null,
      memberCount: 5,
    });
    expect(res).toMatchObject({ total: 1, offset: 0, hasMore: false });
  });

  it('forwards processingType filter into the search body', async () => {
    const cap = mockFetch({ lists: [], total: 0, offset: 0, hasMore: false });
    await listLists.handler({ processingType: 'STATIC' }, ctx);
    expect(cap.body.processingTypes).toEqual(['STATIC']);
  });
});

describe('get-list (CRM Lists v3)', () => {
  it('GETs /crm/lists/2026-03/{id} and unwraps { list }', async () => {
    const cap = mockFetch({
      list: { listId: 'L9', name: 'One', processingType: 'STATIC', size: 3 },
    });

    const res = (await getList.handler({ listId: 'L9' }, ctx)) as any;

    expect(cap.url).toContain('/crm/lists/2026-03/L9');
    expect(cap.url).not.toContain('/contacts/v1/');
    expect(cap.method).toBe('GET');
    expect(res).toEqual({
      id: 'L9',
      name: 'One',
      processingType: 'STATIC',
      dynamic: false,
      objectTypeId: null,
      createdAt: null,
      updatedAt: null,
      memberCount: 3,
    });
  });
});
