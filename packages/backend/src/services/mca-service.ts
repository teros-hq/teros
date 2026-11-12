/**
 * MCA Service
 *
 * Manages MCP/MCA (Model Context Apps) catalog, installations, and access.
 *
 * Resolves:
 * - Available MCAs in catalog
 * - User-installed apps (MCA instances with config)
 * - Agent access to apps
 *
 * ## Credentials Architecture
 *
 * There are TWO types of credentials for MCAs:
 *
 * ### 1. Secrets (system-level, generic)
 * - **Source**: Filesystem at `.secrets/mcas/<mcaId>/credentials.json`
 * - **Examples**: API keys (Perplexity, OpenAI), OAuth client IDs/secrets
 * - **Scope**: Shared across all users/apps using this MCA
 * - **NOT stored in DB** - loaded at runtime from SecretsManager
 * - Injected as `SECRET_MCA_<KEY>` environment variables
 *
 * ### 2. User secrets (user-level, personal)
 * - **Source**: Database in `user_credentials` collection (encrypted)
 * - **Examples**: User's OAuth access/refresh tokens, personal API keys
 * - **Scope**: Specific to one user's app instance
 * - Stored in DB because it's user-specific and may be updated (token refresh)
 * - Injected as `SECRET_USER_<KEY>` environment variables
 *
 * This separation allows:
 * - System secrets to be managed via git-ignored files (secure, not in DB)
 * - User credentials to be stored per-user in DB (personalized access)
 * - Same MCA to work with system API key OR user's personal credentials
 */

import { generateAppId } from '@teros/core';
import { COLLECTIONS, ensureCollectionIndexes } from '../db';
import { type McaToolAnnotations, McaToolAnnotationsSchema } from '@teros/shared';
import { readFileSync } from 'fs';
import * as fs from 'fs/promises';
import type { Db } from 'mongodb';
import * as path from 'path';
import type { AuthManager } from '../auth/auth-manager';
import { config } from '../config';
import type { SecretsManager } from '../secrets/secrets-manager';
import { createInstallPermissions, installSeedPermission, isPrivateTool } from '../types/permissions';
import { AgentMailboxService } from './agent-mailbox-service';
import type {
  AgentAppAccess,
  AgentInstance,
  AgentMailbox,
  AgentApps,
  AppViewer,
  App,
  AppToolPermissions,
  McpCatalogEntry,
  ResolvedApp,
  ToolPermission,
} from '../types/database';
import type { VolumeService } from './volume-service';
import type { WorkspaceService } from './workspace-service';

/**
 * MCA configuration ready for MCP execution
 */
export interface McaExecutionConfig {
  mcaId: string;
  appId: string;
  name: string;
  execution: McpCatalogEntry['execution'];
  /**
   * System-level secrets (API keys, OAuth client credentials)
   * Loaded from filesystem: .secrets/mcas/<mcaId>/credentials.json
   * Injected as SECRET_MCA_<KEY> env vars
   */
  secrets?: Record<string, any>;
  /**
   * User-level secrets (personal OAuth tokens, user API keys)
   * Loaded from DB: user_credentials collection (encrypted)
   * Injected as SECRET_USER_<KEY> env vars
   */
  auth?: Record<string, any>;
  /** @deprecated Use permissions instead */
  allowedTools?: string[];
  /**
   * Tool-level permissions (allow/ask/forbid per tool)
   * If undefined, all tools default to 'ask'
   */
  permissions?: AppToolPermissions;
}

export class McaService {
  private mcaCatalogCollection;
  private appsCollection;
  private accessCollection;
  private onToolCacheInvalidate?: (agentId: string) => Promise<void>;
  private secretsManager?: SecretsManager;
  private authManager?: AuthManager;
  private workspaceService?: WorkspaceService;
  private volumeService?: VolumeService;

