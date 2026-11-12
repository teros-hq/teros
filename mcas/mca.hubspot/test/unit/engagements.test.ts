/**
 * Engagement tools — task fields + owner/status filter guard.
 *
 * Bug original (reporte de Álvaro, 2026-09): "mis tareas" salían con subject /
 * body / status / priority / dueDate a null. Causa: list-engagements mapeaba
 * TODO con formatEngagement, que nunca lee hs_task_* (solo busca hs_email_* /
 * hs_call_* / hs_meeting_* / hs_note_*). El formatTask correcto existía pero
 * no se usaba. Segundo bug en vivo: create-engagement generaba claves inválidas
 * (hs_task_text, hs_task_direction…) que HubSpot rechaza con HTTP 400
 * PROPERTY_DOESNT_EXIST.
 *
 * Estos tests fijan el contrato: (a) type=task usa formatTask y devuelve los
 * campos poblados, (b) ownerId/status conmutan al endpoint de búsqueda con
 * filterGroup (el GET list no soporta filtrado server-side), (c) el payload de
 * create solo contiene propiedades reales de HubSpot.
 *
 * Mock fiel del boundary: globalThis.fetch (lo que hubspotRequest acaba llamando).
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { listEngagements } from '../../src/tools/list-engagements';
import { getEngagement } from '../../src/tools/get-engagement';
import { createEngagement } from '../../src/tools/create-engagement';
import { hubspotRequest } from '../../src/lib';

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

/** Mock that returns a 400 with HubSpot's validationResults shape. */
function mockErrorFetch(status: number, errorBody: any): void {
  globalThis.fetch = mock(async () => {
    return new Response(JSON.stringify(errorBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
}

const ctx = {
  getUserSecrets: async () => ({ ACCESS_TOKEN: 'tok', REFRESH_TOKEN: 'refresh' }),
} as any;

// API v3 devuelve las propiedades como valores planos (no {value: ...}).
const taskRow = {
  id: '517681599730',
  properties: {
    hs_task_subject: '(Ejemplo de tarea) Seguimiento con Brian',
    hs_task_body: 'Llamar para revisar la propuesta',
    hs_task_status: 'NOT_STARTED',
    hs_task_priority: 'HIGH',
    hs_task_type: 'TODO',
    hs_timestamp: '2026-09-28T06:00:00Z',
    hubspot_owner_id: '98710162',
    hs_createdate: '2026-09-08T09:58:28.899Z',
    hs_lastmodifieddate: '2026-09-08T09:58:28.899Z',
  },
};

describe('list-engagements (task fields + owner filter)', () => {
  it('type=task uses formatTask — subject/body/status/priority/dueDate populated, not null', async () => {
    const cap = mockFetch({ results: [taskRow], paging: { next: { after: '1' } } });

    const res = (await listEngagements.handler({ type: 'task', limit: 10 }, ctx)) as any;

    expect(cap.url).toContain('/crm/v3/objects/tasks');
    expect(cap.url).not.toContain('/search'); // sin filtros → GET list plano
    expect(cap.method).toBe('GET');
    // Debe pedir hubspot_owner_id o el filtro por owner no tendría datos.
    expect(cap.url).toContain('hubspot_owner_id');

    const t = res.engagements[0];
    expect(t).toMatchObject({
      id: '517681599730',
      subject: '(Ejemplo de tarea) Seguimiento con Brian',
      body: 'Llamar para revisar la propuesta',
      status: 'NOT_STARTED',
      priority: 'HIGH',
      type: 'TODO',
      dueDate: '2026-09-28T06:00:00Z',
      ownerId: '98710162',
    });
    expect(res).toMatchObject({ total: 1, hasMore: true, nextCursor: '1' });
  });

  it('ownerId switches to the search endpoint with a hubspot_owner_id filterGroup', async () => {
    const cap = mockFetch({ results: [], total: 0 });

    await listEngagements.handler({ type: 'task', ownerId: '98710162' }, ctx);

    expect(cap.url).toContain('/crm/v3/objects/tasks/search');
    expect(cap.method).toBe('POST');
    expect(cap.body.filterGroups).toEqual([
      { filters: [{ propertyName: 'hubspot_owner_id', operator: 'EQ', value: '98710162' }] },
    ]);
    // La búsqueda necesita las propiedades como array en el body.
    expect(cap.body.properties).toContain('hs_task_subject');
    expect(cap.body.properties).toContain('hubspot_owner_id');
  });

  it('status maps to the type\'s status property (hs_task_status for tasks)', async () => {
    const cap = mockFetch({ results: [], total: 0 });

    await listEngagements.handler({ type: 'task', status: 'NOT_STARTED' }, ctx);

    expect(cap.url).toContain('/crm/v3/objects/tasks/search');
    expect(cap.body.filterGroups).toEqual([
      { filters: [{ propertyName: 'hs_task_status', operator: 'EQ', value: 'NOT_STARTED' }] },
    ]);
  });

  it('ownerId + status combine into one filterGroup (AND semantics)', async () => {
    const cap = mockFetch({ results: [], total: 0 });

    await listEngagements.handler({ type: 'task', ownerId: '98710162', status: 'NOT_STARTED' }, ctx);

    expect(cap.body.filterGroups).toHaveLength(1);
    expect(cap.body.filterGroups[0].filters).toHaveLength(2);
    expect(cap.body.filterGroups[0].filters).toContainEqual({
      propertyName: 'hubspot_owner_id',
      operator: 'EQ',
      value: '98710162',
    });
    expect(cap.body.filterGroups[0].filters).toContainEqual({
      propertyName: 'hs_task_status',
      operator: 'EQ',
      value: 'NOT_STARTED',
    });
  });

  it('status on notes is ignored (notes have no status property) → plain GET list', async () => {
    const cap = mockFetch({ results: [] });

    await listEngagements.handler({ type: 'note', status: 'NOT_STARTED' }, ctx);

    expect(cap.url).toContain('/crm/v3/objects/notes');
    expect(cap.url).not.toContain('/search');
    expect(cap.method).toBe('GET');
  });

  it('emails keep formatEngagement (hs_email_* fields, not task fields)', async () => {
    const cap = mockFetch({
      results: [
        {
          id: 'E1',
          properties: {
            hs_email_subject: 'Welcome email',
            hs_email_text: 'Hello there',
            hs_email_status: 'SENT',
            hubspot_owner_id: '37657012',
            hs_createdate: '2026-09-01T00:00:00Z',
            hs_lastmodifieddate: '2026-09-01T00:00:00Z',
          },
        },
      ],
    });

    const res = (await listEngagements.handler({ type: 'email' }, ctx)) as any;

    expect(cap.url).toContain('/crm/v3/objects/emails');
    expect(cap.method).toBe('GET');
    expect(res.engagements[0]).toMatchObject({
      subject: 'Welcome email',
      body: 'Hello there',
      status: 'SENT',
      ownerId: '37657012',
    });
  });
});

describe('get-engagement (task fields)', () => {
  it('type=task returns the task with populated fields via formatTask', async () => {
    const cap = mockFetch(taskRow);

    const res = (await getEngagement.handler({ type: 'task', engagementId: '517681599730' }, ctx)) as any;

    expect(cap.url).toContain('/crm/v3/objects/tasks/517681599730');
    expect(cap.url).toContain('hubspot_owner_id');
    expect(res).toMatchObject({
      id: '517681599730',
      subject: '(Ejemplo de tarea) Seguimiento con Brian',
      body: 'Llamar para revisar la propuesta',
      status: 'NOT_STARTED',
      priority: 'HIGH',
      ownerId: '98710162',
    });
  });
});

describe('create-engagement (task payload)', () => {
  it('type=task builds only real HubSpot task properties — no hs_task_text/hs_task_direction', async () => {
    const cap = mockFetch(taskRow);

    const res = (await createEngagement.handler(
      {
        type: 'task',
        subject: 'Enviar propuesta',
        body: 'Preparar y enviar',
        status: 'NOT_STARTED',
        startTime: '2026-10-01T10:00:00Z',
      },
      ctx,
    )) as any;

    expect(cap.url).toContain('/crm/v3/objects/tasks');
    expect(cap.method).toBe('POST');
    // Solo propiedades reales: el bloque genérico anterior generaba claves
    // que la API rechaza con PROPERTY_DOESNT_EXIST (verificado en vivo).
    expect(Object.keys(cap.body.properties).sort()).toEqual(
      ['hs_task_body', 'hs_task_status', 'hs_task_subject', 'hs_timestamp'].sort(),
    );
    expect(cap.body.properties.hs_timestamp).toBe(String(new Date('2026-10-01T10:00:00Z').getTime()));
    // La respuesta se formatea con formatTask → campos poblados.
    expect(res).toMatchObject({
      subject: '(Ejemplo de tarea) Seguimiento con Brian',
      status: 'NOT_STARTED',
      priority: 'HIGH',
    });
  });

  // Bug fb_7e877154a68782de (2026-10-26): HubSpot pasó a exigir hs_timestamp
  // en TODOS los tipos de engagement. Sin startTime el payload salía sin
  // hs_timestamp y la API respondía 400 "Some required properties were not
  // set" — note y task (y call/email/meeting) fallaban siempre que el caller
  // no pasara startTime, que es el caso casi universal.
  it('hs_timestamp defaults to now when startTime is omitted (HubSpot requires it on every type)', async () => {
    const before = Date.now();
    const cap = mockFetch(taskRow);

    await createEngagement.handler(
      { type: 'note', body: 'Nota sin startTime' },
      ctx,
    );

    const after = Date.now();
    expect(cap.url).toContain('/crm/v3/objects/notes');
    expect(cap.body.properties.hs_note_body).toBe('Nota sin startTime');
    // hs_timestamp presente y con un valor "ahora" (ms Unix).
    expect(cap.body.properties.hs_timestamp).toBeDefined();
    const ts = Number(cap.body.properties.hs_timestamp);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('every engagement type carries hs_timestamp even without startTime', async () => {
    for (const type of ['call', 'email', 'meeting', 'note', 'task'] as const) {
      const cap = mockFetch(taskRow);
      await createEngagement.handler({ type, subject: 'S', body: 'B' }, ctx);
      expect(cap.body.properties.hs_timestamp, `type=${type}`).toBeDefined();
      expect(Number(cap.body.properties.hs_timestamp)).toBeGreaterThan(0);
    }
  });

  // hs_email_direction cambió de opciones en el lado de HubSpot (verificado en
  // vivo 2026-10-27): OUTBOUND/INBOUND → INVALID_OPTION. Los legacy se mapean.
  it('email direction maps legacy OUTBOUND/INBOUND to the new allowed options', async () => {
    const cap = mockFetch({ id: 'E3', properties: {} });

    await createEngagement.handler(
      { type: 'email', subject: 'Hi', body: 'Body', direction: 'OUTBOUND' },
      ctx,
    );

    expect(cap.body.properties.hs_email_direction).toBe('EMAIL');

    const cap2 = mockFetch({ id: 'E4', properties: {} });
    await createEngagement.handler(
      { type: 'email', subject: 'Hi', body: 'Body', direction: 'inbound' },
      ctx,
    );
    expect(cap2.body.properties.hs_email_direction).toBe('INCOMING_EMAIL');

    // Los valores nuevos pasan sin tocar.
    const cap3 = mockFetch({ id: 'E5', properties: {} });
    await createEngagement.handler(
      { type: 'email', subject: 'Hi', body: 'Body', direction: 'FORWARDED_EMAIL' },
      ctx,
    );
    expect(cap3.body.properties.hs_email_direction).toBe('FORWARDED_EMAIL');
  });

  // call direction NO cambió: OUTBOUND sigue siendo válido (verificado en vivo).
  it('call direction passes through unchanged (OUTBOUND still valid for calls)', async () => {
    const cap = mockFetch({ id: 'C1', properties: {} });

    await createEngagement.handler(
      { type: 'call', subject: 'Llamada', body: 'B', direction: 'OUTBOUND' },
      ctx,
    );

    expect(cap.body.properties.hs_call_direction).toBe('OUTBOUND');
  });

  it('type=email builds only real email properties', async () => {
    const cap = mockFetch({ id: 'E2', properties: {} });

    await createEngagement.handler(
      { type: 'email', subject: 'Hi', body: 'Body', direction: 'OUTBOUND' },
      ctx,
    );

    expect(Object.keys(cap.body.properties).sort()).toEqual(
      ['hs_email_direction', 'hs_email_subject', 'hs_email_text', 'hs_timestamp'].sort(),
    );
  });
});

describe('hubspotRequest 400 error surfacing (validationResults)', () => {
  // Bug secundario de fb_7e877154a68782de: el cliente extraía solo
  // errorJson.message y descartaba validationResults, donde HubSpot dice
  // exactamente qué propiedad falla y por qué. Sin eso, un 400 "Some required
  // properties were not set" no daba ninguna pista de la causa.
  it('surfaces validationResults details in 400 errors', async () => {
    mockErrorFetch(400, {
      status: 'error',
      message: 'Property values were not valid',
      validationResults: [
        {
          isValid: false,
          message: 'OUTBOUND was not one of the allowed options: [FORWARDED_EMAIL, INCOMING_EMAIL, EMAIL, DRAFT_EMAIL]',
          error: 'INVALID_OPTION',
          name: 'hs_email_direction',
        },
      ],
    });

    let thrown: any;
    try {
      await hubspotRequest(ctx as any, '/crm/v3/objects/emails', {
        method: 'POST',
        body: { properties: { hs_email_direction: 'OUTBOUND' } },
        skipRateLimit: true,
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    expect(thrown.message).toContain('400');
    expect(thrown.message).toContain('Property values were not valid');
    // El detalle por propiedad debe viajar en el mensaje.
    expect(thrown.message).toContain('hs_email_direction');
    expect(thrown.message).toContain('OUTBOUND was not one of the allowed options');
  });

  it('keeps the plain message when validationResults is absent', async () => {
    mockErrorFetch(400, {
      status: 'error',
      message: 'Error creating NOTE. Some required properties were not set.',
    });

    let thrown: any;
    try {
      await hubspotRequest(ctx as any, '/crm/v3/objects/notes', {
        method: 'POST',
        body: { properties: {} },
        skipRateLimit: true,
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    expect(thrown.message).toBe(
      'HubSpot API error 400: Error creating NOTE. Some required properties were not set.',
    );
  });
});
