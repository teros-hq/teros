/**
 * Integration test: dual-path symmetry (Criterion 22).
 *
 * Agents can be created through two parallel backend paths that do NOT share
 * code: the WsRouter handler (agent.create → AgentProvisioningService) and the
 * MCA resource callback (handleAgentCreate). Both must derive the core from the
 * agent's scope identically — global/personal → super-agent, workspace → agent.
 *
 * Uses the ephemeral test MongoDB (MONGODB_URI, default :27019).
 * Skips silently if Mongo is unreachable.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { type Db, MongoClient } from 'mongodb';
import { AgentProvisioningService } from '../../src/services/agent-provisioning-service';
import { McaService } from '../../src/services/mca-service';
import { handleAgentCreate } from '../../src/routes/mca-resources-handlers';

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27019';
const DB_NAME = `teros_test_dualpath_${Date.now()}`;

let client: MongoClient;
let db: Db;
let provisioning: AgentProvisioningService;
let available = false;

// Minimal ServerResponse stub — handleAgentCreate only calls writeHead + end.
function makeRes(): any {
  return { writeHead() {}, end() {} };
}

// Minimal PubSubService stub — broadcastToWorkspace is async, broadcastToUser sync.
function makePubSub(): any {
  return {
    broadcastToWorkspace: mock(async () => {}),
    broadcastToUser: mock(() => {}),
  };
}

async function coreOf(name: string): Promise<string | undefined> {
  const agent = await db.collection('agents').findOne({ name });
  return agent?.coreId as string | undefined;
}

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 });
    db = client.db(DB_NAME);
    available = true;
  } catch {
    console.warn('[dual-path test] Mongo unreachable — skipping');
    return;
  }

  await db.collection('agent_cores').insertMany([
    { coreId: 'agent', coreType: 'agent', defaultApps: [], avatarUrl: 'a.jpg', status: 'active' },
    {
      coreId: 'super-agent',
      coreType: 'super-agent',
      defaultApps: [],
      avatarUrl: 'a.jpg',
      status: 'active',
    },
  ]);
  await db.collection('users').insertOne({ userId: 'u1', role: 'user' });
  await db.collection('workspaces').insertOne({ workspaceId: 'work_1', ownerId: 'u1', status: 'active' });

  provisioning = new AgentProvisioningService(db, new McaService(db));
});

afterAll(async () => {
  if (available) {
    await db.dropDatabase();
    await client.close();
  }
});

const profile = (name: string) => ({ name, fullName: name, role: 'r', intro: 'i' });

describe('dual-path core assignment is symmetric', () => {
  it('WsRouter path assigns by scope', async () => {
    if (!available) return;
    const global = await provisioning.createAgentFromCore({ ownerId: 'u1', profile: profile('WsGlobal') });
    const ws = await provisioning.createAgentFromCore({
      ownerId: 'u1',
      workspaceId: 'work_1',
      profile: profile('WsWorkspace'),
    });
    expect(global.coreId).toBe('super-agent');
    expect(ws.coreId).toBe('agent');
  });

  it('MCA callback path assigns by scope', async () => {
    if (!available) return;
    const ctx: any = { userId: 'u1', channelId: 'ch_1' };
    await handleAgentCreate(makeRes(), ctx, db, profile('McaGlobal'), provisioning, makePubSub());
    await handleAgentCreate(
      makeRes(),
      ctx,
      db,
      { ...profile('McaWorkspace'), workspaceId: 'work_1' },
      provisioning,
      makePubSub(),
    );
    expect(await coreOf('McaGlobal')).toBe('super-agent');
    expect(await coreOf('McaWorkspace')).toBe('agent');
  });

  // Regression for TER-611: the MCA path must emit `agent.created` so connected
  // navbars update in realtime. Asserts the exact scope + payload shape — delete
  // the broadcast block in handleAgentCreate and these go red.
  it('MCA callback path broadcasts agent.created scoped by membership', async () => {
    if (!available) return;
    const ctx: any = { userId: 'u1', channelId: 'ch_1' };

    // Workspace-scoped agent → broadcastToWorkspace(workspaceId, event).
    const wsPubSub = makePubSub();
    await handleAgentCreate(
      makeRes(),
      ctx,
      db,
      { ...profile('McaBroadcastWs'), workspaceId: 'work_1' },
      provisioning,
      wsPubSub,
    );
    expect(wsPubSub.broadcastToUser).not.toHaveBeenCalled();
    expect(wsPubSub.broadcastToWorkspace).toHaveBeenCalledTimes(1);
    const [wsId, wsEvent] = wsPubSub.broadcastToWorkspace.mock.calls[0];
    expect(wsId).toBe('work_1');
    expect(wsEvent.type).toBe('agent.created');
    expect(Object.keys(wsEvent.agent).sort()).toEqual(
      ['agentId', 'avatarUrl', 'coreId', 'fullName', 'intro', 'name', 'role', 'workspaceId'].sort(),
    );
    expect(wsEvent.agent.name).toBe('McaBroadcastWs');
    expect(wsEvent.agent.workspaceId).toBe('work_1');

    // Global agent (no workspaceId) → broadcastToUser(userId, event).
    const userPubSub = makePubSub();
    await handleAgentCreate(
      makeRes(),
      ctx,
      db,
      profile('McaBroadcastGlobal'),
      provisioning,
      userPubSub,
    );
    expect(userPubSub.broadcastToWorkspace).not.toHaveBeenCalled();
    expect(userPubSub.broadcastToUser).toHaveBeenCalledTimes(1);
    const [userId, userEvent] = userPubSub.broadcastToUser.mock.calls[0];
    expect(userId).toBe('u1');
    expect(userEvent.type).toBe('agent.created');
    expect(userEvent.agent.name).toBe('McaBroadcastGlobal');
    expect(userEvent.agent.workspaceId).toBeUndefined();
  });

  it('both paths agree for the same scope', async () => {
    if (!available) return;
    expect(await coreOf('WsGlobal')).toBe(await coreOf('McaGlobal')); // super-agent
    expect(await coreOf('WsWorkspace')).toBe(await coreOf('McaWorkspace')); // agent
  });

  // Equivalence invariant (the core review ask): both creation paths must yield
  // the SAME agent shape, not just the same coreId. Compares the full field set
  // and the canonical defaults — any path that omits `status` or the provider
  // fields (the historical divergences) fails here.
  it('both paths produce an identical agent shape', async () => {
    if (!available) return;
    // Required fields that a divergent hand-built path historically dropped.
    const REQUIRED_KEYS = [
      'agentId',
      'coreId',
      'name',
      'fullName',
      'role',
      'intro',
      'avatarUrl',
      'status',
      'ownerId',
      'workspaceId',
      'availableProviders',
      'selectedProviderId',
      'selectedModelId',
      'createdAt',
      'updatedAt',
    ];

    const keys = (doc: any) => Object.keys(doc).filter((k) => k !== '_id').sort();
    const stripVolatile = (doc: any) => {
      const { _id, agentId, createdAt, updatedAt, name, fullName, ...rest } = doc;
      return rest;
    };

    const wsAgent = await db.collection('agents').findOne({ name: 'WsWorkspace' });
    const mcaAgent = await db.collection('agents').findOne({ name: 'McaWorkspace' });

    // The actual equivalence: both paths yield the SAME key set...
    expect(keys(mcaAgent)).toEqual(keys(wsAgent));
    // ...and that set covers every required field (no path drops status/providers).
    for (const key of REQUIRED_KEYS) {
      expect(wsAgent).toHaveProperty(key);
      expect(mcaAgent).toHaveProperty(key);
    }
    // ...and the same canonical values for the same scope (id/timestamps aside).
    expect(stripVolatile(mcaAgent)).toEqual(stripVolatile(wsAgent));
    expect(wsAgent!.status).toBe('active');
    expect(wsAgent!.selectedProviderId).toBeNull();
    expect(wsAgent!.availableProviders).toEqual([]);
  });
});