  // Cache for ensureProvisionedApps: `${agentId}:${workspaceId ?? 'global'}` → timestamp of last run.
  // Keyed by agent+workspace so a superagent active in workspace A doesn't skip provisioning
  // when it opens a channel in a fresh workspace B within the TTL window.
  private ensureProvisionedAppsCache = new Map<string, number>();
  private readonly ENSURE_PROVISIONED_APPS_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    private db: Db,
    options?: {
      onToolCacheInvalidate?: (agentId: string) => Promise<void>;
      secretsManager?: SecretsManager;
      authManager?: AuthManager;
      workspaceService?: WorkspaceService;
      volumeService?: VolumeService;
    },
  ) {
    this.mcaCatalogCollection = db.collection<McpCatalogEntry>('mca_catalog');
    this.appsCollection = db.collection<App>('apps');
    this.accessCollection = db.collection<AgentAppAccess>('agent_app_access');
    this.onToolCacheInvalidate = options?.onToolCacheInvalidate;
    this.secretsManager = options?.secretsManager;
    this.authManager = options?.authManager;
    this.workspaceService = options?.workspaceService;
    this.volumeService = options?.volumeService;
  }

  // ==========================================================================
  // MUW v2.2 — app ownership, visibility and the per-conversation rule.
  // Data is complete by migration 20261102_002: `scope` and `installedBy` are
  // required and never defaulted here.
  // ==========================================================================

  /** Is `userId` the owner of this app (the member who installed it)? @spec MUW-REQ-10 */
  isAppOwner(app: Pick<App, 'installedBy'>, userId: string): boolean {
    return app.installedBy === userId;
  }

  /** Shared apps are visible to every member; personal apps only to their owner. @spec MUW-REQ-13 */
  isAppVisibleTo(app: Pick<App, 'scope' | 'installedBy'>, userId: string): boolean {
    return app.scope === 'shared' || app.installedBy === userId;
  }

  /**
   * Who may rename, uninstall, reconfigure credentials or permissions of an
   * app: its owner, or an owner/admin of the workspace. (The scope itself is
   * owner-only — see setAppScope.)
   * @spec MUW-REQ-13
   */
  async canManageApp(app: Pick<App, 'ownerId' | 'installedBy'>, userId: string): Promise<boolean> {
    if (this.isAppOwner(app, userId)) return true;
    return (await this.workspaceService?.canAdmin(app.ownerId, userId)) === true;
  }

  /**
   * The viewer of a conversation for app resolution: its creator and its scope.
   * @spec MUW-REQ-12
   */
  async getChannelViewer(channelId: string): Promise<AppViewer | null> {
    const channel = await this.db
      .collection('channels')
      .findOne({ channelId }, { projection: { userId: 1, scope: 1 } });
    if (!channel?.userId) return null;
    return { userId: channel.userId as string, channelScope: (channel.scope as 'personal' | 'shared') ?? 'personal' };
  }

  /**
   * The critical rule (MUW-REQ-12), in one place for the tool list and both
   * execution gates: in a shared conversation only shared apps; in a personal
   * conversation shared apps plus the creator's own personal apps.
   * @spec MUW-REQ-12
   */
  isAppUsableBy(app: Pick<App, 'scope' | 'installedBy'>, viewer: AppViewer): boolean {
    if (app.scope === 'shared') return true;
    if (app.scope !== 'personal') return false; // data integrity: an unknown scope never runs
    if (viewer.channelScope === 'shared') return false;
    return app.installedBy === viewer.userId;
  }

  /** Convenience for the execution gates: resolve the conversation and apply isAppUsableBy. @spec MUW-REQ-12 */
  async isAppBlockedInChannel(app: Pick<App, 'scope' | 'installedBy'>, channelId: string): Promise<boolean> {
    const viewer = await this.getChannelViewer(channelId);
    if (!viewer) return app.scope !== 'shared';
    return !this.isAppUsableBy(app, viewer);
  }

  /**
   * Set workspace service (for late binding to avoid circular deps)
   */
  setWorkspaceService(workspaceService: WorkspaceService): void {
    this.workspaceService = workspaceService;
  }

  /**
   * Set volume service (for late binding to avoid circular deps)
   */
  setVolumeService(volumeService: VolumeService): void {
    this.volumeService = volumeService;
  }

  /**
   * Set tool cache invalidation callback (late binding — the callback
   * depends on MessageHandler which is created before this service is
   * wired to the WebSocket layer).
   */
  setOnToolCacheInvalidate(cb: (agentId: string) => Promise<void>): void {
    this.onToolCacheInvalidate = cb;
  }

  // ============================================================================
  // INDEXES
  // ============================================================================

  /**
   * Ensure database indexes exist
   */
  async ensureIndexes(): Promise<void> {
    // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
    // ensureAllIndexes after migrations. Kept for tests and scripts.
    await ensureCollectionIndexes(this.appsCollection, COLLECTIONS.apps);
    await ensureCollectionIndexes(this.mcaCatalogCollection, COLLECTIONS.mcaCatalog);
    await ensureCollectionIndexes(this.accessCollection, COLLECTIONS.agentAppAccess);
  }

  // ============================================================================
  // MCP CATALOG
  // ============================================================================

  /**
   * List all MCAs in catalog
   */
  async listCatalog(status?: McpCatalogEntry['status']): Promise<McpCatalogEntry[]> {
    const filter = status ? { status } : {};
    return this.mcaCatalogCollection.find(filter).toArray();
  }

  /**
   * Get MCA from catalog by ID
   */
  async getMcaFromCatalog(mcaId: string): Promise<McpCatalogEntry | null> {
    return this.mcaCatalogCollection.findOne({ mcaId });
  }

  /**
   * Update MCA availability settings in catalog AND manifest.json
   */
  async updateMcaAvailability(
    mcaId: string,
    updates: {
      enabled?: boolean;
      hidden?: boolean;
      system?: boolean;
      role?: 'user' | 'admin' | 'super';
    },
  ): Promise<McpCatalogEntry | null> {
    // Build the update object with dot notation for nested fields
    const updateFields: Record<string, any> = {};

    if (updates.enabled !== undefined) {
      updateFields['availability.enabled'] = updates.enabled;
    }
    if (updates.hidden !== undefined) {
      updateFields['availability.hidden'] = updates.hidden;
    }
    if (updates.system !== undefined) {
      updateFields['availability.system'] = updates.system;
    }
    if (updates.role !== undefined) {
      updateFields['availability.role'] = updates.role;
    }

    if (Object.keys(updateFields).length === 0) {
      // No updates, just return current
      return this.getMcaFromCatalog(mcaId);
    }

    // Update database
    const result = await this.mcaCatalogCollection.findOneAndUpdate(
      { mcaId },
      { $set: updateFields },
      { returnDocument: 'after' },
    );

    if (!result) {
      return null;
    }

    // Update manifest.json file
    try {
      await this.updateManifestFile(mcaId, updates);
      console.log(`✅ Updated manifest.json for ${mcaId}`);
    } catch (error) {
      console.error(`❌ Failed to update manifest.json for ${mcaId}:`, error);
      // Continue - database is already updated
    }

    return result;
  }

  /**
   * Update the manifest.json file for an MCA
   */
  private async updateManifestFile(
    mcaId: string,
    updates: {
      enabled?: boolean;
      hidden?: boolean;
      system?: boolean;
      role?: 'user' | 'admin' | 'super';
    },
  ): Promise<void> {
    // Construct path to manifest.json
    // mcaId format: mca.teros.bash -> mcas/mca.teros.bash/manifest.json
    // Backend runs from packages/backend, so we need to go up to project root
    const projectRoot = path.join(process.cwd(), '..', '..');
    const mcasDir = path.join(projectRoot, 'mcas');
    const manifestPath = path.join(mcasDir, mcaId, 'manifest.json');

    // Read current manifest
    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent);

    // Update availability section
    if (!manifest.availability) {
      manifest.availability = {};
    }

    if (updates.enabled !== undefined) {
      manifest.availability.enabled = updates.enabled;
    }
    if (updates.hidden !== undefined) {
      manifest.availability.hidden = updates.hidden;
    }
    if (updates.system !== undefined) {
      manifest.availability.system = updates.system;
    }
    if (updates.role !== undefined) {
      manifest.availability.role = updates.role;
    }

    // Write back with pretty formatting
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  }

  // ============================================================================
  // APPS (Installed MCA instances)
  // ============================================================================

  /**
   * Get app by ID
   */
  async getApp(appId: string): Promise<App | null> {
    return this.appsCollection.findOne({ appId });
  }

  /**
   * Get app by mcaId and ownerId (used to detect duplicates before install)
   */
  async getAppByMcaIdAndOwner(mcaId: string, ownerId: string): Promise<App | null> {
    return this.appsCollection.findOne({ mcaId, ownerId, status: 'active' });
  }

  /**
   * Get resolved app (with MCA catalog data)
   */
  async getResolvedApp(appId: string): Promise<ResolvedApp | null> {
    const app = await this.getApp(appId);
    if (!app) return null;

    const mca = await this.getMcaFromCatalog(app.mcaId);
    if (!mca) {
      console.error(`[McaService] MCA ${app.mcaId} not found for app ${appId}`);
      return null;
    }

    const { mcaId, ...appWithoutMcaId } = app;
    return {
      ...appWithoutMcaId,
      mca,
    };
  }

  /**
   * List apps by owner
   * @param ownerId - User ID or Workspace ID
   * @param ownerType - Optional filter by owner type
   */
  async listAppsByOwner(ownerId: string, ownerType?: 'workspace'): Promise<App[]> {
    const filter: any = { ownerId, status: 'active' };
    if (ownerType) {
      filter.ownerType = ownerType;
    }
    return this.appsCollection.find(filter).toArray();
  }

  /**
   * List every installed app of one MCA (any owner, any status except
   * 'disabled'). Used by McaBootSync to recycle the containers of an MCA
   * whose tools changed: each app of an http/per-app MCA has its own
   * container keyed by appId.
   */
  async listAppsByMca(mcaId: string): Promise<App[]> {
    return this.appsCollection
      .find({ mcaId, status: { $ne: 'disabled' } })
      .toArray();
  }

  /**
   * List apps by workspace
   */
  async listWorkspaceApps(workspaceId: string): Promise<App[]> {
    return this.appsCollection
      .find({
        ownerId: workspaceId,
        ownerType: 'workspace',
        status: 'active',
      })
      .toArray();
  }

  /**
   * Helper: Resolve volume mounts for an app based on owner type
   * Returns volumes array or undefined if no volume is configured
   */
  private async resolveAppVolumes(
    ownerId: string,
    ownerType: 'workspace',
    mountPath: string = '/workspace',
    readOnly: boolean = false,
  ): Promise<App['volumes']> {
    if (!this.volumeService) {
      return undefined;
    }

    if (ownerType !== 'workspace') {
      throw new Error(`Unsupported ownerType: ${ownerType}. Only 'workspace' is supported.`);
    }

    try {
      // Get workspace volume
      if (!this.workspaceService) {
        return undefined;
      }

      const workspace = await this.workspaceService.getWorkspace(ownerId);
      if (!workspace?.volumeId) {
        console.warn(`[McaService] Workspace ${ownerId} has no volume configured`);
        return undefined;
      }

      return [
        {
          volumeId: workspace.volumeId,
          mountPath,
          readOnly,
        },
      ];
    } catch (error) {
      console.error(`[McaService] Failed to resolve volume for workspace ${ownerId}:`, error);
      return undefined;
    }
  }

  /**
   * Create a new app (install MCA)
   *
   * In the unified workspace model, ownerType is always 'workspace'.
   *
   * For containerized MCAs (per-app mode), automatically configures the owner's
   * volume mount using the resolved volumeId from the database.
   */
  async createApp(app: Omit<App, 'createdAt' | 'updatedAt'>): Promise<App> {
    // Validate app name format
    const nameValidation = this.validateAppName(app.name);
    if (!nameValidation.valid) {
      throw new Error(`Invalid app name "${app.name}": ${nameValidation.error}`);
    }

    // Validate MCA exists
    const mca = await this.getMcaFromCatalog(app.mcaId);
    if (!mca) {
      throw new Error(`MCA ${app.mcaId} not found in catalog`);
    }

    // Build volume mounts - automatically resolve from workspace owner
    let volumes: App['volumes'] = app.volumes;
    const ownerType = app.ownerType || 'workspace';

    // Resolve workspace storage only for MCAs whose manifest declares local
    // workspace or app-data access. Spawn also filters legacy stored workspace
    // mounts unless the current manifest opts in.
    const needsWorkspaceVolume = mca.runtime?.workspaceMount === true ||
      mca.runtime?.appDataMount === true;
    if (!volumes?.length && needsWorkspaceVolume) {
      volumes = await this.resolveAppVolumes(app.ownerId, ownerType);
      if (volumes?.length) {
        console.log(
          `[McaService] Auto-configured volume for ${ownerType} ${app.ownerId}: ${volumes[0].volumeId}`,
        );
      }
    }

    // Note: secrets are NOT stored in DB - they come from .secrets/ filesystem
    // Only auth (user-specific credentials) is stored in DB
    const now = new Date().toISOString();
    const newApp: App = {
      ...app,
      ownerType,
      volumes: volumes?.length ? volumes : undefined,
      // Seed explicit per-tool permissions from the manifest annotations
      // (allow for read-only, ask for mutations) unless the caller already
      // decided them. Permissions are pure data from here on — no runtime
      // policy upgrades anything.
      permissions: app.permissions ?? createInstallPermissions(this.loadStaticToolDefs(app.mcaId)),
      // Core platform tools (messages, tasks, agent management) are used on
      // nearly every turn — pin them out of the tool-execution proxy so they
      // stay individually listed and skip the discovery round-trip.
      // Migration 20260704_003 applies the same pin to existing installs.
      toolExposure: app.toolExposure ?? (app.mcaId === 'mca.teros.core' ? 'direct' : undefined),
      createdAt: now,
      updatedAt: now,
    };

    await this.appsCollection.insertOne(newApp);
    return newApp;
  }

  /**
   * Read the MCA's static tools.json (name + annotations) for the install
   * permission seed. Best-effort: a missing or malformed file returns [] and
   * the seed degrades to `defaultPermission: 'ask'` for every tool —
   * conservative, never blocks the install. Every degradation LOGS (warn for
   * a legitimately absent file, error for anything else) so a wrong
   * MCA_BASE_PATH or a broken manifest can never hide behind the fallback.
   */
  private loadStaticToolDefs(mcaId: string): Array<{ name: string; annotations?: McaToolAnnotations }> {
    const toolsPath = path.join(config.mca.basePath, mcaId, 'tools.json');
    try {
      const content = readFileSync(toolsPath, 'utf-8');
      const parsed = JSON.parse(content) as {
        tools?: Array<{ name: string; annotations?: unknown }>;
      };
      if (!Array.isArray(parsed.tools)) {
        console.warn(
          `[McaService] loadStaticToolDefs: ${toolsPath} has no tools array — permission seed degrades to all-'ask' for ${mcaId}`,
        );
        return [];
      }
      return parsed.tools.map((t) => {
        const result = t.annotations ? McaToolAnnotationsSchema.safeParse(t.annotations) : null;
        if (t.annotations && !result?.success) {
          console.warn(
            `[McaService] loadStaticToolDefs: invalid annotations on tool '${t.name}' (${mcaId}) — seeded as mutation ('ask')`,
          );
        }
        return { name: t.name, annotations: result?.success ? result.data : undefined };
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        console.warn(
          `[McaService] loadStaticToolDefs: no tools.json at ${toolsPath} — permission seed degrades to all-'ask' for ${mcaId}`,
        );
      } else {
        console.error(`[McaService] loadStaticToolDefs: failed to load ${toolsPath} for ${mcaId}:`, err);
      }
      return [];
    }
  }

  /**
   * SEC-1 (TER-720 / B-4): single source of truth for "may this actor install
   * this MCA?". Enforces `availability.enabled` and the role hierarchy
   * ({ user, admin, super }). Every path that installs an MCA must call this so
   * the gate cannot drift onto one path only — the exact "authz enforced on one
   * layer, not the other" class of the scheduler cross-user incident.
   * Throws a plain Error on denial (callers map it to their layer's error).
   */
  async assertInstallable(
    mca: { availability?: { enabled?: boolean; role?: string } },
    actorUserId: string,
  ): Promise<void> {
    if (mca.availability?.enabled === false) {
      throw new Error('MCA is not available');
    }
    const requiredRole = mca.availability?.role || 'user';
    if (requiredRole === 'user') return;

    const user = await this.getUserRole(actorUserId);
    const userRole = user?.role || 'user';
    const roleHierarchy: Record<string, number> = { user: 0, admin: 1, super: 2 };
    const userLevel = roleHierarchy[userRole] ?? 0;
    const requiredLevel = roleHierarchy[requiredRole] ?? 0;
    if (userLevel < requiredLevel) {
      throw new Error(`This MCA requires ${requiredRole} role. You have ${userRole} role.`);
    }
  }

  /**
   * SEC-1 (TER-720 / A1): authorization for app.grant-access / app.revoke-access.
   *
   * Cross-tenant closure (the BOLA fix): the caller must be a member of the
   * app's workspace — a foreign tenant is not a member and is denied here.
   *
   * Agent side: the caller may manage access for any agent the AppWindow offers
   * — the workspace's own agents plus the caller's or workspace owner's
   * superagents — i.e. the SAME roster `app.list-agent-access` renders. An
   * owner-only check here (`agent.ownerId === userId`) diverged from that roster
   * and denied managing access for shared-workspace agents the UI actively
   * offers a toggle for (R1). The membership check above is what closes the
   * cross-tenant BOLA, so widening the agent side does not reopen A1.
   */
  async canManageAppAccess(userId: string, agentId: string, appId: string): Promise<boolean> {
    const app = await this.getApp(appId);
    if (!app || !this.workspaceService) return false;

    // Apps are workspace-scoped; list-agent-access renders an empty roster
    // otherwise, so there is nothing to manage.
    if (app.ownerType !== 'workspace') return false;
    const workspaceId = app.ownerId;

    // Membership closes the cross-tenant BOLA.
    if (!(await this.workspaceService.canAccess(workspaceId, userId))) return false;
    // MUW-REQ-13: a private app is only granted/revoked by its owner.
    if (!this.isAppVisibleTo(app, userId)) return false;
    if (app.scope === 'personal' && !this.isAppOwner(app, userId)) return false;

    // The agent must be in this app's workspace roster — the predicate is kept
    // identical to app.list-agent-access (workspace agents + caller/owner
    // superagents) so the gate can never drift from what the UI offers.
    const workspace = await this.db
      .collection('workspaces')
      .findOne({ workspaceId }, { projection: { ownerId: 1, _id: 0 } });
    const workspaceOwnerId = (workspace?.ownerId as string | undefined) ?? undefined;
    const superagentOwnerIds = Array.from(
      new Set([userId, workspaceOwnerId].filter(Boolean) as string[]),
    );
    const agent = await this.db.collection('agents').findOne({
      agentId,
      $or: [
        { workspaceId },
        { ownerId: { $in: superagentOwnerIds }, workspaceId: { $in: [null, undefined] } },
      ],
    });
    return Boolean(agent);
  }

  /**
   * Create an app for a workspace
   * Automatically mounts the workspace's volume
   */
  async createWorkspaceApp(
    workspaceId: string,
    mcaId: string,
    name: string,
    userId: string,
    options?: {
      mountPath?: string;
      readOnly?: boolean;
    },
  ): Promise<App> {
    if (!this.workspaceService) {
      throw new Error('WorkspaceService not configured');
    }

    // Verify user has write access to workspace
    if (!(await this.workspaceService.canWrite(workspaceId, userId))) {
      throw new Error('Permission denied: cannot install apps in this workspace');
    }

    // Get workspace to find its volume
    const workspace = await this.workspaceService.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    // Ensure workspace has a volume configured
    if (!workspace.volumeId) {
      throw new Error(
        `Workspace ${workspaceId} has no volume configured. This is a data integrity issue - the workspace was created without a volume.`,
      );
    }

    // Validate MCA exists
    const mca = await this.getMcaFromCatalog(mcaId);
    if (!mca) {
      throw new Error(`MCA ${mcaId} not found in catalog`);
    }

    // SEC-1 (TER-720 / B-4): enforce the availability gate on THIS install path
    // too. `app.install` checks `availability.enabled`/`role`, but this parallel
    // path (workspace.install-app, workspace-commands) only checked workspace
    // write access — so any user could install a disabled/admin-only MCA
    // (e.g. an admin-only host-exec MCA)
    // into their own workspace and reach host root. Gating here closes both
    // callers at once.
    await this.assertInstallable(mca, userId);

    // Single-install MCAs (availability.multi=false) may have only one instance
    // per workspace — block a second install (TER-528). Multi MCAs (e.g. Gmail
    // with several accounts) are exempt.
    if (!mca.availability?.multi) {
      const existing = await this.appsCollection.findOne({
        ownerId: workspaceId,
        ownerType: 'workspace',
        mcaId,
        status: 'active',
      });
      if (existing) {
        throw new Error(`MCA ${mcaId} is already installed in this workspace`);
      }
    }

    // Generate app ID and validate name
    const appId = generateAppId();
    const appName = name || (await this.generateDefaultAppName(mcaId, workspaceId, { scope: 'personal', installedBy: userId }));

    const validation = this.validateAppName(appName);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    // Check name availability within what the installer sees (MUW-REQ-27)
    if (!(await this.isAppNameAvailable(workspaceId, appName, { scope: 'personal', installedBy: userId }))) {
      throw new Error(`App name "${appName}" is already in use in this workspace`);
    }

    // Always mount workspace volume for workspace apps
    // This allows both containerized MCAs (Docker mount) and stdio MCAs (via MCA_CWD env var)
    // to access the workspace files
    const volumes: App['volumes'] = [
      {
        volumeId: workspace.volumeId,
        mountPath: options?.mountPath || '/workspace',
        readOnly: options?.readOnly || false,
      },
    ];

    const now = new Date().toISOString();
    const newApp: App = {
      appId,
      mcaId,
      ownerId: workspaceId,
      ownerType: 'workspace',
      // MUW-REQ-10/11: the installer owns the app; a member-installed app is personal.
      installedBy: userId,
      scope: 'personal',
      name: appName,
      status: 'active',
      volumes,
      // Seed explicit per-tool permissions from the manifest annotations
      // (allow for read-only, ask for mutations) — same as createApp.
      // Without this, read-only tools default to 'ask' instead of 'allow'.
      permissions: createInstallPermissions(this.loadStaticToolDefs(mcaId)),
      // Core platform tools are pinned to 'direct' exposure — same as createApp.
      toolExposure: mcaId === 'mca.teros.core' ? 'direct' : undefined,
      createdAt: now,
      updatedAt: now,
    };

    await this.appsCollection.insertOne(newApp);
    console.log(`[McaService] Created workspace app: ${appId} (${appName}) in ${workspaceId}`);

    return newApp;
  }

  /**
   * Update app configuration
   */
  /**
   * Validate app name format
   * - lower-kebab-case
   * - cannot start with number
   * - cannot start or end with hyphen
   */
  validateAppName(name: string): { valid: boolean; error?: string } {
    if (!name || name.length === 0) {
      return { valid: false, error: 'Name cannot be empty' };
    }
    if (name.length > 50) {
      return { valid: false, error: 'Name cannot exceed 50 characters' };
    }
    if (!/^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$/.test(name)) {
      return {
        valid: false,
        error: 'Name must be lower-kebab-case, start with a letter, and not end with hyphen',
      };
    }
    if (name.includes('--')) {
      return { valid: false, error: 'Name cannot contain consecutive hyphens' };
    }
    return { valid: true };
  }

  /**
   * Check if app name is available for a user
   */
  /**
   * Is `name` free within the set the app will be visible in (MUW-REQ-27)?
   * - a shared app must not collide with ANY app of the workspace;
   * - a personal app must not collide with a shared app nor with another
   *   personal app of the same owner (two members may each have `gmail`).
   * Without `scope`, the legacy workspace-wide check applies.
   * @spec MUW-REQ-27
   */
  async isAppNameAvailable(
    ownerId: string,
    name: string,
    opts?: { excludeAppId?: string; scope?: 'personal' | 'shared'; installedBy?: string } | string,
  ): Promise<boolean> {
    const o = typeof opts === 'string' ? { excludeAppId: opts } : (opts ?? {});
    const filter: any = { ownerId, name };
    if (o.excludeAppId) filter.appId = { $ne: o.excludeAppId };
    if (o.scope === 'personal' && o.installedBy) {
      filter.$or = [{ scope: 'shared' }, { scope: 'personal', installedBy: o.installedBy }];
    }
    const existing = await this.appsCollection.findOne(filter);
    return !existing;
  }

  /**
   * Rename an app
   */
  async renameApp(
    appId: string,
    userId: string,
    newName: string,
  ): Promise<{ success: boolean; error?: string }> {
    // Apps are workspace-owned (`ownerType: 'workspace'`, `ownerId === privateWorkspaceId`).
    // The `userId` passed by callers is the auth-context user, not the app owner — so we
    // must look up the app first and then verify the user is a writer of the owning
    // workspace, mirroring the pattern used by deleteApp().
    const app = await this.appsCollection.findOne({ appId, ownerType: 'workspace' });
    if (!app) {
      return { success: false, error: 'App not found or access denied' };
    }
    // MUW-REQ-13: the owner, or a workspace owner/admin.
    if (!(await this.canManageApp(app, userId))) {
      return { success: false, error: 'App not found or access denied' };
    }

    // Validate format
    const validation = this.validateAppName(newName);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    // MUW-REQ-27: unique within the set this app is visible in
    const isAvailable = await this.isAppNameAvailable(app.ownerId, newName, {
      excludeAppId: appId,
      scope: app.scope,
      installedBy: app.installedBy,
    });
    if (!isAvailable) {
      return { success: false, error: `Name "${newName}" is already in use` };
    }

    const result = await this.appsCollection.updateOne(
      { appId, ownerId: app.ownerId },
      { $set: { name: newName, updatedAt: new Date().toISOString() } },
    );

    if (result.matchedCount === 0) {
      return { success: false, error: 'App not found' };
    }

    return { success: true };
  }

  /**
   * Generate default app name from mcaId
   * mca.teros.bash -> bash, bash-2, bash-3, etc.
   * Ensures the generated name is always valid lower-kebab-case
   */
  async generateDefaultAppName(
    mcaId: string,
    ownerId: string,
    opts?: { scope?: 'personal' | 'shared'; installedBy?: string },
  ): Promise<string> {
    // Extract base name from mcaId: mca.teros.bash -> bash
    const parts = mcaId.split('.');
    let baseName = parts[parts.length - 1];

    // Sanitize base name to ensure it's valid lower-kebab-case
    baseName = baseName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-') // Replace invalid chars with hyphen
      .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
      .replace(/--+/g, '-'); // Replace consecutive hyphens with single hyphen

    // Prefix with 'app-' if starts with number
    if (/^[0-9]/.test(baseName)) {
      baseName = `app-${baseName}`;
    }

    // Ensure base name is not empty after sanitization
    if (!baseName) {
      baseName = 'app';
    }

    // Truncate if too long (leave room for potential "-999" suffix)
    if (baseName.length > 46) {
      baseName = baseName.slice(0, 46).replace(/-+$/, '');
    }

    // Validate the sanitized base name
    const validation = this.validateAppName(baseName);
    if (!validation.valid) {
      // If still invalid, use a safe fallback
      baseName = 'app';
    }

    // Check if base name is available
    if (await this.isAppNameAvailable(ownerId, baseName, opts)) {
      return baseName;
    }

    // Find next available number
    let counter = 2;
    while (counter < 1000) {
      const candidateName = `${baseName}-${counter}`;

      // Validate candidate name (should always be valid, but check to be safe)
      const candidateValidation = this.validateAppName(candidateName);
      if (candidateValidation.valid && (await this.isAppNameAvailable(ownerId, candidateName, opts))) {
        return candidateName;
      }
      counter++;
    }

    // Fallback: use shorter timestamp-based suffix
    // Use base36 encoding to keep it short and valid
    const timestamp = Date.now().toString(36); // Converts to base36 (0-9a-z)
    const fallbackName = `${baseName}-${timestamp}`;

    // Final validation
    const fallbackValidation = this.validateAppName(fallbackName);
    if (!fallbackValidation.valid) {
      throw new Error(
        `Unable to generate valid app name for mcaId ${mcaId}. Base name: ${baseName}, validation error: ${fallbackValidation.error}`,
      );
    }

    return fallbackName;
  }

  /**
   * Delete an app (uninstall MCA)
   * Also removes all agent access grants for this app
   */
  async deleteApp(appId: string, ownerId: string): Promise<{ success: boolean; error?: string }> {
    // All apps are workspace-owned (ownerType='workspace'). Verify the user has owner/admin/write
    // access to the workspace that owns this app.
    const app = await this.appsCollection.findOne({ appId, ownerType: 'workspace' });
    if (!app) {
      return { success: false, error: 'App not found or access denied' };
    }
    // MUW-REQ-13: the owner, or a workspace owner/admin.
    if (!(await this.canManageApp(app, ownerId))) {
      return { success: false, error: 'App not found or access denied' };
    }

    // Check if it's a system app (cannot be uninstalled)
    const mca = await this.getMcaFromCatalog(app.mcaId);
    if (mca?.availability?.system) {
      return { success: false, error: 'System apps cannot be uninstalled' };
    }

    // Remove all access grants for this app
    await this.accessCollection.deleteMany({ appId });

    // Delete the app (use app.ownerId to handle both user-owned and workspace-owned apps)
    const result = await this.appsCollection.deleteOne({ appId, ownerId: app.ownerId });

    if (result.deletedCount === 0) {
      return { success: false, error: 'Failed to delete app' };
    }

    // Invalidate tool cache for all agents that had access
    // (Note: We already deleted the access records, so we can't know which agents to invalidate)
    // This is fine - the cache will naturally refresh on next tool listing

    return { success: true };
  }

  // ============================================================================
  // AGENT APP ACCESS
  // ============================================================================

  /**
   * Grant agent access to an app
   *
   * Validates scope compatibility:
   * - Workspace agent can only access apps from the same workspace (ownerType='workspace').
   *
   * `opts.preferredName` (mca.teros.email only): human-chosen local part for
   * the agent's mailbox. Validated + uniqueness-checked; when taken, the
   * clean-first algorithm falls through to the next candidate (the grant
   * still succeeds — naming is non-blocking by design).
   */
  async grantAccess(
    access: Omit<AgentAppAccess, 'grantedAt'>,
    opts: { preferredName?: string } = {},
  ): Promise<AgentAppAccess> {
    // Validate app exists
    const app = await this.getApp(access.appId);
    if (!app) {
      throw new Error(`App ${access.appId} not found`);
    }

    // Get agent to check scope
    const agentsCollection = this.db.collection('agents');
    const agent = await agentsCollection.findOne({ agentId: access.agentId });
    if (!agent) {
      throw new Error(`Agent ${access.agentId} not found`);
    }

    // Validate scope compatibility
    const agentWorkspaceId = agent.workspaceId;
    const appWorkspaceId = app.ownerType === 'workspace' ? app.ownerId : undefined;

    if (agentWorkspaceId && !appWorkspaceId) {
      throw new Error(
        'Workspace agent cannot access global apps. Install the app in the workspace first.',
      );
    }
    // Superagents (no workspaceId) can access workspace apps — they operate
    // across workspaces and their grants are managed explicitly.
    // if (!agentWorkspaceId && appWorkspaceId) { throw ... }
    if (agentWorkspaceId && appWorkspaceId && agentWorkspaceId !== appWorkspaceId) {
      throw new Error('Agent and app must belong to the same workspace.');
    }

    const newAccess: AgentAppAccess = {
      ...access,
      grantedAt: new Date().toISOString(),
    };

    // Upsert: update if exists, insert if not
    await this.accessCollection.updateOne(
      { agentId: access.agentId, appId: access.appId },
      { $set: newAccess },
      { upsert: true },
    );

    // Invalidate tool cache for this agent
    if (this.onToolCacheInvalidate) {
      await this.onToolCacheInvalidate(access.agentId);
    }

    // EMAIL MAILBOX HOOK (tn_PcquTN30AawbK8uE): granting the email app to an
    // agent provisions its mailbox — "el grant ES el interruptor". Fail-soft
    // by design: a provisioning error NEVER breaks the grant (the mailbox
    // doc is stored pending and the lazy safety-net retries).
    if (app.mcaId === 'mca.teros.email') {
      try {
        const mailboxService = new AgentMailboxService(this.db);
        const result = await mailboxService.ensureMailbox(agent as unknown as AgentInstance, {
          preferredName: opts?.preferredName,
        });
        console.log(
          `[McaService] Mailbox hook: ${access.agentId} → ${result.address} (${result.status}${result.reason ? `, ${result.reason}` : ''})`,
        );
      } catch (error) {
        console.error(
          `[McaService] Mailbox hook FAILED for ${access.agentId} (grant NOT affected):`,
          error,
        );
      }
    }

    return newAccess;
  }

  /**
   * Auto-grant an app to the user's superagents (global agents:
   * ownerId = userId, no workspaceId). Called on app install so the
   * superagent gets the app without manual assignment.
   *
   * Fail-soft: an install never fails because a grant fails — errors are
   * logged and skipped. `grantAccess` is an upsert, so repeated calls
   * (e.g. idempotent installs) are harmless.
   */
  async grantAccessToUserSuperagents(userId: string, appId: string): Promise<void> {
    const agentsCollection = this.db.collection('agents');
    const superagents = await agentsCollection
      .find(
        {
          ownerId: userId,
          workspaceId: { $in: [null, undefined] },
          status: 'active',
        },
        { projection: { agentId: 1 } },
      )
      .toArray();

    for (const agent of superagents) {
      try {
        await this.grantAccess({
          agentId: agent.agentId as string,
          appId,
          grantedBy: userId,
        });
        console.log(
          `[McaService] Auto-granted app ${appId} to superagent ${agent.agentId} (user ${userId})`,
        );
      } catch (error) {
        console.error(
          `[McaService] Failed to auto-grant app ${appId} to superagent ${agent.agentId}:`,
          error,
        );
      }
    }
  }

  /**
   * Revoke agent access to an app
   */
  async revokeAccess(agentId: string, appId: string): Promise<boolean> {
    const result = await this.accessCollection.deleteOne({ agentId, appId });

    // Invalidate tool cache for this agent if access was revoked
    if (result.deletedCount > 0 && this.onToolCacheInvalidate) {
      await this.onToolCacheInvalidate(agentId);
    }

    return result.deletedCount > 0;
  }

  /**
   * Check if agent has access to an app
   */
  async hasAccess(agentId: string, appId: string): Promise<boolean> {
    const access = await this.accessCollection.findOne({ agentId, appId });
    return access !== null;
  }

  /**
   * Get agent's access to an app (with tool restrictions)
   */
  async getAccess(agentId: string, appId: string): Promise<AgentAppAccess | null> {
    return this.accessCollection.findOne({ agentId, appId });
  }

  /**
   * Update tool permissions for an agent's app access
   *
   * @param agentId - The agent whose permissions to update
   * @param appId - The app to update permissions for
   * @param permissions - The new permissions configuration
   * @returns The updated access record, or null if not found
   */
  async updatePermissions(
    agentId: string,
    appId: string,
    permissions: AppToolPermissions,
  ): Promise<AgentAppAccess | null> {
    const result = await this.accessCollection.findOneAndUpdate(
      { agentId, appId },
      { $set: { permissions } },
      { returnDocument: 'after' },
    );

    // Invalidate tool cache for this agent
    if (result && this.onToolCacheInvalidate) {
      await this.onToolCacheInvalidate(agentId);
    }

    return result;
  }

  /**
   * Get all access records for an app (all agents with access)
   */
  async getAppAccessList(appId: string): Promise<AgentAppAccess[]> {
    return this.accessCollection.find({ appId }).toArray();
  }

  // ============================================================================
  // SYSTEM APPS AUTO-PROVISIONING
  // ============================================================================

  /**
   * Ensure system apps exist and agent has access to them based on user role.
   *
   * For MCAs with availability.system: true, automatically:
   * 1. Create app instance for the user if it doesn't exist (ownerId = agent's owner)
   * 2. Remove duplicates if found (keep oldest, delete newer ones)
   * 3. Grant access to the agent if user has required role
   * 4. Revoke access if user no longer has required role
   *
   * Role hierarchy: user < admin < super
   *
   * This is called before resolving agent apps to ensure system tools
   * are always available without manual setup.
   *
   * SELF-HEALING: If duplicates are found, they are automatically removed
   * (keeping the oldest one) to maintain system integrity.
   *
   * SYSTEM-CAPABILITY TOGGLES (v1.4.4): system MCAs are provisioned only when
   * the capability is ON for the agent —
   *   ON iff (availability.defaultEnabled !== false &&
   *           !agent.disabledSystemApps.includes(mcaId))
   *        || agent.enabledSystemApps.includes(mcaId)
   * When OFF, provisioning is skipped AND any existing grant is revoked
   * (reconciliation both directions, so toggling back ON re-provisions).
   *
   * ADD-ONLY for core defaults: this provisions system ∪ core.defaultApps and
   * never deprovisions core defaults. If a core's `defaultApps` later shrinks,
   * already-granted apps are intentionally left in place (no reconciliation of
   * removals) — by design, so a config change can't silently strip an agent's
   * tools. Removing a core default from existing agents is an explicit admin
   * action. System-capability toggles are the ONE exception: they are an
   * explicit per-agent admin action, so they DO reconcile removals.
   */
  async ensureProvisionedApps(agentId: string, workspaceId?: string): Promise<void> {
    console.log(`[McaService] ensureProvisionedApps called for agent: ${agentId}`);

    // Role hierarchy for comparison
    const roleHierarchy: Record<string, number> = { user: 0, admin: 1, super: 2 };

    // Get the agent to determine scope (global vs workspace)
    const agentsCollection = this.db.collection('agents');
    const agent = await agentsCollection.findOne({ agentId });

    if (!agent?.ownerId) {
      console.error(`[McaService] Agent ${agentId} has no ownerId, cannot ensure system apps`);
      return;
    }

    const userId = agent.ownerId;
    const agentWorkspaceId = agent.workspaceId as string | undefined;

    // System-capability toggles (v1.4.4): per-agent opt-out for default-ON
    // capabilities and per-agent opt-in for default-OFF ones. Absent lists =
    // historical behaviour (all default-ON provisioned, nothing else).
    const disabledSystemApps = (agent.disabledSystemApps as string[] | undefined) ?? [];
    const enabledSystemApps = (agent.enabledSystemApps as string[] | undefined) ?? [];

    // Determine where to create/find system apps using the unified workspace model.
    // For Superagents (agentWorkspaceId = null), fall back to the active channel workspace.
    const effectiveWorkspaceId = agentWorkspaceId || workspaceId;
    const appOwnerId = effectiveWorkspaceId || userId;
    const appOwnerType = 'workspace';

    // Superagent without an active workspace — cannot provision system apps
    if (!effectiveWorkspaceId) {
      console.warn(
        `[McaService] ensureSystemApps: Superagent ${agentId} has no active workspace. Skipping system app provisioning.`,
      );
      return;
    }


    console.log(`[McaService] Agent ${agentId} scope: ${appOwnerType}, appOwnerId: ${appOwnerId}`);
    const owningWorkspace = await this.db
      .collection('workspaces')
      .findOne({ workspaceId: effectiveWorkspaceId }, { projection: { ownerId: 1 } });
    const workspaceOwnerId = owningWorkspace?.ownerId as string | undefined;
    if (!workspaceOwnerId) {
      throw new Error(`[McaService] ensureProvisionedApps: workspace ${effectiveWorkspaceId} has no owner — cannot provision system apps`);
    }

    const usersCollection = this.db.collection('users');
    const user = await usersCollection.findOne({ userId });
    const userRole = (user?.role as string) || 'user';

    const userLevel = roleHierarchy[userRole] ?? 0;
    console.log(
      `[McaService] Agent ${agentId} owner: ${userId}, role: ${userRole} (level ${userLevel})`,
    );

    // Helper to check if user has required role
    const hasRequiredRole = (requiredRole: string): boolean => {
      const requiredLevel = roleHierarchy[requiredRole] ?? 0;
      return userLevel >= requiredLevel;
    };

    // Find all system MCAs (availability.system: true)
    const systemMcas = await this.mcaCatalogCollection
      .find({
        'availability.system': true,
        'availability.enabled': true,
        status: 'active',
      })
      .toArray();

    // Core default apps: non-system MCAs declared by the agent's core.
    // Provisioned with the same idempotent routine as system apps.
    const core = agent.coreId
      ? await this.db
          .collection<{ defaultApps?: string[] }>('agent_cores')
          .findOne({ coreId: agent.coreId })
      : null;
    const defaultAppIds = core?.defaultApps ?? [];
    const defaultAppMcas = defaultAppIds.length
      ? await this.mcaCatalogCollection
          .find({
            mcaId: { $in: defaultAppIds },
            'availability.enabled': true,
            status: 'active',
          })
          .toArray()
      : [];

    // Merge system + core-default MCAs, deduped by mcaId.
    const seenMcaIds = new Set<string>();
    const mcasToProvision = [...systemMcas, ...defaultAppMcas].filter((m) => {
      if (seenMcaIds.has(m.mcaId)) return false;
      seenMcaIds.add(m.mcaId);
      return true;
    });

    // System-capability resolution (v1.4.4). For each SYSTEM mca, decide
    // whether THIS agent should have it:
    //   ON  iff (defaultEnabled !== false && !disabled.includes(mcaId))
    //         || enabled.includes(mcaId)
    // Core-default apps are NOT toggleable here (they follow the core's
    // declaration) — toggles only govern availability.system MCAs.
    // Disabled capabilities are still visited by the loop below so existing
    // grants get REVOKED (reconciliation both ways, self-healing on re-enable).
    //
    // CAPABILITY GROUPS: one user-facing capability can map to several MCAs.
    // Today: "Terminal" = mca.teros.bash + mca.teros.terminal (Pablo 30-oct:
    // bash and terminal are the same capability — commands + visible PTY
    // sessions). Enabling EITHER mcaId enables the whole group, so the toggle
    // is one entry and the dependency (terminal needs bash) is always
    // satisfied. Disabling either disables both.
    const SYSTEM_CAPABILITY_GROUPS: Record<string, string[]> = {
      terminal: ['mca.teros.bash', 'mca.teros.terminal'],
    };
    const expandCapabilityGroup = (mcaId: string): string[] => {
      for (const members of Object.values(SYSTEM_CAPABILITY_GROUPS)) {
        if (members.includes(mcaId)) return members;
      }
      return [mcaId];
    };
    const isCapabilityEnabled = (mcaId: string, defaultEnabled: boolean): boolean => {
      for (const member of expandCapabilityGroup(mcaId)) {
        if (enabledSystemApps.includes(member)) return true;
        if (disabledSystemApps.includes(member)) return false;
      }
      // No per-agent override: the manifest default decides. Absent/true =
      // default ON (ambient + toggleable caps); false = default OFF (power).
      return defaultEnabled;
    };
    const systemCapabilityOff = new Set<string>();
    for (const mca of systemMcas) {
      const defaultEnabled = mca.availability?.defaultEnabled !== false;
      if (!isCapabilityEnabled(mca.mcaId, defaultEnabled)) {
        for (const member of expandCapabilityGroup(mca.mcaId)) {
          systemCapabilityOff.add(member);
        }
      }
    }

    // PROVISIONING SCOPE (tn_PcquTN30AawbK8uE): a system MCA may declare
    // `availability.provisions.scope: 'super-agents'` — auto-provision ONLY
    // for superagents (no workspaceId). Workspace agents keep manual control:
    // the human grants the app explicitly (the grant IS the toggle), and the
    // mailbox is then provisioned by the grantAccess hook. Explicit
    // enabledSystemApps entries still override (explicit opt-in wins).
    const provisioningScopeOff = new Set<string>();
    for (const mca of systemMcas) {
      const scope = mca.availability?.provisions?.scope;
      if (scope !== 'super-agents') continue;
      if (enabledSystemApps.includes(mca.mcaId)) continue; // explicit opt-in
      if (agentWorkspaceId) {
        for (const member of expandCapabilityGroup(mca.mcaId)) {
          provisioningScopeOff.add(member);
        }
      }
    }

    console.log(
      `[McaService] Provisioning ${mcasToProvision.length} MCAs for ${agentId} ` +
        `(${systemMcas.length} system + ${defaultAppMcas.length} core-default)` +
        (systemCapabilityOff.size
          ? ` — capabilities OFF for this agent: ${[...systemCapabilityOff].join(', ')}`
          : ''),
    );

    for (const mca of mcasToProvision) {
      const requiredRole = mca.availability?.role || 'user';
      const userHasAccess = hasRequiredRole(requiredRole);

      // Capability toggle (v1.4.4): a system capability that is OFF for this
      // agent must not be provisioned — and any stale grant must be revoked.
      // Core-default apps are exempt (they are not system capabilities).
      const isCoreDefault = !systemMcas.some((s) => s.mcaId === mca.mcaId);
      if (!isCoreDefault && systemCapabilityOff.has(mca.mcaId)) {
        const existingAppsForMca = await this.appsCollection
          .find({ mcaId: mca.mcaId, ownerId: appOwnerId, ownerType: appOwnerType })
          .toArray();
        for (const app of existingAppsForMca) {
          const revoked = await this.revokeAccess(agentId, app.appId);
          if (revoked) {
            console.log(
              `[McaService] Capability OFF: revoked access ${agentId} -> ${app.appId} (${mca.mcaId})`,
            );
          }
        }
        continue;
      }

      // Provisioning scope (tn_PcquTN30AawbK8uE): super-agents-only MCA on a
      // workspace agent without explicit opt-in — skip auto-provisioning, but
      // do NOT revoke: an explicit human grant must survive reconciliation
      // (the grant is the toggle; this loop only governs AUTOMATIC grants).
      if (!isCoreDefault && provisioningScopeOff.has(mca.mcaId)) {
        console.log(
          `[McaService] Provisioning scope (super-agents) — skipping auto-provision of ${mca.mcaId} for workspace agent ${agentId}`,
        );
        continue;
      }

      // Find ALL apps for this owner (user or workspace) with this mcaId to detect duplicates
      const existingApps = await this.appsCollection
        .find({ mcaId: mca.mcaId, ownerId: appOwnerId, ownerType: appOwnerType })
        .sort({ createdAt: 1 }) // Oldest first
        .toArray();

      // Remove duplicate apps if found (keep oldest)
      if (existingApps.length > 1) {
        console.warn(
          `[McaService] DUPLICATE DETECTED: Found ${existingApps.length} apps for ${mca.mcaId} owned by ${appOwnerId}. Auto-repairing...`,
        );

        const [keepApp, ...duplicates] = existingApps;

        for (const duplicate of duplicates) {
          // Remove access grants for the duplicate
          await this.accessCollection.deleteMany({ appId: duplicate.appId });
          // Remove the duplicate app
          await this.appsCollection.deleteOne({ appId: duplicate.appId });
          console.warn(
            `[McaService] REMOVED duplicate app: ${duplicate.appId} (${duplicate.name}) for ${mca.mcaId}`,
          );
        }

        console.log(`[McaService] Kept app: ${keepApp.appId} (${keepApp.name}) for ${mca.mcaId}`);
      }

      // Now get the canonical app (either the one we kept or none)
      const existingApp = existingApps[0] || null;

      if (!existingApp) {
        // Create app for the appropriate owner (user or workspace)
        const appId = generateAppId();
        const now = new Date().toISOString();

        // Generate default app name from mcaId (e.g., mca.teros.bash -> bash)
        const appName = await this.generateDefaultAppName(mca.mcaId, appOwnerId);

        // Validate generated name (defensive check - generateDefaultAppName should always return valid)
        const nameValidation = this.validateAppName(appName);
        if (!nameValidation.valid) {
          console.error(
            `[McaService] ERROR: generateDefaultAppName returned invalid name "${appName}" for ${mca.mcaId}: ${nameValidation.error}`,
          );
          throw new Error(
            `Generated app name "${appName}" is invalid: ${nameValidation.error}`,
          );
        }

        // Auto-resolve volumes from owner (user or workspace)
        const volumes = await this.resolveAppVolumes(appOwnerId, appOwnerType);

        const newApp: App = {
          appId,
          mcaId: mca.mcaId,
          ownerId: appOwnerId,
          ownerType: appOwnerType,
          // MUW-REQ-10/11: platform-provisioned apps belong to the workspace
          // owner and are shared with the whole workspace.
          installedBy: workspaceOwnerId,
          scope: 'shared',
          name: appName,
          status: 'active',
          volumes: volumes?.length ? volumes : undefined,
          // Install-time permission seed, same as createApp/createWorkspaceApp —
          // without it every tool (read-only included) falls back to 'ask'
          // (getToolPermission → DEFAULT_TOOL_PERMISSION) and a freshly
          // provisioned workspace nags for trivially safe operations.
          permissions: createInstallPermissions(this.loadStaticToolDefs(mca.mcaId)),
          // No secrets field - loaded from filesystem at runtime
          createdAt: now,
          updatedAt: now,
        };
        await this.appsCollection.insertOne(newApp);
        console.log(
          `[McaService] Auto-created system app: ${appId} (${appName}) for ${appOwnerType} ${appOwnerId}${volumes?.length ? ` with volume ${volumes[0].volumeId}` : ''}`,
        );

        // Grant access to agent only if user has required role
        if (userHasAccess) {
          await this.grantAccess({
            agentId,
            appId,
            grantedBy: 'system',
          });
          console.log(
            `[McaService] Auto-granted access: ${agentId} -> ${appId} (role ${userRole} >= ${requiredRole})`,
          );
        } else {
          console.log(
            `[McaService] Skipped access grant: ${agentId} -> ${appId} (role ${userRole} < ${requiredRole})`,
          );
        }
      } else {
        // App exists - update volume if missing
        if (!existingApp.volumes || existingApp.volumes.length === 0) {
          const volumes = await this.resolveAppVolumes(appOwnerId, appOwnerType);
          if (volumes?.length) {
            await this.appsCollection.updateOne(
              { appId: existingApp.appId },
              { $set: { volumes, updatedAt: new Date().toISOString() } },
            );
            console.log(
              `[McaService] Updated missing volume for system app: ${existingApp.appId} (${mca.mcaId})`,
            );
          }
        }

        // App exists - re-enable if disabled
        if (existingApp.status !== 'active') {
          await this.appsCollection.updateOne(
            { appId: existingApp.appId },
            { $set: { status: 'active', updatedAt: new Date().toISOString() } },
          );
          console.log(`[McaService] Re-enabled app: ${existingApp.appId}`);
        }

        // Check current access
        const currentlyHasAccess = await this.hasAccess(agentId, existingApp.appId);

        if (userHasAccess && !currentlyHasAccess) {
          // User should have access but doesn't - grant it
          await this.grantAccess({
            agentId,
            appId: existingApp.appId,
            grantedBy: 'system',
          });
          console.log(
            `[McaService] Auto-granted access: ${agentId} -> ${existingApp.appId} (role ${userRole} >= ${requiredRole})`,
          );
        } else if (!userHasAccess && currentlyHasAccess) {
          // User should NOT have access but does - revoke it
          await this.revokeAccess(agentId, existingApp.appId);
          console.log(
            `[McaService] Revoked access: ${agentId} -> ${existingApp.appId} (role ${userRole} < ${requiredRole})`,
          );
        }
      }
    }
  }

  /**
   * Disable apps whose MCA no longer exists or is disabled in catalog.
   *
   * Called by sync-mcas to clean up orphaned apps.
   */
  async disableOrphanedApps(): Promise<{ disabled: string[]; reEnabled: string[] }> {
    const disabled: string[] = [];
    const reEnabled: string[] = [];

    // Get all apps
    const allApps = await this.appsCollection.find({}).toArray();

    for (const app of allApps) {
      const mca = await this.getMcaFromCatalog(app.mcaId);

      // MCA doesn't exist or is disabled/inactive
      const mcaUnavailable = !mca || mca.status !== 'active' || !mca.availability?.enabled;

      if (mcaUnavailable && app.status === 'active') {
        // Disable the app
        await this.appsCollection.updateOne(
          { appId: app.appId },
          { $set: { status: 'disabled', updatedAt: new Date().toISOString() } },
        );
        disabled.push(app.appId);
      } else if (!mcaUnavailable && app.status === 'disabled') {
        // Re-enable if MCA is back
        await this.appsCollection.updateOne(
          { appId: app.appId },
          { $set: { status: 'active', updatedAt: new Date().toISOString() } },
        );
        reEnabled.push(app.appId);
      }
    }

    return { disabled, reEnabled };
  }

  /**
   * Delete apps whose mcaId no longer exists in the catalog.
   * Also deletes all associated agent_app_access entries.
   *
   * Called by sync-mcas as the final cleanup phase.
   */
  async deleteOrphanedApps(
    activeMcaIds: Set<string>,
  ): Promise<{ deleted: Array<{ appId: string; mcaId: string; name: string }> }> {
    const deleted: Array<{ appId: string; mcaId: string; name: string }> = [];

    const allApps = await this.appsCollection.find({}).toArray();

    for (const app of allApps) {
      if (!activeMcaIds.has(app.mcaId)) {
        // Delete agent_app_access entries first
        await this.accessCollection.deleteMany({ appId: app.appId });
        // Delete the app itself
        await this.appsCollection.deleteOne({ appId: app.appId });
        deleted.push({ appId: app.appId, mcaId: app.mcaId, name: app.name });
      }
    }

    return { deleted };
  }

  // ============================================================================
  // AGENT APPS RESOLUTION
  // ============================================================================

  /**
   * Get all apps an agent has access to
   *
   * Only includes apps with explicit access grants (agent_app_access).
   * System apps are auto-provisioned via ensureSystemApps().
   * Other apps (workspace or global) must be granted explicitly.
   *
   * Automatically ensures system apps are provisioned before resolving.
   *
   * Resolution strategy:
   * - If the agent has a workspaceId: resolve apps filtered by workspaceId
   *   (ownerId = workspaceId, ownerType = 'workspace') + agent_app_access grants.
   *   This is the primary path for workspace agents.
   * - If the agent has no workspaceId (Superagent or legacy global agent):
   *   resolve apps by appId from agent_app_access only (legacy behaviour preserved).
   */
  async getAgentApps(agentId: string, workspaceId?: string, viewer?: AppViewer): Promise<AgentApps> {
    // Auto-provision system apps — throttled to once every 5 minutes per agent+workspace
    // to avoid running the full provisioning logic on every agent.get-apps call.
    const provisioningCacheKey = `${agentId}:${workspaceId ?? 'global'}`;
    const lastRun = this.ensureProvisionedAppsCache.get(provisioningCacheKey) ?? 0;
    if (Date.now() - lastRun > this.ENSURE_PROVISIONED_APPS_TTL_MS) {
      await this.ensureProvisionedApps(agentId, workspaceId);
      this.ensureProvisionedAppsCache.set(provisioningCacheKey, Date.now());
    }

    // Get all access grants for this agent in one query
    const accessList = await this.accessCollection.find({ agentId }).toArray();
    if (accessList.length === 0) return { agentId, apps: [] };

    const appIds = accessList.map((a) => a.appId);

    // Resolve the agent's workspaceId to determine resolution strategy
    const agentsCollection = this.db.collection('agents');
    const agent = await agentsCollection.findOne({ agentId }, { projection: { workspaceId: 1 } });
    const agentWorkspaceId = agent?.workspaceId as string | undefined | null;

    // Workspace always comes from the channel — no fallbacks (ENGINEERING-PRINCIPLES.md)
    // For Superagents (agentWorkspaceId = null): use the channel's workspaceId
    // For workspace agents (agentWorkspaceId = string): use their own workspaceId
    const effectiveWorkspaceId = agentWorkspaceId ?? workspaceId;
    if (!effectiveWorkspaceId) {
      throw new Error(
        `[McaService.getAgentApps] No workspaceId available for agent ${agentId}. ` +
        `All tool executions must be scoped to a workspace.`
      );
    }
    const appsFilter: Record<string, any> = {
      appId: { $in: appIds },
      status: 'active',
      ownerId: effectiveWorkspaceId,
      ownerType: 'workspace',
    };

    // Batch-fetch all apps in a single query instead of N sequential getResolvedApp calls
    const appsRaw = await this.appsCollection.find(appsFilter).toArray();

    if (appsRaw.length === 0) {
      throw new Error(
        `[McaService.getAgentApps] Agent ${agentId} has no apps in workspace ${effectiveWorkspaceId}. ` +
        `Ensure the agent has been granted access to apps in this workspace.`
      );
    }

    // Batch-fetch all needed MCA catalog entries in a single query
    const mcaIds = [...new Set(appsRaw.map((a) => a.mcaId))];
    const mcaList = await this.mcaCatalogCollection
      .find({ mcaId: { $in: mcaIds }, status: 'active' })
      .toArray();

    // Build lookup maps for O(1) access
    const mcaById = new Map(mcaList.map((m) => [m.mcaId, m]));
    const accessByAppId = new Map(accessList.map((a) => [a.appId, a]));

    const apps: AgentApps['apps'] = [];

    for (const appRaw of appsRaw) {
      const mca = mcaById.get(appRaw.mcaId);
      if (!mca || !mca.availability?.enabled) continue;

      const access = accessByAppId.get(appRaw.appId);
      if (!access) continue;
      // MUW-REQ-12/13: the viewer decides which granted apps exist here —
      // shared ones always; personal ones only for their owner, and never in
      // a shared conversation.
      if (viewer && !this.isAppUsableBy(appRaw, viewer)) continue;

      const { mcaId, ...appWithoutMcaId } = appRaw;
      apps.push({
        app: { ...appWithoutMcaId, mca } as ResolvedApp,
        access,
      });
    }

    return { agentId, apps };
  }

  /**
   * Get all tools available to an agent (across all apps)
   */

  // ============================================================================
  // APP SCOPE (REQ-6: personal / shared)
  // ============================================================================

  /**
   * Update an app's scope between 'personal' and 'shared' (REQ-6).
   *
   * Uses the same authorization model as renameApp/updateAppContext: the
   * requester must be owner or writer of the owning workspace.
   *
   * @returns The updated app, or null if not found / no permission.
   */
  /**
   * Change an app's scope. Only the app owner may do it (MUW-REQ-11): the
   * member who installed it, or — for apps installed before `installedBy`
   * existed — the workspace owner.
   *
   * @throws Error('ACCESS_DENIED') when the caller is not the app owner.
   * @spec MUW-REQ-11
   */
  async setAppScope(
    appId: string,
    userId: string,
    scope: 'personal' | 'shared',
  ): Promise<App | null> {
    const app = await this.appsCollection.findOne({ appId, ownerType: 'workspace' });
    if (!app) return null;

    if (!this.isAppOwner(app, userId)) {
      throw new Error('ACCESS_DENIED');
    }
    // MUW-REQ-27: sharing makes the name visible to everyone — it must not
    // collide with any other app of the workspace (another member's private
    // app included). Nothing about the colliding app is revealed.
    if (scope === 'shared' && app.scope !== 'shared') {
      const collision = await this.appsCollection.findOne({
        ownerId: app.ownerId,
        name: app.name,
        appId: { $ne: app.appId },
      });
      if (collision) throw new Error('NAME_COLLISION');
    }

    const result = await this.appsCollection.findOneAndUpdate(
      { appId, ownerId: app.ownerId },
      {
        $set: {
          scope,
          updatedAt: new Date().toISOString(),
        },
      },
      { returnDocument: 'after' },
    );

    return result;
  }

  // ============================================================================
  // APP PERMISSIONS
  // ============================================================================

  /**
   * Get permissions for an app
   * Returns the tool permissions stored in the app, or defaults if not set
   */
  async getAppPermissions(appId: string): Promise<AppToolPermissions> {
    const app = await this.getApp(appId);
    if (!app) {
      throw new Error(`App ${appId} not found`);
    }

    // Return stored permissions or default (all tools = 'ask')
    return (
      app.permissions || {
        tools: {},
        defaultPermission: 'ask',
      }
    );
  }

  /**
   * Update permissions for an app
   *
   * @param appId - The app to update
   * @param permissions - The new permissions configuration
   * @returns The updated app
   */
  async updateAppPermissions(appId: string, permissions: AppToolPermissions): Promise<App | null> {
    const result = await this.appsCollection.findOneAndUpdate(
      { appId },
      {
        $set: {
          permissions,
          updatedAt: new Date().toISOString(),
        },
      },
      { returnDocument: 'after' },
    );

    return result;
  }

  /**
   * Update a single tool's permission in an app
   *
   * @param appId - The app to update
   * @param toolName - The tool to update
   * @param permission - The new permission level
   * @returns The updated app
   */
  async updateToolPermission(
    appId: string,
    toolName: string,
    permission: ToolPermission,
  ): Promise<App | null> {
    // Extract short tool name (e.g., "bash_bash" -> "bash", "filesystem_read" -> "read")
    const shortName = toolName.includes('_') ? toolName.split('_').slice(1).join('_') : toolName;

    // Get current permissions
    const currentPermissions = await this.getAppPermissions(appId);

    // Update the specific tool using short name
    const newPermissions: AppToolPermissions = {
      ...currentPermissions,
      tools: {
        ...currentPermissions.tools,
        [shortName]: permission,
      },
    };

    return this.updateAppPermissions(appId, newPermissions);
  }

  /**
   * Set all tools to a specific permission level
   *
   * @param appId - The app to update
   * @param permission - The permission level to set for all tools
   * @returns The updated app
   */
  async setAllToolPermissions(appId: string, permission: ToolPermission): Promise<App | null> {
    // Get the app's MCA to know what tools it has
    const app = await this.getResolvedApp(appId);
    if (!app) {
      throw new Error(`App ${appId} not found`);
    }

    // Build permissions object with all tools set to the same permission.
    // Private tools (e.g. '-health-check') are EXCLUDED — they are always
    // 'allow' at runtime and never shown in the permissions UI, so pinning
    // them only leaves a stale fingerprint that later hides seed problems
    // (the 2026-09-30 gravedigging: a full-ask map including '-health-check'
    // is indistinguishable from the pre-TER-369-removal legacy seed).
    const toolsPermissions: Record<string, ToolPermission> = {};
    for (const toolName of app.mca.tools) {
      if (!isPrivateTool(toolName)) toolsPermissions[toolName] = permission;
    }

    const newPermissions: AppToolPermissions = {
      tools: toolsPermissions,
      defaultPermission: permission,
    };

    return this.updateAppPermissions(appId, newPermissions);
  }

  /**
   * Get user role from database
   */
  async getUserRole(userId: string): Promise<{ role: string } | null> {
    const usersCollection = this.db.collection('users');
    const user = await usersCollection.findOne({ userId }, { projection: { role: 1, _id: 0 } });
    return user as { role: string } | null;
  }

  /**
   * Propagate tool changes from a catalog update to all installed apps of an MCA.
   *
   * When an MCA's tools.json changes (new tools added, old tools removed), this
   * method updates the permissions stored in every App instance of that MCA:
   *   - New tools are seeded with the SAME criterion as install time
   *     (`installSeedPermission`): read-only/safe-write → 'allow', mutation →
   *     'ask', `alwaysAsk` always wins. Decision 2026-10-30 (Pablo): a tool
   *     the user never configured gets exactly what it would have gotten had
   *     it existed at install time — no eternal 'ask' for benign tools on
   *     MCA updates (the todo-list set-progress incident: 3 safeWrite tools
   *     denied in headless for 6 days because the old code hardcoded 'ask').
   *   - Removed tools are cleaned up from the permissions map
   *   - Existing tool permissions are preserved unchanged — anything the user
   *     (or any explicit writer) pinned stays exactly as pinned, even when it
   *     differs from the seed. User intent is sacred; only the never-touched
   *     delta is seeded.
   *
   * Called by McaBootSync after updating the catalog entry.
   *
   * @param mcaId - The MCA whose tools changed
   * @param newToolNames - The current tool names from the updated tools.json
   * @param toolAnnotations - Validated annotations by tool name (from the
   *        updated tools.json). Optional for back-compat with older callers;
   *        without it the seed degrades to the old behaviour (new tools 'ask')
   *        — callers should always pass it.
   * @returns Number of apps that were updated
   */
  async propagateToolsToApps(
    mcaId: string,
    newToolNames: string[],
    toolAnnotations?: Map<string, McaToolAnnotations>,
  ): Promise<number> {
    // Find all active apps for this MCA
    const apps = await this.appsCollection
      .find({ mcaId, status: { $ne: 'disabled' } })
      .toArray();

    if (apps.length === 0) {
      return 0;
    }

    let updatedCount = 0;

    for (const app of apps) {
      const currentPermissions = app.permissions ?? {
        tools: {},
        defaultPermission: 'ask' as const,
      };

      const existingToolPerms = currentPermissions.tools ?? {};
      const updatedToolPerms: Record<string, import('../types/database').ToolPermission> = {};

      let changed = false;

      // Keep permissions for tools that still exist; seed new tools with the
      // install-time criterion (read-only/safe-write → 'allow', else 'ask').
      for (const toolName of newToolNames) {
        // Private tools (e.g. '-health-check') never get a map entry — same
        // as createInstallPermissions. They are always 'allow' at runtime;
        // pinning them only leaves stale fingerprints in the map.
        if (isPrivateTool(toolName)) continue;
        if (toolName in existingToolPerms) {
          // Preserve existing permission — user intent is never overwritten
          updatedToolPerms[toolName] = existingToolPerms[toolName];
        } else {
          // New tool — seed it exactly as createInstallPermissions would have
          // (decision 2026-10-30). No annotations passed → conservative 'ask'
          // (back-compat with callers that only know tool names).
          updatedToolPerms[toolName] = installSeedPermission({
            name: toolName,
            annotations: toolAnnotations?.get(toolName),
          });
          changed = true;
        }
      }

      // Detect removed tools (were in existing perms but not in new tool list)
      for (const toolName of Object.keys(existingToolPerms)) {
        if (!newToolNames.includes(toolName)) {
          // Tool removed — don't include it in updatedToolPerms
          changed = true;
        }
      }

      if (!changed) {
        continue;
      }

      const newPermissions = {
        tools: updatedToolPerms,
        defaultPermission: currentPermissions.defaultPermission,
      };

      await this.appsCollection.updateOne(
        { appId: app.appId },
        {
          $set: {
            permissions: newPermissions,
            updatedAt: new Date().toISOString(),
          },
        },
      );

      updatedCount++;
    }

    return updatedCount;
  }

  /**
   * Update app context only (not name or permissions)
   * @param appId - App identifier
   * @param userId - User requesting the update
   * @param context - New context content
   * @returns Success status and updated app
   */
  async updateAppContext(
    appId: string,
    userId: string,
    context: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Same authorization model as renameApp/deleteApp: app is workspace-owned,
      // user must be owner or writer of the owning workspace.
      const appsCollection = this.db.collection('apps');
      const app = await appsCollection.findOne({ appId, ownerType: 'workspace' });
      if (!app) {
        return { success: false, error: 'App not found or no permission to update' };
      }
      const workspace = await this.workspaceService?.getWorkspace(app.ownerId);
      const isOwner = workspace?.ownerId === userId;
      // Check workspace_members collection (single source of truth)
      const member = workspace
        ? await this.db.collection('workspace_members').findOne({ workspaceId: app.ownerId, userId })
        : null;
      const isWriter = member?.role === 'admin' || member?.role === 'write';
      if (!isOwner && !isWriter) {
        return { success: false, error: 'App not found or no permission to update' };
      }

      const result = await appsCollection.updateOne(
        { appId, ownerId: app.ownerId },
        { $set: { context, updatedAt: new Date().toISOString() } },
      );

      if (!result.modifiedCount) {
        return { success: false, error: 'App not found or no permission to update' };
      }

      return { success: true };
    } catch (error) {
      console.error('❌ Error updating app context:', error);
      return { success: false, error: 'Failed to update app context' };
    }
  }
}
