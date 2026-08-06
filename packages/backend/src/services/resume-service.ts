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
 * This replaces the old heuristic approach (updatedAt window + message state detection).
 */

import { reconcileChannel, type MessageWithParts, type Part, type SessionStore } from '@teros/core';
import type { Db } from 'mongodb';
import type { EventHandler } from '../handlers/event-handler';
import type { ChannelManager } from './channel-manager';
import type { AutoplayService } from './autoplay-service';

// Channels running for more than this threshold are considered zombies and just reset
const ZOMBIE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// Delay before checking (let all services initialize)
const STARTUP_DELAY_MS = 5000;

// Parallelism cap for channel-level replay during boot. Per-channel order is
// preserved by serializing within a channel; different channels run in parallel
// but not unbounded — otherwise N pending channels = N concurrent LLM turns at
// boot, which overwhelms providers and DB pools.
const REPLAY_CHANNEL_CONCURRENCY = 5;

/**
 * Callback invoked for each queued user message that needs to be re-driven
 * through the normal agent pipeline after a crash.
 *
 * `text` is the joined text from all `text` parts (may be empty when the
 * message only had file parts). `parts` is the full part list so the callback
 * can reconstruct file descriptors / multimodal context if needed.
 */
export type QueuedMessageReplay = (
  channelId: string,
  messageId: string,
  text: string,
  parts: Part[],
) => Promise<void>;

export class ResumeService {
  private replayUserMessage: QueuedMessageReplay | null = null;

  constructor(
    private db: Db,
    private eventHandler: EventHandler,
    private channelManager: ChannelManager,
    private autoplayService: AutoplayService | null = null,
    private sessionStore: SessionStore | null = null,
  ) {}

  /** Late-binding to break the ResumeService ↔ MessageHandler circular dep. */
  setQueueReplayHook(replay: QueuedMessageReplay): void {
    this.replayUserMessage = replay;
  }

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

      if (runningChannels.length === 0) {
        console.log('🔄 ResumeService: No interrupted conversations found');
        return;
      }

      console.log(
        `🔄 ResumeService: Found ${runningChannels.length} channel(s) with running=true`,
      );

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
          console.log(`🔄 ResumeService: Reset zombie channel ${channelId}`);
        }
      }

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
   * For each recoverable channel, decide whether to delegate to AutoplayService
   * (board tasks) or trigger system_resume directly (normal conversations).
   */
  private async recoverChannels(channelIds: string[]): Promise<void> {
    const reconciled = await this.reconcileOrphansAcross(channelIds);
    await this.replayPendingQueuedMessages(reconciled);
    const { boardPairs, normalChannels } = await this.classifyByBoardLink(reconciled);
    await this.dispatchRecovery(boardPairs, normalChannels);
  }

  private async reconcileOrphansAcross(channelIds: string[]): Promise<string[]> {
    if (!this.sessionStore) {
      console.warn(
        '🔄 ResumeService: SessionStore not provided — skipping TurnReconciler (orphans will be handled by live INV-1 pipeline on next prompt)',
      );
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
          await this.clearRunningFlag(channelId);
        }
      } catch (err) {
        console.error(`🔄 ResumeService: TurnReconciler failed for channel ${channelId}:`, err);
        await this.clearRunningFlag(channelId);
      }
    }
    return reconciledOk;
  }

  private async replayPendingQueuedMessages(channelIds: string[]): Promise<void> {
    if (!this.sessionStore || channelIds.length === 0) return;
    try {
      const pending = await this.sessionStore.listPendingQueueMessages(channelIds);
      if (pending.length === 0) {
        // running=true but nothing pending → clear the flag so it doesn't
        // stay stuck across future recoveries.
        await Promise.all(
          channelIds.map((cid) =>
            this.clearRunningFlag(cid).catch(() => undefined),
          ),
        );
        return;
      }

      if (!this.replayUserMessage) {
        console.warn(
          `🔄 ResumeService: ${pending.length} user message(s) left in the worker queue at crash time — no replay hook wired, marking done (manual replay needed)`,
          { messageIds: pending.map((m) => m.info.id) },
        );
        await Promise.all(
          pending.map((m) =>
            this.sessionStore!.updateUserMessageQueueState(m.info.id, 'done').catch(() => undefined),
          ),
        );
        return;
      }

      // Group by channelId — the worker is FIFO PER channel, so messages
      // within a channel must be replayed in order. Different channels can
      // (and should) be re-driven in parallel up to REPLAY_CHANNEL_CONCURRENCY.
      const byChannel = new Map<string, MessageWithParts[]>();
      for (const m of pending) {
        const cid = m.info.sessionID;
        const list = byChannel.get(cid);
        if (list) list.push(m);
        else byChannel.set(cid, [m]);
      }

      console.log(
        `🔄 ResumeService: re-driving ${pending.length} interrupted user message(s) across ${byChannel.size} channel(s) (concurrency=${REPLAY_CHANNEL_CONCURRENCY})`,
      );
      await this.replayChannelsWithConcurrency(byChannel, REPLAY_CHANNEL_CONCURRENCY);
    } catch (err) {
      console.error('🔄 ResumeService: failed to drain pending queueState:', err);
    }
  }

  /**
   * Process N channels in parallel; messages within a channel stay serial
   * so the existing per-channel FIFO ordering is preserved.
   */
  private async replayChannelsWithConcurrency(
    byChannel: Map<string, MessageWithParts[]>,
    concurrency: number,
  ): Promise<void> {
    const queue: Array<[string, MessageWithParts[]]> = [...byChannel.entries()];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const entry = queue.shift();
        if (!entry) return;
        const [, messages] = entry;
        for (const m of messages) {
          await this.replaySingleMessage(m);
        }
      }
    });
    await Promise.all(workers);
  }

  // Replay failures mark `done` so the next boot doesn't keep hammering
  // broken state. Messages with only file parts (no text) are still replayed
  // so the user doesn't lose attachments on crash recovery; only fully-empty
  // messages (no text, no files) get auto-marked done.
  private async replaySingleMessage(m: MessageWithParts): Promise<void> {
    if (!this.sessionStore || !this.replayUserMessage) return;
    const channelId = m.info.sessionID;
    const text = m.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { type: 'text'; text: string }).text)
      .join('\n');
    const hasFileParts = m.parts.some((p) => p.type === 'file');
    if (!text.trim() && !hasFileParts) {
      await this.sessionStore
        .updateUserMessageQueueState(m.info.id, 'done')
        .catch(() => undefined);
      return;
    }
    try {
      await this.replayUserMessage(channelId, m.info.id, text, m.parts);
    } catch (err) {
      console.error(
        `🔄 ResumeService: replay failed for message ${m.info.id} in channel ${channelId}:`,
        err,
      );
      await this.sessionStore
        .updateUserMessageQueueState(m.info.id, 'done')
        .catch(() => undefined);
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
    queueReplayHook: QueuedMessageReplay | null = null,
  ): Promise<ResumeService> {
    const service = new ResumeService(
      db,
      eventHandler,
      channelManager,
      autoplayService,
      sessionStore,
    );
    if (queueReplayHook) service.setQueueReplayHook(queueReplayHook);

    setTimeout(async () => {
      await service.checkAndResumeConversations();
    }, STARTUP_DELAY_MS);

    return service;
  }
}
