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
import { maskSecret } from '@teros/shared';
import {
  canAccessAgent,
  canAccessApp,
  canAccessWorkspace,
  getUserWorkspaceIds,
} from '../auth/workspace-access';
import type { AgentProvisioningService } from '../services/agent-provisioning-service';
import { AgentMailboxService } from '../services/agent-mailbox-service';
import type { McaOAuth } from '../auth/mca-oauth';
import type { AuthManager } from '../auth/auth-manager';
import type { AwaitingAuthRegistry } from '../handlers/message/awaiting-auth-registry';
import type { McaService } from '../services/mca-service';
import type { McaManager } from "../services/mca-manager";
import type { PubSubService } from '../services/pubsub-service';
import type { WorkspaceService } from '../services/workspace-service';
import type { UserService } from '../auth/user-service';
import { buildInvitationEmailSendFn } from '../handlers/domains/workspace/invitation-email';
import { checkRateLimit } from '../handlers/domains/workspace/add-member';
import type { AgentInstance, AppToolPermissions, McpCatalogEntry, ToolPermission } from '../types/database';
import { buildToolPermissionsView, isPrivateTool, normalizeToolName } from '../types/permissions';
import { buildAppPermissionsView } from '../handlers/domains/app/_permissions-view';
import { buildAvatarUrl } from '../lib/avatar-url';
import {
  broadcastAgentUpdated,
  buildAgentCreatedPayload,
  buildAgentUpdatedPayload,
} from '../lib/agent-payload';
import { SkillService, isValidLoadMode, type SkillLoadMode } from '../services/skill-service';
import { UpgradeRequiredError } from '../services/billing-gate.js';
import { DeletionService } from '../services/deletion-service';

// ============================================================================
// TYPES
// ============================================================================

export interface ResourceContext {
  userId: string;
  mcaManager?: McaManager | null;
  channelId: string;
  appId?: string;
  /**
   * REAL conversation channel (ch_*) when the callback came through a call
   * grant — in grant mode ctx.channelId is rewritten to the appId, which is
   * NOT a channel. The set-app-secret redaction sweep must target the
   * conversation the secret was shared in, so it prefers this field.
   */
  callerChannelId?: string;
}

