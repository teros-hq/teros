/**
 * MCA Resources Handlers
 *
 * User-scoped resource handlers for MCA → Backend communication.
 * All handlers verify ownership before allowing access.
 *
 * NOTE: Body is parsed once in mca-callback-routes.ts and passed to handlers.
 */

import { randomBytes } from 'crypto';
import type { ServerResponse } from 'http';
import type { Db } from 'mongodb';
import {
  canAccessAgent,
  canAccessApp,
  canAccessWorkspace,
  getUserWorkspaceIds,
} from '../auth/workspace-access';
import type { AgentProvisioningService } from '../services/agent-provisioning-service';
import type { McaOAuth } from '../auth/mca-oauth';
import type { McaService } from '../services/mca-service';
import type { PubSubService } from '../services/pubsub-service';
import type { AppToolPermissions, McpCatalogEntry, ToolPermission } from '../types/database';
import { buildToolPermissionsView, isPrivateTool, normalizeToolName } from '../types/permissions';
import { buildAvatarUrl } from '../lib/avatar-url';
import { buildAgentCreatedPayload } from '../lib/agent-payload';
import { SkillService } from '../services/skill-service';
import { canCreateWorkspace, UpgradeRequiredError } from '../services/billing-gate.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ResourceContext {
  userId: string;
  channelId: string;
  appId?: string;
}

// ============================================================================
// HELPERS
// ============================================================================

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

// Authz helpers (getUserWorkspaceIds, canAccessWorkspace, canAccessAgent, canAccessApp)
// live in `../auth/workspace-access.ts` — shared with WS handlers.

// ============================================================================
// AGENTS
// ============================================================================

export async function handleAgentList(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  body: { workspaceId?: string },
): Promise<void> {
  const userWorkspaceIds = await getUserWorkspaceIds(db, ctx.userId);

  // Build query: agents owned by user OR in user's workspaces
  let query: any;

  if (body.workspaceId) {
    // Validate access to the requested workspace
    if (
      !userWorkspaceIds.includes(body.workspaceId) &&
      !(await db
        .collection('workspaces')
        .findOne({ workspaceId: body.workspaceId, ownerId: ctx.userId, status: 'active' }))
    ) {
      sendJson(res, 403, { error: 'Access denied to workspace' });
      return;
    }

    // Find the workspace owner to include their superagents (workspaceId: null)
    const workspace = await db.collection('workspaces').findOne({ workspaceId: body.workspaceId });
    const workspaceOwnerId = (workspace as any)?.ownerId;
    const superagentOwnerIds = Array.from(
      new Set([ctx.userId, workspaceOwnerId].filter(Boolean)),
    );

    query = {
      $or: [
        { workspaceId: body.workspaceId },
        { ownerId: { $in: superagentOwnerIds }, workspaceId: { $in: [null, undefined] } },
      ],
    };
  } else {
    // No workspace filter: return agents in user's workspaces + user's superagents
    query = {
      $or: [
        { ownerId: ctx.userId, workspaceId: { $in: [null, undefined] as any } },
        { workspaceId: { $in: userWorkspaceIds } },
      ],
    };
  }

  const agents = await db.collection('agents').find(query).toArray();

  sendJson(res, 200, {
    agents: agents.map((a) => ({
      agentId: a.agentId,
      name: a.name,
      fullName: a.fullName,
      role: a.role,
      intro: a.intro,
      avatarUrl: buildAvatarUrl(a.avatarUrl),
      coreId: a.coreId,
      workspaceId: a.workspaceId,
      ownerId: a.ownerId,
      createdAt: a.createdAt,
    })),
  });
}

export async function handleAgentGet(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  agentId: string,
): Promise<void> {
  if (!(await canAccessAgent(db, ctx.userId, agentId))) {
    sendJson(res, 403, { error: 'Access denied to agent' });
    return;
  }

  const agent = await db.collection('agents').findOne({ agentId });
  if (!agent) {
    sendJson(res, 404, { error: 'Agent not found' });
    return;
  }

  sendJson(res, 200, {
    agentId: agent.agentId,
    name: agent.name,
    fullName: agent.fullName,
    role: agent.role,
    intro: agent.intro,
    avatarUrl: buildAvatarUrl(agent.avatarUrl),
    context: agent.context,
    coreId: agent.coreId,
    workspaceId: agent.workspaceId,
    ownerId: agent.ownerId,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  });
}

export async function handleAgentCreate(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  body: {
    name: string;
    fullName: string;
    role: string;
    intro: string;
    workspaceId?: string;
    context?: string;
  },
  provisioning: AgentProvisioningService,
  pubSubService: PubSubService,
): Promise<void> {
  if (!body.name || !body.fullName || !body.role || !body.intro) {
    sendJson(res, 400, { error: 'Missing required fields: name, fullName, role, intro' });
    return;
  }

  // Verify workspace access if specified
  if (body.workspaceId) {
    if (!(await canAccessWorkspace(db, ctx.userId, body.workspaceId))) {
      sendJson(res, 403, { error: 'Access denied to workspace' });
      return;
    }
  }

  // Single creation path — shapes and provisions the agent exactly like
  // onboarding and agent.create (core derived by scope, apps provisioned
  // eagerly). No hand-built agent doc here: that is the whole point of routing
  // every creation through AgentProvisioningService.
  try {
    const agent = await provisioning.createAgentFromCore({
      ownerId: ctx.userId,
      workspaceId: body.workspaceId,
      profile: {
        name: body.name,
        fullName: body.fullName,
        role: body.role,
        intro: body.intro,
        context: body.context,
      },
    });

    sendJson(res, 201, { ...agent, avatarUrl: buildAvatarUrl(agent.avatarUrl) });

    // Broadcast agent.created so connected clients' navbars update in realtime.
    // Mirrors the UI path (handlers/domains/agent/create.ts) — same event shape.
    // Emitted AFTER the 201: a transient broadcast failure must not turn a
    // successful, persisted creation into a 500 (→ LLM retry → duplicate agent).
    const event = { type: 'agent.created', agent: buildAgentCreatedPayload(agent) };
    if (agent.workspaceId) {
      await pubSubService
        .broadcastToWorkspace(agent.workspaceId, event)
        .catch((err) => console.warn('[handleAgentCreate] broadcast failed', err));
    } else {
      pubSubService.broadcastToUser(ctx.userId, event);
    }
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : 'Failed to create agent',
    });
  }
}

