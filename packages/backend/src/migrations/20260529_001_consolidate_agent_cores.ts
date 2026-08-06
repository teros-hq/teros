import { readFileSync } from 'fs';
import type { Db } from 'mongodb';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { Migration } from './types.js';

// The two internal cores. Cores are no longer user-facing; agents are mapped to
// one of these by scope (global/personal → super-agent; workspace → agent).
const NEW_CORE_IDS = ['agent', 'super-agent'];

function loadPrompt(filename: string): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, `../prompts/${filename}`), 'utf-8');
  } catch {
    // The system prompts are a product input (refine via seed/admin); fall back
    // to a minimal prompt so the migration never blocks startup.
    return 'You are a helpful Teros agent.';
  }
}

/**
 * The two internal cores, upserted idempotently by the migration. Each core
 * carries its OWN base system prompt: the workspace `agent` (execution within a
 * workspace) and the global `super-agent` (personal assistant + platform
 * orchestrator). The runtime layers identity/context/skills on top of this base.
 */
function internalCores() {
  return [
    {
      coreId: 'agent',
      coreType: 'agent',
      name: 'Agent',
      fullName: 'Teros Agent',
      version: 'v1.0',
      systemPrompt: loadPrompt('base-agent-core.md'),
      personality: ['Direct', 'Efficient', 'Technical', 'Professional'],
      capabilities: ['Software Engineering', 'Project Work', 'Research', 'Execution'],
      defaultApps: [] as string[],
      avatarUrl: 'iria-avatar.jpg',
      modelId: 'claude-sonnet-4-5',
      modelOverrides: { temperature: 0.5 },
      status: 'active',
    },
    {
      coreId: 'super-agent',
      coreType: 'super-agent',
      name: 'Super Agent',
      fullName: 'Teros Super Agent',
      version: 'v1.0',
      systemPrompt: loadPrompt('base-super-agent-core.md'),
      personality: ['Direct', 'Efficient', 'Proactive', 'Resourceful'],
      capabilities: [
        'Personal Assistance',
        'Platform Management',
        'Software Engineering',
        'Research',
      ],
      defaultApps: ['mca.teros.core'],
      avatarUrl: 'iria-avatar.jpg',
      modelId: 'claude-opus-4-5',
      modelOverrides: { temperature: 0.7 },
      status: 'active',
    },
  ];
}

const migration: Migration = {
  description:
    'Consolidate agent cores to two internal cores (agent, super-agent). Remap all agents by scope (global → super-agent, workspace → agent), backfill the required `status` field on legacy agents that predate it, and deactivate legacy cores. (Core default-app provisioning for remapped agents is handled at startup by AgentProvisioningService.backfillCoreApps, which reuses the same path as agent creation.)',

  async up(db: Db): Promise<void> {
    const agentCores = db.collection('agent_cores');
    const agents = db.collection('agents');
    const now = new Date().toISOString();

    // 1. Upsert the two internal cores (idempotent). Each carries its own prompt.
    for (const core of internalCores()) {
      await agentCores.updateOne(
        { coreId: core.coreId },
        { $set: { ...core, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
    }

    // 2. Remap all agents to the new cores by scope (idempotent).
    // A falsy workspaceId (null, absent, or empty string) → super-agent; any
    // non-empty workspace id → agent. The empty-string case must land on the
    // super-agent side to agree with `resolveCoreType` (where '' is falsy);
    // otherwise the same agent would be classified differently by the runtime
    // creation path and by this migration.
    const superRes = await agents.updateMany(
      { $or: [{ workspaceId: null }, { workspaceId: { $exists: false } }, { workspaceId: '' }] },
      { $set: { coreId: 'super-agent', updatedAt: now } },
    );
    const agentRes = await agents.updateMany(
      { workspaceId: { $exists: true, $nin: [null, ''] } },
      { $set: { coreId: 'agent', updatedAt: now } },
    );
    console.log(
      `[Migration] Remapped agents: ${superRes.modifiedCount} → super-agent, ${agentRes.modifiedCount} → agent`,
    );

    // 2b. Backfill the required `status` field on legacy agents that predate it.
    // `AgentInstance.status` is a required field ('active' | 'inactive'), but agents
    // created before it was introduced lack it entirely — a contract violation that
    // makes them diverge from freshly-created agents (which always set 'active').
    // Only fill where the field is absent, so an explicit 'inactive' is never clobbered.
    const statusRes = await agents.updateMany(
      { status: { $exists: false } },
      { $set: { status: 'active', updatedAt: now } },
    );
    console.log(`[Migration] Backfilled status='active' on ${statusRes.modifiedCount} legacy agent(s)`);

    // 3. Deactivate legacy cores (alice, iria, …).
    const deactivated = await agentCores.updateMany(
      { coreId: { $nin: NEW_CORE_IDS } },
      { $set: { status: 'inactive', updatedAt: now } },
    );
    console.log(`[Migration] Deactivated ${deactivated.modifiedCount} legacy core(s)`);
  },

  async down(db: Db): Promise<void> {
    const agentCores = db.collection('agent_cores');
    const agents = db.collection('agents');
    const now = new Date().toISOString();

    // Safety guard: down() does NOT restore the agent→core remapping. If any
    // agent still points at the internal cores, deleting those cores would
    // orphan it (coreId referencing a non-existent core → runtime breakage).
    // Refuse in that case. The real rollback for a populated DB is
    // restore-from-backup, never this down().
    const stillMapped = await agents.countDocuments({ coreId: { $in: NEW_CORE_IDS } });
    if (stillMapped > 0) {
      throw new Error(
        `[Migration] Refusing down(): ${stillMapped} agent(s) still reference the internal cores ` +
          "('agent'/'super-agent'). Re-point them to legacy cores first, or restore from backup — " +
          'deleting the internal cores now would orphan every one of them.',
      );
    }

    // No agent references the internal cores → safe to reactivate legacy and
    // drop the internal cores.
    await agentCores.updateMany(
      { coreId: { $nin: NEW_CORE_IDS } },
      { $set: { status: 'active', updatedAt: now } },
    );
    await agentCores.deleteMany({ coreId: { $in: NEW_CORE_IDS } });
    console.log('[Migration] Rolled back core consolidation (no agents referenced the internal cores).');
  },
};

export default migration;
