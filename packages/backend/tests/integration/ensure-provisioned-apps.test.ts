/**
 * Integration test: McaService.ensureProvisionedApps provisions a core's
 * defaultApps (non-system MCAs) AND system MCAs, seeding the install-time
 * permission map on every created app, and is idempotent — re-running does not
 * create duplicate apps or grants.
 *
 * Uses the ephemeral test MongoDB (MONGODB_URI, default :27019 — see
 * scripts/test-integration.sh). Never touches the shared :27017 instance.
 * Skips silently if unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Db, MongoClient } from 'mongodb';
import { McaService } from '../../src/services/mca-service';

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27019';
const DB_NAME = `teros_test_provision_${Date.now()}`;

let client: MongoClient;
let db: Db;
let mcaService: McaService;
let available = false;

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 });
    db = client.db(DB_NAME);
    available = true;
  } catch {
    console.warn('[provision test] Mongo unreachable — skipping');
    return;
  }

  await db.collection('users').insertOne({ userId: 'u1', role: 'user' });
  await db.collection('mca_catalog').insertOne({
    mcaId: 'mca.teros.core',
    name: 'Teros Core',
    status: 'active',
    availability: { enabled: true, system: false, role: 'user', multi: false },
  });
  // System MCAs (availability.system: true) — provisioned by the same loop as
  // core defaults. Their tools.json is read from MCA_BASE_PATH on this machine.
  await db.collection('mca_catalog').insertOne({
    mcaId: 'mca.teros.memory',
    name: 'Teros Memory',
    status: 'active',
    availability: { enabled: true, system: true, role: 'user', multi: false },
  });
  await db.collection('mca_catalog').insertOne({
    mcaId: 'mca.teros.guide',
    name: 'Teros Guide',
    status: 'active',
    availability: { enabled: true, system: true, role: 'user', multi: false },
  });
  await db.collection('agent_cores').insertOne({
    coreId: 'super-agent',
    coreType: 'super-agent',
    defaultApps: ['mca.teros.core'],
    status: 'active',
  });
  // System apps are provisioned for the workspace owner (installedBy): the
  // workspace document is required, never defaulted.
  await db.collection('workspaces').insertOne({ workspaceId: 'work_1', name: 'W', ownerId: 'u1', status: 'active' });
  await db.collection('agents').insertOne({
    agentId: 'a1',
    coreId: 'super-agent',
    ownerId: 'u1',
    workspaceId: 'work_1',
    status: 'active',
  });

  mcaService = new McaService(db);
});

afterAll(async () => {
  if (available) {
    await db.dropDatabase();
    await client.close();
  }
});

describe('ensureProvisionedApps + core defaultApps', () => {
  it('provisions the core default app and grants the agent access', async () => {
    if (!available) return;
    await mcaService.ensureProvisionedApps('a1', 'work_1');

    const apps = await db
      .collection('apps')
      .find({ mcaId: 'mca.teros.core', ownerId: 'work_1' })
      .toArray();
    expect(apps.length).toBe(1);

    const grants = await db
      .collection('agent_app_access')
      .find({ agentId: 'a1', appId: apps[0]!.appId })
      .toArray();
    expect(grants.length).toBe(1);
  });

  it('seeds the install-time permission map (read-only → allow, mutation → ask)', async () => {
    if (!available) return;
    const app = await db.collection('apps').findOne({ mcaId: 'mca.teros.core', ownerId: 'work_1' });
    expect(app).not.toBeNull();

    const perms = (app as any).permissions as
      | { tools: Record<string, string>; defaultPermission: string }
      | undefined;
    // Regression (2026-10-01): ensureProvisionedApps used to create the app
    // WITHOUT a permissions map, so every tool — read-only included — fell back
    // to DEFAULT_TOOL_PERMISSION 'ask' and fresh workspaces nagged for trivial
    // operations (search-guide, memory-search-knowledge).
    expect(perms).toBeDefined();
    expect(perms!.tools).toBeDefined();
    expect(Object.keys(perms!.tools).length).toBeGreaterThan(0);
    expect(perms!.defaultPermission).toBe('ask');

    // mca.teros.core's tools.json (read from MCA_BASE_PATH on this machine):
    // list-agents is readOnlyHint: true → 'allow'; create-agent is a mutation → 'ask'.
    expect(perms!.tools['list-agents']).toBe('allow');
    expect(perms!.tools['create-agent']).toBe('ask');
  });

  it('provisions SYSTEM apps with the full permission seed (read-only and safe-write → allow, mutation → ask)', async () => {
    if (!available) return;
    // ensureProvisionedApps ran in the first test — the system MCAs (memory,
    // guide) were provisioned alongside the core-default app.
    const memoryApp = await db
      .collection('apps')
      .findOne({ mcaId: 'mca.teros.memory', ownerId: 'work_1' });
    expect(memoryApp).not.toBeNull();
    const memoryPerms = (memoryApp as any).permissions as {
      tools: Record<string, string>;
      defaultPermission: string;
    };
    // Regression (2026-10-01): system apps used to be born WITHOUT a map, so
    // every tool — read-only included — fell back to 'ask'.
    expect(memoryPerms).toBeDefined();
    expect(memoryPerms.defaultPermission).toBe('ask');
    // read-only tool → allow (the original bug: search-knowledge nagged)
    expect(memoryPerms.tools['memory-search-knowledge']).toBe('allow');
    // safeWriteHint tool → allow (Pablo 2026-10-01: saving knowledge must not nag)
    expect(memoryPerms.tools['memory-save-knowledge']).toBe('allow');
    // memory-save-conversation also carries safeWriteHint since 35b3463a0
    // (owner-approved: every memory tool seeds allow)
    expect(memoryPerms.tools['memory-save-conversation']).toBe('allow');
    // private tools never enter the map
    expect(memoryPerms.tools['-health-check']).toBeUndefined();

    const guideApp = await db
      .collection('apps')
      .findOne({ mcaId: 'mca.teros.guide', ownerId: 'work_1' });
    expect(guideApp).not.toBeNull();
    const guidePerms = (guideApp as any).permissions as { tools: Record<string, string> };
    expect(guidePerms.tools['search-guide']).toBe('allow');
    expect(guidePerms.tools['get-guide-section']).toBe('allow');
  });

  it('is idempotent — no duplicate apps or grants on re-run', async () => {
    if (!available) return;
    await mcaService.ensureProvisionedApps('a1', 'work_1');
    await mcaService.ensureProvisionedApps('a1', 'work_1');

    // 1 core-default app + 2 system apps, no duplicates
    const apps = await db.collection('apps').find({ ownerId: 'work_1' }).toArray();
    expect(apps.length).toBe(3);

    // exactly one grant per provisioned app
    const grants = await db.collection('agent_app_access').find({ agentId: 'a1' }).toArray();
    expect(grants.length).toBe(3);
  });
});
