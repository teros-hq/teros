/**
 * FeatureFlagService
 *
 * Core backend service for the Feature Flags system.
 *
 * Responsibilities:
 * - Hierarchical flag resolution (user → workspace → company → global)
 * - Override management (create, update, delete)
 * - Default value management (set, reset to registry)
 * - Registry sync at startup (code → DB)
 * - Type validation for all values
 * - Audit logging for all changes
 * - Publishing changes to affected clients
 *
 * Collections:
 * - feature_flags: DB mirror of the code registry
 * - feature_flag_overrides: Scoped overrides
 * - feature_flag_audit_log: Immutable audit trail
 */

import { generateId } from '@teros/core';
import {
  FEATURE_FLAG_KEYS,
  FEATURE_FLAG_REGISTRY,
  getFeatureFlagDefinition,
  getRegistryDefault,
  TARGET_RESOLUTION_ORDER,
  type FeatureFlagDefinition,
  type FeatureFlagTargetType,
  type FeatureFlagValue,
  validateFeatureFlagValue,
} from '@teros/shared';
import type { Collection, Db } from 'mongodb';
import type {
  FeatureFlag,
  FeatureFlagAuditLog,
  FeatureFlagOverride,
} from '../types/database';
import { isInRollout } from './feature-flag-rollout';
import type { PubSubService } from './pubsub-service';
import type { SessionManager } from './session-manager';
import type { WorkspaceService } from './workspace-service';

// ============================================================================
// RESOLUTION RESULT
// ============================================================================

export interface ResolvedFlag {
  value: FeatureFlagValue;
  source:
    | 'default'
    | 'company_override'
    | 'workspace_override'
    | 'user_override'
    | 'rollout';
  type: string;
}

// ============================================================================
// CONTEXT TYPE
// ============================================================================

/**
 * Context for flag resolution.
 * All fields are optional — missing fields skip that level of resolution.
 */
export interface FeatureFlagContext {
  userId?: string;
  workspaceId?: string;
  companyId?: string;
}

// ============================================================================
// SERVICE
// ============================================================================

export class FeatureFlagService {
  private flagsCol: Collection<FeatureFlag>;
  private overridesCol: Collection<FeatureFlagOverride>;
  private auditCol: Collection<FeatureFlagAuditLog>;
  private pubSubService?: PubSubService;
  private sessionManager?: SessionManager;
  private workspaceService?: WorkspaceService;

  constructor(private db: Db) {
    this.flagsCol = db.collection<FeatureFlag>('feature_flags');
    this.overridesCol = db.collection<FeatureFlagOverride>('feature_flag_overrides');
    this.auditCol = db.collection<FeatureFlagAuditLog>('feature_flag_audit_log');
  }

  // ==========================================================================
  // PUBSUB SETTER (late binding to avoid circular deps)
  // ==========================================================================

  setPubSubService(pubSubService: PubSubService): void {
    this.pubSubService = pubSubService;
  }

  setSessionManager(sessionManager: SessionManager): void {
    this.sessionManager = sessionManager;
  }

  setWorkspaceService(workspaceService: WorkspaceService): void {
    this.workspaceService = workspaceService;
  }

  // ==========================================================================
  // INDEXES
  // ==========================================================================

  async ensureIndexes(): Promise<void> {
    // feature_flags indexes
    await this.flagsCol.createIndex({ key: 1 }, { unique: true, name: 'flag_key_unique' });

    // feature_flag_overrides indexes
    await this.overridesCol.createIndex(
      { key: 1, targetType: 1, targetId: 1 },
      { unique: true, name: 'override_unique' },
    );
    await this.overridesCol.createIndex({ key: 1 }, { name: 'override_key_lookup' });
    await this.overridesCol.createIndex(
      { targetType: 1, targetId: 1 },
      { name: 'override_target_lookup' },
    );

    // feature_flag_audit_log indexes
    await this.auditCol.createIndex({ key: 1, timestamp: -1 }, { name: 'audit_key_time' });
    await this.auditCol.createIndex({ actor: 1, timestamp: -1 }, { name: 'audit_actor_time' });
    await this.auditCol.createIndex({ timestamp: -1 }, { name: 'audit_time' });

    console.log('[FeatureFlagService] Indexes ensured');
  }