export async function handleAgentUpdate(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  agentId: string,
  body: {
    name?: string;
    fullName?: string;
    role?: string;
    intro?: string;
    responseStyle?: string;
    avatarUrl?: string;
    context?: string;
  },
): Promise<void> {
  if (!(await canAccessAgent(db, ctx.userId, agentId))) {
    sendJson(res, 403, { error: 'Access denied to agent' });
    return;
  }

  const updates: any = { updatedAt: new Date().toISOString() };
  if (body.name) updates.name = body.name;
  if (body.fullName) updates.fullName = body.fullName;
  if (body.role) updates.role = body.role;
  if (body.intro) updates.intro = body.intro;
  if (body.responseStyle) updates.responseStyle = body.responseStyle;
  if (body.avatarUrl) updates.avatarUrl = body.avatarUrl;
  if (body.context !== undefined) updates.context = body.context;

  await db.collection('agents').updateOne({ agentId }, { $set: updates });

  const agent = await db.collection('agents').findOne({ agentId });
  sendJson(res, 200, agent ? { ...agent, avatarUrl: buildAvatarUrl(agent.avatarUrl) } : agent);
}

export async function handleAgentDelete(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  agentId: string,
): Promise<void> {
  if (!(await canAccessAgent(db, ctx.userId, agentId))) {
    sendJson(res, 403, { error: 'Access denied to agent' });
    return;
  }

  // Read the agent BEFORE deleting to enrich the response with its name.
  // Enables callers (MCAs, UI) to show "Agent 'X' deleted" without a
  // follow-up lookup.
  const agent = await db.collection('agents').findOne({ agentId });
  const name = (agent?.fullName as string | undefined) ?? (agent?.name as string | undefined) ?? agentId;

  // Delete agent and access grants
  await db.collection('agents').deleteOne({ agentId });
  await db.collection('agent_app_access').deleteMany({ agentId });

  sendJson(res, 200, {
    success: true,
    message: `Agent '${name}' deleted`,
    agentId,
    name,
  });
}

// ============================================================================
// WORKSPACES
// ============================================================================

export async function handleWorkspaceList(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
): Promise<void> {
  // Get workspaces where user is owner
  const ownedWorkspaces = await db
    .collection('workspaces')
    .find({ ownerId: ctx.userId, status: { $ne: 'archived' } })
    .toArray();

  // Get workspaces where user is a member
  const memberships = await db
    .collection('workspace_members')
    .find({ userId: ctx.userId })
    .toArray();
  const memberWorkspaceIds = memberships.map((m) => m.workspaceId);

  const memberWorkspaces =
    memberWorkspaceIds.length > 0
      ? await db
          .collection('workspaces')
          .find({ workspaceId: { $in: memberWorkspaceIds }, status: { $ne: 'archived' } })
          .toArray()
      : [];

  // Combine and dedupe
  const allWorkspaces = [...ownedWorkspaces];
  for (const ws of memberWorkspaces) {
    if (!allWorkspaces.find((w) => w.workspaceId === ws.workspaceId)) {
      allWorkspaces.push(ws);
    }
  }

  sendJson(res, 200, {
    workspaces: allWorkspaces.map((w) => ({
      workspaceId: w.workspaceId,
      name: w.name,
      description: w.description,
      context: w.context,
      ownerId: w.ownerId,
      status: w.status,
      createdAt: w.createdAt,
      isOwner: w.ownerId === ctx.userId,
      role:
        memberships.find((m) => m.workspaceId === w.workspaceId)?.role ||
        (w.ownerId === ctx.userId ? 'owner' : undefined),
    })),
  });
}

export async function handleWorkspaceGet(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  workspaceId: string,
): Promise<void> {
  if (!(await canAccessWorkspace(db, ctx.userId, workspaceId))) {
    sendJson(res, 403, { error: 'Access denied to workspace' });
    return;
  }

  const workspace = await db.collection('workspaces').findOne({ workspaceId });
  if (!workspace) {
    sendJson(res, 404, { error: 'Workspace not found' });
    return;
  }

  // Get members
  const members = await db.collection('workspace_members').find({ workspaceId }).toArray();

  sendJson(res, 200, {
    workspaceId: workspace.workspaceId,
    name: workspace.name,
    description: workspace.description,
    context: workspace.context,
    ownerId: workspace.ownerId,
    status: workspace.status,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    members: members.map((m) => ({
      userId: m.userId,
      role: m.role,
      joinedAt: m.joinedAt,
    })),
  });
}

export async function handleWorkspaceCreate(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  workspaceService: any, // WorkspaceService type
  body: { name: string; description?: string },
): Promise<void> {
  if (!body.name) {
    sendJson(res, 400, { error: 'Missing required field: name' });
    return;
  }

  try {
    // Billing gate: check workspace limit against subscription tier
    const allowed = await canCreateWorkspace(db, ctx.userId);
    if (!allowed) {
      sendJson(res, 403, {
        error: 'Workspace limit reached',
        code: 'UPGRADE_REQUIRED',
        message: 'You have reached the workspace limit on your current plan. Upgrade to create more workspaces.',
      });
      return;
    }

    // Use WorkspaceService to ensure volume is created
    const workspace = await workspaceService.createWorkspace(ctx.userId, {
      name: body.name,
      description: body.description,
    });

    sendJson(res, 201, workspace);
  } catch (error: any) {
    console.error('[handleWorkspaceCreate] Error:', error);
    if (error instanceof UpgradeRequiredError) {
      sendJson(res, 403, {
        error: 'Workspace limit reached',
        code: 'UPGRADE_REQUIRED',
        message: error.message,
        feature: error.feature,
        currentTier: error.currentTier,
        requiredTier: error.requiredTier,
      });
      return;
    }
    sendJson(res, 500, { error: 'Failed to create workspace', message: error.message });
  }
}

export async function handleWorkspaceUpdate(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  workspaceId: string,
  body: { name?: string; description?: string; context?: string },
): Promise<void> {
  if (!(await canAccessWorkspace(db, ctx.userId, workspaceId))) {
    sendJson(res, 403, { error: 'Access denied to workspace' });
    return;
  }

  const updates: any = { updatedAt: new Date().toISOString() };
  if (body.name) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.context !== undefined) updates.context = body.context;

  await db.collection('workspaces').updateOne({ workspaceId }, { $set: updates });

  const workspace = await db.collection('workspaces').findOne({ workspaceId });
  sendJson(res, 200, workspace);
}

export async function handleWorkspaceArchive(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  workspaceId: string,
): Promise<void> {
  // Only owner can archive
  const workspace = await db.collection('workspaces').findOne({ workspaceId });
  if (!workspace || workspace.ownerId !== ctx.userId) {
    sendJson(res, 403, { error: 'Only the owner can archive a workspace' });
    return;
  }

  await db
    .collection('workspaces')
    .updateOne(
      { workspaceId },
      { $set: { status: 'archived', updatedAt: new Date().toISOString() } },
    );

  const name = (workspace.name as string | undefined) ?? workspaceId;
  sendJson(res, 200, {
    success: true,
    message: `Workspace '${name}' archived`,
    workspaceId,
    name,
  });
}

