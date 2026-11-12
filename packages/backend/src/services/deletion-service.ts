/**
 * Deletion Service — one cascade per entity (INF-3).
 *
 * Every entity had several delete paths (two for agents, two for projects)
 * and each left different orphans: messages and sessions after a channel,
 * access grants and channels after an agent, the board and every task after
 * a project. This is now the only place that knows what an entity owns.
 *
 * Shape of every cascade: an idempotent sweep. Children are removed first
 * and the entity's own document LAST, so a crash midway leaves the entity in
 * place and simply re-running the delete finishes the job. (Cascades can be
 * large — a channel's messages — so they are not wrapped in one transaction.)
 *
 * Not deleted on purpose: usage and billing evidence (agent_usage_*,
 * llm_usage, tool_executions, voice_sessions, billing_*). References that
 * outlive the entity (a task linked to a channel, an API token's channel) are
 * unset instead of deleting the referencing document.
 *
 * Each removal goes through the deletion log when it is initialised.
 */

import type { Db, Document, Filter } from 'mongodb';
import type { DeletionReason } from '../models/deletion-log';
import { getDeletionLogService } from './deletion-log-service';

interface Step {
  collection: string;
  filter: Filter<Document>;
  /** Instead of deleting matching documents, unset this field on them */
  unset?: string;
}

/** collection → documents deleted (or updated, for unset steps) */
export type CascadeReport = Record<string, number>;

/** The account owns shared workspaces where other people still work. */
/**
 * The message ends with ": <id>, <id>" — the app reads the blocking workspace
 * ids from there (DeleteAccountDialog), pinned by account-deletion.test.ts.
 */
export class AccountDeletionBlockedError extends Error {
  constructor(readonly workspaceIds: string[]) {
    super(
      `Transfer or delete these shared workspaces first (they have other members): ${workspaceIds.join(', ')}`,
    );
  }
}

interface CascadeContext {
  reason: DeletionReason;
  actor: string;
  trigger: string;
  metadata?: Record<string, unknown>;
}

export class DeletionService {
  constructor(private readonly db: Db) {}

  /** A conversation and everything that only exists for it. */
  async deleteChannel(channelId: string, actor: string, trigger = 'channel.delete'): Promise<CascadeReport> {
    return this.run({ reason: 'channel_close', actor, trigger, metadata: { channelId } }, this.channelSteps(channelId));
  }

  /** An agent, its conversations, its grants and what targets it. */
  async deleteAgent(agentId: string, actor: string, trigger = 'agent.delete'): Promise<CascadeReport> {
    const report: CascadeReport = {};
    const channels = await this.db
      .collection('channels')
      .find({ agentId }, { projection: { channelId: 1 } })
      .toArray();
    for (const channel of channels) {
      merge(report, await this.deleteChannel(channel.channelId as string, actor, trigger));
    }

    merge(
      report,
      await this.run({ reason: 'agent_delete', actor, trigger, metadata: { agentId } }, [
        { collection: 'agent_app_access', filter: { agentId } },
        { collection: 'agent_skill_access', filter: { agentId } },
        { collection: 'agent_project_relationships', filter: { agentId } },
        { collection: 'subscriptions_agent', filter: { agentId } },
        // A starter's lifetime is bounded by its target's (TER-650/G7)
        { collection: 'automate_starters', filter: { 'action.agentId': agentId } },
        { collection: 'tasks', filter: { assignedAgentId: agentId }, unset: 'assignedAgentId' },
        { collection: 'agents', filter: { agentId } },
      ]),
    );
    return report;
  }

  /** A project, its board and everything on it. */
  async deleteProject(projectId: string, actor: string, trigger = 'project.delete'): Promise<CascadeReport> {
    const project = await this.db.collection('projects').findOne({ projectId });
    const boardIds = (
      await this.db.collection('boards').find({ $or: [{ projectId }, ...(project?.boardId ? [{ boardId: project.boardId }] : [])] }, { projection: { boardId: 1 } }).toArray()
    ).map((b) => b.boardId as string);

    const boardSteps: Step[] =
      boardIds.length > 0
        ? [
            { collection: 'tasks', filter: { boardId: { $in: boardIds } } },
            { collection: 'board_events', filter: { boardId: { $in: boardIds } } },
            { collection: 'board_daily_stats', filter: { boardId: { $in: boardIds } } },
            { collection: 'board_subscriptions', filter: { boardId: { $in: boardIds } } },
            { collection: 'boards', filter: { boardId: { $in: boardIds } } },
          ]
        : [];

    return this.run({ reason: 'project_delete', actor, trigger, metadata: { projectId, boardIds } }, [
      ...boardSteps,
      { collection: 'agent_project_relationships', filter: { projectId } },
      { collection: 'automate_starters', filter: { 'action.projectId': projectId } },
      { collection: 'projects', filter: { projectId } },
    ]);
  }

