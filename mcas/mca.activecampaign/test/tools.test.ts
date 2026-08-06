import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ToolContext } from '@teros/mca-sdk';
import { __setAcResolveHostForTests, __setAcSleepForTests } from '../src/lib/index.js';
import { healthCheck } from '../src/tools/-health-check.js';
import { addTagToContact } from '../src/tools/add-tag-to-contact.js';
import { createContact } from '../src/tools/create-contact.js';
import { createDeal } from '../src/tools/create-deal.js';
import { deleteContact } from '../src/tools/delete-contact.js';
import { getCampaign } from '../src/tools/get-campaign.js';
import { getContact } from '../src/tools/get-contact.js';
import { getDeal } from '../src/tools/get-deal.js';
import { listCampaigns } from '../src/tools/list-campaigns.js';
import { listContacts } from '../src/tools/list-contacts.js';
import { listDeals } from '../src/tools/list-deals.js';
import { listLists } from '../src/tools/list-lists.js';
import { listTags } from '../src/tools/list-tags.js';
import { subscribeContactToList } from '../src/tools/subscribe-contact-to-list.js';
import { updateContact } from '../src/tools/update-contact.js';

// `ToolConfig` types handler results as `unknown`; narrow the curated payload for
// assertions (handlers return `{ content, structuredContent }`).
// biome-ignore lint/suspicious/noExplicitAny: test assertion helper
const sc = (out: unknown): any => (out as { structuredContent: unknown }).structuredContent;

const originalFetch = globalThis.fetch;
let nextResponse: () => Response;
const calls: Array<{ url: string; method: string; body?: string }> = [];