export async function handleWorkspaceMemberAdd(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  workspaceId: string,
  body: { userId: string; role: string },
): Promise<void> {
  // Only owner or admin can add members
  const workspace = await db.collection('workspaces').findOne({ workspaceId });
  if (!workspace) {
    sendJson(res, 404, { error: 'Workspace not found' });
    return;
  }

  const isOwner = workspace.ownerId === ctx.userId;
  const membership = await db
    .collection('workspace_members')
    .findOne({ workspaceId, userId: ctx.userId });
  const isAdmin = membership?.role === 'admin';

  if (!isOwner && !isAdmin) {
    sendJson(res, 403, { error: 'Only owner or admin can add members' });
    return;
  }

  if (!body.userId || !body.role) {
    sendJson(res, 400, { error: 'Missing required fields: userId, role' });
    return;
  }

  // Check if already a member
  const existing = await db
    .collection('workspace_members')
    .findOne({ workspaceId, userId: body.userId });
  if (existing) {
    sendJson(res, 409, { error: 'User is already a member' });
    return;
  }

  const member = {
    workspaceId,
    userId: body.userId,
    role: body.role,
    joinedAt: new Date().toISOString(),
  };

  await db.collection('workspace_members').insertOne(member);

  const workspaceName = (workspace.name as string | undefined) ?? workspaceId;
  sendJson(res, 201, {
    success: true,
    message: `Added member to '${workspaceName}' as ${body.role}`,
    workspaceId,
    workspaceName,
    userId: body.userId,
    role: body.role,
  });
}

export async function handleWorkspaceMemberRemove(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  workspaceId: string,
  targetUserId: string,
): Promise<void> {
  const workspace = await db.collection('workspaces').findOne({ workspaceId });
  if (!workspace) {
    sendJson(res, 404, { error: 'Workspace not found' });
    return;
  }

  const isOwner = workspace.ownerId === ctx.userId;
  const membership = await db
    .collection('workspace_members')
    .findOne({ workspaceId, userId: ctx.userId });
  const isAdmin = membership?.role === 'admin';
  const isSelf = targetUserId === ctx.userId;

  if (!isOwner && !isAdmin && !isSelf) {
    sendJson(res, 403, { error: 'Cannot remove this member' });
    return;
  }

  await db.collection('workspace_members').deleteOne({ workspaceId, userId: targetUserId });

  const workspaceName = (workspace.name as string | undefined) ?? workspaceId;
  sendJson(res, 200, {
    success: true,
    message: `Removed member from '${workspaceName}'`,
    workspaceId,
    workspaceName,
    userId: targetUserId,
  });
}

export async function handleWorkspaceMemberUpdate(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  workspaceId: string,
  targetUserId: string,
  body: { role: string },
): Promise<void> {
  const workspace = await db.collection('workspaces').findOne({ workspaceId });
  if (!workspace) {
    sendJson(res, 404, { error: 'Workspace not found' });
    return;
  }

  const isOwner = workspace.ownerId === ctx.userId;
  if (!isOwner) {
    sendJson(res, 403, { error: 'Only owner can change member roles' });
    return;
  }

  if (!body.role) {
    sendJson(res, 400, { error: 'Missing required field: role' });
    return;
  }

  await db
    .collection('workspace_members')
    .updateOne({ workspaceId, userId: targetUserId }, { $set: { role: body.role } });

  const workspaceName = (workspace.name as string | undefined) ?? workspaceId;
  sendJson(res, 200, {
    success: true,
    message: `Updated member role in '${workspaceName}' to ${body.role}`,
    workspaceId,
    workspaceName,
    userId: targetUserId,
    role: body.role,
  });
}

// ============================================================================
// APPS
// ============================================================================

export async function handleAppList(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  body?: {},
): Promise<void> {
  // Return apps from all workspaces the user has access to
  const userWorkspaceIds = await getUserWorkspaceIds(db, ctx.userId);
  const ownedWorkspaces = await db
    .collection('workspaces')
    .find({ ownerId: ctx.userId, status: { $ne: 'archived' } })
    .toArray();
  const ownedWorkspaceIds = ownedWorkspaces.map((w) => w.workspaceId);
  const allWorkspaceIds = Array.from(new Set([...userWorkspaceIds, ...ownedWorkspaceIds]));

  const query: any = {
    status: 'active',
    ownerId: { $in: allWorkspaceIds },
    ownerType: 'workspace',
  };

  const apps = await db.collection('apps').find(query).toArray();

  sendJson(res, 200, {
    apps: apps.map((a) => ({
      appId: a.appId,
      mcaId: a.mcaId,
      name: a.name,
      status: a.status,
      createdAt: a.createdAt,
    })),
  });
}

export async function handleAppGet(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  appId: string,
): Promise<void> {
  if (!(await canAccessApp(db, ctx.userId, appId))) {
    sendJson(res, 403, { error: 'Access denied to app' });
    return;
  }

  const app = await db.collection('apps').findOne({ appId });
  if (!app) {
    sendJson(res, 404, { error: 'App not found' });
    return;
  }

  // Get MCA info from catalog
  const mca = await db.collection('mca_catalog').findOne({ mcaId: app.mcaId });

  sendJson(res, 200, {
    appId: app.appId,
    mcaId: app.mcaId,
    name: app.name,
    status: app.status,
    ownerId: app.ownerId,
    createdAt: app.createdAt,
    mca: mca
      ? {
          name: mca.name,
          description: mca.description,
          category: mca.category,
        }
      : null,
  });
}

