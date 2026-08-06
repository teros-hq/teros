/**
 * Agent Provisioning Service
 *
 * Single entry point for creating and re-provisioning agents. Owns the mechanics
 * shared by onboarding (DefaultAgentService) and agent.create so the agent shape
 * and app provisioning never diverge.
 *
 * Cores are internal: the user never picks one. The core is derived from the
 * agent's scope (global/personal → 'super-agent'; workspace-scoped → 'agent').
 */

import { generateAgentId } from '@teros/core';
import type { Collection, Db } from 'mongodb';
import type { AgentCore, AgentInstance } from '../types/database';
import { stableBucket } from './feature-flag-rollout';
import type { McaService } from './mca-service';
import type { FeatureFlagService } from './feature-flag-service';

export type CoreType = 'agent' | 'super-agent';

/**
 * Derive the core kind from the agent's scope. The user never chooses it.
 * Global/personal agents (no workspace, e.g. the onboarding Iria) get the
 * 'super-agent' core; workspace-scoped agents get the 'agent' core.
 *
 * Single source of truth for the scope→core mapping — the same invariant the
 * consolidate-agent-cores migration encodes in its Mongo query. A falsy
 * workspaceId (null/absent/'') is global. Any divergence here would classify the
 * same agent differently across creation paths.
 */
export function resolveCoreType(workspaceId?: string): CoreType {
  return workspaceId ? 'agent' : 'super-agent';
}

export interface AgentProfile {
  name: string;
  fullName: string;
  role: string;
  intro: string;
  avatarUrl?: string;
  context?: string;
}

export interface CreateAgentParams {
  ownerId: string;
  workspaceId?: string;
  profile: AgentProfile;
}

/** Per-agent decision of a rollout plan. `stay` = no move (stays on `current`). */
export interface RolloutPlanItem {
  agentId: string;
  agentName?: string;
  ownerId?: string;
  current: string;
  target: string;
  kind: 'migrate' | 'revert' | 'stay';
}

/** One agent in the rollout cohort, enriched for the admin "who" view. */
export interface RolloutCohortEntry {
  agentId: string;
  agentName: string;
  ownerId: string | null;
  ownerName: string;
  current: string;
  target: string;
  kind: 'migrate' | 'revert' | 'stay';
  /** Deterministic 0–99 bucket of the owner for this flag; null if no ownerId. */
  bucket: number | null;
}

/**
 * A computed rollout plan for a coreType — the single source of truth shared by
 * `applyCoreRollout` (executes it) and `previewCoreRollout` (counts it without
 * writing). Both derive their numbers from the SAME plan, so a preview can never
 * disagree with what Apply actually does.
 */
export interface RolloutPlan {
  total: number;
  /** Current count of agents per governed coreId (count 0 for governed-but-empty). */
  distribution: Array<{ coreId: string; count: number }>;
  items: RolloutPlanItem[];
}

/** Dry-run shape returned to the admin UI: current state + what Apply would do. */
export interface RolloutPreview {
  total: number;
  /** Where agents run NOW (count per coreId). */
  distribution: Array<{ coreId: string; count: number }>;
  /** What Apply would do at the resolved percentage. */
  plan: { migrate: number; revert: number; stay: number };
  /** Where agents would run AFTER applying (count per coreId). */
  resulting: Array<{ coreId: string; count: number }>;
  /** Agents with no ownerId — no bucketing identity, so they NEVER migrate. A
   *  subset of `plan.stay`, surfaced so the admin sees a stuck-on-stable cohort. */
  unbucketed: number;
}

export class AgentProvisioningService {
  private agents: Collection<AgentInstance>;
  private agentCores: Collection<AgentCore>;
  private users: Collection<{ userId: string; privateWorkspaceId?: string }>;

  constructor(
    private db: Db,
    private mcaService: McaService,
  ) {
    this.agents = db.collection<AgentInstance>('agents');
    this.agentCores = db.collection<AgentCore>('agent_cores');
    this.users = db.collection('users');
  }

  /**
   * Convenience accessor that delegates to the module-level {@link resolveCoreType}
   * (the single source of truth for the scope→core mapping). Kept on the service
   * for ergonomic call sites and so the mapping can be exercised via the public API.
   */
  resolveCoreType(workspaceId?: string): CoreType {
    return resolveCoreType(workspaceId);
  }