  // ==========================================================================
  // REGISTRY SYNC
  // ==========================================================================

  /**
   * Sync the code registry to MongoDB.
   * - Create missing flags
   * - Update type/description/category if changed
   * - Does NOT change defaultValue (that is managed via setDefault)
   *
   * Call once at startup.
   */
  async syncRegistry(actor: string = 'system'): Promise<void> {
    const now = new Date().toISOString();
    let created = 0;
    let updated = 0;

    for (const key of FEATURE_FLAG_KEYS) {
      const def = FEATURE_FLAG_REGISTRY[key];
      const existing = await this.flagsCol.findOne({ key });

      if (!existing) {
        // Create new flag from registry
        const flag: FeatureFlag = {
          ...def,
          syncedAt: now,
          updatedAt: now,
        };
        await this.flagsCol.insertOne(flag as any);
        created++;

        // Audit log
        await this.logAudit({
          key,
          action: 'sync_registry',
          actor,
          timestamp: now,
          newValue: def.defaultValue,
          note: 'Created from registry sync',
        });
      } else {
        // Update metadata if changed (type, description, category)
        const needsUpdate =
          existing.type !== def.type ||
          existing.description !== def.description ||
          existing.category !== def.category;

        if (needsUpdate) {
          await this.flagsCol.updateOne(
            { key },
            {
              $set: {
                type: def.type,
                description: def.description,
                category: def.category,
                syncedAt: now,
              },
            },
          );
          updated++;
        } else {
          // Just update syncedAt
          await this.flagsCol.updateOne({ key }, { $set: { syncedAt: now } });
        }
      }
    }

    console.log(
      `[FeatureFlagService] Registry sync complete: ${created} created, ${updated} updated`,
    );
  }

  // ==========================================================================
  // RESOLUTION
  // ==========================================================================

  /**
   * Resolve a single flag value for the given context.
   * Resolution hierarchy (most specific wins):
   *   user → workspace → company → global (feature_flags.defaultValue)
   *
   * `rolloutOverride` lets a caller resolve AS IF the flag had that rollout instead
   * of the persisted one — used by the rollout preview to show the impact of a
   * not-yet-saved percentage. It replaces `flag.rollout` only; exact overrides and
   * the default still apply as usual.
   */
  async resolve(
    key: string,
    context: FeatureFlagContext = {},
    rolloutOverride?: { value: FeatureFlagValue; percentage: number },
  ): Promise<FeatureFlagValue> {
    // Validate flag exists
    const def = getFeatureFlagDefinition(key);
    if (!def) {
      throw new TypeError(`Unknown feature flag: ${key}`);
    }

    // Try overrides in specificity order
    for (const targetType of TARGET_RESOLUTION_ORDER) {
      const targetId = this.getTargetId(context, targetType);
      if (targetId) {
        const override = await this.overridesCol.findOne({ key, targetType, targetId });
        if (override) {
          return override.value;
        }
      }
    }

    const flag = await this.flagsCol.findOne({ key });

    // Percentage rollout — after exact overrides, before the default. The
    // bucket id is the resolution context's userId (for agent-core flags this
    // is the agent's ownerId, passed by the apply action).
    const rollout = rolloutOverride ?? flag?.rollout;
    if (rollout && context.userId && isInRollout(context.userId, key, rollout.percentage)) {
      return rollout.value;
    }

    // Fall back to DB default (which may differ from registry default)
    if (flag) {
      return flag.defaultValue;
    }

    // Ultimate fallback: registry default
    return def.defaultValue;
  }