export async function handleAppInstall(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  body: { mcaId: string; name?: string; ownerId?: string },
  mcaService: McaService,
  pubSubService?: PubSubService,
): Promise<void> {
  if (!body.mcaId) {
    sendJson(res, 400, { error: 'Missing required field: mcaId' });
    return;
  }

  // Verify MCA exists in catalog and is enabled
  const mca = await mcaService.getMcaFromCatalog(body.mcaId);
  if (!mca) {
    sendJson(res, 404, { error: `MCA '${body.mcaId}' not found in catalog` });
    return;
  }
  if (mca.availability?.enabled === false) {
    sendJson(res, 403, { error: `MCA '${body.mcaId}' is not available` });
    return;
  }

  // Check role requirements — reject if user doesn't have the required role
  const requiredRole = mca.availability?.role || 'user';
  if (requiredRole !== 'user') {
    const roleHierarchy: Record<string, number> = { user: 0, admin: 1, super: 2 };
    const user = await db.collection('users').findOne({ userId: ctx.userId }, { projection: { role: 1 } });
    const userLevel = roleHierarchy[user?.role || 'user'] ?? 0;
    const requiredLevel = roleHierarchy[requiredRole] ?? 0;
    if (userLevel < requiredLevel) {
      sendJson(res, 403, { error: `This MCA requires ${requiredRole} role. You have ${user?.role || 'user'} role.` });
      return;
    }
  }

  // Apps are always workspace-owned. Explicit ownerId must be an accessible
  // workspace; without one, default to the user's private workspace — same
  // contract as the WS app.install path and the install-app tool description.
  let ownerId = body.ownerId;
  if (ownerId) {
    if (!(await canAccessWorkspace(db, ctx.userId, ownerId))) {
      sendJson(res, 403, { error: 'Access denied to workspace' });
      return;
    }
  } else {
    const user = await db
      .collection('users')
      .findOne({ userId: ctx.userId }, { projection: { privateWorkspaceId: 1 } });
    ownerId = user?.privateWorkspaceId as string | undefined;
    if (!ownerId) {
      sendJson(res, 400, { error: 'User has no private workspace configured' });
      return;
    }
  }

  // Idempotent install for single-instance MCAs: return the existing app and
  // heal a missing superagent grant, mirroring the WS app.install path.
  if (!mca.availability?.multi) {
    const existing = await mcaService.getAppByMcaIdAndOwner(body.mcaId, ownerId);
    if (existing) {
      await mcaService.grantAccessToUserSuperagents(ctx.userId, existing.appId);
      sendJson(res, 200, {
        appId: existing.appId,
        mcaId: existing.mcaId,
        name: existing.name,
        ownerId: existing.ownerId,
        status: existing.status,
        alreadyInstalled: true,
      });
      return;
    }
  }

  let appName: string;
  if (body.name) {
    const validation = mcaService.validateAppName(body.name);
    if (!validation.valid) {
      sendJson(res, 400, { error: validation.error || 'Invalid app name' });
      return;
    }
    if (!(await mcaService.isAppNameAvailable(ownerId, body.name))) {
      sendJson(res, 409, { error: `App name "${body.name}" is already in use` });
      return;
    }
    appName = body.name;
  } else {
    appName = await mcaService.generateDefaultAppName(body.mcaId, ownerId);
  }

  // createApp auto-resolves the workspace volume mount
  const app = await mcaService.createApp({
    appId: generateId('app'),
    mcaId: body.mcaId,
    ownerId,
    ownerType: 'workspace',
    name: appName,
    status: 'active',
  });

  // Auto-grant to the user's superagents; grantAccess invalidates the tool
  // cache, so the installing agent picks up the new tools without a restart.
  await mcaService.grantAccessToUserSuperagents(ctx.userId, app.appId);

  if (pubSubService) {
    await pubSubService.broadcastToWorkspace(ownerId, {
      type: 'app.installed',
      app: {
        appId: app.appId,
        mcaId: app.mcaId,
        mcaName: mca.name,
        name: app.name,
        description: mca.description,
        icon: mca.icon,
        color: mca.color,
        category: mca.category,
        status: app.status,
      },
      ownerId,
    });
  }

  sendJson(res, 201, {
    appId: app.appId,
    mcaId: app.mcaId,
    name: app.name,
    ownerId: app.ownerId,
    ownerType: app.ownerType,
    status: app.status,
    createdAt: app.createdAt,
  });
}

export async function handleWorkspaceAppList(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  body?: { workspaceId?: string },
): Promise<void> {
  if (!body?.workspaceId) {
    sendJson(res, 400, { error: 'Missing required field: workspaceId' });
    return;
  }

  // Verify user has access to this workspace
  const canAccess = await canAccessWorkspace(db, ctx.userId, body.workspaceId);
  if (!canAccess) {
    sendJson(res, 403, { error: 'Access denied to workspace' });
    return;
  }

  // Show workspace apps for the specified workspace
  const query: any = {
    status: 'active',
    ownerId: body.workspaceId,
    ownerType: 'workspace',
  };

  const apps = await db.collection('apps').find(query).toArray();

  sendJson(res, 200, {
    apps: apps.map((a) => ({
      appId: a.appId,
      mcaId: a.mcaId,
      name: a.name,
      status: a.status,
      createdAt: a.createdAt,
    })),
  });
}

export async function handleAppUninstall(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  appId: string,
): Promise<void> {
  if (!(await canAccessApp(db, ctx.userId, appId))) {
    sendJson(res, 403, { error: 'Access denied to app' });
    return;
  }

  // Read the app BEFORE deleting to enrich the response with its name.
  const app = await db.collection('apps').findOne({ appId });
  const name = (app?.name as string | undefined) ?? appId;

  // Delete app and access grants
  await db.collection('apps').deleteOne({ appId });
  await db.collection('agent_app_access').deleteMany({ appId });

  sendJson(res, 200, {
    success: true,
    message: `App '${name}' uninstalled`,
    appId,
    name,
  });
}

export async function handleAppRename(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  appId: string,
  body: { name: string },
): Promise<void> {
  if (!(await canAccessApp(db, ctx.userId, appId))) {
    sendJson(res, 403, { error: 'Access denied to app' });
    return;
  }

  if (!body.name) {
    sendJson(res, 400, { error: 'Missing required field: name' });
    return;
  }

  await db
    .collection('apps')
    .updateOne({ appId }, { $set: { name: body.name, updatedAt: new Date().toISOString() } });

  const app = await db.collection('apps').findOne({ appId });
  sendJson(res, 200, app);
}

// ============================================================================
// CATALOG
// ============================================================================

export async function handleCatalogList(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  body: { category?: string; includeHidden?: boolean },
): Promise<void> {
  const query: any = {};
  if (body.category) query.category = body.category;
  if (!body.includeHidden) query.hidden = { $ne: true };

  const mcas = await db.collection('mca_catalog').find(query).toArray();

  sendJson(res, 200, {
    catalog: mcas.map((m) => ({
      mcaId: m.mcaId,
      name: m.name,
      description: m.description,
      category: m.category,
      icon: m.icon,
      multi: m.multi,
    })),
  });
}

// ============================================================================
// ACCESS CONTROL
// ============================================================================