beforeEach(() => {
  calls.length = 0;
  // Fake public DNS so the SSRF guard never hits the network; instant retries.
  __setAcResolveHostForTests(async () => [{ address: '104.16.0.1' }]);
  __setAcSleepForTests(async () => {});
  nextResponse = () =>
    new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  // biome-ignore lint/suspicious/noExplicitAny: monkey-patch fetch
  (globalThis as any).fetch = async (input: any, init?: any) => {
    calls.push({
      url: typeof input === 'string' ? input : input.url,
      method: init?.method ?? 'GET',
      body: init?.body,
    });
    return nextResponse();
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __setAcResolveHostForTests(undefined);
  __setAcSleepForTests(undefined);
});

function makeContext(): ToolContext {
  return {
    execution: { userId: 'u1', appId: 'a1' },
    backend: null,
    requestId: 'req_test',
    getSystemSecrets: async () => ({}),
    getUserSecrets: async () => ({
      ACTIVECAMPAIGN_BASE_URL: 'https://test.api-us1.com',
      ACTIVECAMPAIGN_API_TOKEN: 'token',
    }),
    updateUserSecrets: async () => {},
    getScope: () => 'u1',
    getData: async () => ({ value: null, exists: false }),
    setData: async () => ({ success: true }),
    deleteData: async () => ({ success: true, deleted: false }),
    listData: async () => ({ keys: [] }),
    // biome-ignore lint/suspicious/noExplicitAny: loose ToolContext for tests
  } as any;
}

describe('list-contacts', () => {
  test('returns paginated curated contacts', async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({
          contacts: [
            { id: '1', email: 'a@x.com', firstName: 'Ann', lastName: 'X' },
            { id: '2', email: 'b@x.com', firstName: 'Bob', lastName: 'Y' },
          ],
          meta: { total: '5' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const out = await listContacts.handler({ limit: 2, offset: 0 }, makeContext());
    expect(calls[0].url).toContain('/contacts');
    expect(sc(out)).toEqual({
      contacts: [
        {
          id: '1',
          email: 'a@x.com',
          firstName: 'Ann',
          lastName: 'X',
          phone: '',
          cdate: '',
          udate: '',
        },
        {
          id: '2',
          email: 'b@x.com',
          firstName: 'Bob',
          lastName: 'Y',
          phone: '',
          cdate: '',
          udate: '',
        },
      ],
      total: 5,
      nextOffset: 2,
    });
  });

  test('clamps limit to [1, 100]', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ contacts: [], meta: { total: '0' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await listContacts.handler({ limit: 9999 }, makeContext());
    expect(calls[0].url).toContain('limit=100');
  });
});

describe('get-contact', () => {
  test('throws when id missing', async () => {
    let err: unknown = null;
    try {
      await getContact.handler({ id: '' }, makeContext());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
  });

  test('encodes id and returns curated contact', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ contact: { id: '42', email: 'x@y.z', firstName: 'X' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const out = await getContact.handler({ id: '42' }, makeContext());
    expect(calls[0].url).toContain('/contacts/42');
    expect(sc(out).contact).toEqual({
      id: '42',
      email: 'x@y.z',
      firstName: 'X',
      lastName: '',
      phone: '',
      cdate: '',
      udate: '',
    });
  });
});

describe('create-contact', () => {
  test('rejects invalid email', async () => {
    let err: unknown = null;
    try {
      await createContact.handler({ email: 'not-an-email' }, makeContext());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
  });

  test('posts to /contact/sync with curated body', async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({ contact: { id: '99', email: 'jane@acme.com', firstName: 'Jane' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const out = await createContact.handler(
      { email: 'jane@acme.com', firstName: 'Jane', phone: '+1' },
      makeContext(),
    );
    expect(calls[0].url).toContain('/contact/sync');
    expect(calls[0].method).toBe('POST');
    const body = JSON.parse(calls[0].body!);
    expect(body.contact).toEqual({ email: 'jane@acme.com', firstName: 'Jane', phone: '+1' });
    expect(body.contact.lastName).toBeUndefined(); // not provided → not sent
    expect(sc(out).contact).toEqual({
      id: '99',
      email: 'jane@acme.com',
      firstName: 'Jane',
      lastName: '',
      phone: '',
      cdate: '',
      udate: '',
    });
  });

  test('rejects update-style email that is malformed', async () => {
    let err: unknown = null;
    try {
      await createContact.handler({ email: '  ' }, makeContext());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
  });
});

describe('update-contact', () => {
  test('requires at least one update field', async () => {
    let err: unknown = null;
    try {
      await updateContact.handler({ id: '1' }, makeContext());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
  });

  test('PUTs only provided fields', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ contact: { id: '1', email: 'new@x.com' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await updateContact.handler({ id: '1', email: 'new@x.com' }, makeContext());
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toContain('/contacts/1');
    const body = JSON.parse(calls[0].body!);
    expect(body).toEqual({ contact: { email: 'new@x.com' } });
  });

  test('rejects a malformed email', async () => {
    let err: unknown = null;
    try {
      await updateContact.handler({ id: '1', email: 'not-an-email' }, makeContext());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(calls).toHaveLength(0); // never reached the API
  });
});

describe('delete-contact', () => {
  test('returns deleted: true', async () => {
    nextResponse = () => new Response(null, { status: 204 });
    const out = await deleteContact.handler({ id: '7' }, makeContext());
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toContain('/contacts/7');
    expect(sc(out)).toEqual({ id: '7', deleted: true });
  });
});

describe('subscribe-contact-to-list', () => {
  test('maps subscribed -> 1', async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({ contactList: { id: '99', contact: '1', list: '5', status: '1' } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    await subscribeContactToList.handler({ contactId: '1', listId: '5' }, makeContext());
    const body = JSON.parse(calls[0].body!);
    expect(body.contactList.status).toBe(1);
    expect(body.contactList.list).toBe('5');
    expect(body.contactList.contact).toBe('1');
  });

  test('maps unsubscribed -> 2', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ contactList: { id: '99' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await subscribeContactToList.handler(
      { contactId: '1', listId: '5', status: 'unsubscribed' },
      makeContext(),
    );
    expect(JSON.parse(calls[0].body!).contactList.status).toBe(2);
  });
});

describe('list-deals', () => {
  test('builds filter query params with bracketed keys', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ deals: [], meta: { total: '0' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await listDeals.handler(
      { search: 'big', pipelineId: 'p1', stageId: 's1', status: 'won' },
      makeContext(),
    );
    expect(calls[0].url).toContain('filters%5Bsearch%5D=big');
    expect(calls[0].url).toContain('filters%5Bgroup%5D=p1');
    expect(calls[0].url).toContain('filters%5Bstage%5D=s1');
    expect(calls[0].url).toContain('filters%5Bstatus%5D=1');
  });
});

describe('create-deal', () => {
  test('converts value to cents', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ deal: { id: '1', value: '150000', currency: 'usd' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const out = await createDeal.handler(
      {
        title: 'Big sale',
        value: 1500,
        pipelineId: 'p1',
        stageId: 's1',
        ownerId: 'u1',
      },
      makeContext(),
    );
    const body = JSON.parse(calls[0].body!);
    expect(body.deal.value).toBe(150000);
    expect(body.deal.currency).toBe('usd');
    expect(body.deal.group).toBe('p1');
    expect(sc(out).deal.value).toBe(1500);
  });

  test('rejects missing required fields', async () => {
    let err: unknown = null;
    try {
      await createDeal.handler(
        { title: '', value: 1, pipelineId: 'p', stageId: 's', ownerId: 'o' },
        makeContext(),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
  });

  test('rejects a negative value', async () => {
    let err: unknown = null;
    try {
      await createDeal.handler(
        { title: 'X', value: -5, pipelineId: 'p', stageId: 's', ownerId: 'o' },
        makeContext(),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(calls).toHaveLength(0);
  });
});

describe('get-deal', () => {
  test('throws when id missing', async () => {
    let err: unknown = null;
    try {
      await getDeal.handler({ id: '  ' }, makeContext());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(calls).toHaveLength(0);
  });

  test('encodes id and returns curated deal', async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({ deal: { id: '5', title: 'Big', value: '150000', currency: 'usd' } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    const out = await getDeal.handler({ id: '5' }, makeContext());
    expect(calls[0].url).toContain('/deals/5');
    expect(sc(out).deal).toEqual({
      id: '5',
      title: 'Big',
      description: '',
      value: 1500,
      currency: 'USD',
      status: 0,
      contact: null,
      account: null,
      pipeline: null,
      stage: null,
      owner: null,
      cdate: '',
      udate: '',
    });
  });
});

describe('get-campaign', () => {
  test('throws when id missing', async () => {
    let err: unknown = null;
    try {
      await getCampaign.handler({ id: '' }, makeContext());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(calls).toHaveLength(0);
  });

  test('encodes id and maps send_amt to recipients', async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({
          campaign: {
            id: '7',
            name: 'Spring',
            send_amt: '500',
            opens: '320',
            uniqueopens: '300',
            linkclicks: '42',
            uniquelinkclicks: '40',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const out = await getCampaign.handler({ id: '7' }, makeContext());
    expect(calls[0].url).toContain('/campaigns/7');
    expect(sc(out).campaign).toEqual({
      id: '7',
      name: 'Spring',
      type: '',
      status: '',
      sendDate: null,
      fromName: '',
      fromEmail: '',
      subject: '',
      totalRecipients: 500,
      totalOpens: 320,
      totalLinks: 42,
      uniqueOpens: 300,
      uniqueLinks: 40,
      cdate: '',
    });
  });
});

describe('list-campaigns', () => {
  test('requests /campaigns and curates items with pagination', async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({
          campaigns: [{ id: '1', name: 'Spring', send_amt: '200' }],
          meta: { total: '1' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const out = await listCampaigns.handler({ limit: 1, offset: 0 }, makeContext());
    expect(calls[0].url).toContain('/campaigns');
    expect(calls[0].url).toContain('limit=1');
    expect(sc(out)).toEqual({
      campaigns: [
        {
          id: '1',
          name: 'Spring',
          type: '',
          status: '',
          sendDate: null,
          fromName: '',
          fromEmail: '',
          subject: '',
          totalRecipients: 200,
          totalOpens: 0,
          totalLinks: 0,
          uniqueOpens: 0,
          uniqueLinks: 0,
          cdate: '',
        },
      ],
      total: 1,
      nextOffset: null,
    });
  });
});

describe('list-lists', () => {
  test('requests /lists and curates items', async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({
          lists: [{ id: '3', name: 'NL', stringid: 'nl', subscriber_count: 10 }],
          meta: { total: '1' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const out = await listLists.handler({ limit: 10 }, makeContext());
    expect(calls[0].url).toContain('/lists');
    expect(sc(out)).toEqual({
      lists: [{ id: '3', name: 'NL', stringid: 'nl', subscriberCount: 10, cdate: '' }],
      total: 1,
      nextOffset: null,
    });
  });
});

describe('list-tags', () => {
  test('passes search and curates tags', async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({
          tags: [{ id: '2', tag: 'vip', tagType: 'contact' }],
          meta: { total: '1' },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    const out = await listTags.handler({ search: 'vi', limit: 10 }, makeContext());
    expect(calls[0].url).toContain('/tags');
    expect(calls[0].url).toContain('search=vi');
    expect(sc(out)).toEqual({
      tags: [{ id: '2', name: 'vip', description: '', tagType: 'contact', cdate: '' }],
      total: 1,
      nextOffset: null,
    });
  });
});

describe('add-tag-to-contact', () => {
  test('throws when ids missing', async () => {
    let err: unknown = null;
    try {
      await addTagToContact.handler({ contactId: '', tagId: '2' }, makeContext());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(calls).toHaveLength(0);
  });

  test('POSTs to /contactTags and returns the curated link', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ contactTag: { id: '9', contact: '1', tag: '2' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const out = await addTagToContact.handler({ contactId: '1', tagId: '2' }, makeContext());
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/contactTags');
    expect(JSON.parse(calls[0].body!)).toEqual({ contactTag: { contact: '1', tag: '2' } });
    expect(sc(out)).toEqual({ contactTag: { id: '9', contact: '1', tag: '2' } });
  });
});

describe('-health-check', () => {
  test('reports ready when the API is reachable', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ user: { id: '1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const out = (await healthCheck.handler({}, makeContext())) as {
      status: string;
      issues?: unknown[];
    };
    expect(out.status).toBe('ready');
    expect(out.issues).toBeUndefined();
    expect(calls[0].url).toContain('/users/me');
  });

  test('reports not_ready (no API call) when credentials are missing', async () => {
    const ctx = {
      ...makeContext(),
      getUserSecrets: async () => ({}),
    } as unknown as ToolContext;
    const out = (await healthCheck.handler({}, ctx)) as { status: string; issues?: unknown[] };
    expect(out.status).toBe('not_ready');
    expect(out.issues?.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  });
});
