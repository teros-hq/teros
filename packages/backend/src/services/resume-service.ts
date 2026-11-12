/**
 * Resume Service
 *
 * At backend boot, uses the `running` field on Channel as the source of truth
 * to detect conversations that were interrupted by a restart.
 *
 * Logic:
 * - Find all channels where `running === true`
 * - Classify by `runningAt`:
 *   - runningAt < now - ZOMBIE_THRESHOLD_MS  → zombie (crash happened long ago) → reset to running=false
 *   - runningAt >= now - ZOMBIE_THRESHOLD_MS → recoverable → check if linked to a board task
 *
 * For recoverable channels:
 *   - If linked to a board task → delegate to AutoplayService.scheduleAgentTasks()
 *     (AutoplayService handles slots, columns, priorities — no direct system_resume)
 *   - If NOT linked to a board task → trigger system_resume directly
 *     (normal user conversations not managed by the board)
 *
 * system_resume is the ONLY recovery mechanism. Boot does NOT re-drive queued
 * user messages through the agent pipeline: the interrupted messages are
 * already persisted in the channel history, and the system_resume event
 * instructs the agent to read that history before continuing. Re-driving them
 * blindly at boot made the agent re-execute instructions that had already run
 * (including tool calls against MCAs that were not up yet), and because
 * interrupted messages were never marked `done`, every restart replayed the
 * channel's entire stale backlog (incident 2026-08-14).
 *
 * Queue-state hygiene: any user message still `pending`/`running` from before
 * this boot is swept to `done` so it can never be replayed and never shows up
 * as a ghost entry in the channel runtime snapshot.
 */

import { reconcileChannel, type SessionStore } from '@teros/core';
import type { Db } from 'mongodb';
import type { EventHandler } from '../handlers/event-handler';
import type { ChannelManager } from './channel-manager';
import type { AutoplayService } from './autoplay-service';
import type { InstanceRegistry } from './instance-registry';
import { cappedPush, TASK_ACTIVITY_CAP } from '../lib/task-arrays';

// Channels running for more than this threshold are considered zombies and just reset
const ZOMBIE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// Delay before checking (let all services initialize)
const STARTUP_DELAY_MS = 5000;
// DEP-REQ-6: how often the boot sweep re-checks for other live instances, and
// how long it waits at most before sweeping with a warning.
const SOLE_INSTANCE_POLL_MS = 2000;
const SOLE_INSTANCE_MAX_WAIT_MS = 10 * 60 * 1000;

export class ResumeService {
  /**
   * Anything queued before this instant belongs to a previous process life.
   * The service is constructed during bootstrap, before the server accepts
   * connections, so messages created after it are live traffic and must not
   * be swept.
   */
  private readonly bootTimeMs = Date.now();

  constructor(
    private db: Db,
    private eventHandler: EventHandler,
    private channelManager: ChannelManager,
    private autoplayService: AutoplayService | null = null,
    private sessionStore: SessionStore | null = null,
  ) {}

  /**
   * Check for interrupted conversations and trigger resume events.
   * Should be called after the backend is fully initialized.
   */
  async checkAndResumeConversations(): Promise<void> {
    console.log('🔄 ResumeService: Checking for interrupted conversations...');

    try {
      const channelsCollection = this.db.collection('channels');
      const now = Date.now();
      const zombieCutoff = new Date(now - ZOMBIE_THRESHOLD_MS).toISOString();

      // Find all channels that were running when the backend crashed
      const runningChannels = await channelsCollection
        .find({ running: true })
        .toArray();

      const zombies: string[] = [];
      const recoverable: string[] = [];

      for (const channel of runningChannels) {
        const channelId = channel.channelId || channel._id.toString();
        const runningAt: string | undefined = channel.runningAt;

        if (!runningAt || runningAt < zombieCutoff) {
          // No timestamp or too old — treat as zombie
          zombies.push(channelId);
        } else {
          // Recent enough — attempt recovery
          recoverable.push(channelId);
        }
      }

      if (runningChannels.length === 0) {
        console.log('🔄 ResumeService: No interrupted conversations found');
      } else {
        console.log(
          `🔄 ResumeService: Found ${runningChannels.length} channel(s) with running=true`,
        );
      }

      // Reset zombies (just clear the flag, no resume)
      if (zombies.length > 0) {
        console.log(
          `🔄 ResumeService: Resetting ${zombies.length} zombie channel(s) (running=true but runningAt too old or missing)`,
        );
        for (const channelId of zombies) {
          await channelsCollection.updateOne(
            { channelId },
            { $set: { running: false }, $unset: { runningAt: '' } },
          );
          // Also reset any board task linked to this channel — a zombie channel
          // means the task's running flag is also stale. Without this the task
          // keeps consuming autoplay slots forever (the root bug).
          await this.resetTaskRunningForChannel(channelId);
          console.log(`🔄 ResumeService: Reset zombie channel ${channelId}`);
        }
      }

      // Sweep stale queue state BEFORE waking any agent, so nothing can ever
      // re-drive these messages. The agent still sees them in history.
      await this.sweepStaleQueueState();

      // Recover interrupted channels
      if (recoverable.length > 0) {
        console.log(
          `🔄 ResumeService: Processing ${recoverable.length} recoverable channel(s)`,
        );
        await this.recoverChannels(recoverable);
      }

      console.log('🔄 ResumeService: Boot check complete');
    } catch (error) {
      console.error('🔄 ResumeService: Error during boot check:', error);
    }
  }