  /** A workspace and everything in it: agents, projects, channels, apps, members. */
  async deleteWorkspace(workspaceId: string, actor: string, trigger = 'workspace.delete'): Promise<CascadeReport> {
    const report: CascadeReport = {};
    const ids = async (col: string, field: string) =>
      (await this.db.collection(col).find({ workspaceId }, { projection: { [field]: 1 } }).toArray()).map(
        (d) => d[field] as string,
      );

    for (const agentId of await ids('agents', 'agentId')) {
      merge(report, await this.deleteAgent(agentId, actor, trigger));
    }
    for (const projectId of await ids('projects', 'projectId')) {
      merge(report, await this.deleteProject(projectId, actor, trigger));
    }
    for (const channelId of await ids('channels', 'channelId')) {
      merge(report, await this.deleteChannel(channelId, actor, trigger));
    }

    merge(
      report,
      await this.run({ reason: 'other', actor, trigger, metadata: { workspaceId } }, [
        // apps.ownerId is the workspaceId
        { collection: 'apps', filter: { ownerId: workspaceId } },
        { collection: 'agent_app_installations', filter: { workspaceId } },
        { collection: 'skills', filter: { workspaceId } },
        { collection: 'automate_starters', filter: { workspaceId } },
        { collection: 'workspace_members', filter: { workspaceId } },
        // Saved scrollback of sleeping terminals
        { collection: 'terminal_sleeping_sessions', filter: { workspaceId } },
        { collection: 'workspaces', filter: { workspaceId } },
      ]),
    );
    return report;
  }

  /**
   * Delete an account (GDPR erasure — GOV-3/GOV-6).
   *
   * - Refuses while the user owns shared workspaces with other active members
   *   (their colleagues' data is not the user's to erase): transfer first.
   * - Owned workspaces (private, or shared with nobody else) go with their
   *   whole content; global agents too; the user's personal (non-shared)
   *   channels elsewhere; their memberships.
   * - Credentials and access: sessions, API tokens, identities, stored app
   *   credentials, providers, and the user's encryption key — deleting it
   *   crypto-shreds anything still encrypted with it.
   * - Kept for accounting: invoices and subscription history (the active
   *   subscription is ended). The users document stays as a pseudonymised
   *   tombstone (same userId, which billing references); its email becomes
   *   deleted+<userId>@deleted.invalid, so the address can register again.
   * - audit_logs / email_audit_log lose the user's IP, user agent and email.
   */
  async deleteUser(userId: string, actor: string, trigger = 'account.delete'): Promise<CascadeReport> {
    const user = await this.db.collection('users').findOne({ userId });
    const email = (user?.profile?.email as string | undefined)?.toLowerCase();

    const owned = await this.db
      .collection('workspaces')
      .find({ ownerId: userId }, { projection: { workspaceId: 1, type: 1 } })
      .toArray();
    const blocked: string[] = [];
    for (const ws of owned) {
      const others = await this.db
        .collection('workspace_members')
        .countDocuments({ workspaceId: ws.workspaceId, userId: { $ne: userId }, status: { $ne: 'pending' } });
      if (ws.type !== 'private' && others > 0) blocked.push(ws.workspaceId as string);
    }
    if (blocked.length > 0) throw new AccountDeletionBlockedError(blocked);

    const report: CascadeReport = {};
    for (const ws of owned) {
      merge(report, await this.deleteWorkspace(ws.workspaceId as string, actor, trigger));
    }
    const globalAgents = await this.db
      .collection('agents')
      .find({ ownerId: userId, workspaceId: { $exists: false } }, { projection: { agentId: 1 } })
      .toArray();
    for (const agent of globalAgents) {
      merge(report, await this.deleteAgent(agent.agentId as string, actor, trigger));
    }
    // Their personal conversations in other people's workspaces; shared ones
    // belong to the team and stay
    const personalChannels = await this.db
      .collection('channels')
      .find({ userId, scope: { $ne: 'shared' } }, { projection: { channelId: 1 } })
      .toArray();
    for (const channel of personalChannels) {
      merge(report, await this.deleteChannel(channel.channelId as string, actor, trigger));
    }

    const now = new Date();
    merge(
      report,
      await this.run({ reason: 'user_delete', actor, trigger, metadata: { userId } }, [
        { collection: 'workspace_members', filter: { userId } },
        { collection: 'user_sessions', filter: { userId } },
        { collection: 'api_tokens', filter: { userId } },
        { collection: 'user_identities', filter: { userId } },
        { collection: 'user_credentials', filter: { userId } },
        { collection: 'app_user_auth', filter: { userId } },
        { collection: 'user_providers', filter: { userId } },
        { collection: 'coding_agent_credentials', filter: { userId } },
        { collection: 'oauth_states', filter: { userId } },
        { collection: 'mca_oauth_states', filter: { userId } },
        { collection: 'email_verifications', filter: { userId } },
        { collection: 'user_desktop_state', filter: { userId } },
        { collection: 'feature_flag_overrides', filter: { targetType: 'user', targetId: userId } },
        // Crypto-shredding: without the key, any leftover ciphertext is unreadable
        { collection: 'user_encryption_keys', filter: { userId } },
      ]),
    );

    // Per-user credentials embedded in shared apps (apps.userAuth.<userId>)
    const apps = await this.db
      .collection('apps')
      .updateMany({ [`userAuth.${userId}`]: { $exists: true } }, { $unset: { [`userAuth.${userId}`]: '' } });
    if (apps.modifiedCount > 0) report['apps.userAuth'] = apps.modifiedCount;

    await this.db
      .collection('billing_subscriptions')
      .updateMany(
        { userId, status: 'active' },
        { $set: { status: 'ended', endDate: now, cancelAtPeriodEnd: false, updatedAt: now } },
      );

    const pseudonym = `deleted+${userId}@deleted.invalid`;
    await this.db.collection('audit_logs').updateMany(
      { $or: [{ actorUserId: userId }, { targetUserId: userId }] },
      { $unset: { ip: '', userAgent: '', 'detail.email': '' } },
    );
    if (email) {
      await this.db.collection('email_audit_log').updateMany({ to: email }, { $set: { to: pseudonym } });
    }

    await this.db.collection('users').updateOne(
      { userId },
      {
        $set: {
          'profile.email': pseudonym,
          'profile.displayName': 'Deleted user',
          status: 'suspended',
          emailVerified: false,
          deletedAt: now,
          updatedAt: now,
        },
        $unset: { 'profile.avatarUrl': '', 'profile.description': '', mfa: '' },
      },
    );
    report.users = 1;
    return report;
  }

