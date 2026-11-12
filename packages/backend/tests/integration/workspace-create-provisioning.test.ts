/**
 * Integration test: workspace creation provisions system apps for the owner's
 * superagents (onWorkspaceCreated hook), and the getAgentApps lazy-heal cache
 * is keyed by agent+workspace (not just agent).
 *
 * Regression: 2026-10-17 — creating a workspace and talking to the superagent
 * resulted in 0 apps because (1) createWorkspace never provisioned, and (2)
 * the ensureProvisionedAppsCache was keyed by agentId only, so a superagent
 * active in another workspace within 5min skipped provisioning in the new one.
 *
 * Uses the ephemeral test MongoDB (MONGODB_URI, default :27019).
 * Skips silently if unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Db, MongoClient } from 'mongodb';
import { McaService } from '../../src/services/mca-service';
import { WorkspaceService } from '../../src/services/workspace-service';
import { VolumeService } from '../../src/services/volume-service';

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27019';
const DB_NAME = `teros_test_ws_provision_${Date.now()}`;

let client: MongoClient;
let db: Db;
let mcaService: McaService;
let workspaceService: WorkspaceService;
let available = false;

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 });
    db = client.db(DB_NAME);
    available = true;
  } catch {
    console.warn('[ws-provision test] Mongo unreachable — skipping');
    return;
  }

  // Seed: user with a superagent (workspaceId=null)
  await db.collection('users').insertOne({ userId: 'u1', role: 'user' });
  await db.collection('agents').insertOne({
    agentId: 'sa1',
    coreId: 'super-agent',
    ownerId: 'u1',
    workspaceId: null,
    status: 'active',
  });

  // System MCAs
  await db.collection('mca_catalog').insertMany([
    {
      mcaId: 'mca.teros.memory',
      name: 'Teros Memory',
      status: 'active',
      availability: { enabled: true, system: true, role: 'user', multi: false },
    },
    {
      mcaId: 'mca.teros.guide',
      name: 'Teros Guide',
      status: 'active',
      availability: { enabled: true, system: true, role: 'user', multi: false },
    },
  ]);
  await db.collection('agent_cores').insertOne({
    coreId: 'super-agent',
    coreType: 'super-agent',
    defaultApps: [],
    status: 'active',
  });

  // Seed a subscription plan so the billing gate passes
  await db.collection('billing_subscriptions').insertOne({
    userId: 'u1',
    status: 'active',
    planId: 'plan_free',
  });
  await db.collection('billing_plans').insertOne({
    _id: 'plan_free',
    name: 'free',
    displayName: 'Free',
    features: { maxWorkspaces: -1 },
  });

  // Wire services the same way server-bootstrap does
  const volumeService = new VolumeService(db, {
    basePath: '/tmp/test-volumes',
    defaultWorkspaceQuota: 1024,
  });
  workspaceService = new WorkspaceService(db, volumeService);
  mcaService = new McaService(db);

  // Wire the onWorkspaceCreated hook (same as server-bootstrap.ts)
  workspaceService.setOnWorkspaceCreated(async (workspace) => {
    const agentsCollection = db.collection('agents');
    const superagents = await agentsCollection
      .find({ ownerId: workspace.ownerId, workspaceId: { $in: [null, undefined] as any } })
      .toArray();
    for (const agent of superagents) {
      await mcaService.ensureProvisionedApps(agent.agentId, workspace.workspaceId);
    }
  });
});

afterAll(async () => {
  if (available) {
    await db.dropDatabase();
    await client.close();
  }
});

describe('workspace creation → system app provisioning', () => {
  it('provisions system apps for the owner superagent when a workspace is created', async () => {
    if (!available) return;

    const workspace = await workspaceService.createWorkspace('u1', {
      name: 'Test Workspace',
    });

    // Apps should exist in the new workspace
    const apps = await db
      .collection('apps')
      .find({ ownerId: workspace.workspaceId, ownerType: 'workspace' })
      .toArray();
    expect(apps.length).toBe(2); // memory + guide

    // Superagent should have grants to those apps
    const grants = await db
      .collection('agent_app_access')
      .find({ agentId: 'sa1' })
      .toArray();
    const grantedAppIds = grants.map((g) => g.appId);
    for (const app of apps) {
      expect(grantedAppIds).toContain(app.appId);
    }
  });

  it('superagent gets tools in the new workspace without creating an agent', async () => {
    if (!available) return;

    // The workspace from the previous test should already have apps.
    // getAgentApps should resolve them for the superagent in that workspace.
    const workspaces = await db.collection('workspaces').find({ ownerId: 'u1' }).toArray();
    const ws = workspaces.find((w) => w.name === 'Test Workspace');
    expect(ws).toBeDefined();

    const agentApps = await mcaService.getAgentApps('sa1', ws!.workspaceId);
    expect(agentApps.apps.length).toBe(2);
  });
});

describe('getAgentApps cache — multi-workspace', () => {
  it('provisions in workspace B even if agent was active in workspace A <5min ago', async () => {
    if (!available) return;

    // Create workspace A — hook provisions apps
    const wsA = await workspaceService.createWorkspace('u1', { name: 'Workspace A' });

    // Simulate: agent talks in workspace A (populates cache for sa1:wsA)
    const appsA = await mcaService.getAgentApps('sa1', wsA.workspaceId);
    expect(appsA.apps.length).toBe(2);

    // Create workspace B — hook provisions apps
    const wsB = await workspaceService.createWorkspace('u1', { name: 'Workspace B' });

    // Agent talks in workspace B — cache key is sa1:wsB (different from sa1:wsA),
    // so provisioning runs and apps resolve.
    const appsB = await mcaService.getAgentApps('sa1', wsB.workspaceId);
    expect(appsB.apps.length).toBe(2);

    // Verify apps are workspace-scoped (not leaked from A)
    const appsInB = await db
      .collection('apps')
      .find({ ownerId: wsB.workspaceId, ownerType: 'workspace' })
      .toArray();
    expect(appsInB.length).toBe(2);
    for (const app of appsInB) {
      expect(app.ownerId).toBe(wsB.workspaceId);
    }
  });
});

describe('billing gate enforcement', () => {
  it('createWorkspace throws UpgradeRequiredError when workspace limit is reached', async () => {
    if (!available) return;

    // Create a user with a limited plan (max 1 workspace)
    await db.collection('users').insertOne({ userId: 'u2', role: 'user' });
    await db.collection('billing_subscriptions').insertOne({
      userId: 'u2',
      status: 'active',
      planId: 'plan_limited',
    });
    await db.collection('billing_plans').insertOne({
      _id: 'plan_limited',
      name: 'limited',
      displayName: 'Limited',
      features: { maxWorkspaces: 1 },
    });

    // First workspace succeeds
    const ws = await workspaceService.createWorkspace('u2', { name: 'First' });
    expect(ws.workspaceId).toBeDefined();

    // Second workspace should throw
    await expect(
      workspaceService.createWorkspace('u2', { name: 'Second' }),
    ).rejects.toThrow(/workspace limit/i);
  });

  it('createPrivateWorkspace skips the billing gate', async () => {
    if (!available) return;

    // u2 already has 1 workspace (limit reached), but private workspace
    // creation (signup flow) must not be gated.
    const ws = await workspaceService.createPrivateWorkspace('u2');
    expect(ws.type).toBe('private');
  });
});