  /**
   * Resolve all active flags for the given context.
   * Returns a map of key → resolved value.
   */
  async resolveAll(context: FeatureFlagContext = {}): Promise<Record<string, FeatureFlagValue>> {
    const result: Record<string, FeatureFlagValue> = {};

    // Get all flags from DB (or registry if not synced yet)
    const flags = await this.flagsCol.find().toArray();
    const flagMap = new Map<string, FeatureFlag>();
    for (const flag of flags) {
      flagMap.set(flag.key, flag);
    }

    // For each registry flag, resolve its value
    for (const key of FEATURE_FLAG_KEYS) {
      // Try overrides in specificity order
      let resolved: FeatureFlagValue | undefined;

      for (const targetType of TARGET_RESOLUTION_ORDER) {
        const targetId = this.getTargetId(context, targetType);
        if (targetId) {
          const override = await this.overridesCol.findOne({ key, targetType, targetId });
          if (override) {
            resolved = override.value;
            break;
          }
        }
      }

      // Percentage rollout — after exact overrides, before the default (must
      // agree with resolve()/resolveWithSource(), or the same key would resolve
      // differently between featureFlags.get and featureFlags.getAll).
      if (resolved === undefined) {
        const flag = flagMap.get(key);
        if (flag?.rollout && context.userId && isInRollout(context.userId, key, flag.rollout.percentage)) {
          resolved = flag.rollout.value;
        }
      }

      // Fall back to DB default or registry default
      if (resolved === undefined) {
        const flag = flagMap.get(key);
        resolved = flag?.defaultValue ?? getRegistryDefault(key);
      }

      result[key] = resolved;
    }

    return result;
  }

  /**
   * Resolve a single flag value with source metadata for the given context.
   * Returns null if the flag does not exist in the registry.
   */
  async resolveWithSource(
    key: string,
    context: FeatureFlagContext = {},
  ): Promise<ResolvedFlag | null> {
    const def = getFeatureFlagDefinition(key);
    if (!def) {
      return null;
    }

    // Try overrides in specificity order
    for (const targetType of TARGET_RESOLUTION_ORDER) {
      const targetId = this.getTargetId(context, targetType);
      if (targetId) {
        const override = await this.overridesCol.findOne({ key, targetType, targetId });
        if (override) {
          return {
            value: override.value,
            source: `${targetType}_override` as ResolvedFlag['source'],
            type: def.type,
          };
        }
      }
    }

    const flag = await this.flagsCol.findOne({ key });

    // Percentage rollout — after exact overrides, before the default.
    if (flag?.rollout && context.userId && isInRollout(context.userId, key, flag.rollout.percentage)) {
      return {
        value: flag.rollout.value,
        source: 'rollout',
        type: def.type,
      };
    }

    // Fall back to DB default
    const value = flag?.defaultValue ?? def.defaultValue;

    return {
      value,
      source: 'default',
      type: def.type,
    };
  }

  /**
   * Resolve all active flags with source metadata for the given context.
   * Returns a map of key → { value, source, type }.
   */
  async resolveAllWithSource(
    context: FeatureFlagContext = {},
  ): Promise<Record<string, ResolvedFlag>> {
    const result: Record<string, ResolvedFlag> = {};

    const flags = await this.flagsCol.find().toArray();
    const flagMap = new Map<string, FeatureFlag>();
    for (const flag of flags) {
      flagMap.set(flag.key, flag);
    }

    for (const key of FEATURE_FLAG_KEYS) {
      const def = FEATURE_FLAG_REGISTRY[key];
      if (!def) continue;

      let resolved: ResolvedFlag | undefined;

      // Try overrides in specificity order
      for (const targetType of TARGET_RESOLUTION_ORDER) {
        const targetId = this.getTargetId(context, targetType);
        if (targetId) {
          const override = await this.overridesCol.findOne({ key, targetType, targetId });
          if (override) {
            resolved = {
              value: override.value,
              source: `${targetType}_override` as ResolvedFlag['source'],
              type: def.type,
            };
            break;
          }
        }
      }

      // Percentage rollout — after exact overrides, before the default (must
      // agree with resolveWithSource(), or get vs getAll would disagree).
      if (!resolved) {
        const flag = flagMap.get(key);
        if (flag?.rollout && context.userId && isInRollout(context.userId, key, flag.rollout.percentage)) {
          resolved = {
            value: flag.rollout.value,
            source: 'rollout',
            type: def.type,
          };
        }
      }

      // Fall back to DB default or registry default
      if (!resolved) {
        const flag = flagMap.get(key);
        resolved = {
          value: flag?.defaultValue ?? def.defaultValue,
          source: 'default',
          type: def.type,
        };
      }

      result[key] = resolved;
    }

    return result;
  }