export async function handleAccessGrant(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  body: { agentId: string; appId: string },
  invalidateToolCache?: (agentId: string) => Promise<void>,
): Promise<void> {
  if (!body.agentId || !body.appId) {
    sendJson(res, 400, { error: 'Missing required fields: agentId, appId' });
    return;
  }

  // Verify access to both agent and app
  if (!(await canAccessAgent(db, ctx.userId, body.agentId))) {
    sendJson(res, 403, { error: 'Access denied to agent' });
    return;
  }

  if (!(await canAccessApp(db, ctx.userId, body.appId))) {
    sendJson(res, 403, { error: 'Access denied to app' });
    return;
  }

  // Validate scope compatibility: agent and app must be in the same scope
  const agent = await db.collection('agents').findOne({ agentId: body.agentId });
  const app = await db.collection('apps').findOne({ appId: body.appId });

  if (!agent || !app) {
    sendJson(res, 404, { error: 'Agent or app not found' });
    return;
  }

  const agentWorkspaceId = agent.workspaceId;
  const appWorkspaceId = app.ownerId;

  if (agentWorkspaceId && appWorkspaceId && agentWorkspaceId !== appWorkspaceId) {
    sendJson(res, 400, {
      error: 'Agent and app must belong to the same workspace.',
    });
    return;
  }

  // Check if already granted
  const existing = await db.collection('agent_app_access').findOne({
    agentId: body.agentId,
    appId: body.appId,
  });

  if (existing) {
    sendJson(res, 409, { error: 'Access already granted' });
    return;
  }

  const access = {
    agentId: body.agentId,
    appId: body.appId,
    grantedAt: new Date().toISOString(),
    grantedBy: ctx.userId,
  };

  await db.collection('agent_app_access').insertOne(access);

  // Hot-reload: invalidate the tool executor cache so active conversations
  // pick up the new app immediately without a backend restart.
  if (invalidateToolCache) {
    await invalidateToolCache(body.agentId).catch(() => {/* non-fatal */});
  }

  const agentName = (agent.fullName as string | undefined) ?? (agent.name as string | undefined) ?? body.agentId;
  const appName = (app.name as string | undefined) ?? body.appId;
  sendJson(res, 201, {
    success: true,
    message: `Granted '${appName}' access to '${agentName}'`,
    agentId: body.agentId,
    appId: body.appId,
    agentName,
    appName,
    grantedAt: access.grantedAt,
    grantedBy: access.grantedBy,
  });
}

export async function handleAccessRevoke(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  agentId: string,
  appId: string,
  invalidateToolCache?: (agentId: string) => Promise<void>,
): Promise<void> {
  // Verify access to both agent and app
  if (!(await canAccessAgent(db, ctx.userId, agentId))) {
    sendJson(res, 403, { error: 'Access denied to agent' });
    return;
  }

  if (!(await canAccessApp(db, ctx.userId, appId))) {
    sendJson(res, 403, { error: 'Access denied to app' });
    return;
  }

  // Read names before deleting — enables rich feedback.
  const [agent, app] = await Promise.all([
    db.collection('agents').findOne({ agentId }),
    db.collection('apps').findOne({ appId }),
  ]);
  const agentName = (agent?.fullName as string | undefined) ?? (agent?.name as string | undefined) ?? agentId;
  const appName = (app?.name as string | undefined) ?? appId;

  await db.collection('agent_app_access').deleteOne({ agentId, appId });

  // Hot-reload: invalidate the tool executor cache so active conversations
  // stop seeing the revoked app immediately without a backend restart.
  if (invalidateToolCache) {
    await invalidateToolCache(agentId).catch(() => {/* non-fatal */});
  }

  sendJson(res, 200, {
    success: true,
    message: `Revoked '${appName}' access from '${agentName}'`,
    agentId,
    appId,
    agentName,
    appName,
  });
}

export async function handleAgentAppsList(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  agentId: string,
): Promise<void> {
  if (!(await canAccessAgent(db, ctx.userId, agentId))) {
    sendJson(res, 403, { error: 'Access denied to agent' });
    return;
  }

  const accesses = await db.collection('agent_app_access').find({ agentId }).toArray();

  const appIds = accesses.map((a) => a.appId);
  const apps =
    appIds.length > 0
      ? await db
          .collection('apps')
          .find({ appId: { $in: appIds } })
          .toArray()
      : [];

  sendJson(res, 200, {
    apps: apps.map((a) => ({
      appId: a.appId,
      mcaId: a.mcaId,
      name: a.name,
    })),
  });
}

export async function handleAppAccessList(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  appId: string,
): Promise<void> {
  if (!(await canAccessApp(db, ctx.userId, appId))) {
    sendJson(res, 403, { error: 'Access denied to app' });
    return;
  }

  const accesses = await db.collection('agent_app_access').find({ appId }).toArray();

  const agentIds = accesses.map((a) => a.agentId);
  const agents =
    agentIds.length > 0
      ? await db
          .collection('agents')
          .find({ agentId: { $in: agentIds } })
          .toArray()
      : [];

  sendJson(res, 200, {
    agents: agents.map((a) => ({
      agentId: a.agentId,
      name: a.name,
      fullName: a.fullName,
    })),
  });
}

// ============================================================================
// APP TOOL PERMISSIONS
// ============================================================================

type ToolPermissionChange = ToolPermission | 'default';

const VALID_PERMISSION_CHANGES: readonly string[] = ['allow', 'ask', 'forbid', 'default'];

/**
 * Manage-level check for permission mutations — stricter than canAccessApp,
 * mirroring the WS handlers' canManageApp + workspaceService.canAdmin: app
 * owner, or owner/admin of the owning workspace. System apps are never
 * editable.
 */
async function canManageAppPermissions(
  db: Db,
  userId: string,
  app: { ownerId: string; ownerType?: string },
): Promise<boolean> {
  if (app.ownerId === userId) return true;
  if (app.ownerId === 'system') return false;
  if (app.ownerType === 'workspace' || app.ownerId.startsWith('work_')) {
    const workspace = await db
      .collection('workspaces')
      .findOne({ workspaceId: app.ownerId, status: 'active' });
    if (!workspace) return false;
    if (workspace.ownerId === userId) return true;
    const member = (
      workspace.members as Array<{ userId: string; role?: string }> | undefined
    )?.find((m) => m.userId === userId);
    return member?.role === 'admin';
  }
  return false;
}

async function loadAppWithTools(
  db: Db,
  appId: string,
): Promise<
  | { error: { status: number; message: string } }
  | { app: any; toolNames: string[] }
> {
  const app = await db.collection('apps').findOne({ appId });
  if (!app) return { error: { status: 404, message: 'App not found' } };

  const mca = await db.collection('mca_catalog').findOne({ mcaId: app.mcaId });
  if (!mca) return { error: { status: 404, message: `MCA '${app.mcaId}' not found` } };

  return { app, toolNames: (mca.tools as string[] | undefined) ?? [] };
}

export async function handleAppPermissionsGet(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  appId: string,
): Promise<void> {
  if (!(await canAccessApp(db, ctx.userId, appId))) {
    sendJson(res, 403, { error: 'Access denied to app' });
    return;
  }

  const loaded = await loadAppWithTools(db, appId);
  if ('error' in loaded) {
    sendJson(res, loaded.error.status, { error: loaded.error.message });
    return;
  }

  const { tools, summary } = buildToolPermissionsView(loaded.app, loaded.toolNames, new Map());
  sendJson(res, 200, {
    appId,
    appName: loaded.app.name,
    defaultPermission: loaded.app.permissions?.defaultPermission ?? 'ask',
    tools,
    summary,
  });
}

/**
 * Batch-update tool permissions for an app.
 *
 * Body:
 *   - `all`: set every tool at once ('allow' | 'ask' | 'forbid'), or 'default'
 *     to clear all per-tool pins back to the app default ('ask' + read-only
 *     auto-allow).
 *   - `tools`: per-tool changes, `{ toolName: 'allow' | 'ask' | 'forbid' | 'default' }`
 *     where 'default' removes that tool's pin. Applied after `all`.
 */
