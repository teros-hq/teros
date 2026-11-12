/**
 * GET /share/:shareId for To Do io shares (docs/specs/todo/output-window.md,
 * TODOOV-REQ-4) — the public link serves the task's CURRENT output.
 *
 * Against a real MongoDB (MONGODB_URI, throwaway db): the shares are created
 * with the To Do actions (share-io / unshare-io) and served by
 * HttpShareHandler with a fake request/response. Volume file shares are not
 * exercised here (no volume service).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'http';
import { type Db, MongoClient } from 'mongodb';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
// The registry first: mca-actions/todo imports it back (same order as todo-autoplay.test.ts).
import '../../src/mca-actions';
import type { McaActionCtx } from '../../src/mca-actions';
import { todoCapability } from '../../src/mca-actions/todo';
import { HttpShareHandler } from '../../src/handlers/http-share-handler';
import { ShareService } from '../../src/services/share-service';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = `teros_http_share_test_${Date.now()}`;

const MCA_ID = 'mca.teros.todo-list';
const WS = 'ws_sh_1';
const APP = 'app_sh_1';
const OWNER = 'user_owner';

const ctx: McaActionCtx = { mcaId: MCA_ID, appId: APP };

let client: MongoClient;
let db: Db;
let handler: HttpShareHandler;

async function call(action: string, body: Record<string, unknown> = {}): Promise<any> {
  return todoCapability.actions[action](ctx, db, body);
}

async function seed(doc: Record<string, unknown>): Promise<void> {
  const now = Date.now();
  await db.collection('todo_nodes').insertOne({
    parentId: null,
    workspaceId: WS,
    description: '',
    instructions: '',
    completed: false,
    collapsed: false,
    position: 0,
    log: [],
    createdAt: now,
    updatedAt: now,
    kind: 'task',
    state: 'working',
    ...doc,
  });
}

/** GET a path through the handler; returns status, headers and body. */
async function get(path: string): Promise<{ handled: boolean; status: number; headers: Record<string, string>; body: string }> {
  const out = { status: 0, headers: {} as Record<string, string>, body: '' };
  const req = { method: 'GET', headers: { host: 'localhost' } } as unknown as IncomingMessage;
  const res = {
    writeHead(status: number, headers: Record<string, string> = {}) {
      out.status = status;
      out.headers = headers;
      return this;
    },
    end(body?: string | Buffer) {
      out.body = body ? String(body) : '';
    },
  } as unknown as ServerResponse;
  const handled = await handler.handleRoute(req, res, path);
  return { handled, ...out };
}

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  db = client.db(DB_NAME);
  handler = new HttpShareHandler(db, null as any, null, new ShareService(db));
});

afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

beforeEach(async () => {
  for (const col of ['todo_nodes', 'apps', 'workspaces', 'workspace_members', 'shared_files']) {
    await db.collection(col).deleteMany({});
  }
  await db.collection('apps').insertOne({ appId: APP, mcaId: MCA_ID, ownerId: WS });
  await db.collection('workspaces').insertOne({ workspaceId: WS, ownerId: OWNER, status: 'active' });
});

