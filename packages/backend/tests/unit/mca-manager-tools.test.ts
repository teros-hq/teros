/**
 * Unit — mca-manager.tools: loadStaticTools / convertStaticTools / lookup /
 * executeTool (stdio + HTTP) (TER-484).
 *
 * Boundary real: tools.json se lee de un tmpdir REAL (fs auténtico). El client
 * MCP, el httpClient y el containerManager son fakes con la superficie exacta
 * que consume el módulo.
 *
 * El drift tools.json ↔ handler es incidente recurrente (TER-222, TER-312) y
 * la validación de annotations protege el badge de irreversibilidad (§8).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  convertStaticTools,
  executeTool,
  executeToolViaHttp,
  getCachedHealthIfNotReady,
  getMcaIdForTool,
  getToolsForApp,
  invalidateStaticToolsCache,
  loadStaticTools,
  type ToolsContext,
} from '../../src/services/mca-manager.tools';
import { MAX_TOOL_OUTPUT_CHARS, type ManagedMca } from '../../src/services/mca-manager.types';

const BASE = mkdtempSync(join(tmpdir(), 'ter484-mcas-'));

afterAll(() => rmSync(BASE, { recursive: true, force: true }));

function writeToolsJson(mcaId: string, tools: unknown[]): void {
  mkdirSync(join(BASE, mcaId), { recursive: true });
  writeFileSync(
    join(BASE, mcaId, 'tools.json'),
    JSON.stringify({ $schema: 'x', mcaId, tools }, null, 2),
  );
}

function makeManaged(overrides: Partial<ManagedMca> = {}): ManagedMca {
  return {
    appId: 'app_x',
    mcaId: 'mca.test',
    appName: 'testapp',
    client: null,
    transport: null,
    tools: [],
    toolNameMapping: new Map(),
    status: 'ready',
    lastUsed: new Date(0),
    restartCount: 0,
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: fixture parcial
  } as any;
}

function makeCtx(overrides: Partial<ToolsContext> = {}): ToolsContext {
  return {
    mcas: new Map(),
    // biome-ignore lint/suspicious/noExplicitAny: fake mínimo
    mcaService: { getApp: mock(async () => null) } as any,
    // biome-ignore lint/suspicious/noExplicitAny: fake mínimo
    containerManager: { touch: mock(() => {}) } as any,
    httpClients: new Map(),
    staticToolsCache: new Map(),
    containerBackendHost: 'host.docker.internal',
    // biome-ignore lint/suspicious/noExplicitAny: config parcial requerida
    config: { mcaBasePath: BASE, serverPort: 10001 } as any,
    getOrSpawn: mock(async () => makeManaged()),
    registerApp: mock(async () => null),
    ...overrides,
  };
}

const VALID_TOOL = {
  name: 'read_file',
  description: 'Lee un archivo',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

// ===========================================================================
// loadStaticTools
// ===========================================================================

describe('loadStaticTools', () => {
  beforeEach(() => {
    rmSync(BASE, { recursive: true, force: true });
    mkdirSync(BASE, { recursive: true });
  });

  it('carga tools.json válido y lo cachea (no relee el disco)', () => {
    const ctx = makeCtx();
    writeToolsJson('mca.test', [VALID_TOOL]);

    const first = loadStaticTools(ctx, 'mca.test');
    expect(first).toHaveLength(1);
    expect(first[0].name).toBe('read_file');

    // Mutar el archivo: la cache debe ganar
    writeToolsJson('mca.test', []);
    const second = loadStaticTools(ctx, 'mca.test');
    expect(second).toHaveLength(1);
    expect(second).toBe(first);
  });

  it('sin tools.json → [] sin crash', () => {
    expect(loadStaticTools(makeCtx(), 'mca.inexistente')).toEqual([]);
  });

  it('JSON malformado → [] sin crash', () => {
    mkdirSync(join(BASE, 'mca.roto'), { recursive: true });
    writeFileSync(join(BASE, 'mca.roto', 'tools.json'), '{ not json');
    expect(loadStaticTools(makeCtx(), 'mca.roto')).toEqual([]);
  });

  it('annotations INVÁLIDAS (irreversible como string) rechazan el archivo ENTERO — fail loud', () => {
    writeToolsJson('mca.test', [
      VALID_TOOL,
      { ...VALID_TOOL, name: 'delete_file', annotations: { irreversible: 'true' } },
    ]);
    const ctx = makeCtx();
    expect(loadStaticTools(ctx, 'mca.test')).toEqual([]);
    // Y NO cachea el rechazo a vacío de forma envenenada
    expect(ctx.staticToolsCache.has('mca.test')).toBe(false);
  });

  it('annotations válidas se normalizan vía Zod y se conservan', () => {
    writeToolsJson('mca.test', [
      { ...VALID_TOOL, name: 'drop_db', annotations: { irreversible: true, stability: 'stable' } },
    ]);
    const tools = loadStaticTools(makeCtx(), 'mca.test');
    expect(tools[0].annotations).toEqual({ irreversible: true, stability: 'stable' });
  });

  it('tools sin annotations pasan intactas', () => {
    writeToolsJson('mca.test', [VALID_TOOL]);
    const tools = loadStaticTools(makeCtx(), 'mca.test');
    expect('annotations' in tools[0]).toBe(false);
  });
});

// ===========================================================================
// invalidateStaticToolsCache
// ===========================================================================

describe('invalidateStaticToolsCache', () => {
  it('borra la cache y evicta SOLO entries standby del mcaId', () => {
    const ctx = makeCtx();
    ctx.staticToolsCache.set('mca.test', []);
    ctx.mcas.set('app_standby', makeManaged({ appId: 'app_standby', status: 'standby' }));
    ctx.mcas.set('app_ready', makeManaged({ appId: 'app_ready', status: 'ready' }));
    ctx.mcas.set('app_otro', makeManaged({ appId: 'app_otro', mcaId: 'mca.otro', status: 'standby' }));

    invalidateStaticToolsCache(ctx, 'mca.test');

    expect(ctx.staticToolsCache.has('mca.test')).toBe(false);
    expect(ctx.mcas.has('app_standby')).toBe(false); // evictada
    expect(ctx.mcas.has('app_ready')).toBe(true); // ready se respeta
    expect(ctx.mcas.has('app_otro')).toBe(true); // otro mcaId intacto
  });
});

// ===========================================================================
// convertStaticTools
// ===========================================================================

describe('convertStaticTools', () => {
  it('kebab + prefijo appName; internas _ en mapping pero fuera de tools; annotations propagadas', () => {
    const { tools, mapping } = convertStaticTools(
      [
        { ...VALID_TOOL, annotations: { irreversible: true } },
        { name: '_health_check', description: 'interna', inputSchema: { type: 'object', properties: {} } },
        // biome-ignore lint/suspicious/noExplicitAny: fixture
      ] as any,
      'files',
    );

    expect(tools).toEqual([
      {
        name: 'files_read-file',
        description: 'Lee un archivo',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        annotations: { irreversible: true },
      },
    ]);
    expect(mapping.get('files_read-file')).toBe('read_file');
    expect(mapping.get('files_-health-check')).toBe('_health_check');
  });

  it('tool con inputSchema roto se SALTA (broken tools.json) y el resto sobrevive', () => {
    const { tools } = convertStaticTools(
      // biome-ignore lint/suspicious/noExplicitAny: fixture rota a propósito
      [{ name: 'rota', description: 'x' } as any, VALID_TOOL],
      'files',
    );
    expect(tools.map((t) => t.name)).toEqual(['files_read-file']);
  });
});

// ===========================================================================
// Lookups
// ===========================================================================

describe('getMcaIdForTool / getToolsForApp / getCachedHealthIfNotReady', () => {
  it('getMcaIdForTool resuelve por mapping; undefined si nadie la tiene', () => {
    const ctx = makeCtx();
    const managed = makeManaged({ toolNameMapping: new Map([['files_read-file', 'read_file']]) });
    ctx.mcas.set('app_x', managed);
    expect(getMcaIdForTool(ctx, 'files_read-file')).toBe('mca.test');
    expect(getMcaIdForTool(ctx, 'nope')).toBeUndefined();
  });

  it('getToolsForApp: disabled → []; ready/standby → tools del managed', async () => {
    const ctx = makeCtx();
    const tools = [{ name: 'files_read-file', description: '', input_schema: { type: 'object' as const, properties: {} } }];
    ctx.mcas.set('app_d', makeManaged({ status: 'disabled' }));
    ctx.mcas.set('app_r', makeManaged({ status: 'ready', tools }));
    ctx.mcas.set('app_s', makeManaged({ status: 'standby', tools, lastError: 'algo' }));

    expect(await getToolsForApp(ctx, 'app_d')).toEqual({ tools: [], status: 'disabled' });
    expect(await getToolsForApp(ctx, 'app_r')).toEqual({ tools, status: 'ready' });
    expect(await getToolsForApp(ctx, 'app_s')).toEqual({ tools, status: 'standby' });
  });

  it('getToolsForApp sin managed: resuelve vía app + tools.json → standby', async () => {
    writeToolsJson('mca.test', [VALID_TOOL]);
    const ctx = makeCtx({
      // biome-ignore lint/suspicious/noExplicitAny: fake
      mcaService: { getApp: mock(async () => ({ appId: 'app_x', mcaId: 'mca.test', name: 'files' })) } as any,
    });
    const result = await getToolsForApp(ctx, 'app_x');
    expect(result.status).toBe('standby');
    expect(result.tools.map((t) => t.name)).toEqual(['files_read-file']);
  });

  it('getToolsForApp: app inexistente → error; sin tools.json → error', async () => {
    const ctx = makeCtx();
    expect((await getToolsForApp(ctx, 'app_nope')).status).toBe('error');

    const ctx2 = makeCtx({
      // biome-ignore lint/suspicious/noExplicitAny: fake
      mcaService: { getApp: mock(async () => ({ appId: 'app_x', mcaId: 'mca.sin-json', name: 'x' })) } as any,
    });
    const r2 = await getToolsForApp(ctx2, 'app_x');
    expect(r2.status).toBe('error');
    expect(r2.error).toContain('No tools.json');
  });

  it('getCachedHealthIfNotReady: null sin managed/health o si ready/degraded; cached si no', () => {
    const ctx = makeCtx();
    expect(getCachedHealthIfNotReady(ctx, 'nope')).toBeNull();

    const ready = makeManaged({ health: { status: 'ready', checkedAt: new Date() } });
    ctx.mcas.set('app_ok', ready);
    expect(getCachedHealthIfNotReady(ctx, 'app_ok')).toBeNull();

    const degraded = makeManaged({ appId: 'app_deg', health: { status: 'degraded', checkedAt: new Date() } });
    ctx.mcas.set('app_deg', degraded);
    expect(getCachedHealthIfNotReady(ctx, 'app_deg')).toBeNull();

    const bad = makeManaged({ appId: 'app_bad', health: { status: 'not_ready', message: 'sin credenciales', checkedAt: new Date() } });
    ctx.mcas.set('app_bad', bad);
    expect(getCachedHealthIfNotReady(ctx, 'app_bad')).toBe(bad.health ?? null);
  });
});

// ===========================================================================
// executeTool — stdio path
// ===========================================================================

describe('executeTool (stdio)', () => {
  function readyManaged(callToolImpl?: (args: unknown) => Promise<unknown>) {
    const callTool = mock(
      callToolImpl ??
        (async () => ({ content: [{ type: 'text', text: 'resultado' }], isError: false })),
    );
    const managed = makeManaged({
      // biome-ignore lint/suspicious/noExplicitAny: client MCP fake
      client: { callTool } as any,
      toolNameMapping: new Map([['testapp_read-file', 'read_file']]),
    });
    return { managed, callTool };
  }

  it('tool desconocida sin appId → error not found', async () => {
    const result = await executeTool(makeCtx(), 'nope_tool', {});
    expect(result).toEqual({
      output: `Error: Tool 'nope_tool' not found. The MCA may not be installed or configured.`,
      isError: true,
      mcaId: 'unknown',
    });
  });

  it('disabled → error explícito con mcaId', async () => {
    const ctx = makeCtx();
    ctx.mcas.set('app_x', makeManaged({ status: 'disabled', toolNameMapping: new Map([['t_a', 'a']]) }));
    const result = await executeTool(ctx, 't_a', {});
    expect(result.isError).toBe(true);
    expect(result.output).toContain('disabled');
    expect(result.mcaId).toBe('mca.test');
  });

  it('health cacheada not_ready → MCA_NOT_READY con el shape JSON', async () => {
    const ctx = makeCtx();
    ctx.mcas.set('app_x', makeManaged({
      toolNameMapping: new Map([['t_a', 'a']]),
      health: { status: 'not_ready', message: 'OAuth caducado', issues: [{ code: 'AUTH_EXPIRED' }], checkedAt: new Date() },
      // biome-ignore lint/suspicious/noExplicitAny: fixture
    } as any));
    const result = await executeTool(ctx, 't_a', {});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toEqual({
      error: 'MCA_NOT_READY',
      message: 'OAuth caducado',
      status: 'not_ready',
      issues: [{ code: 'AUTH_EXPIRED' }],
    });
  });

  it('happy: callTool con nombre ORIGINAL + input; texto concatenado; lastUsed refrescado', async () => {
    const ctx = makeCtx();
    const { managed, callTool } = readyManaged(async () => ({
      content: [
        { type: 'text', text: 'línea 1\n' },
        { type: 'text', text: 'línea 2' },
      ],
      isError: false,
    }));
    ctx.mcas.set('app_x', managed);

    const result = await executeTool(ctx, 'testapp_read-file', { path: '/x' });

    expect(callTool).toHaveBeenCalledWith({ name: 'read_file', arguments: { path: '/x' } });
    expect(result).toEqual({ output: 'línea 1\nlínea 2', isError: false, mcaId: 'mca.test' });
    expect(managed.lastUsed.getTime()).toBeGreaterThan(0);
  });

  it('attachments: image → data URL; resource → uri+mime+filename', async () => {
    const ctx = makeCtx();
    const { managed } = readyManaged(async () => ({
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', data: 'QkFTRTY0', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'https://x/f.pdf', mimeType: 'application/pdf', text: 'f.pdf' } },
      ],
      isError: false,
    }));
    ctx.mcas.set('app_x', managed);

    const result = await executeTool(ctx, 'testapp_read-file', {});
    expect(result.attachments).toEqual([
      { url: 'data:image/png;base64,QkFTRTY0', mime: 'image/png' },
      { url: 'https://x/f.pdf', mime: 'application/pdf', filename: 'f.pdf' },
    ]);
  });

  it('output > MAX_TOOL_OUTPUT_CHARS se trunca con el marcador del sistema', async () => {
    const ctx = makeCtx();
    const { managed } = readyManaged(async () => ({
      content: [{ type: 'text', text: 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 1) }],
      isError: false,
    }));
    ctx.mcas.set('app_x', managed);

    const result = await executeTool(ctx, 'testapp_read-file', {});
    expect(result.output).toContain('OUTPUT TRUNCATED BY SYSTEM');
    expect(result.output.startsWith('x'.repeat(100))).toBe(true);
  });

  it('output EXACTAMENTE en el límite NO se trunca (boundary)', async () => {
    const ctx = makeCtx();
    const exact = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS);
    const { managed } = readyManaged(async () => ({
      content: [{ type: 'text', text: exact }],
      isError: false,
    }));
    ctx.mcas.set('app_x', managed);

    const result = await executeTool(ctx, 'testapp_read-file', {});
    expect(result.output).toBe(exact);
  });

  it('mapping ausente → error de configuración; callTool que lanza → error con message', async () => {
    const ctx = makeCtx();
    ctx.mcas.set('app_x', makeManaged({
      // biome-ignore lint/suspicious/noExplicitAny: client fake
      client: { callTool: mock(async () => ({ content: [] })) } as any,
      toolNameMapping: new Map([['testapp_otra', 'otra']]),
    }));
    const noMapping = await executeTool(ctx, 'testapp_read-file', {}, { appId: 'app_x' });
    expect(noMapping.output).toContain('Tool mapping not found');

    const ctx2 = makeCtx();
    const { managed } = readyManaged(async () => {
      throw new Error('socket hangup');
    });
    ctx2.mcas.set('app_x', managed);
    const thrown = await executeTool(ctx2, 'testapp_read-file', {});
    expect(thrown).toEqual({
      output: `Error executing tool 'testapp_read-file': socket hangup`,
      isError: true,
      mcaId: 'mca.test',
    });
  });

  it('appId no registrado → registerApp; si devuelve null → error not installed', async () => {
    const registerApp = mock(async () => null);
    const ctx = makeCtx({ registerApp });
    const result = await executeTool(ctx, 'testapp_read-file', {}, { appId: 'app_x' });
    expect(registerApp).toHaveBeenCalledWith('app_x');
    expect(result.output).toContain(`The app 'testapp' is not installed`);
  });

  it('standby → getOrSpawn; si tras el spawn no queda ready → error con lastError', async () => {
    const ctx = makeCtx({
      getOrSpawn: mock(async () => {
        // El spawn deja el estado en error (no actualiza a ready)
        return makeManaged({ status: 'error' });
      }),
    });
    ctx.mcas.set('app_x', makeManaged({
      status: 'standby',
      lastError: 'no docker',
      toolNameMapping: new Map([['testapp_read-file', 'read_file']]),
    }));

    const result = await executeTool(ctx, 'testapp_read-file', {});
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Failed to start MCA');
    expect(result.output).toContain('no docker');
  });
});

// ===========================================================================
// executeToolViaHttp
// ===========================================================================

describe('executeToolViaHttp', () => {
  function httpSetup(callToolImpl: (...args: unknown[]) => Promise<unknown>) {
    const callTool = mock(callToolImpl);
    const ctx = makeCtx();
    const managed = makeManaged({ containerKey: 'mca.test' });
    // biome-ignore lint/suspicious/noExplicitAny: httpClient fake
    return { ctx, managed, httpClient: { callTool } as any, callTool };
  }

  it('manda el executionContext EXACTO (callback con host-gateway si hay containerKey)', async () => {
    const { ctx, managed, httpClient, callTool } = httpSetup(async () => ({ success: true, result: 'ok' }));

    await executeToolViaHttp(ctx, managed, 'read_file', { path: '/x' }, httpClient, {
      userId: 'user_1',
      workspaceId: 'work_1',
      agentId: 'agent_1',
      channelId: 'ch_1',
    });

    const [toolName, input, execCtx] = callTool.mock.calls[0];
    expect(toolName).toBe('read_file');
    expect(input).toEqual({ path: '/x' });
    expect(execCtx).toEqual({
      userId: 'user_1',
      workspaceId: 'work_1',
      userDisplayName: undefined,
      userAvatarUrl: undefined,
      agentId: 'agent_1',
      channelId: 'ch_1',
      appId: 'app_x',
      requestId: expect.stringMatching(/^req-\d+$/),
      callbackUrl: 'http://host.docker.internal:10001/mca/callback/app_x',
    });
    expect(ctx.containerManager.touch).toHaveBeenCalledWith('mca.test');
  });

  it('sin userId en contexto → system; sin containerKey → callback por localhost', async () => {
    const { ctx, httpClient, callTool } = httpSetup(async () => ({ success: true, result: 'ok' }));
    const managed = makeManaged(); // sin containerKey

    await executeToolViaHttp(ctx, managed, 't', {}, httpClient);

    // biome-ignore lint/suspicious/noExplicitAny: shape verificado
    const execCtx = callTool.mock.calls[0][2] as any;
    expect(execCtx.userId).toBe('system');
    expect(execCtx.callbackUrl).toBe('http://localhost:10001/mca/callback/app_x');
  });

  it.each([
    ['string directo', 'texto plano', 'texto plano'],
    ['shape {output}', { output: 'desde handler' }, 'desde handler'],
    [
      'shape MCP {content}',
      {
        content: [
          { type: 'text', text: 'a' },
          // resource CON campo text (filename) — un filter laxo que mire solo
          // `typeof c.text === 'string'` lo colaría en el output (gap T16)
          { type: 'resource', text: 'no-debe-entrar.pdf' },
          { type: 'text', text: 'b' },
        ],
      },
      'a\nb',
    ],
    ['objeto arbitrario → JSON', { foo: 1 }, JSON.stringify({ foo: 1 }, null, 2)],
  ])('normaliza el result: %s', async (_label, raw, expected) => {
    const { ctx, managed, httpClient } = httpSetup(async () => ({ success: true, result: raw }));
    const result = await executeToolViaHttp(ctx, managed, 't', {}, httpClient);
    expect(result.output).toBe(expected as string);
    expect(result.isError).toBe(false);
  });

  it('result.error → mensaje de error; attachments válidos extraídos y sin mime saltados', async () => {
    const { ctx, managed, httpClient } = httpSetup(async () => ({
      success: false,
      error: { code: 'X', message: 'falló' },
      attachments: [
        { url: 'https://x/a.png', mime: 'image/png' },
        { url: 'https://x/sin-mime' },
      ],
    }));
    const result = await executeToolViaHttp(ctx, managed, 't', {}, httpClient);
    expect(result.output).toBe('Error: falló');
    expect(result.isError).toBe(true);
    expect(result.attachments).toEqual([{ url: 'https://x/a.png', mime: 'image/png' }]);
  });

  it('ABORTED → mensaje de cancelación sin leak de URL ni stack', async () => {
    const { ctx, managed, httpClient } = httpSetup(async () => {
      throw Object.assign(new Error('http://localhost:4000/tools aborted'), { code: 'ABORTED' });
    });
    const result = await executeToolViaHttp(ctx, managed, 't', {}, httpClient);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('cancelled before completion');
    expect(result.output).not.toContain('http://localhost:4000');
  });

  it('throw genérico → error con el message', async () => {
    const { ctx, managed, httpClient } = httpSetup(async () => {
      throw new Error('fetch failed');
    });
    const result = await executeToolViaHttp(ctx, managed, 't', {}, httpClient);
    expect(result).toEqual({ output: `Error executing tool 't': fetch failed`, isError: true, mcaId: 'mca.test' });
  });
});
