/**
 * Integration test: system-capability toggles (v1.4.4 — task tn_87LdJ26pE7yHehBw).
 *
 * ensureProvisionedApps must respect the per-agent capability model:
 *  - default-ON capabilities (availability.defaultEnabled !== false) are
 *    provisioned unless the agent's disabledSystemApps contains them
 *  - default-OFF capabilities (availability.defaultEnabled === false, the
 *    power set: terminal/filesystem/browser/ui) are NOT provisioned unless
 *    enabledSystemApps contains them
 *  - capability groups: Terminal = mca.teros.bash + mca.teros.terminal —
 *    enabling either enables both; disabling either disables both
 *  - toggling OFF revokes existing grants (self-healing both directions)
 *
 * Uses the ephemeral test MongoDB (MONGODB_URI, default :27019). Skips
 * silently if unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Db, MongoClient } from 'mongodb';
import { McaService } from '../../src/services/mca-service';

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27019';
const DB_NAME = `teros_test_caps_${Date.now()}`;

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
    console.warn('[caps test] Mongo unreachable — skipping');
    return;
  }

  await db.collection('users').insertOne({ userId: 'u1', role: 'user' });

  const cat = (mcaId: string, system: boolean, defaultEnabled?: boolean) => ({
    mcaId,
    name: mcaId,
    status: 'active',
    availability: {
      enabled: true,
      system,
      role: 'user',
      multi: false,
      ...(defaultEnabled === undefined ? {} : { defaultEnabled }),
    },
  });

  // Ambient (default-ON, not toggleable in the UI but controllable via the lists)
  await db.collection('mca_catalog').insertMany([
    cat('mca.teros.memory', true), // defaultEnabled absent = ON
    cat('mca.teros.messaging', true),
    // Toggleable default-ON
    cat('mca.teros.todo-list', true),
    cat('mca.teros.automate', true),
    // Power default-OFF (Terminal group = bash + terminal)
    cat('mca.teros.bash', true, false),
    cat('mca.teros.terminal', true, false),
    cat('mca.teros.filesystem', true, false),
    cat('mca.teros.browser', true, false),
    cat('mca.teros.ui', true, false),
  ]);

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

const agentAppMcaIds = async (agentId: string): Promise<string[]> => {
  const access = await db.collection('agent_app_access').find({ agentId }).toArray();
  const apps = await db
    .collection('apps')
    .find({ appId: { $in: access.map((a) => a.appId) } })
    .toArray();
  return apps.map((a) => a.mcaId as string);
};

describe('ensureProvisionedApps — system capability toggles', () => {
  it('default agent: default-ON capabilities provisioned, default-OFF not', async () => {
    if (!available) return;
    await mcaService.ensureProvisionedApps('a1', 'work_1');
    const mcaIds = await agentAppMcaIds('a1');
    expect(mcaIds).toContain('mca.teros.memory');
    expect(mcaIds).toContain('mca.teros.messaging');
    expect(mcaIds).toContain('mca.teros.todo-list');
    expect(mcaIds).toContain('mca.teros.automate');
    expect(mcaIds).not.toContain('mca.teros.bash');
    expect(mcaIds).not.toContain('mca.teros.terminal');
    expect(mcaIds).not.toContain('mca.teros.filesystem');
    expect(mcaIds).not.toContain('mca.teros.browser');
    expect(mcaIds).not.toContain('mca.teros.ui');
  });

  it('isolated agent (memory in disabledSystemApps): memory NOT provisioned, ambient still on', async () => {
    if (!available) return;
    await db
      .collection('agents')
      .updateOne({ agentId: 'a1' }, { $set: { disabledSystemApps: ['mca.teros.memory'] } });
    await mcaService.ensureProvisionedApps('a1', 'work_1');
    const mcaIds = await agentAppMcaIds('a1');
    expect(mcaIds).not.toContain('mca.teros.memory');
    expect(mcaIds).toContain('mca.teros.messaging');
    expect(mcaIds).toContain('mca.teros.todo-list');
  });

  it('toggling memory OFF revokes an existing grant (self-healing removal)', async () => {
    if (!available) return;
    // Re-enable memory first (grant comes back — self-healing on re-enable)
    await db.collection('agents').updateOne({ agentId: 'a1' }, { $set: { disabledSystemApps: [] } });
    await mcaService.ensureProvisionedApps('a1', 'work_1');
    let mcaIds = await agentAppMcaIds('a1');
    expect(mcaIds).toContain('mca.teros.memory');

    // Now disable again — the grant must be revoked
    await db
      .collection('agents')
      .updateOne({ agentId: 'a1' }, { $set: { disabledSystemApps: ['mca.teros.memory'] } });
    await mcaService.ensureProvisionedApps('a1', 'work_1');
    mcaIds = await agentAppMcaIds('a1');
    expect(mcaIds).not.toContain('mca.teros.memory');
  });

  it('Terminal group: enabling mca.teros.terminal provisions BOTH bash and terminal', async () => {
    if (!available) return;
    await db
      .collection('agents')
      .updateOne({ agentId: 'a1' }, { $set: { enabledSystemApps: ['mca.teros.terminal'] } });
    await mcaService.ensureProvisionedApps('a1', 'work_1');
    const mcaIds = await agentAppMcaIds('a1');
    expect(mcaIds).toContain('mca.teros.terminal');
    expect(mcaIds).toContain('mca.teros.bash'); // group sibling provisioned too
    expect(mcaIds).not.toContain('mca.teros.filesystem'); // other power caps stay off
    expect(mcaIds).not.toContain('mca.teros.ui');
  });

  it('Terminal group: disabling via bash turns the whole group off', async () => {
    if (!available) return;
    // Agent has terminal enabled (from previous test). Now disable bash explicitly.
    await db.collection('agents').updateOne(
      { agentId: 'a1' },
      {
        $set: {
          enabledSystemApps: [],
          disabledSystemApps: ['mca.teros.bash'],
        },
      },
    );
    await mcaService.ensureProvisionedApps('a1', 'work_1');
    const mcaIds = await agentAppMcaIds('a1');
    expect(mcaIds).not.toContain('mca.teros.bash');
    expect(mcaIds).not.toContain('mca.teros.terminal'); // group sibling revoked too
  });

  it('explicit enable beats explicit disable for the same mcaId', async () => {
    if (!available) return;
    await db.collection('agents').updateOne(
      { agentId: 'a1' },
      {
        $set: {
          disabledSystemApps: ['mca.teros.memory'],
          enabledSystemApps: ['mca.teros.memory'],
        },
      },
    );
    await mcaService.ensureProvisionedApps('a1', 'work_1');
    const mcaIds = await agentAppMcaIds('a1');
    expect(mcaIds).toContain('mca.teros.memory');
  });
});
