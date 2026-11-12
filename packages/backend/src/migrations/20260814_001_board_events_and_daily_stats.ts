import type { Db } from 'mongodb';
import type { Migration } from './types.js';

const migration: Migration = {
  description:
    'Create board_events + board_daily_stats collections with indexes. ' +
    'Backfill events from existing Task.activity arrays. ' +
    'Does NOT remove the activity array from tasks (backward compat).',

  async up(db: Db): Promise<void> {
    // 1. Create indexes on board_events (the service does this too, but we
    //    create them here so they exist even before the service is initialized)
    const eventsCol = db.collection('board_events');
    await eventsCol.createIndex({ boardId: 1, timestamp: -1 }, { name: 'boardId_timestamp_desc' });
    await eventsCol.createIndex({ taskId: 1, timestamp: -1 }, { name: 'taskId_timestamp_desc' });
    await eventsCol.createIndex({ projectId: 1, timestamp: -1 }, { name: 'projectId_timestamp_desc' });
    await eventsCol.createIndex({ workspaceId: 1, timestamp: -1 }, { name: 'workspaceId_timestamp_desc' });
    await eventsCol.createIndex({ eventType: 1, timestamp: -1 }, { name: 'eventType_timestamp_desc' });
    await eventsCol.createIndex({ actor: 1, timestamp: -1 }, { name: 'actor_timestamp_desc' });
    // TTL: 90 days
    await eventsCol.createIndex(
      { timestamp: 1 },
      { name: 'ttl_timestamp', expireAfterSeconds: 90 * 24 * 60 * 60 },
    );

    // 2. Create indexes on board_daily_stats
    const statsCol = db.collection('board_daily_stats');
    await statsCol.createIndex({ boardId: 1, date: 1 }, { unique: true, name: 'boardId_date_unique' });
    await statsCol.createIndex({ projectId: 1, date: -1 }, { name: 'projectId_date_desc' });
    await statsCol.createIndex({ workspaceId: 1, date: -1 }, { name: 'workspaceId_date_desc' });
    await statsCol.createIndex({ date: -1 }, { name: 'date_desc' });

    console.log('[Migration] board_events + board_daily_stats indexes created');

    // 3. Backfill from existing task.activity arrays
    // We do this inline (not via the service) to keep the migration self-contained.
    const tasksCol = db.collection('tasks');

    // Build boardId → projectId map
    const boardsCol = db.collection('boards');
    const boards = await boardsCol.find({}, { projection: { boardId: 1, projectId: 1 } }).toArray();
    const boardToProject = new Map<string, string>();
    for (const b of boards) {
      boardToProject.set(b.boardId, b.projectId);
    }

    // Build projectId → workspaceId map
    const projectsCol = db.collection('projects');
    const projects = await projectsCol.find({}, { projection: { projectId: 1, workspaceId: 1 } }).toArray();
    const projectToWorkspace = new Map<string, string>();
    for (const p of projects) {
      projectToWorkspace.set(p.projectId, p.workspaceId);
    }

    // Legacy type mapping
    const ACTIVITY_TYPE_MAP: Record<string, string> = {
      created: 'task.created',
      moved: 'task.moved',
      assigned: 'task.assigned',
      unassigned: 'task.unassigned',
      started: 'task.started',
      linked: 'task.linked',
      priority_changed: 'task.priority_changed',
      updated: 'task.updated',
      deleted: 'task.deleted',
      status_changed: 'task.moved',
      progress_note: 'task.progress_note',
      running_changed: 'task.running_changed',
      dependency_added: 'task.dependency_added',
      dependency_removed: 'task.dependency_removed',
      circular_dependency_detected: 'task.circular_dependency_detected',
    };

    let totalEvents = 0;
    let batch: any[] = [];
    const BATCH_SIZE = 500;

    const cursor = tasksCol.find(
      { activity: { $exists: true, $ne: [] } },
      { projection: { taskId: 1, boardId: 1, title: 1, activity: 1 } },
    );

    for await (const task of cursor) {
      const projectId = boardToProject.get(task.boardId);
      if (!projectId) continue;

      const workspaceId = projectToWorkspace.get(projectId);
      if (!workspaceId) continue;

      for (const entry of task.activity ?? []) {
        const eventType = ACTIVITY_TYPE_MAP[entry.eventType] ?? 'task.updated';
        const event = {
          eventId: `bevt_backfill_${totalEvents}`,
          boardId: task.boardId,
          projectId,
          workspaceId,
          taskId: task.taskId,
          taskTitle: task.title,
          eventType,
          actor: entry.actor,
          timestamp: entry.timestamp,
          details: entry.details,
        };

        batch.push(event);
        totalEvents++;

        if (batch.length >= BATCH_SIZE) {
          await eventsCol.insertMany(batch);
          batch = [];
        }
      }
    }

    if (batch.length > 0) {
      await eventsCol.insertMany(batch);
    }

    console.log(`[Migration] Backfilled ${totalEvents} events from task.activity arrays`);

    // 4. Build initial daily stats from the backfilled events using aggregation
    const pipeline = [
      {
        $group: {
          _id: { boardId: '$boardId', date: { $substr: ['$timestamp', 0, 10] } },
          projectId: { $first: '$projectId' },
          workspaceId: { $first: '$workspaceId' },
          events: { $push: '$$ROOT' },
        },
      },
    ];

    const groups = await eventsCol.aggregate(pipeline).toArray();

    for (const group of groups) {
      const { boardId, date } = group._id;
      const events = group.events;

      const countByType = (types: string[]) =>
        events.filter((e: any) => types.includes(e.eventType)).length;

      const statsDoc = {
        statsId: `bds_backfill_${boardId}_${date}`,
        boardId,
        projectId: group.projectId,
        workspaceId: group.workspaceId,
        date,
        columnCounts: {},
        tasksCreated: countByType(['task.created', 'board.task_created']),
        tasksMoved: countByType(['task.moved', 'board.task_moved']),
        tasksCompleted: countByType(['task.completed']),
        tasksBlocked: countByType(['task.blocked']),
        tasksArchived: countByType(['task.archived', 'board.task_archived']),
        tasksStarted: countByType(['task.started']),
        progressNotesPosted: countByType(['task.progress_note', 'board.task_progress_note']),
        dependenciesAdded: countByType(['task.dependency_added', 'board.dependency_added']),
        dependenciesRemoved: countByType(['task.dependency_removed', 'board.dependency_removed']),
        activeAgents: [...new Set(
          events
            .filter((e: any) => e.actor && e.actor !== 'system' && !e.actor.startsWith('system:'))
            .map((e: any) => e.actor),
        )],
        assignmentsMade: countByType(['task.assigned', 'board.task_assigned']),
        unassignmentsMade: countByType(['task.unassigned']),
        recentEventIds: events.slice(-20).map((e: any) => e.eventId),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await statsCol.insertOne(statsDoc);
    }

    console.log(`[Migration] Rebuilt daily stats for ${groups.length} board-date combinations`);
  },

  async down(db: Db): Promise<void> {
    // Drop both collections
    await db.collection('board_events').drop().catch(() => {});
    await db.collection('board_daily_stats').drop().catch(() => {});
    console.log('[Migration] Dropped board_events + board_daily_stats collections');
  },
};

export default migration;
