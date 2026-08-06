import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import type { ToolContext } from '@teros/mca-sdk';
import { MakeError } from '../../src/lib/errors';
import {
  cloneScenarioTool,
  createScenarioTool,
  deleteScenarioTool,
  getScenarioBlueprintTool,
  getScenarioTool,
  startScenarioTool,
  stopScenarioTool,
  updateScenarioTool,
} from '../../src/tools/scenarios';

interface Call {
  url: string;
  init?: RequestInit;
}

let calls: Call[] = [];
let fetchResponder: ((call: Call) => Response) | null = null;
const originalFetch = globalThis.fetch;

function installFetchMock(responder: (call: Call) => Response) {
  fetchResponder = responder;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const call: Call = { url, init };
    calls.push(call);
    return fetchResponder!(call);
  }) as typeof globalThis.fetch;
}

function uninstallFetchMock() {
  globalThis.fetch = originalFetch;
  fetchResponder = null;
  calls = [];
}

function ctx(secrets: Record<string, string>): ToolContext {
  return {
    getUserSecrets: async () => secrets,
    signal: undefined,
  } as unknown as ToolContext;
}

function headerOf(init: RequestInit | undefined, key: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[key];
}

async function rejectedWith(promise: Promise<unknown>): Promise<MakeError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof MakeError) return e;
    throw e;
  }
  throw new Error('expected the promise to reject with a MakeError');
}

const TOKEN = { MAKE_API_TOKEN: 'tok-abc', MAKE_REGION: 'eu1' };

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  uninstallFetchMock();
});

// ─── create-scenario ─────────────────────────────────────────────────────────

describe('create-scenario', () => {
  test('POSTs blueprint serialized as a string with defaults', () => {
    installFetchMock(() =>
      new Response('{"id":123,"name":"New scenario","teamId":7,"isActive":false}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = (createScenarioTool.handler(
      { teamId: '7', name: 'New scenario', blueprint: { flow: [{ module: 'http' }] } },
      ctx(TOKEN),
    ) as Promise<any>);

    return res.then((result) => {
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://eu1.make.com/api/v2/scenarios');
      expect(calls[0].init?.method).toBe('POST');
      expect(headerOf(calls[0].init, 'authorization')).toBe('Token tok-abc');

      const body = JSON.parse(calls[0].init?.body as string);
      expect(body.teamId).toBe('7');
      expect(body.name).toBe('New scenario');
      expect(typeof body.blueprint).toBe('string');
      expect(JSON.parse(body.blueprint)).toEqual({ flow: [{ module: 'http' }] });
      expect(body.scheduling).toEqual({ type: 'indefinitely', interval: 60 });
      expect(body.confirmed).toBe(true);

      expect(result).toEqual({
        scenarioId: '123',
        name: 'New scenario',
        teamId: '7',
        folderId: null,
        isActive: false,
        region: 'eu1',
        url: null,
      });
    });
  });

  test('accepts optional folderId, basedon and custom scheduling', () => {
    installFetchMock(() => new Response('{"id":1}', { status: 200, headers: { 'content-type': 'application/json' } }));

    const res = (createScenarioTool.handler(
      {
        teamId: '7',
        blueprint: { a: 1 },
        folderId: 'folder-9',
        basedon: '42',
        scheduling: { type: 'specific', interval: 300 },
        confirmed: false,
      },
      ctx(TOKEN),
    ) as Promise<any>);

    return res.then(() => {
      const body = JSON.parse(calls[0].init?.body as string);
      expect(body.folderId).toBe('folder-9');
      expect(body.basedon).toBe('42');
      expect(body.scheduling).toEqual({ type: 'specific', interval: 300 });
      expect(body.confirmed).toBe(false);
    });
  });

  test('rejects missing teamId', async () => {
    const err = await rejectedWith((createScenarioTool.handler({ blueprint: {} } as any, ctx(TOKEN)) as Promise<unknown>));
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).toContain('teamId');
  });

  test('rejects missing blueprint', async () => {
    const err = await rejectedWith((createScenarioTool.handler({ teamId: '7' } as any, ctx(TOKEN)) as Promise<unknown>));
    expect(err.code).toBe('BAD_REQUEST');
  });
});

// ─── get-scenario ────────────────────────────────────────────────────────────