export async function handleAppPermissionsSet(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  appId: string,
  body: { all?: ToolPermissionChange; tools?: Record<string, ToolPermissionChange> },
): Promise<void> {
  const { all, tools: toolChanges } = body;

  if (all === undefined && (!toolChanges || Object.keys(toolChanges).length === 0)) {
    sendJson(res, 400, { error: "Provide 'all' and/or a non-empty 'tools' map" });
    return;
  }
  const invalid = [all, ...Object.values(toolChanges ?? {})].filter(
    (v) => v !== undefined && !VALID_PERMISSION_CHANGES.includes(v),
  );
  if (invalid.length > 0) {
    sendJson(res, 400, {
      error: `Invalid permission value(s): ${invalid.join(', ')}. Must be: allow, ask, forbid, or default`,
    });
    return;
  }

  const loaded = await loadAppWithTools(db, appId);
  if ('error' in loaded) {
    sendJson(res, loaded.error.status, { error: loaded.error.message });
    return;
  }
  const { app, toolNames } = loaded;

  if (!(await canManageAppPermissions(db, ctx.userId, app))) {
    sendJson(res, 403, {
      error: 'Access denied - you need admin access to modify permissions',
    });
    return;
  }

  // Validate requested tool names against the MCA's catalog (kebab-normalised
  // short names, same as the WS handlers).
  const normalizedCatalog = new Map(toolNames.map((name) => [normalizeToolName(name), name]));
  const unknown = Object.keys(toolChanges ?? {}).filter(
    (name) => !normalizedCatalog.has(normalizeToolName(name)),
  );
  if (unknown.length > 0) {
    sendJson(res, 404, { error: `Tool(s) not found in this app: ${unknown.join(', ')}` });
    return;
  }

  const current: AppToolPermissions = app.permissions ?? { tools: {}, defaultPermission: 'ask' };
  let next: AppToolPermissions = {
    defaultPermission: current.defaultPermission ?? 'ask',
    tools: { ...current.tools },
  };

  if (all === 'default') {
    // Reset: no per-tool pins, app default back to 'ask'.
    next = { tools: {}, defaultPermission: 'ask' };
  } else if (all !== undefined) {
    // Pin every public tool + set the default (mirrors setAllToolPermissions).
    const pinned: Record<string, ToolPermission> = {};
    for (const name of toolNames) {
      if (!isPrivateTool(name)) pinned[name] = all;
    }
    next = { tools: pinned, defaultPermission: all };
  }

  for (const [name, change] of Object.entries(toolChanges ?? {})) {
    const catalogName = normalizedCatalog.get(normalizeToolName(name))!;
    if (change === 'default') {
      // Remove the pin under any historical spelling of the name.
      delete next.tools[catalogName];
      delete next.tools[name];
      delete next.tools[normalizeToolName(name)];
    } else {
      next.tools[catalogName] = change;
    }
  }

  const updated = await db
    .collection('apps')
    .findOneAndUpdate(
      { appId },
      { $set: { permissions: next, updatedAt: new Date().toISOString() } },
      { returnDocument: 'after' },
    );
  if (!updated) {
    sendJson(res, 500, { error: 'Failed to update permissions' });
    return;
  }

  const { tools, summary } = buildToolPermissionsView({ permissions: next }, toolNames, new Map());
  console.log(
    `[Resources] app.permissions updated for ${appId} by ${ctx.userId}: all=${all ?? '-'}, tools=${Object.keys(toolChanges ?? {}).length}`,
  );
  sendJson(res, 200, {
    success: true,
    appId,
    appName: app.name,
    defaultPermission: next.defaultPermission,
    tools,
    summary,
  });
}

/** Load an app doc plus its catalog entry, for the auth handlers below. */
async function loadAppAndMca(
  db: Db,
  appId: string,
): Promise<{ app: any; mca: McpCatalogEntry } | { error: { status: number; message: string } }> {
  const app = await db.collection('apps').findOne({ appId });
  if (!app) return { error: { status: 404, message: 'App not found' } };

  const mca = await db.collection('mca_catalog').findOne({ mcaId: app.mcaId });
  if (!mca) return { error: { status: 404, message: `MCA '${app.mcaId}' not found` } };

  return { app, mca: mca as unknown as McpCatalogEntry };
}

/**
 * Show the app's authentication section to the user (`show-app-auth`).
 *
 * The tool-call result itself IS the UI: the chat renders it as an inline
 * auth widget (ShowAppAuthRenderer in TerosCoreRenderer.tsx) with the status
 * and a Connect/Reconnect button — no window is opened and no WS event is
 * broadcast. This handler just authorizes and returns the data the widget
 * (and the agent) need.
 *
 * The auth-status read is best-effort: credentials are per-user and the
 * widget re-resolves the live status when it mounts, so a failure here must
 * not block showing the widget.
 */
export async function handleAppShowAuth(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  appId: string,
  mcaOAuth: McaOAuth | undefined,
): Promise<void> {
  if (!(await canAccessApp(db, ctx.userId, appId))) {
    sendJson(res, 403, { error: 'Access denied to app' });
    return;
  }

  const loaded = await loadAppAndMca(db, appId);
  if ('error' in loaded) {
    sendJson(res, loaded.error.status, { error: loaded.error.message });
    return;
  }
  const { app, mca } = loaded;

  let auth: { status: string; authType: string; message?: string } | undefined;
  if (mcaOAuth) {
    try {
      const info = await mcaOAuth.getAuthStatus(ctx.userId, appId, mca);
      auth = { status: info.status, authType: info.authType, message: info.message };
    } catch (err) {
      console.warn(`[Resources] app.show-auth: getAuthStatus failed for ${appId}`, err);
    }
  }

  console.log(`[Resources] app.show-auth: ${appId} shown to ${ctx.userId} (status=${auth?.status ?? 'unknown'})`);
  sendJson(res, 200, {
    displayed: true,
    appId,
    appName: app.name,
    mcaId: app.mcaId,
    auth,
    note: 'An authentication widget for this app is now shown to the user inside the chat, with a connect/reconnect button. Tell the user what is wrong and ask them to complete the connection there.',
  });
}

/**
 * Check the app's authentication status (`check-app-auth`).
 *
 * Pure read for the agent — same safe fields as show, but nothing is
 * displayed to the user. Unlike show, a failed status read is an error here:
 * the status IS the answer, so degrading silently would mislead the agent.
 */