  /**
   * Mark every user message left `pending`/`running` by a previous process
   * life as `done`. These messages are already part of the channel history;
   * they must never be re-driven through the agent pipeline. Time-guarded by
   * bootTimeMs so live messages arriving during boot are untouched.
   */
  private async sweepStaleQueueState(): Promise<void> {
    try {
      const result = await this.db.collection('session_messages').updateMany(
        {
          'info.role': 'user',
          'info.meta.queueState': { $in: ['pending', 'running'] },
          'info.time.created': { $lt: this.bootTimeMs },
        },
        { $set: { 'info.meta.queueState': 'done' } },
      );
      if (result.modifiedCount > 0) {
        console.log(
          `🔄 ResumeService: Swept ${result.modifiedCount} stale queued message(s) to done (pre-boot pending/running)`,
        );
      }
    } catch (err) {
      console.error('🔄 ResumeService: Failed to sweep stale queue state:', err);
    }
  }

  /**
   * For each recoverable channel, decide whether to delegate to AutoplayService
   * (board tasks) or trigger system_resume directly (normal conversations).
   */
  private async recoverChannels(channelIds: string[]): Promise<void> {
    const reconciled = await this.reconcileOrphansAcross(channelIds);
    const { boardPairs, normalChannels } = await this.classifyByBoardLink(reconciled);
    await this.dispatchRecovery(boardPairs, normalChannels);
  }