describe('get-scenario', () => {
  test('GETs the scenario by id and returns normalized fields', () => {
    installFetchMock(() =>
      new Response('{"id":55,"name":"Lead sync","isActive":true,"teamId":7,"folderId":2}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = (getScenarioTool.handler({ scenarioId: '55' }, ctx(TOKEN)) as Promise<any>);

    return res.then((result) => {
      expect(calls[0].url).toBe('https://eu1.make.com/api/v2/scenarios/55');
      expect(calls[0].init?.method).toBe('GET');
      expect(result).toMatchObject({
        scenarioId: '55',
        name: 'Lead sync',
        isActive: true,
        teamId: '7',
        folderId: '2',
        region: 'eu1',
      });
    });
  });

  test('rejects empty scenarioId', async () => {
    const err = await rejectedWith((getScenarioTool.handler({ scenarioId: '' }, ctx(TOKEN)) as Promise<unknown>));
    expect(err.code).toBe('BAD_REQUEST');
  });
});

// ─── get-scenario-blueprint ──────────────────────────────────────────────────

describe('get-scenario-blueprint', () => {
  test('GETs the blueprint and parses it from a string', () => {
    const blueprint = { flow: [{ module: 'json' }] };
    installFetchMock(() =>
      new Response(JSON.stringify({ blueprint: JSON.stringify(blueprint) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = (getScenarioBlueprintTool.handler({ scenarioId: '55' }, ctx(TOKEN)) as Promise<any>);

    return res.then((result) => {
      expect(calls[0].url).toBe('https://eu1.make.com/api/v2/scenarios/55/blueprint');
      expect(result).toEqual({ scenarioId: '55', blueprint, region: 'eu1' });
    });
  });

  test('returns parsed object blueprint as-is', () => {
    const blueprint = { flow: [{ module: 'json' }] };
    installFetchMock(() =>
      new Response(JSON.stringify({ blueprint }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = (getScenarioBlueprintTool.handler({ scenarioId: '55' }, ctx(TOKEN)) as Promise<any>);

    return res.then((result) => {
      expect(result).toEqual({ scenarioId: '55', blueprint, region: 'eu1' });
    });
  });
});

// ─── update-scenario ─────────────────────────────────────────────────────────

describe('update-scenario', () => {
  test('PATCHes only the provided fields and serializes blueprint', () => {
    installFetchMock(() => new Response('{"id":55,"name":"Renamed"}', { status: 200, headers: { 'content-type': 'application/json' } }));

    const res = (updateScenarioTool.handler({ scenarioId: '55', name: 'Renamed' }, ctx(TOKEN)) as Promise<any>);

    return res.then((result) => {
      expect(calls[0].url).toBe('https://eu1.make.com/api/v2/scenarios/55');
      expect(calls[0].init?.method).toBe('PATCH');
      const body = JSON.parse(calls[0].init?.body as string);
      expect(body).toEqual({ name: 'Renamed' });
      expect(result).toMatchObject({ scenarioId: '55', name: 'Renamed', region: 'eu1' });
    });
  });

  test('serializes blueprint object to string', () => {
    installFetchMock(() => new Response('{"id":55}', { status: 200, headers: { 'content-type': 'application/json' } }));

    const res = (updateScenarioTool.handler(
      { scenarioId: '55', blueprint: { flow: [] }, folderId: 'f1' },
      ctx(TOKEN),
    ) as Promise<any>);

    return res.then(() => {
      const body = JSON.parse(calls[0].init?.body as string);
      expect(typeof body.blueprint).toBe('string');
      expect(JSON.parse(body.blueprint)).toEqual({ flow: [] });
      expect(body.folderId).toBe('f1');
    });
  });

  test('rejects update with no fields', async () => {
    const err = await rejectedWith((updateScenarioTool.handler({ scenarioId: '55' }, ctx(TOKEN)) as Promise<unknown>));
    expect(err.code).toBe('BAD_REQUEST');
  });
});

// ─── delete-scenario ─────────────────────────────────────────────────────────

describe('delete-scenario', () => {
  test('DELETEs the scenario and returns deleted flag', () => {
    installFetchMock(() => new Response('', { status: 204 }));

    const res = (deleteScenarioTool.handler({ scenarioId: '55' }, ctx(TOKEN)) as Promise<any>);

    return res.then((result) => {
      expect(calls[0].url).toBe('https://eu1.make.com/api/v2/scenarios/55');
      expect(calls[0].init?.method).toBe('DELETE');
      expect(result).toEqual({ scenarioId: '55', deleted: true, region: 'eu1' });
    });
  });
});

// ─── clone-scenario ─────────────────────────────────────────────────────────

describe('clone-scenario', () => {
  test('POSTs to /clone and returns the cloned scenario', () => {
    installFetchMock(() =>
      new Response('{"id":99,"name":"Copy","teamId":7,"folderId":2,"isActive":false}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = (cloneScenarioTool.handler({ scenarioId: '55', name: 'Copy', folderId: '2' }, ctx(TOKEN)) as Promise<any>);

    return res.then((result) => {
      expect(calls[0].url).toBe('https://eu1.make.com/api/v2/scenarios/55/clone');
      expect(calls[0].init?.method).toBe('POST');
      const body = JSON.parse(calls[0].init?.body as string);
      expect(body).toEqual({ name: 'Copy', folderId: '2' });
      expect(result).toMatchObject({ scenarioId: '99', name: 'Copy', teamId: '7', folderId: '2', region: 'eu1' });
    });
  });
});

// ─── start-scenario / stop-scenario ──────────────────────────────────────────

describe('start-scenario', () => {
  test('POSTs to /start and reports active', () => {
    installFetchMock(() => new Response('{"id":55,"isActive":true}', { status: 200, headers: { 'content-type': 'application/json' } }));

    const res = (startScenarioTool.handler({ scenarioId: '55' }, ctx(TOKEN)) as Promise<any>);

    return res.then((result) => {
      expect(calls[0].url).toBe('https://eu1.make.com/api/v2/scenarios/55/start');
      expect(calls[0].init?.method).toBe('POST');
      expect(result).toEqual({ scenarioId: '55', isActive: true, region: 'eu1' });
    });
  });
});

describe('stop-scenario', () => {
  test('POSTs to /stop and reports inactive', () => {
    installFetchMock(() => new Response('{"id":55,"isActive":false}', { status: 200, headers: { 'content-type': 'application/json' } }));

    const res = (stopScenarioTool.handler({ scenarioId: '55' }, ctx(TOKEN)) as Promise<any>);

    return res.then((result) => {
      expect(calls[0].url).toBe('https://eu1.make.com/api/v2/scenarios/55/stop');
      expect(calls[0].init?.method).toBe('POST');
      expect(result).toEqual({ scenarioId: '55', isActive: false, region: 'eu1' });
    });
  });
});
