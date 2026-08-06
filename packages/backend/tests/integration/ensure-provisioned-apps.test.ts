/**
 * Integration test: McaService.ensureProvisionedApps provisions a core's
 * defaultApps (non-system MCAs) and is idempotent — re-running does not create
 * duplicate apps or grants.
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
  await db.collection('agent_cores').insertOne({
    coreId: 'super-agent',
    coreType: 'super-agent',
    defaultApps: ['mca.teros.core'],
    status: 'active',
  });
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

  it('is idempotent — no duplicate apps or grants on re-run', async () => {
    if (!available) return;
    await mcaService.ensureProvisionedApps('a1', 'work_1');
    await mcaService.ensureProvisionedApps('a1', 'work_1');

    const apps = await db
      .collection('apps')
      .find({ mcaId: 'mca.teros.core', ownerId: 'work_1' })
      .toArray();
    expect(apps.length).toBe(1);

    const grants = await db.collection('agent_app_access').find({ agentId: 'a1' }).toArray();
    expect(grants.length).toBe(1);
  });
});