export async function handleAppCheckAuth(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  appId: string,
  mcaOAuth: McaOAuth | undefined,
): Promise<void> {
  if (!(await canAccessApp(db, ctx.userId, appId))) {
    sendJson(res, 403, { error: 'Access denied to app' });
    return;
  }

  const loaded = await loadAppAndMca(db, appId);
  if ('error' in loaded) {
    sendJson(res, loaded.error.status, { error: loaded.error.message });
    return;
  }
  const { app, mca } = loaded;

  if (!mcaOAuth) {
    sendJson(res, 503, { error: 'Auth status unavailable: OAuth service not configured' });
    return;
  }

  let auth: { status: string; authType: string; message?: string };
  try {
    const info = await mcaOAuth.getAuthStatus(ctx.userId, appId, mca);
    auth = { status: info.status, authType: info.authType, message: info.message };
  } catch (err) {
    console.warn(`[Resources] app.check-auth: getAuthStatus failed for ${appId}`, err);
    sendJson(res, 502, {
      error: `Failed to read auth status: ${err instanceof Error ? err.message : 'unknown error'}`,
    });
    return;
  }

  console.log(`[Resources] app.check-auth: ${appId} checked by ${ctx.userId} (status=${auth.status})`);
  sendJson(res, 200, {
    appId,
    appName: app.name,
    mcaId: app.mcaId,
    auth,
    ...(auth.status !== 'ready' && auth.status !== 'not_required'
      ? { note: 'The app is not authenticated. Use show-app-auth to let the user connect it from the chat.' }
      : {}),
  });
}

// ============================================================================
// PROVIDERS
// ============================================================================