  // ==========================================================================
  // DEFAULT VALUE MANAGEMENT
  // ==========================================================================

  /**
   * Change the default value for a flag.
   * This changes the DB default, not the registry default.
   */
  async setDefault(
    key: string,
    value: FeatureFlagValue,
    actor: string = 'system',
    note?: string,
  ): Promise<void> {
    // Validate type
    validateFeatureFlagValue(key, value);

    const flag = await this.flagsCol.findOne({ key });
    if (!flag) {
      throw new TypeError(`Feature flag "${key}" not found in DB. Run syncRegistry() first.`);
    }

    const previousValue = flag.defaultValue;
    const now = new Date().toISOString();

    await this.flagsCol.updateOne(
      { key },
      { $set: { defaultValue: value, updatedAt: now } },
    );

    // Audit log
    await this.logAudit({
      key,
      action: 'set_default',
      actor,
      timestamp: now,
      previousValue,
      newValue: value,
      note,
    });

    // Publish change
    await this.publishChanges([key]);
  }

  /**
   * Reset a flag's default value to the code-defined registry default.
   */
  async resetToRegistryDefault(
    key: string,
    actor: string = 'system',
    note?: string,
  ): Promise<void> {
    const registryDefault = getRegistryDefault(key);
    const flag = await this.flagsCol.findOne({ key });

    if (!flag) {
      throw new TypeError(`Feature flag "${key}" not found in DB. Run syncRegistry() first.`);
    }

    const previousValue = flag.defaultValue;
    const now = new Date().toISOString();

    await this.flagsCol.updateOne(
      { key },
      { $set: { defaultValue: registryDefault, updatedAt: now } },
    );

    // Audit log
    await this.logAudit({
      key,
      action: 'reset_default',
      actor,
      timestamp: now,
      previousValue,
      newValue: registryDefault,
      note: note ?? 'Reset to registry default',
    });

    // Publish change
    await this.publishChanges([key]);
  }

  // ==========================================================================
  // ROLLOUT MANAGEMENT
  // ==========================================================================

  /**
   * Set (or update) the percentage rollout for a flag: `value` is served to ids
   * whose deterministic bucket falls in [0, percentage). Generic over flag type
   * — callers that need value-specific validation (e.g. that a core-flag value
   * is a real, active coreId) must do it before calling this.
   */
  async setRollout(
    key: string,
    value: FeatureFlagValue,
    percentage: number,
    actor: string = 'system',
    note?: string,
  ): Promise<void> {
    const def = getFeatureFlagDefinition(key);
    if (!def) {
      throw new TypeError(`Unknown feature flag: ${key}`);
    }
    validateFeatureFlagValue(key, value);
    if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) {
      throw new TypeError(`Rollout percentage must be an integer in [0, 100], got ${percentage}`);
    }

    const flag = await this.flagsCol.findOne({ key });
    if (!flag) {
      throw new TypeError(`Feature flag "${key}" not found in DB. Run syncRegistry() first.`);
    }

    const previousValue = flag.rollout?.value;
    const now = new Date().toISOString();

    await this.flagsCol.updateOne(
      { key },
      { $set: { rollout: { value, percentage }, updatedAt: now } },
    );

    await this.logAudit({
      key,
      action: 'set_rollout',
      actor,
      timestamp: now,
      previousValue,
      newValue: value,
      note: note ?? `percentage=${percentage}`,
    });

