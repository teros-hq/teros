/**
 * WS file-watcher handlers — contract-boundary (TER-480, grupo archivos/io).
 *
 * Boundary REAL: archivos y fs.watch sobre un directorio temporal — sin mocks
 * de fs. Cubre el payload exacto del broadcast file_changed, el ciclo de vida
 * del registry per-connection (re-watch cierra el anterior, unwatch limpia,
 * cleanup masivo), el fail-closed de la suscripción cuando el archivo nunca
 * aparece, y la REGRESIÓN del fix del resolver: un path absoluto del host
 * existente (p.ej. /etc/hosts) ya no se vigila ni se emite su contenido.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { WsHandlerContext } from '@teros/shared';
import {
  createWatchFileHandler,
  createWatcherRegistry,
  cleanupWatcherRegistry,
  type WatcherRegistry,
} from '../../src/handlers/domains/file-watcher/watch';
import { createUnwatchFileHandler } from '../../src/handlers/domains/file-watcher/unwatch';

const TEST_BASE = mkdtempSync(join(tmpdir(), 'ter480-fw-'));
const VOL = join(TEST_BASE, 'vol_001');
mkdirSync(VOL, { recursive: true });

afterAll(() => rmSync(TEST_BASE, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ctx con ws fake — el handler usa ctx.ws solo como clave para sessionId/registry */
const WS = {} as any;
const ctx = (userId: string): WsHandlerContext => ({ userId, sessionId: 'sess1', connectionId: 'c1', ws: WS }) as any;

function makeDeps(registry: WatcherRegistry, over: Record<string, unknown> = {}) {
  const broadcasts: any[] = [];
  const pubSubService = {
    subscribeSession: mock(() => {}),
    unsubscribeSession: mock(() => {}),
    broadcastToTopic: mock((topic: string, payload: any) => broadcasts.push({ topic, payload })),
  } as any;
  const deps = {
    db: { collection: () => ({ findOne: async () => null }) } as any,
    volumeService: { getVolume: mock(async () => ({ volumeId: 'vol_001', hostPath: VOL })) } as any,
    workspaceService: { getWorkspace: mock(async () => ({ workspaceId: 'work_1', volumeId: 'vol_001' })) } as any,
    pubSubService,
    getSessionId: () => 'sess1',
    getRegistry: () => registry,
    // En tests el polling de waitForFile se acorta (producción: 10 × 500 ms)
    waitForFileRetries: 3,
    waitForFileDelayMs: 20,
    ...over,
  };
  return { deps, pubSubService, broadcasts };
}

let registry: WatcherRegistry;
beforeEach(() => {
  cleanupWatcherRegistry(registry ?? createWatcherRegistry());
  registry = createWatcherRegistry();
});
afterAll(() => cleanupWatcherRegistry(registry));

// ---------------------------------------------------------------------------
// file.watch — validación
// ---------------------------------------------------------------------------

