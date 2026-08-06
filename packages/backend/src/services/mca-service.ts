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
import { type McaToolAnnotations, McaToolAnnotationsSchema } from '@teros/shared';
import { readFileSync } from 'fs';
import * as fs from 'fs/promises';
import type { Db } from 'mongodb';
import * as path from 'path';
import type { AuthManager } from '../auth/auth-manager';
import { config } from '../config';
import type { SecretsManager } from '../secrets/secrets-manager';
import { createInstallPermissions } from '../types/permissions';
import type {
  AgentAppAccess,
  AgentApps,
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

  // Cache for ensureProvisionedApps: agentId → timestamp of last run
  // Avoids re-running the full provisioning logic on every agent.get-apps call.
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
    // Unique constraint: same owner cannot have two apps with same name
    await this.appsCollection.createIndex({ ownerId: 1, name: 1 }, { unique: true });
    // Fast lookup by appId
    await this.appsCollection.createIndex({ appId: 1 }, { unique: true });
    // Fast lookup by owner
    await this.appsCollection.createIndex({ ownerId: 1 });
    // MCA catalog: unique mcaId
    await this.mcaCatalogCollection.createIndex({ mcaId: 1 }, { unique: true });
    // Agent app access indexes
    await this.accessCollection.createIndex({ agentId: 1 });
    await this.accessCollection.createIndex({ appId: 1 });
    await this.accessCollection.createIndex({ agentId: 1, appId: 1 }, { unique: true });
    console.log('[McaService] Database indexes created');
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

    // If volumes not explicitly provided, auto-resolve from owner
    if (!volumes?.length) {
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
   * conservative, never blocks the install.
   */
  private loadStaticToolDefs(mcaId: string): Array<{ name: string; annotations?: McaToolAnnotations }> {
    try {
      const toolsPath = path.join(config.mca.basePath, mcaId, 'tools.json');
      const content = readFileSync(toolsPath, 'utf-8');
      const parsed = JSON.parse(content) as {
        tools?: Array<{ name: string; annotations?: unknown }>;
      };
      if (!Array.isArray(parsed.tools)) return [];
      return parsed.tools.map((t) => {
        const result = t.annotations ? McaToolAnnotationsSchema.safeParse(t.annotations) : null;
        return { name: t.name, annotations: result?.success ? result.data : undefined };
      });
    } catch {
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
    // (e.g. mca.teros.docker-env, which mounts the Docker socket) into their own
    // workspace and reach host root. Gating here closes both callers at once.
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
    const appName = name || (await this.generateDefaultAppName(mcaId, workspaceId));

    const validation = this.validateAppName(appName);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    // Check name availability within workspace
    if (!(await this.isAppNameAvailable(workspaceId, appName))) {
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
      name: appName,
      status: 'active',
      volumes,
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
  async isAppNameAvailable(ownerId: string, name: string, excludeAppId?: string): Promise<boolean> {
    const filter: any = { ownerId, name };
    if (excludeAppId) {
      filter.appId = { $ne: excludeAppId };
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
    const workspace = await this.workspaceService?.getWorkspace(app.ownerId);
    const member = workspace?.members?.find((m: any) => m.userId === userId);
    const isOwner = workspace?.ownerId === userId;
    const isWriter = member?.role === 'admin' || member?.role === 'write';
    if (!isOwner && !isWriter) {
      return { success: false, error: 'App not found or access denied' };
    }

    // Validate format
    const validation = this.validateAppName(newName);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    // Check availability against the real owner (workspaceId)
    const isAvailable = await this.isAppNameAvailable(app.ownerId, newName, appId);
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
  async generateDefaultAppName(mcaId: string, ownerId: string): Promise<string> {
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
    if (await this.isAppNameAvailable(ownerId, baseName)) {
      return baseName;
    }

    // Find next available number
    let counter = 2;
    while (counter < 1000) {
      const candidateName = `${baseName}-${counter}`;

      // Validate candidate name (should always be valid, but check to be safe)
      const candidateValidation = this.validateAppName(candidateName);
      if (candidateValidation.valid && (await this.isAppNameAvailable(ownerId, candidateName))) {
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
    const workspace = await this.workspaceService?.getWorkspace(app.ownerId);
    const member = workspace?.members?.find((m: any) => m.userId === ownerId);
    const isOwner = workspace?.ownerId === ownerId;
    const isAdmin = member?.role === 'admin' || member?.role === 'write';
    if (!isOwner && !isAdmin) {
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
   */
  async grantAccess(access: Omit<AgentAppAccess, 'grantedAt'>): Promise<AgentAppAccess> {
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
   * ADD-ONLY for core defaults: this provisions system ∪ core.defaultApps and
   * never deprovisions. If a core's `defaultApps` later shrinks, already-granted
   * apps are intentionally left in place (no reconciliation of removals) — by
   * design, so a config change can't silently strip an agent's tools. Removing a
   * core default from existing agents is an explicit admin action.
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

    console.log(
      `[McaService] Provisioning ${mcasToProvision.length} MCAs for ${agentId} ` +
        `(${systemMcas.length} system + ${defaultAppMcas.length} core-default): ` +
        `${mcasToProvision.map((m) => m.mcaId).join(', ')}`,
    );

    for (const mca of mcasToProvision) {
      const requiredRole = mca.availability?.role || 'user';
      const userHasAccess = hasRequiredRole(requiredRole);

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
          name: appName,
          status: 'active',
          volumes: volumes?.length ? volumes : undefined,
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
  async getAgentApps(agentId: string, workspaceId?: string): Promise<AgentApps> {
    // Auto-provision system apps — throttled to once every 5 minutes per agent
    // to avoid running the full provisioning logic on every agent.get-apps call.
    const lastRun = this.ensureProvisionedAppsCache.get(agentId) ?? 0;
    if (Date.now() - lastRun > this.ENSURE_PROVISIONED_APPS_TTL_MS) {
      await this.ensureProvisionedApps(agentId, workspaceId);
      this.ensureProvisionedAppsCache.set(agentId, Date.now());
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

    // Build permissions object with all tools set to the same permission
    const toolsPermissions: Record<string, ToolPermission> = {};
    for (const toolName of app.mca.tools) {
      toolsPermissions[toolName] = permission;
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
   *   - New tools are added with the default permission ('ask')
   *   - Removed tools are cleaned up from the permissions map
   *   - Existing tool permissions are preserved unchanged
   *
   * Called by McaBootSync after updating the catalog entry.
   *
   * @param mcaId - The MCA whose tools changed
   * @param newToolNames - The current tool names from the updated tools.json
   * @returns Number of apps that were updated
   */
  async propagateToolsToApps(mcaId: string, newToolNames: string[]): Promise<number> {
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

      // Keep permissions for tools that still exist; add new tools with 'ask'
      for (const toolName of newToolNames) {
        if (toolName in existingToolPerms) {
          // Preserve existing permission
          updatedToolPerms[toolName] = existingToolPerms[toolName];
        } else {
          // New tool — default to 'ask'
          updatedToolPerms[toolName] = 'ask';
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
      const member = workspace?.members?.find((m: any) => m.userId === userId);
      const isOwner = workspace?.ownerId === userId;
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