describe('GET /share/:shareId — To Do io shares', () => {
  it('[TODOOV-AC-5] a markdown share serves an HTML page with the task text and the rendered markdown, reflects a later set-output, a file share redirects to the object URL, and after unshare-io it is 404', async () => {
    await seed({ nodeId: 't_md', text: 'Quarterly <report>', output: { format: 'markdown', markdown: '# Results\n\n- **up** 12%' } });
    const { shareId } = await call('share-io', { nodeId: 't_md', io: 'output', callerUserId: OWNER });

    const page = await get(`/share/${shareId}`);
    expect(page.handled).toBe(true);
    expect(page.status).toBe(200);
    expect(page.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(page.body).toContain('<title>Quarterly &lt;report&gt;</title>');
    expect(page.body).toContain('<h1>Results</h1>');
    expect(page.body).toContain('<strong>up</strong>');

    await call('set-output', { nodeId: 't_md', overwrite: true, output: { format: 'markdown', markdown: 'Second *delivery*' } });
    const next = await get(`/share/${shareId}`);
    expect(next.status).toBe(200);
    expect(next.body).toContain('<em>delivery</em>');
    expect(next.body).not.toContain('Results');

    const objectUrl = 'https://be.example/objects/obj_123';
    await seed({
      nodeId: 't_file',
      text: 'Invoice',
      output: { format: 'file', objectId: 'obj_123', url: objectUrl, name: 'invoice.pdf', mime: 'application/pdf', size: 10 },
    });
    const fileShare = await call('share-io', { nodeId: 't_file', io: 'output', callerUserId: OWNER });
    const redirect = await get(`/share/${fileShare.shareId}`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.Location).toBe(objectUrl);

    // A form or a removed io is the 404 page.
    await call('set-output', { nodeId: 't_file', output: null });
    const gone = await get(`/share/${fileShare.shareId}`);
    expect(gone.status).toBe(404);
    expect(gone.body).toContain('404 · Not Found');

    expect(await call('unshare-io', { shareId, callerUserId: OWNER })).toEqual({ ok: true });
    const revoked = await get(`/share/${shareId}`);
    expect(revoked.status).toBe(404);
    expect(revoked.body).toContain('404 · Not Found');
  });

  it('[TODOOV-REQ-4] a todo-io share reads its node only in the share\'s workspace', async () => {
    await seed({ nodeId: 't_x', text: 'Elsewhere', workspaceId: 'ws_other', output: { format: 'markdown', markdown: 'secret' } });
    await db.collection('shared_files').insertOne({
      shareId: 'f'.repeat(32),
      ownerId: OWNER,
      workspaceId: WS,
      source: { kind: 'todo-io', workspaceId: WS, nodeId: 't_x', io: 'output' },
      createdAt: new Date(),
    });
    const res = await get(`/share/${'f'.repeat(32)}`);
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('secret');
  });
});

describe('GET /share/:shareId — cache policy (security F5, review tn_KjOnSKdgygs1xbQu)', () => {
  // Volume shares need a volume + workspace service; fakes resolve to a tmp dir.
  const VOL = join(tmpdir(), `share-cache-vol-${Date.now()}`);
  let volHandler: HttpShareHandler;

  /** GET a path through the volume-serving handler instance. */
  async function getVol(path: string): Promise<{ handled: boolean; status: number; headers: Record<string, string>; body: string }> {
    const out = { status: 0, headers: {} as Record<string, string>, body: '' };
    const req = { method: 'GET', headers: { host: 'localhost' } } as unknown as IncomingMessage;
    const res = {
      writeHead(status: number, headers: Record<string, string> = {}) {
        out.status = status;
        out.headers = headers;
        return this;
      },
      end(body?: string | Buffer) {
        out.body = body ? String(body) : '';
      },
    } as unknown as ServerResponse;
    const handled = await volHandler.handleRoute(req, res, path);
    return { handled, ...out };
  }

  beforeAll(async () => {
    await fs.mkdir(join(VOL, 'reports'), { recursive: true });
    volHandler = new HttpShareHandler(
      db,
      { getVolume: async () => ({ volumeId: 'vol_cc', hostPath: VOL }) } as any,
      { getWorkspace: async () => ({ workspaceId: WS, volumeId: 'vol_cc' }) } as any,
      new ShareService(db),
    );
  });

  afterAll(async () => {
    await fs.rm(VOL, { recursive: true, force: true });
  });

  it('[F5] todo-io shares are never cached (no-store on the 200 page and on the 302 to the object) — every view re-reads the node', async () => {
    await seed({ nodeId: 't_cc_md', text: 'CC', output: { format: 'markdown', markdown: '# live view' } });
    const { shareId } = await call('share-io', { nodeId: 't_cc_md', io: 'output', callerUserId: OWNER });

    const page = await get(`/share/${shareId}`);
    expect(page.status).toBe(200);
    expect(page.headers['Cache-Control']).toBe('no-store');

    await seed({
      nodeId: 't_cc_file',
      text: 'CC file',
      output: { format: 'file', objectId: 'obj_cc', url: 'https://be.example/objects/obj_cc', name: 'a.pdf', mime: 'application/pdf', size: 1 },
    });
    const { shareId: fileShareId } = await call('share-io', { nodeId: 't_cc_file', io: 'output', callerUserId: OWNER });
    const redirect = await get(`/share/${fileShareId}`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers['Cache-Control']).toBe('no-store');
  });

  it('[F5] after unshare-io the revoked link answers 404 with no-store — no browser or shared proxy may cache or delay a revocation', async () => {
    await seed({ nodeId: 't_cc_rv', text: 'RV', output: { format: 'markdown', markdown: 'about to vanish' } });
    const { shareId } = await call('share-io', { nodeId: 't_cc_rv', io: 'output', callerUserId: OWNER });
    expect((await get(`/share/${shareId}`)).status).toBe(200);

    expect(await call('unshare-io', { shareId, callerUserId: OWNER })).toEqual({ ok: true });

    const revoked = await get(`/share/${shareId}`);
    expect(revoked.status).toBe(404);
    expect(revoked.headers['Cache-Control']).toBe('no-store');
    expect(revoked.body).toContain('404 · Not Found');
  });

  it('[F5] volume shares (html and file) serve with a short 60s public cache — revocation lands within a minute, never immutable', async () => {
    await fs.writeFile(join(VOL, 'reports', 'informe.html'), '<p>report body</p>', 'utf-8');
    await fs.writeFile(join(VOL, 'reports', 'informe.pdf'), Buffer.from('%PDF-1.4 fake'));

    const svc = new ShareService(db);
    const htmlShare = await svc.createShare(OWNER, '/workspace/reports/informe.html', WS, 'html');
    const htmlPage = await getVol(`/share/${htmlShare.shareId}`);
    expect(htmlPage.status).toBe(200);
    expect(htmlPage.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(htmlPage.headers['Cache-Control']).toBe('public, max-age=60');
    expect(htmlPage.headers['Cache-Control']).not.toContain('immutable');

    const fileShare = await svc.createShare(OWNER, '/workspace/reports/informe.pdf', WS, 'file');
    const filePage = await getVol(`/share/${fileShare.shareId}`);
    expect(filePage.status).toBe(200);
    expect(filePage.headers['Content-Type']).toBe('application/pdf');
    expect(filePage.headers['Cache-Control']).toBe('public, max-age=60');
    expect(filePage.headers['Cache-Control']).not.toContain('immutable');

    // And the revoked volume share is a no-store 404 too.
    await svc.deleteShare(fileShare.shareId, OWNER);
    const revoked = await getVol(`/share/${fileShare.shareId}`);
    expect(revoked.status).toBe(404);
    expect(revoked.headers['Cache-Control']).toBe('no-store');
  });
});

describe('GET /share/:shareId — inline containment headers (security F1)', () => {
  // Volume shares with a fixed CORS allowlist injected so the CSP assertion
  // is exact. The F1 headers apply to the volume html/file branches; todo-io
  // shares redirect (302) or serve OUR generated markdown page — nosniff only.
  const VOL_F1 = join(tmpdir(), `share-f1-vol-${Date.now()}`);
  const FA = "frame-ancestors 'self' https://os.teros.ai";
  let f1Handler: HttpShareHandler;

  async function getF1(path: string): Promise<{ handled: boolean; status: number; headers: Record<string, string>; body: string }> {
    const out = { status: 0, headers: {} as Record<string, string>, body: '' };
    const req = { method: 'GET', headers: { host: 'localhost' } } as unknown as IncomingMessage;
    const res = {
      writeHead(status: number, headers: Record<string, string> = {}) {
        out.status = status;
        out.headers = headers;
        return this;
      },
      end(body?: string | Buffer) {
        out.body = body ? String(body) : '';
      },
    } as unknown as ServerResponse;
    const handled = await f1Handler.handleRoute(req, res, path);
    return { handled, ...out };
  }

  beforeAll(async () => {
    await fs.mkdir(join(VOL_F1, 'reports'), { recursive: true });
    f1Handler = new HttpShareHandler(
      db,
      { getVolume: async () => ({ volumeId: 'vol_f1', hostPath: VOL_F1 }) } as any,
      { getWorkspace: async () => ({ workspaceId: WS, volumeId: 'vol_f1' }) } as any,
      new ShareService(db),
      ['https://os.teros.ai'],
    );
  });

  afterAll(async () => {
    await fs.rm(VOL_F1, { recursive: true, force: true });
  });

  it('[F1] a volume html share serves 200 with CSP sandbox allow-scripts (NEVER allow-same-origin) + frame-ancestors + nosniff', async () => {
    await fs.writeFile(join(VOL_F1, 'reports', 'entregable.html'), '<p>interactive deliverable</p>', 'utf-8');
    const svc = new ShareService(db);
    const share = await svc.createShare(OWNER, '/workspace/reports/entregable.html', WS, 'html');

    const r = await getF1(`/share/${share.shareId}`);
    expect(r.status).toBe(200);
    expect(r.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(r.headers['Content-Security-Policy']).toBe(`sandbox allow-scripts; ${FA}`);
    expect(r.headers['Content-Security-Policy']).not.toContain('allow-same-origin');
    expect(r.headers['X-Content-Type-Options']).toBe('nosniff');
    // F5 cache policy untouched by F1
    expect(r.headers['Cache-Control']).toBe('public, max-age=60');
  });

  it('[F1] a volume svg share (fileType file) gets the sandbox CSP; a png share gets nosniff only', async () => {
    await fs.writeFile(join(VOL_F1, 'reports', 'icono.svg'), '<svg><script>alert(1)</script></svg>', 'utf-8');
    await fs.writeFile(join(VOL_F1, 'reports', 'foto.png'), 'PNG-bytes', 'utf-8');
    const svc = new ShareService(db);

    const svgShare = await svc.createShare(OWNER, '/workspace/reports/icono.svg', WS, 'file');
    const svg = await getF1(`/share/${svgShare.shareId}`);
    expect(svg.status).toBe(200);
    expect(svg.headers['Content-Type']).toBe('image/svg+xml');
    expect(svg.headers['Content-Security-Policy']).toBe(`sandbox allow-scripts; ${FA}`);
    expect(svg.headers['X-Content-Type-Options']).toBe('nosniff');

    const pngShare = await svc.createShare(OWNER, '/workspace/reports/foto.png', WS, 'file');
    const png = await getF1(`/share/${pngShare.shareId}`);
    expect(png.status).toBe(200);
    expect(png.headers['Content-Type']).toBe('image/png');
    expect(png.headers['Content-Security-Policy']).toBeUndefined();
    expect(png.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('[F1] a volume markdown share (our generated page) gets nosniff only — sanitized markdown is not user-executable', async () => {
    await fs.writeFile(join(VOL_F1, 'reports', 'notas.md'), '# Notas', 'utf-8');
    const svc = new ShareService(db);
    const share = await svc.createShare(OWNER, '/workspace/reports/notas.md', WS, 'markdown');

    const r = await getF1(`/share/${share.shareId}`);
    expect(r.status).toBe(200);
    expect(r.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(r.headers['Content-Security-Policy']).toBeUndefined();
    expect(r.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('[F1] a todo-io file share 302 carries nosniff; the todo-io markdown page carries nosniff only', async () => {
    await seed({
      nodeId: 't_f1_file',
      text: 'F1 file',
      output: { format: 'file', objectId: 'obj_f1', url: 'https://be.example/objects/obj_f1', name: 'a.html', mime: 'text/html', size: 1 },
    });
    const { shareId } = await call('share-io', { nodeId: 't_f1_file', io: 'output', callerUserId: OWNER });
    const redirect = await getF1(`/share/${shareId}`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers['X-Content-Type-Options']).toBe('nosniff');

    await seed({ nodeId: 't_f1_md', text: 'F1 md', output: { format: 'markdown', markdown: '# live' } });
    const { shareId: mdShareId } = await call('share-io', { nodeId: 't_f1_md', io: 'output', callerUserId: OWNER });
    const page = await getF1(`/share/${mdShareId}`);
    expect(page.status).toBe(200);
    expect(page.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(page.headers['Content-Security-Policy']).toBeUndefined();
  });

  it('[F1] the 404 page (unknown share) carries nosniff — no response of this route is sniffable', async () => {
    const r = await getF1(`/share/${'a'.repeat(32)}`);
    expect(r.status).toBe(404);
    expect(r.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(r.headers['Content-Security-Policy']).toBeUndefined();
  });
});
