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
import type { VolumeService } from '../services/volume-service';
import type { WorkspaceService } from '../services/workspace-service';

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

async function getUserWorkspaceIds(db: Db, userId: string): Promise<string[]> {
  const memberships = await db.collection('workspace_members').find({ userId }).toArray();
  return memberships.map((m) => m.workspaceId);
}

async function canAccessWorkspace(db: Db, userId: string, workspaceId: string): Promise<boolean> {
  // Check if owner
  const workspace = await db.collection('workspaces').findOne({ workspaceId });
  if (workspace?.ownerId === userId) return true;

  // Check if member
  const membership = await db.collection('workspace_members').findOne({ workspaceId, userId });
  return !!membership;
}

async function canAccessAgent(db: Db, userId: string, agentId: string): Promise<boolean> {
  const agent = await db.collection('agents').findOne({ agentId });
  if (!agent) return false;

  // Global agent owned by user
  if (!agent.workspaceId && agent.ownerId === userId) return true;

  // Workspace agent - check workspace access
  if (agent.workspaceId) {
    return canAccessWorkspace(db, userId, agent.workspaceId);
  }

  return false;
}

async function canAccessApp(db: Db, userId: string, appId: string): Promise<boolean> {
  const app = await db.collection('apps').findOne({ appId });
  if (!app) return false;

  // User-owned app
  if (app.ownerType === 'user' && app.ownerId === userId) return true;

  // Workspace-owned app - check workspace access
  if (app.ownerType === 'workspace') {
    return canAccessWorkspace(db, userId, app.ownerId);
  }

  return false;
}

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
  let query: any = {
    $or: [
      { ownerId: ctx.userId, workspaceId: { $exists: false } },
      { workspaceId: { $in: userWorkspaceIds } },
    ],
  };

  // Filter by specific workspace if provided
  if (body.workspaceId) {
    if (
      !userWorkspaceIds.includes(body.workspaceId) &&
      !(await db
        .collection('workspaces')
        .findOne({ workspaceId: body.workspaceId, ownerId: ctx.userId }))
    ) {
      sendJson(res, 403, { error: 'Access denied to workspace' });
      return;
    }
    query = { workspaceId: body.workspaceId };
  }

  const agents = await db.collection('agents').find(query).toArray();

  sendJson(res, 200, {
    agents: agents.map((a) => ({
      agentId: a.agentId,
      name: a.name,
      fullName: a.fullName,
      role: a.role,
      intro: a.intro,
      avatarUrl: a.avatarUrl,
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
    avatarUrl: agent.avatarUrl,
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
    coreId: string;
    name: string;
    fullName: string;
    role: string;
    intro: string;
    workspaceId?: string;
  },
): Promise<void> {
  if (!body.coreId || !body.name || !body.fullName || !body.role || !body.intro) {
    sendJson(res, 400, { error: 'Missing required fields: coreId, name, fullName, role, intro' });
    return;
  }

  // Verify workspace access if specified
  if (body.workspaceId) {
    if (!(await canAccessWorkspace(db, ctx.userId, body.workspaceId))) {
      sendJson(res, 403, { error: 'Access denied to workspace' });
      return;
    }
  }

  // Verify core exists
  const core = await db.collection('agent_cores').findOne({ coreId: body.coreId });
  if (!core) {
    sendJson(res, 404, { error: `Agent core '${body.coreId}' not found` });
    return;
  }

  const agent = {
    agentId: generateId('agent'),
    coreId: body.coreId,
    name: body.name,
    fullName: body.fullName,
    role: body.role,
    intro: body.intro,
    avatarUrl: core.avatarUrl || 'default-avatar.jpg',
    workspaceId: body.workspaceId,
    ownerId: ctx.userId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await db.collection('agents').insertOne(agent);

  sendJson(res, 201, agent);
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
  sendJson(res, 200, agent);
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

  // Delete agent and access grants
  await db.collection('agents').deleteOne({ agentId });
  await db.collection('agent_app_access').deleteMany({ agentId });

  sendJson(res, 200, { success: true, message: 'Agent deleted' });
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
    // Use WorkspaceService to ensure volume is created
    const workspace = await workspaceService.createWorkspace(ctx.userId, {
      name: body.name,
      description: body.description,
    });

    sendJson(res, 201, workspace);
  } catch (error: any) {
    console.error('[handleWorkspaceCreate] Error:', error);
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

  sendJson(res, 200, { success: true, message: 'Workspace archived' });
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

  sendJson(res, 201, member);
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

  sendJson(res, 200, { success: true, message: 'Member removed' });
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

  sendJson(res, 200, { success: true, message: 'Member role updated' });
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
  // Show current user's own apps only
  const query: any = {
    status: 'active',
    ownerId: ctx.userId,
    ownerType: 'user',
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
  body: { mcaId: string; name?: string; ownerId?: string; ownerType?: 'user' | 'workspace' },
  volumeService?: VolumeService,
  workspaceService?: WorkspaceService,
): Promise<void> {
  if (!body.mcaId) {
    sendJson(res, 400, { error: 'Missing required field: mcaId' });
    return;
  }

  // Default to current user if not specified
  const ownerId = body.ownerId || ctx.userId;
  const ownerType = body.ownerType || 'user';

  // Validate ownerType
  if (!['user', 'workspace'].includes(ownerType)) {
    sendJson(res, 400, { error: 'ownerType must be either "user" or "workspace"' });
    return;
  }

  // Validate ownership
  if (ownerType === 'user' && ownerId !== ctx.userId) {
    sendJson(res, 403, { error: 'Cannot create apps for other users' });
    return;
  }

  if (ownerType === 'workspace') {
    const canAccess = await canAccessWorkspace(db, ctx.userId, ownerId);
    if (!canAccess) {
      sendJson(res, 403, { error: 'Access denied to workspace' });
      return;
    }
  }

  // Verify MCA exists in catalog
  const mca = await db.collection('mca_catalog').findOne({ mcaId: body.mcaId });
  if (!mca) {
    sendJson(res, 404, { error: `MCA '${body.mcaId}' not found in catalog` });
    return;
  }

  // Check if multi-instance is allowed
  if (!mca.multi) {
    const existing = await db.collection('apps').findOne({
      mcaId: body.mcaId,
      ownerId: ownerId,
      status: 'active',
    });
    if (existing) {
      sendJson(res, 409, {
        error: 'App already installed. This MCA does not allow multiple instances.',
      });
      return;
    }
  }

  // Generate name if not provided
  const appName = body.name || mca.name.toLowerCase().replace(/\s+/g, '-');

  // Resolve volume mount for the owner (user or workspace)
  let volumes: Array<{ volumeId: string; mountPath: string; readOnly?: boolean }> | undefined;
  if (volumeService) {
    try {
      if (ownerType === 'workspace') {
        // For workspace apps: get the workspace's volumeId
        const workspace = await db.collection('workspaces').findOne({ workspaceId: ownerId });
        if (workspace?.volumeId) {
          volumes = [{ volumeId: workspace.volumeId, mountPath: '/workspace' }];
          console.log(
            `[handleAppInstall] Assigned workspace volume ${workspace.volumeId} to app for workspace ${ownerId}`,
          );
        } else {
          console.warn(
            `[handleAppInstall] Workspace ${ownerId} has no volumeId — app will have no volume`,
          );
        }
      } else {
        // For user apps: get or create the user's personal volume
        const userVolume = await volumeService.getUserVolume(ownerId);
        if (userVolume) {
          volumes = [{ volumeId: userVolume.volumeId, mountPath: '/workspace' }];
          console.log(
            `[handleAppInstall] Assigned user volume ${userVolume.volumeId} to app for user ${ownerId}`,
          );
        } else {
          console.warn(
            `[handleAppInstall] Could not resolve volume for user ${ownerId} — app will have no volume`,
          );
        }
      }
    } catch (err) {
      console.warn(
        `[handleAppInstall] Failed to resolve volume for ${ownerType} ${ownerId}:`,
        err,
      );
    }
  }

  const app = {
    appId: generateId('app'),
    mcaId: body.mcaId,
    name: appName,
    ownerId: ownerId,
    ownerType: ownerType,
    status: 'active',
    ...(volumes?.length ? { volumes } : {}),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await db.collection('apps').insertOne(app);

  sendJson(res, 201, app);
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

  // Delete app and access grants
  await db.collection('apps').deleteOne({ appId });
  await db.collection('agent_app_access').deleteMany({ appId });

  sendJson(res, 200, { success: true, message: 'App uninstalled' });
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
// AGENT CORES
// ============================================================================

export async function handleAgentCoresList(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
): Promise<void> {
  const cores = await db.collection('agent_cores').find({}).toArray();

  sendJson(res, 200, {
    cores: cores.map((c) => ({
      coreId: c.coreId,
      name: c.name,
      description: c.description,
      avatarUrl: c.avatarUrl,
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
  const appWorkspaceId = app.ownerType === 'workspace' ? app.ownerId : undefined;

  if (agentWorkspaceId && !appWorkspaceId) {
    sendJson(res, 400, {
      error: 'Workspace agent cannot access user apps. Install the app in the workspace first.',
    });
    return;
  }

  if (!agentWorkspaceId && appWorkspaceId) {
    sendJson(res, 400, {
      error: 'User agent cannot access workspace apps.',
    });
    return;
  }

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

  sendJson(res, 201, access);
}

export async function handleAccessRevoke(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  agentId: string,
  appId: string,
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

  await db.collection('agent_app_access').deleteOne({ agentId, appId });

  sendJson(res, 200, { success: true, message: 'Access revoked' });
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

  sendJson(res, 200, {
    success: true,
    agentId,
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

  sendJson(res, 200, {
    success: true,
    agentId,
    preferredProviderId: providerId,
  });
}