  /**
   * Create an agent from the core matching its scope, then provision its apps.
   * This is the only path that should build an AgentInstance document.
   */
  async createAgentFromCore(params: CreateAgentParams): Promise<AgentInstance> {
    const { ownerId, workspaceId, profile } = params;

    const coreType = this.resolveCoreType(workspaceId);
    // Deterministic: the canonical (stable) core for a coreType has
    // coreId === coreType ('agent'/'super-agent'). Rollout introduces additional
    // ACTIVE cores of the same coreType (experimental ones with their own coreId);
    // new agents must always be born from the canonical core — never an
    // experimental one — and only enter a rollout via the explicit apply action.
    // Falling back to a stable sort keeps it deterministic if the canonical core
    // is ever missing.
    const core =
      (await this.agentCores.findOne({ coreId: coreType, status: 'active' })) ??
      (await this.agentCores.findOne({ coreType, status: 'active' }, { sort: { coreId: 1 } }));
    if (!core) {
      throw new Error(`No active agent core for coreType '${coreType}'`);
    }

    const now = new Date().toISOString();
    const agent: AgentInstance = {
      agentId: generateAgentId(),
      coreId: core.coreId,
      name: profile.name,
      fullName: profile.fullName,
      role: profile.role,
      intro: profile.intro,
      avatarUrl: profile.avatarUrl || core.avatarUrl,
      status: 'active',
      ownerId,
      workspaceId,
      context: profile.context,
      // No explicit provider/model → uses the user's system default.
      availableProviders: [],
      selectedProviderId: null,
      selectedModelId: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.agents.insertOne(agent);

    // Provision system + core default apps. Superagents have no workspace of
    // their own, so provision against the owner's private workspace.
    const activeWorkspaceId = workspaceId ?? (await this.privateWorkspaceId(ownerId));
    if (activeWorkspaceId) {
      try {
        await this.mcaService.ensureProvisionedApps(agent.agentId, activeWorkspaceId);
      } catch (err) {
        // All-or-nothing: a provisioning failure must not leave a half-created
        // agent that we hand back to the caller as "created". The lazy heal in
        // getAgentApps is the safety net for agents that reach this state via
        // other paths (backfill, legacy docs) — not a licence to return broken
        // creations here. DB writes are contracts (ENGINEERING-PRINCIPLES.md).
        await this.agents.deleteOne({ agentId: agent.agentId });
        throw err;
      }
    }

    return agent;
  }

  /**
   * Move an agent to a different core (admin-only) and (re-)provision its apps.
   * Does not revoke apps from the previous core; admins can do that explicitly.
   */
  async reprovisionForCore(agentId: string, newCoreId: string): Promise<void> {
    const agent = await this.agents.findOne({ agentId });
    if (!agent) {
      throw new Error(`Agent '${agentId}' not found`);
    }
    const core = await this.agentCores.findOne({ coreId: newCoreId });
    if (!core) {
      throw new Error(`Agent core '${newCoreId}' not found`);
    }

    await this.agents.updateOne(
      { agentId },
      { $set: { coreId: newCoreId, updatedAt: new Date().toISOString() } },
    );

    const activeWorkspaceId =
      agent.workspaceId ?? (await this.privateWorkspaceId(agent.ownerId));
    if (activeWorkspaceId) {
      await this.mcaService.ensureProvisionedApps(agentId, activeWorkspaceId);
    }
  }

  /**
   * One-time backfill: provision every existing agent's core default apps, using
   * the exact same path as agent creation (`ensureProvisionedApps` against the
   * agent's workspace, or the owner's private workspace for super-agents).
   *
   * Needed after the consolidate-agent-cores migration: that migration only
   * re-points `coreId`, so agents remapped to 'super-agent' never received the
   * super-agent core's `defaultApps` (e.g. mca.teros.core). Freshly-created
   * agents get them at creation; this closes the gap so migrated and new agents
   * are identical.
   *
   * Idempotent: `ensureProvisionedApps` dedups and only creates what is missing,
   * so already-provisioned agents are a no-op. A per-agent failure is logged and
   * skipped — one bad agent never aborts the backfill.
   */
  async backfillCoreApps(): Promise<{
    processed: number;
    provisioned: number;
    skipped: number;
    failed: number;
  }> {
    const all = await this.agents
      .find({}, { projection: { agentId: 1, ownerId: 1, workspaceId: 1, _id: 0 } })
      .toArray();

    let provisioned = 0;
    let skipped = 0;
    let failed = 0;

    for (const agent of all) {
      const activeWorkspaceId =
        agent.workspaceId ?? (await this.privateWorkspaceId(agent.ownerId));
      if (!activeWorkspaceId) {
        // Super-agent whose owner has no private workspace — cannot provision,
        // same constraint as creation. The lazy getAgentApps path heals it on
        // first use within a workspace.
        skipped++;
        continue;
      }
      try {
        await this.mcaService.ensureProvisionedApps(agent.agentId, activeWorkspaceId);
        provisioned++;
      } catch (err) {
        failed++;
        console.error(
          `[AgentProvisioning] backfillCoreApps failed for agent ${agent.agentId}:`,
          err,
        );
      }
    }

    return { processed: all.length, provisioned, skipped, failed };
  }

  /**
   * Apply the percentage rollout for a coreType (TER-412): re-point each agent of
   * that coreType to the core it should run — stable (canonical, coreId===coreType)
   * or experimental — per the feature-flag resolution (override > rollout% >
   * default), bucketed by the agent's `ownerId`. Reuses `reprovisionForCore`, so a
   * migrated agent gets the FULL engine of its new core (prompt + model + MCAs).
   *
   * Add-only on apps: reverting (target back to stable) restores prompt/model and
   * the stable app baseline, but extra MCAs granted by the experimental core stay
   * (non-destructive drift — clean revocation is a deferred follow-up).
   *
   * Only touches agents currently pointing at a core OF THIS coreType, so an agent
   * deliberately moved (change-core) to another coreType's core is never disturbed.
   * Fails loud if the rollout points at a missing/inactive core (won't migrate
   * anyone onto a broken engine).
   *
   * Recoverability: the loop is NOT transactional (standalone Mongo). If a
   * reprovision fails mid-run the error propagates loud and the apply can simply
   * be re-run — it is idempotent (already-migrated agents resolve to their
   * current core and count as unchanged), so a re-run continues where it left off.
   *
   * Agents without an ownerId have no bucketing identity — they are left on
   * their current core (counted as unchanged), the same fail-safe as having no
   * rollout at all.
   */
  async applyCoreRollout(
    coreType: CoreType,
    flagService: FeatureFlagService,
  ): Promise<{ migrated: number; reverted: number; unchanged: number; total: number }> {
    const key = `core.${coreType}`;

    const flag = await flagService.getFlag(key);
    const experimentalId = flag?.rollout?.value;
    // Only guard against a missing/inactive experimental core when the rollout is
    // actually routing agents toward it (percentage > 0). At 0% nobody migrates to
    // the experimental, so an Apply is a REVERSION — it must run even if that core
    // was deactivated, or agents already on it get stuck (the guard would throw
    // before reverting anyone).
    const percentage = flag?.rollout?.percentage ?? 0;
    if (experimentalId !== undefined && experimentalId !== coreType && percentage > 0) {
      const exp = await this.agentCores.findOne({ coreId: String(experimentalId) });
      if (!exp || exp.status !== 'active') {
        throw new Error(
          `Rollout target core '${String(experimentalId)}' for ${key} is missing or inactive — ` +
            'activate it or clear the rollout before applying.',
        );
      }
    }

    // Resolve the plan first (read-only), then execute it. Reusing the shared
    // planner guarantees Apply moves EXACTLY the agents the preview reported.
    const plan = await this.computeRolloutPlan(coreType, (agent) =>
      flagService
        .resolve(key, { userId: agent.ownerId, workspaceId: agent.workspaceId ?? undefined })
        .then(String),
    );

    let migrated = 0;
    let reverted = 0;
    for (const item of plan.items) {
      if (item.kind === 'stay') continue;
      await this.reprovisionForCore(item.agentId, item.target);
      if (item.kind === 'revert') reverted++;
      else migrated++;
    }

    return { migrated, reverted, unchanged: plan.total - migrated - reverted, total: plan.total };
  }

  /**
   * Dry-run of {@link applyCoreRollout}: returns the current distribution and what
   * Apply WOULD do, without re-pointing or reprovisioning anyone. Drives the admin
   * UI so the operator sees who a rollout affects before committing.
   *
   * `hypothetical` resolves the plan AS IF the flag had that experimental core at
   * that percentage (for the live "% slider" preview before the rollout is saved);
   * omit it to preview the currently-saved rollout (exact match to Apply). No guard
   * on a missing/inactive core here — a preview never migrates anyone, and showing
   * the impact is useful even when the target is not yet active.
   */
  async previewCoreRollout(
    coreType: CoreType,
    flagService: FeatureFlagService,
    hypothetical?: { experimentalCoreId: string; percentage: number },
  ): Promise<RolloutPreview> {
    const key = `core.${coreType}`;
    const resolveTarget = (agent: AgentInstance): Promise<string> =>
      flagService
        .resolve(
          key,
          { userId: agent.ownerId, workspaceId: agent.workspaceId ?? undefined },
          hypothetical
            ? { value: hypothetical.experimentalCoreId, percentage: hypothetical.percentage }
            : undefined,
        )
        .then(String);

    const plan = await this.computeRolloutPlan(coreType, resolveTarget);

    let migrate = 0;
    let revert = 0;
    let stay = 0;
    const resultMap = new Map<string, number>();
    for (const { coreId } of plan.distribution) resultMap.set(coreId, 0);
    for (const item of plan.items) {
      if (item.kind === 'migrate') migrate++;
      else if (item.kind === 'revert') revert++;
      else stay++;
      // Where the agent ends up: a `stay` keeps `current`; a move lands on `target`.
      const landing = item.kind === 'stay' ? item.current : item.target;
      resultMap.set(landing, (resultMap.get(landing) ?? 0) + 1);
    }

    return {
      total: plan.total,
      distribution: plan.distribution,
      plan: { migrate, revert, stay },
      resulting: [...resultMap.entries()].map(([coreId, count]) => ({ coreId, count })),
      unbucketed: plan.items.filter((i) => !i.ownerId).length,
    };
  }

  /**
   * The rollout COHORT, enriched for the admin "who" view: every agent of this
   * coreType with its owner (resolved to a readable name), its current/target core,
   * its move kind, and its deterministic bucket. Reuses the same plan as Apply, so
   * "who is shown" === "who Apply moves". `hypothetical` previews a not-yet-saved %.
   * Pulled on demand (panel expand), not on every live slider tick.
   */
  async coreRolloutCohort(
    coreType: CoreType,
    flagService: FeatureFlagService,
    hypothetical?: { experimentalCoreId: string; percentage: number },
  ): Promise<RolloutCohortEntry[]> {
    const key = `core.${coreType}`;
    const resolveTarget = (agent: AgentInstance): Promise<string> =>
      flagService
        .resolve(
          key,
          { userId: agent.ownerId, workspaceId: agent.workspaceId ?? undefined },
          hypothetical
            ? { value: hypothetical.experimentalCoreId, percentage: hypothetical.percentage }
            : undefined,
        )
        .then(String);

    const plan = await this.computeRolloutPlan(coreType, resolveTarget);

    // Resolve owner ids → readable names in one query.
    const ownerIds = [...new Set(plan.items.map((i) => i.ownerId).filter(Boolean))] as string[];
    const userDocs = ownerIds.length
      ? await this.db
          .collection<{ userId: string; profile?: { displayName?: string; email?: string } }>('users')
          .find({ userId: { $in: ownerIds } }, { projection: { userId: 1, profile: 1, _id: 0 } })
          .toArray()
      : [];
    const nameById = new Map(
      userDocs.map((u) => [u.userId, u.profile?.displayName || u.profile?.email || u.userId]),
    );

    return plan.items.map((i) => ({
      agentId: i.agentId,
      agentName: i.agentName ?? i.agentId,
      ownerId: i.ownerId ?? null,
      ownerName: i.ownerId ? (nameById.get(i.ownerId) ?? i.ownerId) : '—',
      current: i.current,
      target: i.target,
      kind: i.kind,
      bucket: i.ownerId ? stableBucket(i.ownerId, key) : null,
    }));
  }

  /**
   * Compute (without mutating) which core each agent of `coreType` should run,
   * given a `resolveTarget` resolver. The shared core of `applyCoreRollout` (which
   * executes the plan) and `previewCoreRollout` (which counts it). Only agents
   * currently pointing at a core OF THIS coreType are considered, so an agent
   * deliberately moved (change-core) to another coreType is never disturbed. An
   * agent without an ownerId has no bucketing identity → always `stay`.
   */
  private async computeRolloutPlan(
    coreType: CoreType,
    resolveTarget: (agent: AgentInstance) => Promise<string>,
  ): Promise<RolloutPlan> {
    const governedDocs = await this.agentCores
      .find({ coreType }, { projection: { coreId: 1, _id: 0 } })
      .toArray();
    const governed = governedDocs.map((c) => c.coreId);

    const agents = await this.agents.find({ coreId: { $in: governed } }).toArray();

    const distMap = new Map<string, number>();
    for (const coreId of governed) distMap.set(coreId, 0);
    for (const agent of agents) distMap.set(agent.coreId, (distMap.get(agent.coreId) ?? 0) + 1);

    const items: RolloutPlanItem[] = [];
    for (const agent of agents) {
      const base = {
        agentId: agent.agentId,
        agentName: agent.fullName ?? agent.name ?? agent.agentId,
        ownerId: agent.ownerId,
      };
      if (!agent.ownerId) {
        // No bucketing identity → never migrates (stays on its current core forever).
        items.push({ ...base, current: agent.coreId, target: agent.coreId, kind: 'stay' });
        continue;
      }
      const target = await resolveTarget(agent);
      let kind: RolloutPlanItem['kind'];
      if (target === agent.coreId || !governed.includes(target)) kind = 'stay';
      else if (target === coreType) kind = 'revert';
      else kind = 'migrate';
      items.push({ ...base, current: agent.coreId, target, kind });
    }

    return {
      total: agents.length,
      distribution: [...distMap.entries()].map(([coreId, count]) => ({ coreId, count })),
      items,
    };
  }

  private async privateWorkspaceId(ownerId?: string): Promise<string | undefined> {
    if (!ownerId) return undefined;
    const user = await this.users.findOne(
      { userId: ownerId },
      { projection: { privateWorkspaceId: 1, _id: 0 } },
    );
    return user?.privateWorkspaceId;
  }
}
