/**
 * Migration: System capabilities toggles (v1.4.4 — task tn_87LdJ26pE7yHehBw).
 *
 * The power capabilities (terminal = bash+terminal, filesystem, browser,
 * ui) move from catalog apps to default-OFF system capabilities
 * (availability.system: true, hidden: true, defaultEnabled: false). From
 * now on the ONLY thing that provisions them is the per-agent toggle
 * (agent.enabledSystemApps).
 *
 * This migration preserves the status quo: every agent that TODAY has an
 * agent_app_access grant for one of those MCAs gets the corresponding mcaId
 * seeded into `enabledSystemApps`, so the capability stays ON for them.
 * Agents without grants are untouched (they simply won't get the now
 * default-off capabilities — same as before, since these MCAs were never
 * auto-provisioned).
 *
 * The Terminal capability group (bash + terminal) is expanded: a grant for
 * either member enables BOTH mcaIds, so the unified toggle never breaks the
 * terminal→bash dependency.
 *
 * Idempotent: only $addToSet into existing arrays (or creates them), never
 * removes anything.
 */
import type { Db } from 'mongodb'
import type { Migration } from './types.js'

const POWER_MCA_IDS = [
  'mca.teros.bash',
  'mca.teros.terminal',
  'mca.teros.filesystem',
  'mca.teros.playwright',
  'mca.teros.ui',
]

// Capability groups (must mirror SYSTEM_CAPABILITY_GROUPS in mca-service.ts):
// enabling one member enables the whole group.
const CAPABILITY_GROUPS: Record<string, string[]> = {
  terminal: ['mca.teros.bash', 'mca.teros.terminal'],
}

function expandGroup(mcaId: string): string[] {
  for (const members of Object.values(CAPABILITY_GROUPS)) {
    if (members.includes(mcaId)) return members
  }
  return [mcaId]
}

const migration: Migration = {
  description:
    'System capabilities v1.4.4: seed enabledSystemApps for agents with existing power-capability grants (terminal/filesystem/browser/ui)',

  async up(db: Db): Promise<void> {
    const agents = db.collection('agents')
    const access = db.collection('agent_app_access')
    const apps = db.collection('apps')

    // appId -> mcaId map for the power MCAs
    const powerApps = await apps
      .find({ mcaId: { $in: POWER_MCA_IDS } }, { projection: { appId: 1, mcaId: 1 } })
      .toArray()
    const mcaByAppId = new Map(powerApps.map((a) => [a.appId as string, a.mcaId as string]))

    // agentId -> set of power mcaIds it has grants for
    const grants = await access
      .find({ appId: { $in: [...mcaByAppId.keys()] } }, { projection: { agentId: 1, appId: 1 } })
      .toArray()

    const enabledByAgent = new Map<string, Set<string>>()
    for (const g of grants) {
      const mcaId = mcaByAppId.get(g.appId)
      if (!mcaId) continue
      const agentId = g.agentId as string
      if (!enabledByAgent.has(agentId)) enabledByAgent.set(agentId, new Set())
      for (const member of expandGroup(mcaId)) {
        enabledByAgent.get(agentId)!.add(member)
      }
    }

    let seeded = 0
    for (const [agentId, mcaIds] of enabledByAgent) {
      const res = await agents.updateOne(
        { agentId },
        { $addToSet: { enabledSystemApps: { $each: [...mcaIds] } } },
      )
      if (res.modifiedCount > 0) seeded++
    }

    console.log(
      `[Migration 20261030_001] system capabilities: seeded enabledSystemApps for ${seeded} of ${enabledByAgent.size} agents with existing power grants`,
    )
  },

  async down(db: Db): Promise<void> {
    // Removing the seeds returns the power capabilities to default-off for
    // everyone — the pre-v1.4.4 grants are still in agent_app_access, but
    // ensureProvisionedApps would revoke them on the next reconciliation.
    await db.collection('agents').updateMany(
      { enabledSystemApps: { $exists: true } },
      { $unset: { enabledSystemApps: '' } },
    )
  },
}

export default migration