export async function handleProviderList(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
): Promise<void> {
  const providers = await db
    .collection('user_providers')
    .find({ userId: ctx.userId })
    .toArray();

  // Strip encrypted data before sending
  const sanitized = providers.map((p) => ({
    providerId: p.providerId,
    providerType: p.providerType,
    displayName: p.displayName,
    config: p.config,
    models: p.models,
    priority: p.priority,
    status: p.status,
    lastTestedAt: p.lastTestedAt,
    errorMessage: p.errorMessage,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));

  sendJson(res, 200, { providers: sanitized });
}

export async function handleAgentProvidersGet(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  agentId: string,
): Promise<void> {
  if (!(await canAccessAgent(db, ctx.userId, agentId))) {
    sendJson(res, 403, { error: 'Access denied to agent' });
    return;
  }

  const agent = await db.collection('agents').findOne({ agentId });
  if (!agent) {
    sendJson(res, 404, { error: 'Agent not found' });
    return;
  }

  const availableProviders: string[] = agent.availableProviders ?? [];
  const preferredProviderId: string | null = agent.preferredProviderId ?? null;
  const selectedModelId: string | null = agent.selectedModelId ?? null;

  // Fetch provider details
  let providerDetails: any[] = [];
  if (availableProviders.length > 0) {
    const records = await db
      .collection('user_providers')
      .find({ providerId: { $in: availableProviders } })
      .toArray();

    providerDetails = records.map((p) => ({
      providerId: p.providerId,
      providerType: p.providerType,
      displayName: p.displayName,
      status: p.status,
      models: p.models,
    }));
  }

  sendJson(res, 200, {
    agentId,
    availableProviders,
    preferredProviderId,
    selectedModelId,
    providers: providerDetails,
  });
}

export async function handleAgentProvidersSet(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  agentId: string,
  body: { providerIds: string[] },
): Promise<void> {
  if (!(await canAccessAgent(db, ctx.userId, agentId))) {
    sendJson(res, 403, { error: 'Access denied to agent' });
    return;
  }

  if (!Array.isArray(body.providerIds)) {
    sendJson(res, 400, { error: 'providerIds must be an array' });
    return;
  }

  const agent = await db.collection('agents').findOne({ agentId });
  if (!agent) {
    sendJson(res, 404, { error: 'Agent not found' });
    return;
  }

  // Verify all providers exist and belong to user
  if (body.providerIds.length > 0) {
    const providers = await db
      .collection('user_providers')
      .find({
        providerId: { $in: body.providerIds },
        userId: ctx.userId,
      })
      .toArray();

    if (providers.length !== body.providerIds.length) {
      sendJson(res, 400, {
        error: 'One or more provider IDs are invalid or do not belong to user',
      });
      return;
    }
  }

  await db.collection('agents').updateOne(
    { agentId },
    {
      $set: {
        availableProviders: body.providerIds,
        updatedAt: new Date().toISOString(),
      },
    },
  );

  const agentName = (agent.fullName as string | undefined) ?? (agent.name as string | undefined) ?? agentId;
  sendJson(res, 200, {
    success: true,
    message: `Set providers for '${agentName}': ${body.providerIds.join(', ') || '(none)'}`,
    agentId,
    agentName,
    availableProviders: body.providerIds,
  });
}

export async function handleAgentPreferredProviderSet(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  agentId: string,
  body: { providerId: string | null },
): Promise<void> {
  if (!(await canAccessAgent(db, ctx.userId, agentId))) {
    sendJson(res, 403, { error: 'Access denied to agent' });
    return;
  }

  const agent = await db.collection('agents').findOne({ agentId });
  if (!agent) {
    sendJson(res, 404, { error: 'Agent not found' });
    return;
  }

  const providerId = body.providerId;

  // If providerId is set, verify it's in availableProviders
  if (providerId) {
    const available: string[] = agent.availableProviders ?? [];
    if (!available.includes(providerId)) {
      sendJson(res, 400, {
        error: 'Provider must be in availableProviders before setting as preferred',
      });
      return;
    }
  }

  await db.collection('agents').updateOne(
    { agentId },
    {
      $set: {
        preferredProviderId: providerId,
        updatedAt: new Date().toISOString(),
      },
    },
  );

  const agentName = (agent.fullName as string | undefined) ?? (agent.name as string | undefined) ?? agentId;
  sendJson(res, 200, {
    success: true,
    message: providerId
      ? `Preferred provider for '${agentName}' set to ${providerId}`
      : `Cleared preferred provider for '${agentName}'`,
    agentId,
    agentName,
    preferredProviderId: providerId,
  });
}

// ============================================================================
// SKILLS
// ============================================================================

export async function handleSkillList(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  body: { workspaceId: string },
  skillService?: SkillService,
): Promise<void> {
  const { workspaceId } = body;

  if (!workspaceId) {
    sendJson(res, 400, { error: 'workspaceId is required' });
    return;
  }

  if (!(await canAccessWorkspace(db, ctx.userId, workspaceId))) {
    sendJson(res, 403, { error: 'Access denied to workspace' });
    return;
  }

  const svc = skillService ?? new SkillService(db);
  const skills = await svc.listSkills(workspaceId);
  sendJson(res, 200, { skills });
}

export async function handleSkillCreate(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  body: { workspaceId: string; name: string; description?: string; content: string },
  skillService?: SkillService,
): Promise<void> {
  const { workspaceId, name, description, content } = body;

  if (!workspaceId) {
    sendJson(res, 400, { error: 'workspaceId is required' });
    return;
  }
  if (!name) {
    sendJson(res, 400, { error: 'name is required' });
    return;
  }
  if (content === undefined || content === null) {
    sendJson(res, 400, { error: 'content is required' });
    return;
  }

  if (!(await canAccessWorkspace(db, ctx.userId, workspaceId))) {
    sendJson(res, 403, { error: 'Access denied to workspace' });
    return;
  }

  const svc = skillService ?? new SkillService(db);
  const skill = await svc.createSkill(workspaceId, ctx.userId, {
    name,
    description,
    content,
  });
  sendJson(res, 200, { skill });
}

export async function handleSkillUpdate(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  skillId: string,
  body: { name?: string; description?: string; content?: string },
  skillService?: SkillService,
): Promise<void> {
  if (!skillId) {
    sendJson(res, 400, { error: 'skillId is required' });
    return;
  }

  const svc = skillService ?? new SkillService(db);
  const existing = await svc.getSkill(skillId);
  if (!existing) {
    sendJson(res, 404, { error: 'Skill not found' });
    return;
  }

  if (!(await canAccessWorkspace(db, ctx.userId, existing.workspaceId))) {
    sendJson(res, 403, { error: 'Access denied to workspace' });
    return;
  }

  const skill = await svc.updateSkill(skillId, {
    name: body.name,
    description: body.description,
    content: body.content,
  });

  if (!skill) {
    sendJson(res, 404, { error: 'Skill not found' });
    return;
  }

  sendJson(res, 200, { skill });
}

export async function handleSkillDelete(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  skillId: string,
  skillService?: SkillService,
): Promise<void> {
  if (!skillId) {
    sendJson(res, 400, { error: 'skillId is required' });
    return;
  }

  const svc = skillService ?? new SkillService(db);
  const existing = await svc.getSkill(skillId);
  if (!existing) {
    sendJson(res, 404, { error: 'Skill not found' });
    return;
  }

  if (!(await canAccessWorkspace(db, ctx.userId, existing.workspaceId))) {
    sendJson(res, 403, { error: 'Access denied to workspace' });
    return;
  }

  const deleted = await svc.deleteSkill(skillId);
  const name = (existing as { name?: string }).name ?? skillId;
  sendJson(res, 200, {
    success: deleted,
    message: `Skill '${name}' deleted`,
    skillId,
    name,
  });
}

export async function handleSkillGrantAccess(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  body: { agentId: string; skillId: string },
  skillService?: SkillService,
): Promise<void> {
  const { agentId, skillId } = body;

  if (!agentId) {
    sendJson(res, 400, { error: 'agentId is required' });
    return;
  }
  if (!skillId) {
    sendJson(res, 400, { error: 'skillId is required' });
    return;
  }

  if (!(await canAccessAgent(db, ctx.userId, agentId))) {
    sendJson(res, 403, { error: 'Access denied to agent' });
    return;
  }

  const svc = skillService ?? new SkillService(db);
  const skill = await svc.getSkill(skillId);
  if (!skill) {
    sendJson(res, 404, { error: 'Skill not found' });
    return;
  }

  if (!(await canAccessWorkspace(db, ctx.userId, skill.workspaceId))) {
    sendJson(res, 403, { error: 'Access denied to skill workspace' });
    return;
  }

  const access = await svc.grantSkillAccess(agentId, skillId, skill.workspaceId, ctx.userId);

  const agent = await db.collection('agents').findOne({ agentId });
  const agentName = (agent?.fullName as string | undefined) ?? (agent?.name as string | undefined) ?? agentId;
  const skillName = (skill as { name?: string }).name ?? skillId;
  sendJson(res, 200, {
    success: true,
    message: `Granted skill '${skillName}' to '${agentName}'`,
    agentId,
    skillId,
    agentName,
    skillName,
    access,
  });
}

export async function handleSkillRevokeAccess(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  agentId: string,
  skillId: string,
  skillService?: SkillService,
): Promise<void> {
  if (!agentId) {
    sendJson(res, 400, { error: 'agentId is required' });
    return;
  }
  if (!skillId) {
    sendJson(res, 400, { error: 'skillId is required' });
    return;
  }

  if (!(await canAccessAgent(db, ctx.userId, agentId))) {
    sendJson(res, 403, { error: 'Access denied to agent' });
    return;
  }

  // Load names before revoking — after revoke the access row is gone.
  const svc = skillService ?? new SkillService(db);
  const [agent, skill] = await Promise.all([
    db.collection('agents').findOne({ agentId }),
    svc.getSkill(skillId),
  ]);
  const agentName = (agent?.fullName as string | undefined) ?? (agent?.name as string | undefined) ?? agentId;
  const skillName = (skill as { name?: string } | null)?.name ?? skillId;

  await svc.revokeSkillAccess(agentId, skillId);

  sendJson(res, 200, {
    success: true,
    message: `Revoked skill '${skillName}' from '${agentName}'`,
    agentId,
    skillId,
    agentName,
    skillName,
  });
}

export async function handleSkillSetEnabled(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  agentId: string,
  skillId: string,
  body: { enabled: boolean },
  skillService?: SkillService,
): Promise<void> {
  const { enabled } = body;

  if (!agentId) {
    sendJson(res, 400, { error: 'agentId is required' });
    return;
  }
  if (!skillId) {
    sendJson(res, 400, { error: 'skillId is required' });
    return;
  }
  if (typeof enabled !== 'boolean') {
    sendJson(res, 400, { error: 'enabled (boolean) is required' });
    return;
  }

  if (!(await canAccessAgent(db, ctx.userId, agentId))) {
    sendJson(res, 403, { error: 'Access denied to agent' });
    return;
  }

  const svc = skillService ?? new SkillService(db);
  const access = await svc.setSkillEnabled(agentId, skillId, enabled);
  if (!access) {
    sendJson(res, 404, { error: 'Skill access entry not found' });
    return;
  }

  const [agent, skill] = await Promise.all([
    db.collection('agents').findOne({ agentId }),
    svc.getSkill(skillId),
  ]);
  const agentName = (agent?.fullName as string | undefined) ?? (agent?.name as string | undefined) ?? agentId;
  const skillName = (skill as { name?: string } | null)?.name ?? skillId;

  sendJson(res, 200, {
    success: true,
    message: `Skill '${skillName}' ${enabled ? 'enabled' : 'disabled'} for '${agentName}'`,
    agentId,
    skillId,
    enabled,
    agentName,
    skillName,
  });
}

export async function handleSkillGetAgentSkills(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  agentId: string,
  skillService?: SkillService,
): Promise<void> {
  if (!agentId) {
    sendJson(res, 400, { error: 'agentId is required' });
    return;
  }

  if (!(await canAccessAgent(db, ctx.userId, agentId))) {
    sendJson(res, 403, { error: 'Access denied to agent' });
    return;
  }

  const svc = skillService ?? new SkillService(db);
  const skills = await svc.getAgentSkills(agentId);
  sendJson(res, 200, { skills });
}