// ============================================================================
// HELPERS
// ============================================================================

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  // ACAO is set by the main request handler via resolveAllowedOrigin() —
  // do not override it with a wildcard here.
  res.writeHead(status, {
    'Content-Type': 'application/json',
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
  pubSubService: PubSubService,
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

  const agents = db.collection<AgentInstance>('agents');
  await agents.updateOne({ agentId }, { $set: updates });

  const agent = await agents.findOne({ agentId });

  // Resolve avatar with the core fallback so the synchronous 200 body matches the
  // agent.updated broadcast below — an agent with no own avatar still surfaces its
  // core avatar in both (TER-644).
  const core = agent ? await db.collection('agent_cores').findOne({ coreId: agent.coreId }) : null;
  const coreAvatarUrl = core?.avatarUrl as string | undefined;
  sendJson(
    res,
    200,
    agent ? { ...agent, avatarUrl: buildAvatarUrl(agent.avatarUrl || coreAvatarUrl) } : agent,
  );

  // Broadcast agent.updated so connected clients' navbars refresh in realtime
  // (TER-644). This MCA resource path is how the UI mutates agents (rename /
  // avatar via the `core_update-agent` tool) — a separate path from the WsRouter
  // agent.update handler, so it must emit its own event or the panel keeps the
  // stale value until reload. Same pattern as handleAgentCreate above (TER-611).
  // Emitted AFTER the 200 with a non-fatal catch: the update is already persisted.
  if (agent) {
    try {
      const payload = buildAgentUpdatedPayload(agent, coreAvatarUrl);
      await broadcastAgentUpdated(pubSubService, ctx.userId, payload);
    } catch (err) {
      console.warn('[handleAgentUpdate] agent.updated broadcast failed', err);
    }
  }
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

  // Same full cascade as agent.delete (INF-3: this path used to leave the
  // agent's channels, skills, relationships and subscriptions behind)
  await new DeletionService(db).deleteAgent(agentId, ctx.userId, 'mca.agent.delete');

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
    // Billing gate is enforced inside workspaceService.createWorkspace —
    // UpgradeRequiredError is caught below and returned as 403.
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
  body: { email?: string; userId?: string; role?: string },
  workspaceService: WorkspaceService,
  userService: UserService,
): Promise<void> {
  // Invitations are ALWAYS by email (Pablo's rule, 2026-10-27).
  // The wire value is an email address. `userId` is accepted as a legacy
  // field name (older MCA containers post it) and is interpreted the same
  // way — the pre-fix handler inserted it verbatim as a userId, creating
  // ghost members (repro: work_bb02eff683ac5b89).
  const email = String(body.email ?? body.userId ?? '').trim().toLowerCase();
  const role = body.role;

  const workspace = await db.collection('workspaces').findOne({ workspaceId });
  if (!workspace) {
    sendJson(res, 404, { error: 'Workspace not found' });
    return;
  }

  // Authorization + rate limit: same guards as the WS handler
  // (workspace.add_member) — canManageMembers (owner/admin, REQ-17) and
  // Guard 6 (10 calls/min/workspace/admin against bulk email enumeration).
  if (!(await workspaceService.canManageMembers(workspaceId, ctx.userId))) {
    sendJson(res, 403, { error: 'Only owner or admin can add members' });
    return;
  }
  if (!checkRateLimit(workspaceId, ctx.userId)) {
    sendJson(res, 429, {
      error: 'Too many member additions — please try again in a minute',
    });
    return;
  }

  if (!email || !role) {
    sendJson(res, 400, { error: 'Missing required fields: email, role' });
    return;
  }

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!EMAIL_RE.test(email)) {
    sendJson(res, 400, { error: 'Invalid email address — members are invited by email' });
    return;
  }

  const validRoles = ['admin', 'write', 'read'];
  if (!validRoles.includes(role)) {
    sendJson(res, 400, { error: 'Invalid role — must be one of: admin, write, read' });
    return;
  }

  // Resolve existing account by email (case-insensitive) — same as the WS handler
  const existingUser = await userService.getByEmail(email);
  const existingUserId = existingUser?.userId ?? null;

  // Best-effort invitation email (shared helper, NFR-5)
  const emailSendFn = buildInvitationEmailSendFn(userService, db, ctx.userId, {
    logTag: 'mca.workspaceMemberAdd',
  });

  // Delegate to the canonical MUW-14 flow (WorkspaceService.addMemberByEmail):
  // existing account → active member (+ volume access); no account → pending
  // member + invitation email with inv_ token (activated on signup).
  const result = await workspaceService.addMemberByEmail(
    workspaceId,
    email,
    role as 'admin' | 'write' | 'read',
    ctx.userId,
    existingUserId,
    emailSendFn,
  );

  const workspaceName = (workspace.name as string | undefined) ?? workspaceId;
  sendJson(res, 201, {
    success: true,
    message:
      result.status === 'pending'
        ? `Invitation created for '${email}' in '${workspaceName}' as ${role}${result.invitationEmailSent ? ' — invitation email sent' : ''}`
        : `Added '${email}' to '${workspaceName}' as ${role}`,
    workspaceId,
    workspaceName,
    email: result.email,
    status: result.status, // 'active' | 'pending'
    invitationEmailSent: result.invitationEmailSent,
    role,
    // Guard 1: the resolved userId is NEVER returned.
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
    if (!(await mcaService.isAppNameAvailable(ownerId, body.name, { scope: 'personal', installedBy: ctx.userId }))) {
      sendJson(res, 409, { error: `App name "${body.name}" is already in use` });
      return;
    }
    appName = body.name;
  } else {
    appName = await mcaService.generateDefaultAppName(body.mcaId, ownerId, { scope: 'personal', installedBy: ctx.userId });
  }

  // createApp auto-resolves the workspace volume mount
  const app = await mcaService.createApp({
    appId: generateId('app'),
    mcaId: body.mcaId,
    ownerId,
    ownerType: 'workspace',
    // MUW-REQ-10/11: the acting user owns it; member-installed apps are personal.
    installedBy: ctx.userId,
    scope: 'personal',
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
  body: { agentId: string; appId: string; preferredName?: string },
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

  // EMAIL MAILBOX HOOK (tn_PcquTN30AawbK8uE): same fail-soft provisioning as
  // McaService.grantAccess — this REST path writes the grant directly, so the
  // hook is duplicated here. NEVER fails the grant.
  if (app.mcaId === 'mca.teros.email') {
    try {
      const mailboxService = new AgentMailboxService(db);
      const mailbox = await mailboxService.ensureMailbox(agent as unknown as AgentInstance, {
        preferredName: body.preferredName,
      });
      console.log(
        `[McaResources] Mailbox hook: ${body.agentId} → ${mailbox.address} (${mailbox.status}${mailbox.reason ? `, ${mailbox.reason}` : ''})`,
      );
    } catch (error) {
      console.error(
        `[McaResources] Mailbox hook FAILED for ${body.agentId} (grant NOT affected):`,
        error,
      );
    }
  }

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
  if (app.ownerType === 'workspace' || app.ownerId.startsWith('work_') || app.ownerId.startsWith('ws_')) {
    const workspace = await db
      .collection('workspaces')
      .findOne({ workspaceId: app.ownerId, status: 'active' });
    if (!workspace) return false;
    if (workspace.ownerId === userId) return true;
    // Check workspace_members collection (single source of truth)
    const membership = await db
      .collection('workspace_members')
      .findOne({ workspaceId: app.ownerId, userId });
    return membership?.role === 'admin';
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

  // Use buildAppPermissionsView to load manifest annotations (readOnlyHint, alwaysAsk)
  // so the readOnly flag is correctly reported — not hardcoded to false via new Map().
  const { tools, summary } = await buildAppPermissionsView(
    ctx.mcaManager ?? null,
    loaded.app,
    appId,
    loaded.toolNames,
  );
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

  // Use buildAppPermissionsView to load manifest annotations (readOnlyHint, alwaysAsk)
  // so the readOnly flag is correctly reported — not hardcoded to false via new Map().
  const { tools, summary } = await buildAppPermissionsView(
    ctx.mcaManager ?? null,
    { ...app, permissions: next },
    appId,
    toolNames,
  );
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
  /** v2 non-blocking interactions: register the (userId, appId) → channelId
   * wake pointer so the OAuth callback can wake this channel's agent. */
  awaitingAuth?: AwaitingAuthRegistry,
  /** v2 non-blocking interactions: broadcast channel_status awaitingUser
   * { kind: 'auth' } so the unified frontend chip can show the state. */
  pubSubService?: PubSubService,
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

  // v2: the widget is shown and the connection is pending — remember where to
  // send the wake when the OAuth callback completes. Best-effort: skip when
  // already connected or when the registry isn't wired (tests/legacy).
  if (awaitingAuth && auth?.status !== 'ready' && auth?.status !== 'not_required') {
    awaitingAuth.register(ctx.userId, appId, ctx.channelId);
    // v2: the channel enters awaiting_user { kind: 'auth', pointer } — the
    // unified frontend chip reads it (spec §Implementation design 5).
    if (pubSubService && ctx.channelId) {
      pubSubService.broadcastToTopic(`channel:${ctx.channelId}`, {
        type: 'channel_status',
        channelId: ctx.channelId,
        awaitingUser: { kind: 'auth', pointer: appId },
      });
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

// Shared shape of a user_providers record as read by these handlers (subset).
interface ProviderRecordForAgents {
  providerId: string;
  userId: string;
  providerType: string;
  displayName: string;
  status: string;
  defaultModelId?: string;
  models?: Array<{ modelId: string; capabilities?: Record<string, unknown> }>;
}

/**
 * Models with an exclusive assignment (spec 20261017_agent-model-tools §3.4.3).
 * A shared provider's default must NEVER point at one of these, and pinning
 * another agent to one requires an explicit operator decision — set-agent-model
 * rejects them unless `allowReserved: true` is passed.
 *
 * Today: `teros-glm-5p3-fast` is reserved exclusively for Alice.
 */
// @todo pablo - 2026.10.20 : RESERVED_MODEL_IDS should be workspace config, not hardcoded
// Removed hardcoded 'teros-glm-5p3-fast' reservation — this is operational, not architectural
export const RESERVED_MODEL_IDS = new Set<string>();

/**
 * Compute the (provider, model) pair a run would actually use for this agent,
 * mirroring the runtime chain in provider-service's private agent resolver
 * (2-level model, 2026-10-21):
 *   pin (selectedProviderId active + selectedModelId served)
 *     → user's isDefault provider → provider.defaultModelId → first model.
 * The availableProviders list is GONE — it is never consulted.
 * Pure read — no secrets, no billing throws — so it is safe for a read tool.
 */
function resolveAgentModel(
  agent: {
    selectedModelId?: string | null;
    selectedProviderId?: string | null;
  },
  providers: ProviderRecordForAgents[],
  defaultProvider: ProviderRecordForAgents | null,
): { providerId: string | null; modelId: string | null; source: string } {
  const selectedProviderId = agent.selectedProviderId ?? null;
  const selectedModelId = agent.selectedModelId ?? null;

  // ── Level 1: the pin ────────────────────────────────────────────────────────
  const pinned = selectedProviderId
    ? providers.find((p) => p.providerId === selectedProviderId && p.status === 'active')
    : null;

  if (pinned) {
    const model =
      (selectedModelId && (pinned.models ?? []).some((m) => m.modelId === selectedModelId)
        ? selectedModelId
        : null) ??
      pinned.defaultModelId ??
      (pinned.models ?? [])[0]?.modelId ??
      null;
    return { providerId: pinned.providerId, modelId: model, source: 'agent_pin' };
  }

  // ── Level 2: System Default — the user's default provider ──────────────────
  if (defaultProvider) {
    const models = defaultProvider.models ?? [];
    const viaDefault = defaultProvider.defaultModelId
      ? models.find((m) => m.modelId === defaultProvider.defaultModelId)
      : undefined;
    const model = viaDefault ?? models[0];
    if (model) {
      return {
        providerId: defaultProvider.providerId,
        modelId: model.modelId,
        source: 'user_default_provider',
      };
    }
  }

  return { providerId: null, modelId: null, source: 'unresolved' };
}

/**
 * Detect orphaned/inconsistent provider config for an agent (spec §3.1.3),
 * updated for the 2-level model (2026-10-21): a pin whose provider does not
 * exist / is inactive, a model pin no provider serves, or no user default to
 * inherit. The availableProviders list no longer exists — no warnings for it.
 */
function collectAgentProviderWarnings(
  agent: {
    selectedProviderId?: string | null;
    selectedModelId?: string | null;
  },
  providerRecords: ProviderRecordForAgents[],
  defaultProvider: ProviderRecordForAgents | null,
): string[] {
  const warnings: string[] = [];
  const foundIds = new Set(providerRecords.map((p) => p.providerId));
  const selectedProviderId = agent.selectedProviderId ?? null;
  const selectedModelId = agent.selectedModelId ?? null;

  if (selectedProviderId && !foundIds.has(selectedProviderId)) {
    warnings.push(
      `selectedProviderId points at provider '${selectedProviderId}' which does not exist (orphan pin).`,
    );
  } else if (
    selectedProviderId &&
    providerRecords.find((p) => p.providerId === selectedProviderId)?.status !== 'active'
  ) {
    warnings.push(
      `selectedProviderId '${selectedProviderId}' is inactive — the run falls back to the user default provider.`,
    );
  }

  if (selectedModelId) {
    const served = providerRecords.some((p) =>
      (p.models ?? []).some((m) => m.modelId === selectedModelId),
    );
    if (!served) {
      warnings.push(
        `selectedModelId '${selectedModelId}' is not served by any provider (ghost pin).`,
      );
    }
  }

  if (!selectedProviderId && !defaultProvider) {
    warnings.push(
      'Agent has no pin and the user has no active default provider — the run cannot resolve a provider (System Default unresolved).',
    );
  }

  return warnings;
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

  const selectedProviderId: string | null = agent.selectedProviderId ?? null;
  const selectedModelId: string | null = agent.selectedModelId ?? null;

  // ALL of the owner's providers — the availableProviders filter no longer
  // exists; the selector shows every option.
  const providerRecords = (await db
    .collection('user_providers')
    .find({ userId: agent.ownerId })
    .toArray()) as unknown as ProviderRecordForAgents[];

  const providerDetails = providerRecords.map((p) => ({
    providerId: p.providerId,
    providerType: p.providerType,
    displayName: p.displayName,
    status: p.status,
    isDefault: (p as any).isDefault ?? false,
    models: p.models,
    defaultModelId: p.defaultModelId ?? null,
  }));

  // The user's default provider — what System Default resolves to.
  const defaultProvider = (await db.collection('user_providers').findOne({
    userId: agent.ownerId,
    isDefault: true,
    status: 'active',
  })) as unknown as ProviderRecordForAgents | null;

  const resolved = resolveAgentModel(agent as any, providerRecords, defaultProvider);
  const warnings = collectAgentProviderWarnings(agent as any, providerRecords, defaultProvider);

  sendJson(res, 200, {
    agentId,
    selectedProviderId,
    selectedModelId,
    providers: providerDetails,
    resolved,
    warnings,
  });
}

/**
 * set-agent-providers (legacy endpoint, now pin-only) — the availableProviders
 * list is GONE (2026-10-21). `providerIds` is accepted for backward
 * compatibility but IGNORED: a pin is a single (provider, model) pair
 * (selectedProviderId + selectedModelId); without a pin the agent inherits the
 * user's default provider (System Default).
 */
export async function handleAgentProvidersSet(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  agentId: string,
  body: {
    providerIds?: string[];
    selectedProviderId?: string | null;
    selectedModelId?: string | null;
    reason?: string;
  },
  pubSubService?: PubSubService | null,
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

  // The pin: a single (provider, model) pair. providerIds (if sent) is ignored.
  const selectedProviderId: string | null | undefined = body.selectedProviderId;
  const selectedModelId: string | null | undefined = body.selectedModelId;

  // Validate the pin target when one is being set.
  if (selectedProviderId) {
    const provider = (await db
      .collection('user_providers')
      .findOne({ providerId: selectedProviderId, userId: ctx.userId })) as unknown as
      | ProviderRecordForAgents
      | null;

    if (!provider) {
      sendJson(res, 400, {
        error: `Provider '${selectedProviderId}' not found or does not belong to user`,
      });
      return;
    }

    // Billing gate: pinning a teros provider consumes teros hours (same rule
    // as handleAgentModelSet).
    if (provider.providerType === 'teros') {
      const { BillingGateService } = await import('../services/billing-gate.js');
      try {
        await new BillingGateService(db).assertTerosModelAllowed(ctx.userId);
      } catch (err) {
        if (err instanceof UpgradeRequiredError) {
          sendJson(res, 402, { error: err.message });
          return;
        }
        throw err;
      }
    }

    if (selectedModelId) {
      const served = (provider.models ?? []).some((m) => m.modelId === selectedModelId);
      if (!served) {
        sendJson(res, 400, {
          error: `Model '${selectedModelId}' is not served by provider '${selectedProviderId}'`,
        });
        return;
      }
    }
  }

  const updateFields: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  };
  if (selectedProviderId !== undefined) updateFields.selectedProviderId = selectedProviderId;
  if (selectedModelId !== undefined) updateFields.selectedModelId = selectedModelId;

  // Clearing the provider pin also clears the model pin — a model pin without
  // a provider pin is not a state the resolver understands.
  if (selectedProviderId === null) updateFields.selectedModelId = null;

  await db.collection('agents').updateOne({ agentId }, { $set: updateFields });

  const updatedAgent = await db.collection('agents').findOne({ agentId });
  const agentName =
    (agent.fullName as string | undefined) ?? (agent.name as string | undefined) ?? agentId;

  sendJson(res, 200, {
    success: true,
    message: selectedProviderId
      ? `Pinned '${agentName}' to provider ${selectedProviderId}${selectedModelId ? ` / model ${selectedModelId}` : ''}`
      : `Cleared the pin for '${agentName}' — System Default (the user's default provider) applies`,
    agentId,
    agentName,
    selectedProviderId: selectedProviderId !== undefined ? selectedProviderId : (updatedAgent?.selectedProviderId ?? null),
    selectedModelId: selectedModelId !== undefined ? selectedModelId : (updatedAgent?.selectedModelId ?? null),
  });

  // Broadcast agent.updated so the UI reflects the change without a reload.
  if (pubSubService && updatedAgent) {
    try {
      const core = await db
        .collection('agent_cores')
        .findOne({ coreId: updatedAgent.coreId });
      const payload = buildAgentUpdatedPayload(updatedAgent as any, core?.avatarUrl);
      await broadcastAgentUpdated(pubSubService, ctx.userId, payload);
    } catch (err) {
      console.warn('[handleAgentProvidersSet] agent.updated broadcast failed', err);
    }
  }
}

/**
 * set-agent-model — the atomic model pin (spec 20261017_agent-model-tools §3.1.1).
 *
 * Writes `selectedProviderId` + `selectedModelId` in a single update, validates
 * the model is served by the provider, enforces the billing gate when the
 * provider is teros, and broadcasts `agent.updated` so the UI refreshes live.
 * The availableProviders list is GONE (2026-10-21) — nothing is auto-added to
 * any list; a pin is just the (provider, model) pair.
 *
 * `reason` is optional but recommended: model changes are a considered decision
 * (policy §3.4.2), so every change is logged with who/when/why for audit.
 */
export async function handleAgentModelSet(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  agentId: string,
  body: {
    providerId: string;
    modelId: string;
    reason?: string;
    allowReserved?: boolean;
  },
  pubSubService?: PubSubService | null,
): Promise<void> {
  if (!(await canAccessAgent(db, ctx.userId, agentId))) {
    sendJson(res, 403, { error: 'Access denied to agent' });
    return;
  }

  const { providerId, modelId, reason, allowReserved } = body;
  if (!providerId || !modelId) {
    sendJson(res, 400, { error: 'providerId and modelId are required' });
    return;
  }

  const agent = await db.collection('agents').findOne({ agentId });
  if (!agent) {
    sendJson(res, 404, { error: 'Agent not found' });
    return;
  }

  // Provider must exist and belong to the calling user.
  const provider = (await db
    .collection('user_providers')
    .findOne({ providerId, userId: ctx.userId })) as unknown as ProviderRecordForAgents | null;
  if (!provider) {
    sendJson(res, 400, { error: `Provider '${providerId}' not found or does not belong to user` });
    return;
  }

  // Model must be served by the provider.
  const model = (provider.models ?? []).find((m) => m.modelId === modelId);
  if (!model) {
    sendJson(res, 400, {
      error: `Model '${modelId}' is not served by provider '${providerId}'`,
      availableModels: (provider.models ?? []).map((m) => m.modelId),
    });
    return;
  }

  // Reserved models (policy §3.4.3): reject unless explicitly overridden.
  if (RESERVED_MODEL_IDS.has(modelId) && !allowReserved) {
    sendJson(res, 409, {
      error:
        `Model '${modelId}' is reserved (exclusive assignment). ` +
        `Pass allowReserved: true only with an explicit operator decision.`,
      reserved: true,
    });
    return;
  }

  // Billing gate: pinning a teros-provider model consumes teros hours.
  if (provider.providerType === 'teros') {
    const { BillingGateService } = await import('../services/billing-gate.js');
    try {
      await new BillingGateService(db).assertTerosModelAllowed(ctx.userId);
    } catch (err) {
      if (err instanceof UpgradeRequiredError) {
        sendJson(res, 402, { error: err.message });
        return;
      }
      throw err;
    }
  }

  await db.collection('agents').updateOne(
    { agentId },
    {
      $set: {
        selectedProviderId: providerId,
        selectedModelId: modelId,
        updatedAt: new Date().toISOString(),
      },
    },
  );

  // Audit trail (policy §3.4.2): who/when/why for every model change.
  console.log(
    `[handleAgentModelSet] user=${ctx.userId} set agent=${agentId} ` +
      `provider=${providerId} model=${modelId} reason=${reason ?? '(none)'}`,
  );

  const updatedAgent = await db.collection('agents').findOne({ agentId });
  const agentName =
    (agent.fullName as string | undefined) ?? (agent.name as string | undefined) ?? agentId;

  sendJson(res, 200, {
    success: true,
    message: `Model for '${agentName}' set to ${modelId} (provider ${providerId})`,
    agentId,
    agentName,
    selectedProviderId: providerId,
    selectedModelId: modelId,
    reason: reason ?? null,
  });

  // Broadcast agent.updated so the UI reflects the new model without a reload.
  if (pubSubService && updatedAgent) {
    try {
      const core = await db
        .collection('agent_cores')
        .findOne({ coreId: updatedAgent.coreId });
      const payload = buildAgentUpdatedPayload(updatedAgent as any, core?.avatarUrl);
      await broadcastAgentUpdated(pubSubService, ctx.userId, payload);
    } catch (err) {
      console.warn('[handleAgentModelSet] agent.updated broadcast failed', err);
    }
  }
}

/**
 * reset-agent-model — clear the explicit pin so the agent returns to System
 * Default (spec §3.1.2). This is the preferred state: the user's default
 * provider/model wins unless there is a considered reason to pin.
 */
export async function handleAgentModelReset(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  agentId: string,
  body: { reason?: string },
  pubSubService?: PubSubService | null,
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

  await db.collection('agents').updateOne(
    { agentId },
    {
      $set: {
        selectedProviderId: null,
        selectedModelId: null,
        updatedAt: new Date().toISOString(),
      },
    },
  );

  console.log(
    `[handleAgentModelReset] user=${ctx.userId} reset agent=${agentId} to System Default ` +
      `reason=${body?.reason ?? '(none)'}`,
  );

  const updatedAgent = await db.collection('agents').findOne({ agentId });
  const agentName =
    (agent.fullName as string | undefined) ?? (agent.name as string | undefined) ?? agentId;

  sendJson(res, 200, {
    success: true,
    message: `Model for '${agentName}' reset to System Default`,
    agentId,
    agentName,
    selectedProviderId: null,
    selectedModelId: null,
  });

  if (pubSubService && updatedAgent) {
    try {
      const core = await db
        .collection('agent_cores')
        .findOne({ coreId: updatedAgent.coreId });
      const payload = buildAgentUpdatedPayload(updatedAgent as any, core?.avatarUrl);
      await broadcastAgentUpdated(pubSubService, ctx.userId, payload);
    } catch (err) {
      console.warn('[handleAgentModelReset] agent.updated broadcast failed', err);
    }
  }
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
  body: { workspaceId: string; name: string; description?: string; content: string; loadMode?: SkillLoadMode },
  skillService?: SkillService,
): Promise<void> {
  const { workspaceId, name, description, content, loadMode } = body;

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
  if (loadMode !== undefined && !isValidLoadMode(loadMode)) {
    sendJson(res, 400, { error: "loadMode must be 'always' or 'on-demand'" });
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
    loadMode,
  });
  sendJson(res, 200, { skill });
}

export async function handleSkillUpdate(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  skillId: string,
  body: { name?: string; description?: string; content?: string; loadMode?: SkillLoadMode },
  skillService?: SkillService,
): Promise<void> {
  if (!skillId) {
    sendJson(res, 400, { error: 'skillId is required' });
    return;
  }
  if (body.loadMode !== undefined && !isValidLoadMode(body.loadMode)) {
    sendJson(res, 400, { error: "loadMode must be 'always' or 'on-demand'" });
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
    loadMode: body.loadMode,
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

// ============================================================================
// APP SECRETS — agent secret tools
// (docs/specs/20261031_agent-secret-tools.md, designs B & C)
// ============================================================================

/**
 * Valid secret keys an agent may write for an app: the MCA's declared
 * `userSecrets` plus OAuth `auth.extraFields` (e.g. TEAM_ID in Figma).
 * System secrets (`systemSecrets`) are admin-only — never agent-writable.
 */
function allowedSecretKeys(mca: McpCatalogEntry): { keys: string[]; extraFields: string[] } {
  const userSecrets = (mca as any).userSecrets ?? (mca as any).auth?.userSecrets ?? [];
  const extraFields = ((mca as any).auth?.extraFields ?? []) as Array<{ name: string }>;
  return {
    keys: [...userSecrets, ...extraFields.map((f) => f.name)],
    extraFields: extraFields.map((f) => f.name),
  };
}

/**
 * `set-app-secret` — write ONE user secret for an app (design B).
 *
 * Permission: the TOOL is `alwaysAsk` (teros-core), so the user confirmed
 * before this runs. The write path is the same one the panel uses
 * (saveApiKeyCredentials → AuthManager.merge — partial, preserves siblings).
 *
 * After the write, the backend runs the redaction sweep server-side over the
 * CALLING channel (riding on this same confirmation — no separate ask): every
 * message containing the value gets redacted, INCLUDING this call's own
 * arguments. MCA containers fetch secrets live via /secrets/user, so no
 * respawn is needed.
 *
 * Audit: "secret <key> of app <appId> updated by <agentId>" — NEVER the value.
 */
export async function handleAppSetSecret(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  appId: string,
  body: { key?: string; value?: string; scope?: 'user' | 'app'; alsoRedact?: string[] },
  mcaOAuth: McaOAuth | undefined,
  channelManager: import('../services/channel-manager').ChannelManager | undefined,
  agentId?: string,
): Promise<void> {
  const { key, value, scope = 'user', alsoRedact } = body ?? ({} as any);

  if (!(await canAccessApp(db, ctx.userId, appId))) {
    sendJson(res, 403, { error: 'Access denied to app' });
    return;
  }

  if (!key || typeof key !== 'string') {
    sendJson(res, 400, { error: 'key is required (the secret field name, e.g. MAKE_API_TOKEN)' });
    return;
  }
  if (value == null || typeof value !== 'string' || value.length === 0) {
    sendJson(res, 400, { error: 'value is required' });
    return;
  }
  if (scope === 'app') {
    // System secrets are admin surface only — an agent must never write them.
    sendJson(res, 403, {
      error: "scope 'app' (MCA system secrets) is admin-only; agents can only write user secrets",
    });
    return;
  }
  if (scope !== 'user') {
    sendJson(res, 400, { error: "scope must be 'user' (default) or 'app'" });
    return;
  }

  const loaded = await loadAppAndMca(db, appId);
  if ('error' in loaded) {
    sendJson(res, loaded.error.status, { error: loaded.error.message });
    return;
  }
  const { app, mca } = loaded;

  const { keys } = allowedSecretKeys(mca);
  if (!keys.includes(key)) {
    sendJson(res, 400, {
      error: `key '${key}' is not a declared secret of ${app.mcaId}`,
      allowedKeys: keys,
      hint: 'The MCA manifest declares writable user secrets (userSecrets / auth.extraFields).',
    });
    return;
  }

  if (!mcaOAuth) {
    sendJson(res, 503, { error: 'Secret write unavailable: OAuth service not configured' });
    return;
  }

  // ── Write (same path as the panel: partial merge, preserves siblings) ────
  await mcaOAuth.saveApiKeyCredentials(ctx.userId, appId, app.mcaId, { [key]: value });

  // ── Audit — key + app + actor, NEVER the value (AC 6) ────────────────────
  console.log(
    `[Resources] app.set-secret: secret ${key} of app ${appId} updated by ${agentId ?? ctx.userId} (user ${ctx.userId})`,
  );

  // ── Post-write sweep over the CALLING channel (self-redacting) ───────────
  // Best-effort: a sweep failure must not fail the credential write (the
  // secret IS saved). The agent can still run redact-by-value standalone.
  // callerChannelId: in grant mode ctx.channelId is the appId — the REAL
  // conversation channel (ch_*) came from the call grant.
  const sweepChannelId = ctx.callerChannelId ?? ctx.channelId;
  let sweep: { redactedCount: number; messageIds: string[] } | null = null;
  let sweepError: string | undefined;
  if (sweepChannelId && channelManager) {
    try {
      const { sweepRedactByValue } = await import('../services/redaction-sweep');
      const result = await sweepRedactByValue(db, channelManager, sweepChannelId, value, {
        ...(alsoRedact && alsoRedact.length > 0 ? { alsoRedact } : {}),
        redactedBy: agentId ?? ctx.userId,
      });
      sweep = { redactedCount: result.redactedCount, messageIds: result.messageIds };

      // Live UI update for every swept message — ids only, no content.
      const pubSub = (globalThis as any).__terosPubSub;
      if (pubSub) {
        for (const messageId of result.messageIds) {
          pubSub.broadcastToTopic(`channel:${sweepChannelId}`, {
            type: 'message_redacted',
            channelId: sweepChannelId,
            messageId,
            redacted: true,
            redactedBy: agentId ?? ctx.userId,
            redactedAt: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      sweepError = err instanceof Error ? err.message : 'sweep failed';
      console.warn(`[Resources] app.set-secret: post-write sweep failed for ${appId}`, err);
    }
  }

  // ── Read back status so the agent can verify connection (AC 1) ───────────
  let auth: { status: string; authType: string; message?: string } | undefined;
  try {
    const info = await mcaOAuth.getAuthStatus(ctx.userId, appId, mca);
    auth = { status: info.status, authType: info.authType, message: info.message };
  } catch (err) {
    console.warn(`[Resources] app.set-secret: getAuthStatus failed for ${appId}`, err);
  }

  sendJson(res, 200, {
    success: true,
    appId,
    appName: app.name,
    mcaId: app.mcaId,
    key,
    scope: 'user',
    maskedValue: maskSecret(value),
    auth,
    redaction: sweep
      ? {
          swept: true,
          channelId: sweepChannelId,
          redactedCount: sweep.redactedCount,
          messageIds: sweep.messageIds,
        }
      : { swept: false, error: sweepError ?? 'no channel context' },
    note:
      `Secret ${key} saved (${maskSecret(value)}). All messages containing it were redacted` +
      ' (including this call). The app reads the new value live — no restart needed. ' +
      'Reference the secret only by its mask from now on.',
  });
}

/**
 * `copy-app-auth` — replicate the COMPLETE auth of one app instance to another
 * (task tn_aGVdSrVwIJi9mfvc, the 5th credential tool). URL names the TARGET
 * app; the source travels in the body. The copy itself lives in
 * services/app-auth-copy.ts (get→set: decrypt with the source scope,
 * re-encrypt with the target scope — NEVER a Mongo clone).
 *
 * Permission: the TOOL is `alwaysAsk` (teros-core), so the user confirmed
 * before this runs. Cross-user is impossible here: ctx.userId IS the caller's
 * own userId, and canAccessApp verified access to both apps.
 */
export async function handleAppCopyAuth(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  targetAppId: string,
  body: { sourceAppId?: string; sourceWorkspaceId?: string; targetWorkspaceId?: string; agentId?: string },
  authManager: AuthManager | undefined,
  mcaOAuth: McaOAuth | undefined,
): Promise<void> {
  const { sourceAppId, sourceWorkspaceId, targetWorkspaceId, agentId } = body ?? ({} as any);

  // ── 1. The caller must have access to BOTH apps (cross-workspace OK —
  // canAccessApp walks the caller's workspace memberships).
  if (!(await canAccessApp(db, ctx.userId, targetAppId))) {
    sendJson(res, 403, { error: `Access denied to target app '${targetAppId}'` });
    return;
  }
  if (!sourceAppId || typeof sourceAppId !== 'string') {
    sendJson(res, 400, { error: 'sourceAppId is required (the app instance to copy credentials FROM)' });
    return;
  }
  // Cross-workspace tools ALWAYS name their workspaces (tn_hj1s2cs1t93g91xq,
  // Pablo 2-nov: infra sharded by workspaceId — a tool must know which
  // infrastructure it is hitting at all times).
  if (!sourceWorkspaceId || typeof sourceWorkspaceId !== 'string') {
    sendJson(res, 400, {
      error: 'sourceWorkspaceId is required — cross-workspace tools always name their workspaces (the workspace the source app lives in)',
    });
    return;
  }
  if (!targetWorkspaceId || typeof targetWorkspaceId !== 'string') {
    sendJson(res, 400, {
      error: 'targetWorkspaceId is required — cross-workspace tools always name their workspaces (the workspace the target app lives in)',
    });
    return;
  }
  if (!(await canAccessApp(db, ctx.userId, sourceAppId))) {
    sendJson(res, 403, { error: `Access denied to source app '${sourceAppId}'` });
    return;
  }

  if (!authManager) {
    sendJson(res, 503, { error: 'Auth copy unavailable: AuthManager not configured' });
    return;
  }

  // ── 2. The copy (validations inside the service, in order, with clear errors)
  const { copyAppAuth } = await import('../services/app-auth-copy');
  const outcome = await copyAppAuth(db, authManager, {
    userId: ctx.userId,
    sourceAppId,
    targetAppId,
    sourceWorkspaceId,
    targetWorkspaceId,
    ...(agentId ? { actorId: agentId } : {}),
  });

  if (!outcome.ok) {
    sendJson(res, outcome.status, {
      error: outcome.message,
      code: outcome.code,
      ...(outcome.extra ?? {}),
    });
    return;
  }

  // ── 3. Read back the target's live status so the agent can verify the copy
  // (same contract as set-app-secret's AC 1). Best-effort: the copy IS saved.
  let auth: { status: string; authType: string; message?: string } | undefined;
  if (mcaOAuth) {
    try {
      const loaded = await loadAppAndMca(db, targetAppId);
      if (!('error' in loaded)) {
        const info = await mcaOAuth.getAuthStatus(ctx.userId, targetAppId, loaded.mca);
        auth = { status: info.status, authType: info.authType, message: info.message };
      }
    } catch (err) {
      console.warn(`[Resources] app.copy-auth: getAuthStatus failed for ${targetAppId}`, err);
    }
  }

  const s = outcome.summary;
  sendJson(res, 200, {
    success: true,
    sourceAppId: s.sourceAppId,
    sourceAppName: s.sourceAppName,
    targetAppId: s.targetAppId,
    targetAppName: s.targetAppName,
    mcaId: s.mcaId,
    copiedFields: s.copiedFields,
    fieldCount: s.fieldCount,
    auth,
    note:
      `Auth of '${s.sourceAppName}' (${s.sourceAppId}) copied to '${s.targetAppName}' (${s.targetAppId}) — ` +
      `${s.fieldCount} field(s): ${s.copiedFields.map((f) => `${f.key}=${f.maskedValue}`).join(', ')}. ` +
      'Full replace on the target; it reads the new credentials live (no restart). ' +
      (s.hasOAuthTokens
        ? 'Both instances now share the same OAuth tokens — if the provider rotates refresh tokens, one can invalidate the other. '
        : '') +
      'Values are never exposed; reference them only by mask.',
  });
}

/**
 * `get-app-secret` — masked preview + metadata ONLY (design C).
 *
 * Never returns the value. The mask format is the shared `maskSecret`
 * (prefix…last4), the same one the agent sees in redaction placeholders —
 * so "the …4f2a key" is a stable reference across both surfaces.
 */
export async function handleAppGetSecret(
  res: ServerResponse,
  ctx: ResourceContext,
  db: Db,
  appId: string,
  body: { key?: string; scope?: 'user' | 'app' },
  mcaOAuth: McaOAuth | undefined,
): Promise<void> {
  const { key, scope = 'user' } = body ?? ({} as any);

  if (!(await canAccessApp(db, ctx.userId, appId))) {
    sendJson(res, 403, { error: 'Access denied to app' });
    return;
  }
  if (!key || typeof key !== 'string') {
    sendJson(res, 400, { error: 'key is required' });
    return;
  }
  if (scope !== 'user' && scope !== 'app') {
    sendJson(res, 400, { error: "scope must be 'user' (default) or 'app'" });
    return;
  }

  const loaded = await loadAppAndMca(db, appId);
  if ('error' in loaded) {
    sendJson(res, loaded.error.status, { error: loaded.error.message });
    return;
  }
  const { app, mca } = loaded;

  const { keys } = allowedSecretKeys(mca);
  if (!keys.includes(key)) {
    sendJson(res, 400, {
      error: `key '${key}' is not a declared secret of ${app.mcaId}`,
      allowedKeys: keys,
    });
    return;
  }

  if (!mcaOAuth) {
    sendJson(res, 503, { error: 'Secret read unavailable: OAuth service not configured' });
    return;
  }

  // Read the stored credential through the SAME auth path the app uses.
  const credentials = await mcaOAuth
    .getCredentials(ctx.userId, appId)
    .catch(() => undefined);

  let stored: string | undefined;
  if (credentials && typeof credentials === 'object') {
    stored = (credentials as any)[key];
  }
  if (stored == null) {
    sendJson(res, 200, {
      appId,
      appName: app.name,
      mcaId: app.mcaId,
      key,
      scope,
      configured: false,
      note: 'No value stored for this key. Use set-app-secret to store one.',
    });
    return;
  }

  console.log(
    `[Resources] app.get-secret: secret ${key} of app ${appId} previewed by ${ctx.userId} (masked)`,
  );

  sendJson(res, 200, {
    appId,
    appName: app.name,
    mcaId: app.mcaId,
    key,
    scope,
    configured: true,
    maskedValue: maskSecret(stored),
    updatedAt: undefined, // per-key timestamps are not tracked; kept for future use
    note: 'Only a masked preview is available to agents — the full value is never returned.',
  });
}