    await this.publishChanges([key]);
  }

  /** Remove the rollout from a flag (turns it off and drops the config). */
  async clearRollout(key: string, actor: string = 'system'): Promise<void> {
    const flag = await this.flagsCol.findOne({ key });
    if (!flag) {
      throw new TypeError(`Feature flag "${key}" not found in DB. Run syncRegistry() first.`);
    }

    const previousValue = flag.rollout?.value;
    const now = new Date().toISOString();

    await this.flagsCol.updateOne(
      { key },
      { $unset: { rollout: '' }, $set: { updatedAt: now } },
    );

    await this.logAudit({
      key,
      action: 'clear_rollout',
      actor,
      timestamp: now,
      previousValue,
    });

    await this.publishChanges([key]);
  }

  // ==========================================================================
  // OVERRIDE MANAGEMENT
  // ==========================================================================

  /**
   * Create or update an override for a flag.
   * Validates that the value matches the flag's type.
   */
  async setOverride(
    key: string,
    targetType: FeatureFlagTargetType,
    targetId: string,
    value: FeatureFlagValue,
    actor: string = 'system',
    note?: string,
  ): Promise<void> {
    // Validate flag exists
    const def = getFeatureFlagDefinition(key);
    if (!def) {
      throw new TypeError(`Unknown feature flag: ${key}`);
    }

    // Validate value type
    validateFeatureFlagValue(key, value);

    const now = new Date().toISOString();

    // Check if override already exists
    const existing = await this.overridesCol.findOne({ key, targetType, targetId });
    const previousValue = existing?.value;

    const override: FeatureFlagOverride = {
      key,
      targetType,
      targetId,
      value,
      note,
      createdBy: actor,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.overridesCol.replaceOne({ key, targetType, targetId }, override as any, {
      upsert: true,
    });

    // Audit log
    await this.logAudit({
      key,
      action: 'set_override',
      actor,
      timestamp: now,
      previousValue,
      newValue: value,
      targetType,
      targetId,
      note,
    });

    // Publish change
    await this.publishChanges([key]);
  }

  /**
   * Hard delete an override.
   */
  async deleteOverride(
    key: string,
    targetType: FeatureFlagTargetType,
    targetId: string,
    actor: string = 'system',
  ): Promise<void> {
    const existing = await this.overridesCol.findOne({ key, targetType, targetId });
    if (!existing) {
      throw new Error(
        `Override not found: ${key} for ${targetType}=${targetId}`,
      );
    }

    const previousValue = existing.value;
    const now = new Date().toISOString();

    await this.overridesCol.deleteOne({ key, targetType, targetId });

    // Audit log
    await this.logAudit({
      key,
      action: 'delete_override',
      actor,
      timestamp: now,
      previousValue,
      targetType,
      targetId,
    });

    // Publish change
    await this.publishChanges([key]);
  }

  /**
   * List all overrides for a flag.
   */
  async listOverrides(key: string): Promise<FeatureFlagOverride[]> {
    return this.overridesCol.find({ key }).sort({ targetType: 1, targetId: 1 }).toArray();
  }

  /**
   * List all overrides for a target.
   */
  async listOverridesForTarget(
    targetType: FeatureFlagTargetType,
    targetId: string,
  ): Promise<FeatureFlagOverride[]> {
    return this.overridesCol
      .find({ targetType, targetId })
      .sort({ key: 1 })
      .toArray();
  }

  /**
   * Get all overrides across all flags (lightweight projection).
   * Used by the list handler to compute override counts per flag.
   */
  async getOverridesForAllFlags(): Promise<Array<{ key: string }>> {
    return this.overridesCol
      .find({}, { projection: { _id: 0, key: 1 } })
      .toArray() as Promise<Array<{ key: string }>>;
  }

  // ==========================================================================
  // AUDIT LOG
  // ==========================================================================

  private async logAudit(entry: Omit<FeatureFlagAuditLog, 'auditId'>): Promise<void> {
    const auditEntry: FeatureFlagAuditLog = {
      ...entry,
      auditId: generateId('ff_audit'),
    };
    await this.auditCol.insertOne(auditEntry as any);
  }

  /**
   * Record a rollout APPLY (re-point + reprovision of agents). Apply is not a flag
   * mutation, so set_/clear_rollout don't capture it; this gives the audit timeline a
   * "last applied: when / who / result" entry. Counts go in `note`.
   */
  async recordRolloutApply(
    key: string,
    actor: string,
    summary: { migrated: number; reverted: number; unchanged: number; total: number },
  ): Promise<void> {
    await this.logAudit({
      key,
      action: 'apply_rollout',
      actor,
      timestamp: new Date().toISOString(),
      note: `migrated=${summary.migrated} reverted=${summary.reverted} unchanged=${summary.unchanged} total=${summary.total}`,
    });
  }

  /**
   * Get audit log entries for a flag.
   */
  async getAuditLog(
    key: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<FeatureFlagAuditLog[]> {
    return this.auditCol
      .find({ key })
      .sort({ timestamp: -1 })
      .skip(options.offset ?? 0)
      .limit(options.limit ?? 50)
      .toArray();
  }

  // ==========================================================================
  // PUBLISHING
  // ==========================================================================

  /**
   * Publish changes to affected clients.
   *
   * Efficiently calculates which connected clients are affected by the changed
   * keys and pushes `featureFlags.changed` events directly to their WebSockets.
   *
   * A client is affected if:
   * - A default changed (all clients are affected)
   * - An override changed for their userId, workspaceId, or companyId
   */
  async publishChanges(changedKeys: string[]): Promise<void> {
    if (changedKeys.length === 0) {
      return;
    }

    // Collect affected target IDs for each changed key
    const affectedUserIds = new Set<string>();
    const affectedWorkspaceIds = new Set<string>();
    const hasDefaultChange = true; // default changes affect everyone

    const overrides = await this.overridesCol
      .find({ key: { $in: changedKeys } })
      .toArray();

    for (const o of overrides) {
      if (o.targetType === 'user') affectedUserIds.add(o.targetId);
      if (o.targetType === 'workspace') affectedWorkspaceIds.add(o.targetId);
      // company-level overrides: no companyId in session yet, so we
      // can't efficiently target them — they fall through to default
    }

    // Build a map of affected keys per context for precise filtering
    const affectedKeys = new Set(changedKeys);

    // Get all active sessions
    const sessions = this.sessionManager?.getAllActiveSessions() ?? [];
    if (sessions.length === 0) {
      console.log(`[FeatureFlagService] No active sessions to notify for keys: ${changedKeys.join(', ')}`);
      return;
    }

    // Resolve current flag values for affected contexts
    const pushPromises: Promise<void>[] = [];

    for (const session of sessions) {
      // Every client gets notified for default changes. For override changes,
      // only notify if the client's context matches an affected target.
      // For simplicity and correctness, we re-resolve all changed keys for
      // every client and let them compare against their cached values.
      //
      // The context MUST include the workspace — resolving with only the
      // userId makes workspace overrides invisible in the push: the client
      // would receive the stale default right after an admin enabled the
      // flag for their workspace (TER-460). Same criterion as the
      // featureFlags.get handler: the user's first workspace.
      const workspaces = this.workspaceService
        ? await this.workspaceService.listUserWorkspaces(session.userId)
        : [];
      const context: FeatureFlagContext = {
        userId: session.userId,
        workspaceId: workspaces[0]?.workspaceId,
      };

      const changes: Array<{ flagKey: string; value: unknown; source: string; type: string }> = [];

      for (const key of changedKeys) {
        const resolved = await this.resolveWithSource(key, context);
        if (resolved) {
          changes.push({
            flagKey: key,
            value: resolved.value,
            source: resolved.source,
            type: resolved.type,
          });
        }
      }

      if (changes.length > 0) {
        const event = {
          type: 'event' as const,
          event: 'featureFlags.changed',
          data: { changes },
        };

        pushPromises.push(
          new Promise<void>((resolve) => {
            try {
              if (session.ws.readyState === 1) {
                session.ws.send(JSON.stringify(event));
              }
            } catch {
              // Ignore send errors on closed sockets
            }
            resolve();
          }),
        );
      }
    }

    await Promise.all(pushPromises);

    console.log(
      `[FeatureFlagService] Pushed changes to ${pushPromises.length} session(s) for keys: ${changedKeys.join(', ')}`,
    );
  }

  // ==========================================================================
  // LISTING
  // ==========================================================================

  /**
   * List all flags with their current DB defaults.
   */
  async listFlags(): Promise<FeatureFlag[]> {
    return this.flagsCol.find().sort({ key: 1 }).toArray();
  }

  /**
   * Get a single flag definition from DB.
   */
  async getFlag(key: string): Promise<FeatureFlag | null> {
    return this.flagsCol.findOne({ key });
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  private getTargetId(
    context: FeatureFlagContext,
    targetType: FeatureFlagTargetType,
  ): string | undefined {
    switch (targetType) {
      case 'user':
        return context.userId;
      case 'workspace':
        return context.workspaceId;
      case 'company':
        return context.companyId;
      default:
        return undefined;
    }
  }
}