  private async reconcileOrphansAcross(channelIds: string[]): Promise<string[]> {
    if (!this.sessionStore) {
      console.warn(
        '🔄 ResumeService: SessionStore not provided — skipping TurnReconciler (orphans will be handled by live INV-1 pipeline on next prompt)',
      );
      // incident-2026-08-14: even without SessionStore, cancel orphaned
      // permissions so they don't accumulate in DB forever.
      for (const channelId of channelIds) {
        await this.cancelOrphanedPermissions(channelId, 'SessionStore unavailable — turn reconciliation skipped');
      }
      return channelIds;
    }
    const reconciledOk: string[] = [];
    for (const channelId of channelIds) {
      try {
        const result = await reconcileChannel(this.sessionStore, channelId);
        if (result.orphanedToolCount > 0) {
          console.log(
            `🔄 ResumeService: TurnReconciler closed ${result.orphanedToolCount} orphan(s) in channel ${channelId}`,
          );
        }
        if (result.recovered) {
          reconciledOk.push(channelId);
        } else {
          console.warn(
            `🔄 ResumeService: TurnReconciler did NOT fully recover channel ${channelId} — skipping resume`,
          );
          // incident-2026-08-14: INV-1 failed — the turn is dead. Cancel
          // any pending permission requests so they don't accumulate.
          await this.cancelOrphanedPermissions(
            channelId,
            'INV-1 reconciliation failed — turn is dead',
          );
          await this.clearRunningFlag(channelId);
        }
      } catch (err) {
        console.error(`🔄 ResumeService: TurnReconciler failed for channel ${channelId}:`, err);
        // incident-2026-08-14: TurnReconciler threw — same cleanup.
        await this.cancelOrphanedPermissions(
          channelId,
          `TurnReconciler threw: ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.clearRunningFlag(channelId);
      }
    }
    return reconciledOk;
  }

  /**
   * Cancel all pending permission requests for a channel by marking
   * their `channel_messages` documents as `failed`.
   *
   * incident-2026-08-14: when a turn dies (INV-1 failure, crash,
   * TurnReconciler error), any permission requests it created are
   * orphaned. Without this cleanup they persist in DB indefinitely
   * and are re-broadcast on every subscribe via restorePendingApprovals.
   *
   * This is a DB-only operation — no broadcast (at boot time there
   * are no active WebSocket subscribers). The frontend will see the
   * `failed` status when it loads the channel history.
   */
  private async cancelOrphanedPermissions(channelId: string, reason: string): Promise<void> {
    try {
      const result = await this.db.collection('channel_messages').updateMany(
        {
          channelId,
          'content.type': 'tool_execution',
          'content.status': 'pending_permission',
        },
        {
          $set: {
            'content.status': 'failed',
            'content.error': `Permission cancelled: ${reason}`,
            'content.permissionRequestId': undefined,
          },
        },
      );
      if (result.modifiedCount > 0) {
        console.log(
          `🔄 ResumeService: Cancelled ${result.modifiedCount} orphaned permission(s) for channel ${channelId}: ${reason}`,
        );
      }
    } catch (err) {
      console.error(`🔄 ResumeService: Failed to cancel orphaned permissions for ${channelId}:`, err);
    }
  }

  /** Board pairs deduped by `${projectId}:${agentId}` — N tasks → 1 call. */
  private async classifyByBoardLink(channelIds: string[]): Promise<{
    boardPairs: Map<string, { projectId: string; agentId: string }>;
    normalChannels: string[];
  }> {
    const boardPairs = new Map<string, { projectId: string; agentId: string }>();
    const normalChannels: string[] = [];

    for (const channelId of channelIds) {
      const task = await this.db.collection('tasks').findOne(
        { channelId },
        { projection: { taskId: 1, boardId: 1, assignedAgentId: 1, columnId: 1 } },
      );

      if (!task || !task.boardId || !task.assignedAgentId || !this.autoplayService) {
        normalChannels.push(channelId);
        if (task && !this.autoplayService) {
          console.warn(
            `🔄 ResumeService: Channel ${channelId} linked to board task but AutoplayService not available — falling back to direct resume`,
          );
        }
        continue;
      }

      const project = await this.db.collection('projects').findOne(
        { boardId: task.boardId },
        { projection: { projectId: 1 } },
      );

      if (!project?.projectId) {
        console.warn(
          `🔄 ResumeService: Channel ${channelId} linked to task ${task.taskId} but project not found (boardId: ${task.boardId}) — falling back to direct resume`,
        );
        normalChannels.push(channelId);
        continue;
      }

      const key = `${project.projectId}:${task.assignedAgentId}`;
      boardPairs.set(key, { projectId: project.projectId, agentId: task.assignedAgentId });
      console.log(
        `🔄 ResumeService: Channel ${channelId} linked to task ${task.taskId} → will delegate to AutoplayService (project ${project.projectId}, agent ${task.assignedAgentId})`,
      );
    }
    return { boardPairs, normalChannels };
  }

  private async dispatchRecovery(
    boardPairs: Map<string, { projectId: string; agentId: string }>,
    normalChannels: string[],
  ): Promise<void> {
    if (boardPairs.size > 0) {
      console.log(
        `🔄 ResumeService: Delegating to AutoplayService for ${boardPairs.size} unique (project, agent) pair(s)`,
      );
      for (const { projectId, agentId } of boardPairs.values()) {
        console.log(`🔄 ResumeService: scheduleAgentTasks(${projectId}, ${agentId})`);
        this.autoplayService!.scheduleAgentTasks(projectId, agentId).catch((err) => {
          console.error(
            `🔄 ResumeService: AutoplayService.scheduleAgentTasks error for project ${projectId}, agent ${agentId}:`,
            err,
          );
        });
      }
    }

    if (normalChannels.length > 0) {
      console.log(
        `🔄 ResumeService: Triggering direct system_resume for ${normalChannels.length} normal channel(s)`,
      );
      for (const channelId of normalChannels) {
        await this.triggerResumeEvent(channelId);
      }
    }
  }

  private async clearRunningFlag(channelId: string): Promise<void> {
    await this.db
      .collection('channels')
      .updateOne({ channelId }, { $set: { running: false }, $unset: { runningAt: '' } });
    // Also clear the task running flag — if the channel is no longer running,
    // neither is the task. Without this the task stays running=true and blocks
    // autoplay slots indefinitely.
    await this.resetTaskRunningForChannel(channelId);
  }

  /**
   * Reset the running flag on any board task linked to the given channel.
   * Called during zombie/recovery cleanup to ensure task.running matches
   * channel.running. Without this, tasks stuck with running=true consume
   * autoplay slots and prevent new tasks from being picked up.
   */
  private async resetTaskRunningForChannel(channelId: string): Promise<void> {
    try {
      const result = await this.db.collection('tasks').updateMany(
        { channelId, running: true },
        {
          $set: { running: false, updatedAt: new Date().toISOString() },
          $push: {
            activity: cappedPush({
              eventType: 'status_changed',
              actor: 'system:resume-service',
              timestamp: new Date().toISOString(),
              details: { reason: 'channel_running_reset', fromRunning: true, toRunning: false },
            }, TASK_ACTIVITY_CAP) as any,
          },
        },
      );
      if (result.modifiedCount > 0) {
        console.log(
          `🔄 ResumeService: Reset running=false on ${result.modifiedCount} task(s) linked to channel ${channelId}`,
        );
      }
    } catch (err) {
      console.error(`🔄 ResumeService: Failed to reset task running flag for channel ${channelId}:`, err);
    }
  }

  /**
   * Trigger a system_resume event for a channel that was interrupted.
   * Used only for normal (non-board) conversations.
   *
   * Revalidates that the channel is still running before emitting — if the
   * agent already finished its turn (running=false by the time we get here),
   * there is nothing to resume and we must NOT wake the agent, otherwise it
   * will repeat actions that were already completed.
   */
  private async triggerResumeEvent(channelId: string): Promise<void> {
    // Revalidate: is the channel still actually running?
    const channel = await this.db.collection('channels').findOne(
      { channelId },
      { projection: { running: 1 } },
    );

    if (!channel || !channel.running) {
      console.log(
        `🔄 ResumeService: Channel ${channelId} is no longer running — skipping system_resume (agent already finished)`,
      );
      await this.clearRunningFlag(channelId);
      return;
    }

    console.log(`🔄 ResumeService: Triggering direct resume for channel ${channelId} (still running)`);

    await this.eventHandler.handleScheduledEvent({
      channelId,
      message: 'The backend was restarted while a task was in progress. Check the conversation history to see what was already completed before continuing — do not repeat actions that already succeeded.',
      eventType: 'system_resume',
      wakeUpAgent: true,
      metadata: {
        source: 'resume-service',
        reason: 'Backend restarted while channel had running=true',
      },
    });
  }

  /**
   * Start the resume service with a startup delay.
   * This allows time for all services to initialize before checking.
   */
  static async startWithDelay(
    db: Db,
    eventHandler: EventHandler,
    channelManager: ChannelManager,
    autoplayService: AutoplayService | null = null,
    sessionStore: SessionStore | null = null,
    instanceRegistry: InstanceRegistry | null = null,
    startupDelayMs: number = STARTUP_DELAY_MS,
  ): Promise<ResumeService> {
    const service = new ResumeService(
      db,
      eventHandler,
      channelManager,
      autoplayService,
      sessionStore,
    );

    setTimeout(async () => {
      // Blue/green handoff (DEP-REQ-6): while the previous color is still
      // alive, every `running: true` channel is ITS live conversation, not an
      // interrupted one. Sweeping now would wake a second agent turn on each
      // of them. Wait until we are the only instance; after the maximum wait
      // sweep anyway (logged) rather than never resuming.
      if (instanceRegistry) {
        await instanceRegistry.waitUntilSoleInstance({
          pollMs: SOLE_INSTANCE_POLL_MS,
          timeoutMs: SOLE_INSTANCE_MAX_WAIT_MS,
        });
      }
      await service.checkAndResumeConversations();
    }, startupDelayMs);

    return service;
  }
}
