/**
 * Integration — agent-core rollout: createAgentCore, the E4 deterministic-core
 * guard, and applyCoreRollout (TER-412). Real Mongo for cores/agents/flags; a
 * faithful mock of ensureProvisionedApps records reprovision calls (the app
 * provisioning itself is covered by ensure-provisioned-apps.test.ts).
 * Skips silently if Mongo is unreachable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type Db, MongoClient } from 'mongodb';
import { AgentProvisioningService } from '../../src/services/agent-provisioning-service';
import { FeatureFlagService } from '../../src/services/feature-flag-service';
import { ModelService } from '../../src/services/model-service';
import { stableBucket } from '../../src/services/feature-flag-rollout';

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const DB_NAME = `teros_test_rollout_apply_${Date.now()}`;
const KEY = 'core.agent';

let client: MongoClient;
let db: Db;
let available = false;
let reprovisionCalls: Array<{ agentId: string; workspaceId: string }>;

function makeProvisioning(opts: { failFor?: string } = {}): AgentProvisioningService {
  reprovisionCalls = [];
  const mcaService: any = {
    ensureProvisionedApps: async (agentId: string, workspaceId: string) => {
      if (opts.failFor === agentId) throw new Error(`provisioning boom for ${agentId}`);
      reprovisionCalls.push({ agentId, workspaceId });
    },
  };
  return new AgentProvisioningService(db, mcaService);
}

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 });
    db = client.db(DB_NAME);
    available = true;
  } catch {
    console.warn('[core-rollout-apply test] Mongo unreachable — skipping');
  }
});

afterAll(async () => {
  if (available) {
    await db.dropDatabase();
    await client.close();
  }
});

beforeEach(async () => {
  if (!available) return;
  for (const c of ['agent_cores', 'agents', 'models', 'feature_flags', 'feature_flag_overrides', 'users']) {
    await db.collection(c).deleteMany({});
  }
  await db.collection('models').insertOne({ modelId: 'm1', provider: 'anthropic', status: 'active', defaults: {} });
  // Stable canonical core + an active experimental core of the same coreType.
  await db.collection('agent_cores').insertMany([
    { coreId: 'agent', coreType: 'agent', name: 'Agent', modelId: 'm1', status: 'active', defaultApps: [] },
    { coreId: 'agent-exp', coreType: 'agent', name: 'Agent Exp', modelId: 'm1', status: 'active', defaultApps: ['mca.x'] },
  ]);
});

describe('ModelService.createAgentCore', () => {
  it('creates a core active by default (E4 makes an active experimental core safe), and respects an explicit status', async () => {
    if (!available) return;
    const ms = new ModelService(db);
    const core = await ms.createAgentCore({
      coreId: 'agent-exp2',
      coreType: 'agent',
      name: 'Exp2',
      fullName: 'Agent Exp 2',
      systemPrompt: 'hi',
      modelId: 'm1',
    });
    expect(core.status).toBe('active');
    expect(core.coreType).toBe('agent');
    expect(await db.collection('agent_cores').countDocuments({ coreId: 'agent-exp2' })).toBe(1);

    const inactive = await ms.createAgentCore({
      coreId: 'agent-exp3',
      coreType: 'agent',
      name: 'Exp3',
      fullName: 'Agent Exp 3',
      systemPrompt: 'hi',
      modelId: 'm1',
      status: 'inactive',
    });
    expect(inactive.status).toBe('inactive');
  });

  it('rejects a duplicate coreId, an invalid coreType, and a missing modelId', async () => {
    if (!available) return;
    const ms = new ModelService(db);
    await expect(
      ms.createAgentCore({ coreId: 'agent', coreType: 'agent', name: 'x', fullName: 'x', systemPrompt: 'x', modelId: 'm1' }),
    ).rejects.toThrow(/already exists/);
    await expect(
      ms.createAgentCore({ coreId: 'z', coreType: 'nope' as any, name: 'x', fullName: 'x', systemPrompt: 'x', modelId: 'm1' }),
    ).rejects.toThrow(/Invalid coreType/);
    await expect(
      ms.createAgentCore({ coreId: 'z', coreType: 'agent', name: 'x', fullName: 'x', systemPrompt: 'x', modelId: 'nope' }),
    ).rejects.toThrow(/Model nope not found/);
  });
});

describe('createAgentFromCore — E4 deterministic canonical core', () => {
  it('always assigns the canonical core even with 2 active cores of the same coreType', async () => {
    if (!available) return;
    const svc = makeProvisioning();
    const agent = await svc.createAgentFromCore({
      ownerId: 'u1',
      workspaceId: 'work_1',
      profile: { name: 'A', fullName: 'A B', role: 'r', intro: 'i' },
    });
    expect(agent.coreId).toBe('agent'); // canonical, never 'agent-exp'
  });
});

describe('applyCoreRollout', () => {
  const OWNERS = ['o_1', 'o_2', 'o_3', 'o_4', 'o_5', 'o_6'];

  async function seedAgents() {
    await db.collection('agents').insertMany(
      OWNERS.map((ownerId, i) => ({
        agentId: `ag_${i}`,
        coreId: 'agent',
        ownerId,
        workspaceId: `w_${i}`,
        status: 'active',
      })),
    );
  }

  it('migrates everyone at 100% and reverts everyone at 0%', async () => {
    if (!available) return;
    await seedAgents();
    const svc = makeProvisioning();
    const flags = new FeatureFlagService(db);
    await flags.syncRegistry();

    await flags.setRollout(KEY, 'agent-exp', 100);
    const up = await svc.applyCoreRollout('agent', flags);
    expect(up.migrated).toBe(OWNERS.length);
    expect(up.reverted).toBe(0);
    for (let i = 0; i < OWNERS.length; i++) {
      expect((await db.collection('agents').findOne({ agentId: `ag_${i}` }))?.coreId).toBe('agent-exp');
    }
    expect(reprovisionCalls.length).toBe(OWNERS.length); // each migration reprovisions

    await flags.setRollout(KEY, 'agent-exp', 0);
    const down = await svc.applyCoreRollout('agent', flags);
    expect(down.reverted).toBe(OWNERS.length);
    expect(down.migrated).toBe(0);
    for (let i = 0; i < OWNERS.length; i++) {
      expect((await db.collection('agents').findOne({ agentId: `ag_${i}` }))?.coreId).toBe('agent');
    }
  });

  it('is idempotent: re-applying the same % changes nothing', async () => {
    if (!available) return;
    await seedAgents();
    const svc = makeProvisioning();
    const flags = new FeatureFlagService(db);
    await flags.syncRegistry();
    await flags.setRollout(KEY, 'agent-exp', 100);

    await svc.applyCoreRollout('agent', flags);
    const second = await svc.applyCoreRollout('agent', flags);
    expect(second.migrated).toBe(0);
    expect(second.reverted).toBe(0);
    expect(second.unchanged).toBe(OWNERS.length);
  });

  it('migrates exactly the owners whose bucket falls under 50%', async () => {
    if (!available) return;
    await seedAgents();
    const svc = makeProvisioning();
    const flags = new FeatureFlagService(db);
    await flags.syncRegistry();
    await flags.setRollout(KEY, 'agent-exp', 50);

    await svc.applyCoreRollout('agent', flags);
    for (let i = 0; i < OWNERS.length; i++) {
      const expected = stableBucket(OWNERS[i], KEY) < 50 ? 'agent-exp' : 'agent';
      expect((await db.collection('agents').findOne({ agentId: `ag_${i}` }))?.coreId).toBe(expected);
    }
  });

  it('fails loud if the rollout target core is inactive (no migration onto a broken engine)', async () => {
    if (!available) return;
    await seedAgents();
    await db.collection('agent_cores').updateOne({ coreId: 'agent-exp' }, { $set: { status: 'inactive' } });
    const svc = makeProvisioning();
    const flags = new FeatureFlagService(db);
    await flags.syncRegistry();
    await flags.setRollout(KEY, 'agent-exp', 100);

    await expect(svc.applyCoreRollout('agent', flags)).rejects.toThrow(/missing or inactive/);
  });

  it('does not touch an agent pinned to a core of another coreType', async () => {
    if (!available) return;
    await seedAgents();
    await db.collection('agent_cores').insertOne({ coreId: 'super-agent', coreType: 'super-agent', modelId: 'm1', status: 'active', defaultApps: [] });
    await db.collection('agents').insertOne({ agentId: 'ag_pinned', coreId: 'super-agent', ownerId: 'o_1', workspaceId: 'w_x', status: 'active' });
    const svc = makeProvisioning();
    const flags = new FeatureFlagService(db);
    await flags.syncRegistry();
    await flags.setRollout(KEY, 'agent-exp', 100);

    await svc.applyCoreRollout('agent', flags);
    // The 'agent' coreType rollout must not move an agent on the super-agent core.
    expect((await db.collection('agents').findOne({ agentId: 'ag_pinned' }))?.coreId).toBe('super-agent');
  });

  it('a mid-run reprovision failure propagates loud and a re-run completes (idempotent recovery)', async () => {
    if (!available) return;
    await seedAgents();
    const flags = new FeatureFlagService(db);
    await flags.syncRegistry();
    await flags.setRollout(KEY, 'agent-exp', 100);

    // 1st apply: provisioning blows up on ag_2 → the error must PROPAGATE (fail loud,
    // not swallowed). The apply is intentionally non-transactional.
    const svc1 = makeProvisioning({ failFor: 'ag_2' });
    await expect(svc1.applyCoreRollout('agent', flags)).rejects.toThrow(/provisioning boom/);

    // 2nd apply (no failure): idempotent recovery — already-migrated agents are
    // unchanged, the rest finish. Net: everyone lands on the experimental core.
    const svc2 = makeProvisioning();
    await svc2.applyCoreRollout('agent', flags);
    for (let i = 0; i < OWNERS.length; i++) {
      expect((await db.collection('agents').findOne({ agentId: `ag_${i}` }))?.coreId).toBe('agent-exp');
    }
  });

  // Regression for the reversion guard (TER-412 review H2): reverting (percentage→0)
  // must NOT be blocked when the experimental core was deactivated. The old guard
  // threw on any inactive rollout.value regardless of percentage, leaving agents
  // stuck on the inactive core. Mutation: drop `&& percentage > 0` from the guard →
  // this throws and the test goes red.
  it('reverts to 0% even when the experimental core is now inactive (no stuck agents)', async () => {
    if (!available) return;
    await seedAgents();
    const flags = new FeatureFlagService(db);
    await flags.syncRegistry();

    // Migrate everyone onto the experimental core at 100%.
    await flags.setRollout(KEY, 'agent-exp', 100);
    await makeProvisioning().applyCoreRollout('agent', flags);
    for (let i = 0; i < OWNERS.length; i++) {
      expect((await db.collection('agents').findOne({ agentId: `ag_${i}` }))?.coreId).toBe('agent-exp');
    }

    // Admin deactivates the experimental core, then drops to 0% to revert.
    await db.collection('agent_cores').updateOne({ coreId: 'agent-exp' }, { $set: { status: 'inactive' } });
    await flags.setRollout(KEY, 'agent-exp', 0);

    const down = await makeProvisioning().applyCoreRollout('agent', flags);
    expect(down.reverted).toBe(OWNERS.length);
    expect(down.migrated).toBe(0);
    for (let i = 0; i < OWNERS.length; i++) {
      expect((await db.collection('agents').findOne({ agentId: `ag_${i}` }))?.coreId).toBe('agent');
    }
  });

  it('with no rollout configured, leaves every agent unchanged', async () => {
    if (!available) return;
    await seedAgents();
    const flags = new FeatureFlagService(db);
    await flags.syncRegistry(); // flag exists, but no rollout set

    const res = await makeProvisioning().applyCoreRollout('agent', flags);
    expect(res).toEqual({ migrated: 0, reverted: 0, unchanged: OWNERS.length, total: OWNERS.length });
    for (let i = 0; i < OWNERS.length; i++) {
      expect((await db.collection('agents').findOne({ agentId: `ag_${i}` }))?.coreId).toBe('agent');
    }
  });
});

// The 'agent' suite covers workspace-scoped agents; super-agents are GLOBAL
// (no workspaceId), so applyCoreRollout → reprovisionForCore must resolve the
// owner's private workspace from the `users` collection. This exercises both the
// 'super-agent' coreType path (key = 'core.super-agent') and the
// `agent.workspaceId ?? privateWorkspaceId(ownerId)` branch.
describe('applyCoreRollout — super-agent (global agents, no workspaceId)', () => {
  const SUPER_KEY = 'core.super-agent';
  const SUPER_OWNERS = ['s_1', 's_2', 's_3'];

  async function seedSuperAgents() {
    await db.collection('agent_cores').insertMany([
      { coreId: 'super-agent', coreType: 'super-agent', name: 'Super', modelId: 'm1', status: 'active', defaultApps: [] },
      { coreId: 'super-agent-exp', coreType: 'super-agent', name: 'Super Exp', modelId: 'm1', status: 'active', defaultApps: ['mca.x'] },
    ]);
    // Global agents: NO workspaceId. Each owner has a private workspace in `users`.
    await db.collection('users').insertMany(
      SUPER_OWNERS.map((userId) => ({ userId, privateWorkspaceId: `priv_${userId}` })),
    );
    await db.collection('agents').insertMany(
      SUPER_OWNERS.map((ownerId, i) => ({
        agentId: `sag_${i}`,
        coreId: 'super-agent',
        ownerId,
        status: 'active',
        // intentionally no workspaceId
      })),
    );
  }

  it('migrates global super-agents at 100% and reprovisions against the private workspace', async () => {
    if (!available) return;
    await seedSuperAgents();
    const svc = makeProvisioning();
    const flags = new FeatureFlagService(db);
    await flags.syncRegistry();
    await flags.setRollout(SUPER_KEY, 'super-agent-exp', 100);

    const up = await svc.applyCoreRollout('super-agent', flags);
    expect(up.migrated).toBe(SUPER_OWNERS.length);
    for (let i = 0; i < SUPER_OWNERS.length; i++) {
      expect((await db.collection('agents').findOne({ agentId: `sag_${i}` }))?.coreId).toBe('super-agent-exp');
    }
    // reprovisionForCore resolved each owner's PRIVATE workspace (no agent.workspaceId).
    for (let i = 0; i < SUPER_OWNERS.length; i++) {
      expect(reprovisionCalls).toContainEqual({ agentId: `sag_${i}`, workspaceId: `priv_${SUPER_OWNERS[i]}` });
    }

    // And reverts at 0%.
    await flags.setRollout(SUPER_KEY, 'super-agent-exp', 0);
    const down = await makeProvisioning().applyCoreRollout('super-agent', flags);
    expect(down.reverted).toBe(SUPER_OWNERS.length);
    for (let i = 0; i < SUPER_OWNERS.length; i++) {
      expect((await db.collection('agents').findOne({ agentId: `sag_${i}` }))?.coreId).toBe('super-agent');
    }
  });
});

// previewCoreRollout drives the admin UI: it must show the real current state and
// EXACTLY what an Apply would do, without mutating anything.
describe('previewCoreRollout — dry-run', () => {
  const OWNERS = ['o_1', 'o_2', 'o_3', 'o_4', 'o_5', 'o_6'];

  async function seedAgents() {
    await db.collection('agents').insertMany(
      OWNERS.map((ownerId, i) => ({
        agentId: `ag_${i}`,
        coreId: 'agent',
        ownerId,
        workspaceId: `w_${i}`,
        status: 'active',
      })),
    );
  }

  it('reports the current distribution and moves no one', async () => {
    if (!available) return;
    await seedAgents();
    const svc = makeProvisioning();
    const flags = new FeatureFlagService(db);
    await flags.syncRegistry();
    await flags.setRollout(KEY, 'agent-exp', 100);

    const preview = await svc.previewCoreRollout('agent', flags);
    expect(preview.total).toBe(OWNERS.length);
    // distribution = current state (all on the stable core), NOT the post-apply state.
    expect(preview.distribution).toContainEqual({ coreId: 'agent', count: OWNERS.length });
    expect(preview.distribution).toContainEqual({ coreId: 'agent-exp', count: 0 });
    // Dry-run: zero reprovision calls, and the DB is untouched.
    expect(reprovisionCalls.length).toBe(0);
    for (let i = 0; i < OWNERS.length; i++) {
      expect((await db.collection('agents').findOne({ agentId: `ag_${i}` }))?.coreId).toBe('agent');
    }
  });

  // THE guard (CLAUDE.md: a structural guard beats "remembering"): the saved-state
  // preview must equal what Apply actually does, at every percentage. Both derive
  // from the same computeRolloutPlan — this goes red if they ever diverge.
  for (const percentage of [0, 50, 100]) {
    it(`preview.plan === apply counts at ${percentage}%`, async () => {
      if (!available) return;
      await seedAgents();
      const flags = new FeatureFlagService(db);
      await flags.syncRegistry();
      await flags.setRollout(KEY, 'agent-exp', percentage);

      const preview = await makeProvisioning().previewCoreRollout('agent', flags);
      const applied = await makeProvisioning().applyCoreRollout('agent', flags);

      expect(preview.plan.migrate).toBe(applied.migrated);
      expect(preview.plan.revert).toBe(applied.reverted);
      expect(preview.plan.stay).toBe(applied.unchanged);
      expect(preview.total).toBe(applied.total);
    });
  }

  it('matches Apply on a reversion: agents on the experimental, % → 0', async () => {
    if (!available) return;
    await seedAgents();
    const flags = new FeatureFlagService(db);
    await flags.syncRegistry();
    // Put everyone on the experimental core first.
    await flags.setRollout(KEY, 'agent-exp', 100);
    await makeProvisioning().applyCoreRollout('agent', flags);
    // Drop to 0% — both preview and apply must report a full reversion.
    await flags.setRollout(KEY, 'agent-exp', 0);

    const preview = await makeProvisioning().previewCoreRollout('agent', flags);
    expect(preview.plan.revert).toBe(OWNERS.length);
    expect(preview.plan.migrate).toBe(0);
    // distribution = current (all on experimental); resulting = post-revert (all stable).
    expect(preview.distribution).toContainEqual({ coreId: 'agent-exp', count: OWNERS.length });
    expect(preview.resulting).toContainEqual({ coreId: 'agent', count: OWNERS.length });

    const applied = await makeProvisioning().applyCoreRollout('agent', flags);
    expect(applied.reverted).toBe(preview.plan.revert);
  });

  it('hypothetical preview is monotonic and matches the bucket count', async () => {
    if (!available) return;
    await seedAgents();
    const flags = new FeatureFlagService(db);
    await flags.syncRegistry(); // no saved rollout — preview the hypothetical directly

    const at0 = await makeProvisioning().previewCoreRollout('agent', flags, {
      experimentalCoreId: 'agent-exp',
      percentage: 0,
    });
    const at50 = await makeProvisioning().previewCoreRollout('agent', flags, {
      experimentalCoreId: 'agent-exp',
      percentage: 50,
    });
    const at100 = await makeProvisioning().previewCoreRollout('agent', flags, {
      experimentalCoreId: 'agent-exp',
      percentage: 100,
    });

    expect(at0.plan.migrate).toBe(0);
    expect(at100.plan.migrate).toBe(OWNERS.length);
    expect(at50.plan.migrate).toBe(OWNERS.filter((o) => stableBucket(o, KEY) < 50).length);
    expect(at0.plan.migrate).toBeLessThanOrEqual(at50.plan.migrate);
    expect(at50.plan.migrate).toBeLessThanOrEqual(at100.plan.migrate);
    // resulting follows the migration: at 100% everyone lands on the experimental.
    expect(at100.resulting).toContainEqual({ coreId: 'agent-exp', count: OWNERS.length });
    expect(reprovisionCalls.length).toBe(0); // still a dry-run
  });

  it('an agent without an ownerId always stays (no bucketing identity)', async () => {
    if (!available) return;
    await db.collection('agents').insertOne({ agentId: 'ag_noowner', coreId: 'agent', status: 'active' });
    const flags = new FeatureFlagService(db);
    await flags.syncRegistry();

    const preview = await makeProvisioning().previewCoreRollout('agent', flags, {
      experimentalCoreId: 'agent-exp',
      percentage: 100,
    });
    expect(preview.total).toBe(1);
    expect(preview.plan.migrate).toBe(0);
    expect(preview.plan.stay).toBe(1);
    expect(preview.resulting).toContainEqual({ coreId: 'agent', count: 1 });
  });
});

// resolve() gained an optional rolloutOverride (powers the hypothetical preview):
// resolve AS IF the flag had that rollout, without persisting it.
describe('FeatureFlagService.resolve — rolloutOverride', () => {
  it('uses the passed rollout instead of the persisted one, and never writes it', async () => {
    if (!available) return;
    const flags = new FeatureFlagService(db);
    await flags.syncRegistry(); // no persisted rollout on core.agent

    // 100% override routes the user to the experimental value...
    expect(await flags.resolve(KEY, { userId: 'o_1' }, { value: 'agent-exp', percentage: 100 })).toBe(
      'agent-exp',
    );
    // ...0% falls back to the flag default (the canonical 'agent'), NOT the override value.
    expect(await flags.resolve(KEY, { userId: 'o_1' }, { value: 'agent-exp', percentage: 0 })).toBe(
      'agent',
    );
    // The persisted flag still has no rollout — the override didn't mutate state.
    expect((await flags.getFlag(KEY))?.rollout).toBeUndefined();
  });

  it('an exact user override beats the hypothetical rollout', async () => {
    if (!available) return;
    const flags = new FeatureFlagService(db);
    await flags.syncRegistry();
    await flags.setOverride(KEY, 'user', 'o_1', 'agent'); // pin o_1 to the stable core

    expect(await flags.resolve(KEY, { userId: 'o_1' }, { value: 'agent-exp', percentage: 100 })).toBe(
      'agent',
    );
  });
});

// The cohort is the admin "who" view: one entry per agent with owner resolved +
// bucket. It MUST agree, kind-for-kind, with what Apply does (both from one plan).
describe('coreRolloutCohort — the "who"', () => {
  const OWNERS = ['o_1', 'o_2', 'o_3', 'o_4', 'o_5', 'o_6'];

  async function seedWithOwners() {
    await db.collection('users').insertMany(
      OWNERS.map((u, i) => ({ userId: u, profile: { displayName: `User ${i}`, email: `${u}@x.com` } })),
    );
    await db.collection('agents').insertMany(
      OWNERS.map((u, i) => ({ agentId: `ag_${i}`, coreId: 'agent', ownerId: u, workspaceId: `w_${i}`, status: 'active' })),
    );
    // One agent without an ownerId — no bucketing identity → never migrates.
    await db.collection('agents').insertOne({ agentId: 'ag_noowner', coreId: 'agent', status: 'active' });
  }

  it('one entry per agent, owner resolved, bucket correct, no-owner → stay/null', async () => {
    if (!available) return;
    await seedWithOwners();
    const flags = new FeatureFlagService(db);
    await flags.syncRegistry();
    await flags.setRollout(KEY, 'agent-exp', 50);

    const cohort = await makeProvisioning().coreRolloutCohort('agent', flags);
    expect(cohort.length).toBe(OWNERS.length + 1);

    const e0 = cohort.find((e) => e.agentId === 'ag_0');
    expect(e0?.ownerName).toBe('User 0'); // resolved from users.profile.displayName
    expect(e0?.bucket).toBe(stableBucket('o_1', KEY));

    const noOwner = cohort.find((e) => e.agentId === 'ag_noowner');
    expect(noOwner?.bucket).toBeNull();
    expect(noOwner?.kind).toBe('stay');
    expect(noOwner?.ownerName).toBe('—');
  });

  // The guard: cohort kind counts === what Apply actually does (same plan source).
  it('cohort kinds match apply counts exactly', async () => {
    if (!available) return;
    await seedWithOwners();
    const flags = new FeatureFlagService(db);
    await flags.syncRegistry();
    await flags.setRollout(KEY, 'agent-exp', 50);

    const cohort = await makeProvisioning().coreRolloutCohort('agent', flags);
    const applied = await makeProvisioning().applyCoreRollout('agent', flags);

    expect(cohort.filter((e) => e.kind === 'migrate').length).toBe(applied.migrated);
    expect(cohort.filter((e) => e.kind === 'revert').length).toBe(applied.reverted);
    expect(cohort.filter((e) => e.kind === 'stay').length).toBe(applied.unchanged);
    // Per-agent target must match where each migrated agent actually landed.
    for (const e of cohort) {
      if (e.kind === 'migrate') {
        expect((await db.collection('agents').findOne({ agentId: e.agentId }))?.coreId).toBe(e.target);
      }
    }
  });
});

describe('recordRolloutApply — apply audit entry', () => {
  it('writes an apply_rollout entry with actor + counts in the note', async () => {
    if (!available) return;
    const flags = new FeatureFlagService(db);
    await flags.syncRegistry();
    await flags.recordRolloutApply(KEY, 'admin_x', { migrated: 3, reverted: 1, unchanged: 2, total: 6 });

    const log = await flags.getAuditLog(KEY, { limit: 10 });
    const apply = log.find((e) => e.action === 'apply_rollout');
    expect(apply).toBeDefined();
    expect(apply?.actor).toBe('admin_x');
    expect(apply?.note).toContain('migrated=3');
    expect(apply?.note).toContain('reverted=1');
  });
});