  private channelSteps(channelId: string): Step[] {
    return [
      { collection: 'channel_messages', filter: { channelId } },
      // LLM-side history of the conversation (session id = channel id)
      { collection: 'session_messages', filter: { sessionId: channelId } },
      { collection: 'compactions', filter: { sessionId: channelId } },
      { collection: 'sessions', filter: { id: channelId } },
      { collection: 'message_feedback', filter: { conversationId: channelId } },
      {
        collection: 'channel_subscriptions',
        filter: { $or: [{ subscriberChannelId: channelId }, { observedChannelId: channelId }] },
      },
      { collection: 'subscriptions_channel', filter: { channelId } },
      { collection: 'subscriptions_correlation', filter: { channelId } },
      { collection: 'board_subscriptions', filter: { channelId } },
      // A starter must not keep firing into a channel that no longer exists (TER-650/G7)
      { collection: 'automate_starters', filter: { 'action.channelId': channelId } },
      // Legacy placeholder rows (MOD-2)
      { collection: 'agent_configs', filter: { channelId } },
      { collection: 'tasks', filter: { channelId }, unset: 'channelId' },
      { collection: 'api_tokens', filter: { channelId }, unset: 'channelId' },
      { collection: 'channels', filter: { channelId } },
    ];
  }

  private async run(ctx: CascadeContext, steps: Step[]): Promise<CascadeReport> {
    const report: CascadeReport = {};
    const deletionLog = getDeletionLogService();

    for (const step of steps) {
      const col = this.db.collection(step.collection);

      if (step.unset) {
        const res = await col.updateMany(step.filter, { $unset: { [step.unset]: '' } });
        if (res.modifiedCount > 0) report[`${step.collection}.${step.unset}`] = res.modifiedCount;
        continue;
      }

      const count = await col.countDocuments(step.filter);
      if (count === 0) continue;

      if (deletionLog) {
        await deletionLog.logDeletion({
          collection: step.collection,
          filterSummary: JSON.stringify(step.filter),
          count,
          reason: ctx.reason,
          actor: ctx.actor,
          trigger: ctx.trigger,
          metadata: ctx.metadata,
          deleteFn: () => col.deleteMany(step.filter),
        });
      } else {
        await col.deleteMany(step.filter);
      }
      report[step.collection] = count;
    }
    return report;
  }
}

function merge(into: CascadeReport, from: CascadeReport): void {
  for (const [key, n] of Object.entries(from)) into[key] = (into[key] ?? 0) + n;
}
