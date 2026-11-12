/**
 * Engagement→object associations — correct v4 typeIds + surfaced errors.
 *
 * Bug original (Álvaro / reporte de soporte 2026-09-11: "error 400 al crear
 * notes/tasks asociados a deals"): al crear una tarea asociada a un deal, la
 * tarea se creaba pero quedaba "en el limbo" — sin asociar. Dos causas:
 * (a) create-engagement mandaba associationTypeId: 1 hardcodeado para TODOS
 * los pares. typeId 1 es SOLO contact→primary company; para task→deal la API
 * lo rechaza con HTTP 400. (b) el catch se comía el error en silencio, así que
 * la respuesta del tool parecía exitosa aunque la tarea quedara huérfana.
 *
 * Estos tests fijan el contrato: (a) cada par usa su typeId verificado de la
 * tabla oficial (task→deal=216, note→deal=214, call→deal=206, email→deal=210,
 * meeting→deal=212, y el resto de pares engagement↔contact/company/ticket),
 * (b) la dirección from/to es engagement→objeto, (c) si la asociación falla,
 * la respuesta lo dice (associated:false + associationError), (d) sin
 * asociación pedida no hay campos de asociación en la respuesta.
 *
 * Mock fiel del boundary: globalThis.fetch (lo que hubspotRequest acaba llamando).
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createEngagement } from '../../src/tools/create-engagement';
import { createAssociation } from '../../src/tools/create-association';
import { listAssociations } from '../../src/tools/list-associations';
import { ASSOCIATION_TYPE_IDS, resolveAssociationTypeId } from '../../src/lib';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ctx = {
  getUserSecrets: async () => ({ ACCESS_TOKEN: 'tok', REFRESH_TOKEN: 'refresh' }),
} as any;

/** Mock fetch that captures ALL calls and answers each with its queued response. */
function mockFetchSequence(responses: Array<{ json?: any; status?: number }>): Array<{ url?: string; method?: string; body?: any }> {
  const captured: Array<{ url?: string; method?: string; body?: any }> = [];
  let i = 0;
  globalThis.fetch = mock(async (url: any, init: any) => {
    const call = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined };
    captured.push(call);
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r.status && r.status !== 200) {
      return new Response(JSON.stringify(r.json ?? { message: 'error' }), {
        status: r.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(r.json ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
  return captured;
}

const createdTask = { id: '517681599730', properties: { hs_task_subject: 'Seguimiento', hs_task_status: 'NOT_STARTED' } };

// ---------------------------------------------------------------------------
// typeId map — verified against the official HubSpot docs table
// ---------------------------------------------------------------------------

describe('association typeId map (official docs table)', () => {
  it('task→deal is 216 — NOT 1 (the old hardcoded value the API rejects with 400)', () => {
    expect(resolveAssociationTypeId('tasks', 'deals')).toBe(216);
  });

  it('covers every engagement↔CRM pair with the documented typeId', () => {
    // From the official "Association type ID values" table:
    // tasks: 204/192/216/230 · notes: 202/190/214/228 · calls: 194/182/206/220
    // emails: 198/186/210/224 · meetings: 200/188/212/226
    const expected: Record<string, Record<string, number>> = {
      tasks: { contacts: 204, companies: 192, deals: 216, tickets: 230 },
      notes: { contacts: 202, companies: 190, deals: 214, tickets: 228 },
      calls: { contacts: 194, companies: 182, deals: 206, tickets: 220 },
      emails: { contacts: 198, companies: 186, deals: 210, tickets: 224 },
      meetings: { contacts: 200, companies: 188, deals: 212, tickets: 226 },
    };
    for (const [from, tos] of Object.entries(expected)) {
      for (const [to, typeId] of Object.entries(tos)) {
        expect(`${from}→${to}`).toBe(`${from}→${to}`); // keep pair label on failure
        expect(resolveAssociationTypeId(from, to)).toBe(typeId);
      }
    }
    expect(ASSOCIATION_TYPE_IDS).toMatchObject(expected);
  });

  it('keeps the CRM↔CRM primary defaults (contact→company=1, deal→contact=3, …)', () => {
    expect(resolveAssociationTypeId('contacts', 'companies')).toBe(1);
    expect(resolveAssociationTypeId('deals', 'contacts')).toBe(3);
    expect(resolveAssociationTypeId('tickets', 'deals')).toBe(28);
  });

  it('returns undefined for unknown pairs — never guesses', () => {
    expect(resolveAssociationTypeId('tasks', 'courses')).toBeUndefined();
    expect(resolveAssociationTypeId('dragons', 'deals')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// create-engagement — association request payload + surfaced failures
// ---------------------------------------------------------------------------

describe('create-engagement (association typeIds + error surfacing)', () => {
  it('type=task + deal sends task→deal typeId 216, from=task, to=deal', async () => {
    const calls = mockFetchSequence([{ json: createdTask }, { json: { status: 'COMPLETE', results: [{ from: { id: '517681599730' }, to: { id: 'deal-1' } }] } }]);

    const res = (await createEngagement.handler(
      {
        type: 'task',
        subject: 'Enviar propuesta',
        associatedObjectType: 'deals',
        associatedObjectId: 'deal-1',
      },
      ctx,
    )) as any;

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('/crm/v3/objects/tasks');
    expect(calls[1].url).toBe('https://api.hubapi.com/crm/v4/associations/tasks/deals/batch/create');
    expect(calls[1].method).toBe('POST');
    expect(calls[1].body.inputs[0]).toEqual({
      from: { id: '517681599730' },
      to: { id: 'deal-1' },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 216 }],
    });
    expect(res.associated).toBe(true);
    expect(res.associationError).toBeUndefined();
  });

  it.each([
    ['note', 'deals', 214],
    ['call', 'deals', 206],
    ['email', 'deals', 210],
    ['meeting', 'deals', 212],
  ] as const)('type=%s + deal uses typeId %d', async (type, toType, typeId) => {
    const calls = mockFetchSequence([
      { json: { id: 'E1', properties: {} } },
      { json: { results: [] } },
    ]);

    await createEngagement.handler(
      { type, subject: 'x', associatedObjectType: toType, associatedObjectId: 'deal-1' },
      ctx,
    );

    const assocCall = calls.find((c) => c.url?.includes('/crm/v4/associations/'))!;
    expect(assocCall.body.inputs[0].types[0].associationTypeId).toBe(typeId);
  });

  it('surfaces association failure (associated:false + associationError) instead of swallowing it', async () => {
    // Second call (the association) fails with 400 — the exact support-report
    // scenario. The task exists, but is orphaned: the response must say so.
    const calls = mockFetchSequence([
      { json: createdTask },
      { status: 400, json: { message: 'INVALID_ASSOCIATION_TYPE' } },
    ]);

    const res = (await createEngagement.handler(
      {
        type: 'task',
        subject: 'Enviar propuesta',
        associatedObjectType: 'deals',
        associatedObjectId: 'deal-1',
      },
      ctx,
    )) as any;

    expect(calls).toHaveLength(2);
    expect(res.associated).toBe(false);
    expect(res.associationError).toContain('517681599730');
    expect(res.associationError).toContain('failed');
    expect(res.associationError).toContain('INVALID_ASSOCIATION_TYPE');
    expect(res.associationError).toContain('create-association');
    // The created task data is still returned.
    expect(res.id).toBe('517681599730');
    expect(res.subject).toBe('Seguimiento');
  });

  it('reports unknown pair as not associated (no guessed typeId sent)', async () => {
    const calls = mockFetchSequence([{ json: createdTask }]);

    const res = (await createEngagement.handler(
      {
        type: 'task',
        subject: 'x',
        // 'dragons' is not a valid associatedObjectType — simulating an
        // unsupported pair slipping past the schema enum.
        associatedObjectType: 'dragons',
        associatedObjectId: 'd-1',
      },
      ctx,
    )) as any;

    // Only the create call — no association call with a guessed typeId.
    expect(calls).toHaveLength(1);
    expect(res.associated).toBe(false);
    expect(res.associationError).toContain('dragons');
  });

  it('without association params the response has no association fields', async () => {
    const calls = mockFetchSequence([{ json: createdTask }]);

    const res = (await createEngagement.handler({ type: 'task', subject: 'x' }, ctx)) as any;

    expect(calls).toHaveLength(1);
    expect(res).not.toHaveProperty('associated');
    expect(res).not.toHaveProperty('associationError');
    expect(res.subject).toBe('Seguimiento');
  });
});

// ---------------------------------------------------------------------------
// create-association — pair resolution for manual remediation
// ---------------------------------------------------------------------------

describe('create-association (pair typeId resolution)', () => {
  it('resolves task→deal to 216 when no explicit typeId is given', async () => {
    const calls = mockFetchSequence([{ json: { results: [{ from: { id: 'task-1' }, to: { id: 'deal-1' } }] } }]);

    const res = (await createAssociation.handler(
      { fromObjectType: 'tasks', fromObjectId: 'task-1', toObjectType: 'deals', toObjectId: 'deal-1' },
      ctx,
    )) as any;

    expect(calls[0].body.inputs[0].types[0].associationTypeId).toBe(216);
    expect(res.success).toBe(true);
    expect(res.associationTypeId).toBe(216);
    expect(res.associations[0]).toEqual({ fromObjectId: 'task-1', toObjectId: 'deal-1' });
  });

  it('resolves contact→company to 1 (the only pair where 1 is actually valid)', async () => {
    const calls = mockFetchSequence([{ json: { results: [] } }]);

    await createAssociation.handler(
      { fromObjectType: 'contacts', fromObjectId: 'c-1', toObjectType: 'companies', toObjectId: 'co-1' },
      ctx,
    );

    expect(calls[0].body.inputs[0].types[0].associationTypeId).toBe(1);
  });

  it('explicit associationTypeId wins over the map', async () => {
    const calls = mockFetchSequence([{ json: { results: [] } }]);

    await createAssociation.handler(
      { fromObjectType: 'tasks', fromObjectId: 't-1', toObjectType: 'deals', toObjectId: 'd-1', associationTypeId: '218' },
      ctx,
    );

    expect(calls[0].body.inputs[0].types[0].associationTypeId).toBe('218');
  });

  it('returns success:false + guidance for unknown pairs (no API call)', async () => {
    const calls = mockFetchSequence([{ json: { results: [] } }]);

    const res = (await createAssociation.handler(
      // 'dragons' is not a valid fromObjectType — simulating an unsupported
      // pair slipping past the schema enum.
      { fromObjectType: 'dragons', fromObjectId: 'd-1', toObjectType: 'deals', toObjectId: 'deal-1' },
      ctx,
    )) as any;

    expect(calls).toHaveLength(0);
    expect(res.success).toBe(false);
    expect(res.error).toContain('dragons');
    expect(res.error).toContain('labels');
  });
});

// ---------------------------------------------------------------------------
// list-associations — real v4 route + response shape
// ---------------------------------------------------------------------------

describe('list-associations (v4 route + shape)', () => {
  it('uses the real v4 objects route, not the invented /associations/{a}/{b}/{id} path', async () => {
    const calls = mockFetchSequence([
      { json: { results: [{ toObjectId: 517681599730, associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 216, label: null }] }] } },
    ]);

    const res = (await listAssociations.handler(
      { objectType: 'deals', objectId: 'deal-1', toObjectType: 'tasks' },
      ctx,
    )) as any;

    expect(calls[0].url).toBe('https://api.hubapi.com/crm/v4/objects/deals/deal-1/associations/tasks?limit=100');
    expect(res.total).toBe(1);
    expect(res.associations[0]).toEqual({
      toObjectId: '517681599730',
      associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 216, label: null }],
    });
  });
});