describe('file.watch — validación de params', () => {
  it('MISSING_FIELDS sin filePath', async () => {
    const { deps } = makeDeps(registry);
    const h = createWatchFileHandler(deps);
    await expect(h(ctx('u1'), { channelId: 'ch_1' })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('MISSING_FIELDS sin channelId NI workspaceId', async () => {
    const { deps } = makeDeps(registry);
    const h = createWatchFileHandler(deps);
    await expect(h(ctx('u1'), { filePath: '/workspace/a.html' })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('FILE_WATCHER_ERROR si el resolver no puede resolver (channel inexistente)', async () => {
    const { deps } = makeDeps(registry, {
      workspaceService: null,
      db: { collection: () => ({ findOne: async () => null }) },
    });
    const h = createWatchFileHandler(deps);
    await expect(h(ctx('u1'), { filePath: '/workspace/a.html', channelId: 'ch_nope' })).rejects.toMatchObject({
      code: 'FILE_WATCHER_ERROR',
    });
  });
});

// ---------------------------------------------------------------------------
// file.watch — happy path + lifecycle
// ---------------------------------------------------------------------------

describe('file.watch — contenido inicial + watcher real', () => {
  it('emite el contenido actual con el payload EXACTO y registra el watcher', async () => {
    writeFileSync(join(VOL, 'page.html'), '<h1>v1</h1>');
    const { deps, pubSubService, broadcasts } = makeDeps(registry);
    const h = createWatchFileHandler(deps);

    const res = await h(ctx('u1'), { filePath: '/workspace/page.html', workspaceId: 'work_1' });

    expect(res).toEqual({ filePath: '/workspace/page.html', watching: true });
    expect(pubSubService.subscribeSession).toHaveBeenCalledWith('sess1', 'file:/workspace/page.html');
    expect(broadcasts).toEqual([
      {
        topic: 'file:/workspace/page.html',
        payload: {
          type: 'event',
          event: 'file_changed',
          channel: 'file:/workspace/page.html',
          data: { filePath: '/workspace/page.html', content: '<h1>v1</h1>' },
        },
      },
    ]);
    const entry = registry.get('/workspace/page.html');
    expect(entry?.hostPath).toBe(join(VOL, 'page.html'));
  });

  it('un cambio en disco emite el contenido nuevo tras el debounce de 300 ms', async () => {
    writeFileSync(join(VOL, 'live.md'), 'v1');
    const { deps, broadcasts } = makeDeps(registry);
    const h = createWatchFileHandler(deps);
    await h(ctx('u1'), { filePath: '/workspace/live.md', workspaceId: 'work_1' });

    writeFileSync(join(VOL, 'live.md'), 'v2');
    // debounce 300 ms + margen para el evento de fs.watch
    await sleep(600);

    const last = broadcasts[broadcasts.length - 1];
    expect(last.payload.data).toEqual({ filePath: '/workspace/live.md', content: 'v2' });
    expect(broadcasts.length).toBeGreaterThanOrEqual(2);
  });

  it('re-watch del mismo filePath cierra el watcher anterior (no se acumulan ni se filtran)', async () => {
    writeFileSync(join(VOL, 'twice.html'), 'x');
    const { deps } = makeDeps(registry);
    const h = createWatchFileHandler(deps);

    await h(ctx('u1'), { filePath: '/workspace/twice.html', workspaceId: 'work_1' });
    const first = registry.get('/workspace/twice.html')!.watcher;
    // Espía el close del watcher previo: el re-watch DEBE cerrarlo, no solo
    // sobreescribir la entrada del registry (de lo contrario el FSWatcher viejo
    // queda huérfano vigilando — resource leak).
    let firstClosed = false;
    const origClose = first.close.bind(first);
    first.close = () => { firstClosed = true; origClose(); };

    await h(ctx('u1'), { filePath: '/workspace/twice.html', workspaceId: 'work_1' });

    expect(firstClosed).toBe(true);
    expect(registry.size).toBe(1);
    expect(registry.get('/workspace/twice.html')!.watcher).not.toBe(first);
  });

  it('con channelId Y workspaceId provistos, workspaceId tiene precedencia (Ordering)', async () => {
    // El contrato dice que son mutuamente exclusivos; si un caller manda ambos,
    // el handler resuelve por workspaceId. Se observa por qué vía resolvió el
    // path: workspaceId → workspaceService.getWorkspace; channelId → db.channels.
    writeFileSync(join(VOL, 'both.html'), 'x');
    const channelLookup = mock(async () => ({ channelId: 'ch_X', workspaceId: 'work_other' }));
    const { deps } = makeDeps(registry, {
      db: { collection: () => ({ findOne: channelLookup }) } as any,
    });
    await createWatchFileHandler(deps)(ctx('u1'), {
      filePath: '/workspace/both.html',
      workspaceId: 'work_1',
      channelId: 'ch_X',
    });

    // Resolvió por workspaceId → nunca consultó la colección channels
    expect(deps.workspaceService!.getWorkspace).toHaveBeenCalledWith('work_1');
    expect(channelLookup).not.toHaveBeenCalled();
  });

  it('archivo que nunca aparece → FILE_WATCHER_ERROR y desuscribe (fail-closed)', async () => {
    const { deps, pubSubService } = makeDeps(registry);
    const h = createWatchFileHandler(deps);

    await expect(h(ctx('u1'), { filePath: '/workspace/ghost.html', workspaceId: 'work_1' })).rejects.toMatchObject({
      code: 'FILE_WATCHER_ERROR',
    });
    expect(pubSubService.unsubscribeSession).toHaveBeenCalledWith('sess1', 'file:/workspace/ghost.html');
    expect(registry.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// REGRESIÓN del fix del resolver (host-read vía fallback literal)
// ---------------------------------------------------------------------------

describe('file.watch — un path del host existente NO se vigila (regresión fallback literal)', () => {
  it('/etc/hosts existe en el host pero el watch falla sin emitir su contenido', async () => {
    const { deps, broadcasts } = makeDeps(registry);
    const h = createWatchFileHandler(deps);

    // Antes del fix: el resolver devolvía '/etc/hosts' literal (existe) y el
    // handler emitía su CONTENIDO al topic. Ahora el resolver devuelve el path
    // del volumen (inexistente) y waitForFile falla.
    await expect(h(ctx('u1'), { filePath: '/etc/hosts', workspaceId: 'work_1' })).rejects.toMatchObject({
      code: 'FILE_WATCHER_ERROR',
    });
    expect(broadcasts).toEqual([]);
    expect(registry.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// file.unwatch
// ---------------------------------------------------------------------------

describe('file.unwatch', () => {
  it('MISSING_FIELDS sin filePath', async () => {
    const { deps } = makeDeps(registry);
    const h = createUnwatchFileHandler(deps);
    await expect(h(ctx('u1'), {})).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('cierra el watcher, limpia el registry y desuscribe del topic', async () => {
    writeFileSync(join(VOL, 'bye.html'), 'x');
    const { deps, pubSubService } = makeDeps(registry);
    await createWatchFileHandler(deps)(ctx('u1'), { filePath: '/workspace/bye.html', workspaceId: 'work_1' });
    expect(registry.size).toBe(1);

    const res = await createUnwatchFileHandler(deps)(ctx('u1'), { filePath: '/workspace/bye.html' });

    expect(res).toEqual({ filePath: '/workspace/bye.html', watching: false });
    expect(registry.size).toBe(0);
    expect(pubSubService.unsubscribeSession).toHaveBeenCalledWith('sess1', 'file:/workspace/bye.html');
  });

  it('path no vigilado → no lanza y desuscribe igualmente (idempotente)', async () => {
    const { deps, pubSubService } = makeDeps(registry);
    const res = await createUnwatchFileHandler(deps)(ctx('u1'), { filePath: '/workspace/never.html' });
    expect(res).toEqual({ filePath: '/workspace/never.html', watching: false });
    expect(pubSubService.unsubscribeSession).toHaveBeenCalledWith('sess1', 'file:/workspace/never.html');
  });
});

// ---------------------------------------------------------------------------
// cleanupWatcherRegistry (disconnect)
// ---------------------------------------------------------------------------

describe('cleanupWatcherRegistry', () => {
  it('cierra todos los watchers y vacía el registry', async () => {
    writeFileSync(join(VOL, 'c1.html'), 'x');
    writeFileSync(join(VOL, 'c2.html'), 'y');
    const { deps } = makeDeps(registry);
    const h = createWatchFileHandler(deps);
    await h(ctx('u1'), { filePath: '/workspace/c1.html', workspaceId: 'work_1' });
    await h(ctx('u1'), { filePath: '/workspace/c2.html', workspaceId: 'work_1' });
    expect(registry.size).toBe(2);

    cleanupWatcherRegistry(registry);

    expect(registry.size).toBe(0);
  });
});
