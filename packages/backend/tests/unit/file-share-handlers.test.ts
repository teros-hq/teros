/**
 * WS file-share handlers — contract-boundary (TER-480, grupo archivos/io).
 *
 * Lo CRÍTICO de file-share: crea enlaces PÚBLICOS a archivos del volumen de un
 * workspace, así que la authz manda — workspace-sovereign en share/get-share
 * (regresión del fix FORBIDDEN_WORKSPACE: antes bastaba conocer un channelId
 * ajeno para publicar archivos de otro workspace) y ownership en unshare
 * (mapping literal de los errores de ShareService). Las factories son
 * privadas: se testean vía register() con un router fake, lo que además fija
 * el set exacto de actions registradas.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { WsHandlerContext } from '@teros/shared';
import { register } from '../../src/handlers/domains/file-share/index';
import { config } from '../../src/config';

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

/**
 * Mock db fiel a los dos consumidores reales:
 *  - el handler lee `channels` (findOne por channelId)
 *  - canAccessWorkspace lee `workspaces` (ownerId) y `workspace_members`
 */
function makeDb(opts: { channel?: any; workspaceOwnerId?: string; memberUserIds?: string[] } = {}) {
  const queries: Array<{ col: string; filter: any }> = [];
  const db = {
    collection: (name: string) => ({
      findOne: mock(async (filter: any) => {
        queries.push({ col: name, filter });
        if (name === 'channels') {
          return opts.channel && filter.channelId === opts.channel.channelId ? opts.channel : null;
        }
        if (name === 'workspaces') {
          return { workspaceId: filter.workspaceId, ownerId: opts.workspaceOwnerId ?? 'someone_else', status: 'active' };
        }
        if (name === 'workspace_members') {
          return (opts.memberUserIds ?? []).includes(filter.userId)
            ? { workspaceId: filter.workspaceId, userId: filter.userId }
            : null;
        }
        return null;
      }),
    }),
  } as any;
  return { db, queries };
}

function makeShareService(over: any = {}) {
  return {
    createShare: mock(async () => ({ shareId: 'abcd1234', publicUrl: 'https://x/share/abcd1234' })),
    deleteShare: mock(async () => {}),
    getShareByFile: mock(async () => null),
    ...over,
  } as any;
}

function setup(opts: Parameters<typeof makeDb>[0] = {}, svc: any = {}) {
  const { router, handlers } = makeRouter();
  const { db, queries } = makeDb(opts);
  const shareService = makeShareService(svc);
  register(router, { db, shareService });
  return { handlers, shareService, queries };
}

const CHANNEL = { channelId: 'ch_1', workspaceId: 'work_1' };

// ---------------------------------------------------------------------------
// Registro (invariante)
// ---------------------------------------------------------------------------

describe('file-share register', () => {
  it('registra exactamente file.share / file.unshare / file.get-share', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(['file.get-share', 'file.share', 'file.unshare']);
  });
});

// ---------------------------------------------------------------------------
// file.share
// ---------------------------------------------------------------------------

describe('file.share — validación de params', () => {
  it('MISSING_FIELDS sin filePath / sin channelId / sin fileType', async () => {
    const { handlers } = setup({ channel: CHANNEL });
    const h = handlers.get('file.share')!;
    await expect(h(ctx('u1'), { channelId: 'ch_1', fileType: 'html' })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
    await expect(h(ctx('u1'), { filePath: '/workspace/a.html', fileType: 'html' })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
    await expect(h(ctx('u1'), { filePath: '/workspace/a.html', channelId: 'ch_1' })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('INVALID_FILE_TYPE para tipos fuera de html|markdown', async () => {
    const { handlers, shareService } = setup({ channel: CHANNEL });
    await expect(
      handlers.get('file.share')!(ctx('u1'), { filePath: '/workspace/a.pdf', channelId: 'ch_1', fileType: 'pdf' }),
    ).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
    expect(shareService.createShare).not.toHaveBeenCalled();
  });

  it('CHANNEL_NOT_FOUND si el channel no existe', async () => {
    const { handlers } = setup({ channel: undefined });
    await expect(
      handlers.get('file.share')!(ctx('u1'), { filePath: '/workspace/a.html', channelId: 'ch_nope', fileType: 'html' }),
    ).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
  });

  it('NO_WORKSPACE si el channel no tiene workspaceId', async () => {
    const { handlers } = setup({ channel: { channelId: 'ch_1' } });
    await expect(
      handlers.get('file.share')!(ctx('u1'), { filePath: '/workspace/a.html', channelId: 'ch_1', fileType: 'html' }),
    ).rejects.toMatchObject({ code: 'NO_WORKSPACE' });
  });
});

describe('file.share — authz workspace-sovereign (regresión FORBIDDEN_WORKSPACE)', () => {
  it('rechaza a un no-miembro y NO crea el share', async () => {
    const { handlers, shareService } = setup({ channel: CHANNEL, workspaceOwnerId: 'victim', memberUserIds: [] });
    await expect(
      handlers.get('file.share')!(ctx('attacker'), { filePath: '/workspace/secret.html', channelId: 'ch_1', fileType: 'html' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_WORKSPACE' });
    expect(shareService.createShare).not.toHaveBeenCalled();
  });

  it('consulta membership con el filtro exacto {workspaceId, userId}', async () => {
    const { handlers, queries } = setup({ channel: CHANNEL, workspaceOwnerId: 'victim', memberUserIds: [] });
    await handlers.get('file.share')!(ctx('attacker'), { filePath: '/workspace/a.html', channelId: 'ch_1', fileType: 'html' }).catch(() => {});
    expect(queries.filter((q) => q.col === 'workspace_members').map((q) => q.filter)).toEqual([
      { workspaceId: 'work_1', userId: 'attacker' },
    ]);
  });

  it('permite al owner del workspace', async () => {
    const { handlers, shareService } = setup({ channel: CHANNEL, workspaceOwnerId: 'u1' });
    const res = await handlers.get('file.share')!(ctx('u1'), { filePath: '/workspace/a.html', channelId: 'ch_1', fileType: 'html' });
    expect(res).toEqual({ shareId: 'abcd1234', publicUrl: 'https://x/share/abcd1234' });
    expect(shareService.createShare).toHaveBeenCalledWith('u1', '/workspace/a.html', 'work_1', 'html');
  });

  it('permite a un miembro no-owner', async () => {
    const { handlers, shareService } = setup({ channel: CHANNEL, workspaceOwnerId: 'someone_else', memberUserIds: ['u1'] });
    const res = await handlers.get('file.share')!(ctx('u1'), { filePath: '/workspace/b.md', channelId: 'ch_1', fileType: 'markdown' });
    expect(res).toEqual({ shareId: 'abcd1234', publicUrl: 'https://x/share/abcd1234' });
    expect(shareService.createShare).toHaveBeenCalledWith('u1', '/workspace/b.md', 'work_1', 'markdown');
  });
});

describe('file.share — error del service', () => {
  it('SHARE_CREATE_ERROR si createShare lanza', async () => {
    const { handlers } = setup(
      { channel: CHANNEL, workspaceOwnerId: 'u1' },
      { createShare: mock(async () => { throw new Error('mongo down'); }) },
    );
    await expect(
      handlers.get('file.share')!(ctx('u1'), { filePath: '/workspace/a.html', channelId: 'ch_1', fileType: 'html' }),
    ).rejects.toMatchObject({ code: 'SHARE_CREATE_ERROR' });
  });
});

// ---------------------------------------------------------------------------
// file.unshare
// ---------------------------------------------------------------------------

describe('file.unshare — ownership delegada en ShareService (mapping literal)', () => {
  it('MISSING_FIELDS sin shareId', async () => {
    const { handlers } = setup();
    await expect(handlers.get('file.unshare')!(ctx('u1'), {})).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('happy: {ok:true} y deleteShare(shareId, userId) exactos', async () => {
    const { handlers, shareService } = setup();
    const res = await handlers.get('file.unshare')!(ctx('u1'), { shareId: 'sh_1' });
    expect(res).toEqual({ ok: true });
    expect(shareService.deleteShare).toHaveBeenCalledWith('sh_1', 'u1');
  });

  it('"not found" del service → SHARE_NOT_FOUND', async () => {
    const { handlers } = setup({}, { deleteShare: mock(async () => { throw new Error('Share not found: sh_1'); }) });
    await expect(handlers.get('file.unshare')!(ctx('u1'), { shareId: 'sh_1' })).rejects.toMatchObject({ code: 'SHARE_NOT_FOUND' });
  });

  it('"Permission denied" del service → SHARE_PERMISSION_DENIED (no borra shares ajenos)', async () => {
    const { handlers } = setup({}, {
      deleteShare: mock(async () => { throw new Error('Permission denied: user u1 does not own share sh_1'); }),
    });
    await expect(handlers.get('file.unshare')!(ctx('u1'), { shareId: 'sh_1' })).rejects.toMatchObject({
      code: 'SHARE_PERMISSION_DENIED',
    });
  });

  it('cualquier otro error → SHARE_DELETE_ERROR', async () => {
    const { handlers } = setup({}, { deleteShare: mock(async () => { throw new Error('mongo down'); }) });
    await expect(handlers.get('file.unshare')!(ctx('u1'), { shareId: 'sh_1' })).rejects.toMatchObject({ code: 'SHARE_DELETE_ERROR' });
  });
});

// ---------------------------------------------------------------------------
// file.get-share
// ---------------------------------------------------------------------------

describe('file.get-share', () => {
  it('MISSING_FIELDS sin filePath / sin channelId', async () => {
    const { handlers } = setup({ channel: CHANNEL });
    const h = handlers.get('file.get-share')!;
    await expect(h(ctx('u1'), { channelId: 'ch_1' })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
    await expect(h(ctx('u1'), { filePath: '/workspace/a.html' })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('CHANNEL_NOT_FOUND / NO_WORKSPACE como file.share', async () => {
    const a = setup({ channel: undefined });
    await expect(
      a.handlers.get('file.get-share')!(ctx('u1'), { filePath: '/workspace/a.html', channelId: 'ch_nope' }),
    ).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    const b = setup({ channel: { channelId: 'ch_1' } });
    await expect(
      b.handlers.get('file.get-share')!(ctx('u1'), { filePath: '/workspace/a.html', channelId: 'ch_1' }),
    ).rejects.toMatchObject({ code: 'NO_WORKSPACE' });
  });

  it('FORBIDDEN_WORKSPACE para no-miembros y NO consulta el share', async () => {
    const { handlers, shareService } = setup({ channel: CHANNEL, workspaceOwnerId: 'victim', memberUserIds: [] });
    await expect(
      handlers.get('file.get-share')!(ctx('attacker'), { filePath: '/workspace/a.html', channelId: 'ch_1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_WORKSPACE' });
    expect(shareService.getShareByFile).not.toHaveBeenCalled();
  });

  it('sin share existente → {share:null}', async () => {
    const { handlers, shareService } = setup({ channel: CHANNEL, workspaceOwnerId: 'u1' });
    const res = await handlers.get('file.get-share')!(ctx('u1'), { filePath: '/workspace/a.html', channelId: 'ch_1' });
    expect(res).toEqual({ share: null });
    expect(shareService.getShareByFile).toHaveBeenCalledWith('u1', '/workspace/a.html', 'work_1');
  });

  it('con share → payload exacto {share:{shareId, publicUrl}} compuesto con config.share.baseUrl', async () => {
    const { handlers } = setup(
      { channel: CHANNEL, workspaceOwnerId: 'u1' },
      { getShareByFile: mock(async () => ({ shareId: 'beef0001', ownerId: 'u1', filePath: '/workspace/a.html', workspaceId: 'work_1' })) },
    );
    const res = await handlers.get('file.get-share')!(ctx('u1'), { filePath: '/workspace/a.html', channelId: 'ch_1' });
    expect(res).toEqual({ share: { shareId: 'beef0001', publicUrl: `${config.share.baseUrl}/share/beef0001` } });
  });
});
