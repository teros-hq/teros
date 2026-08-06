/**
 * Whitelists de campos expuestos por los tools del MCA board-runner.
 *
 * El runner opera sobre el mismo modelo de datos que board-manager pero con
 * una perspectiva reducida (solo tareas asignadas al agente actual). Las
 * whitelists son un subconjunto coherente de las del manager.
 *
 * **Nota sobre campos derivados**: los handlers backend enriquecen las
 * responses con `columnName`, `columnSlug`, `assigneeName`, `projectName`,
 * etc. (ver `packages/backend/src/handlers/domains/board/_helpers.ts`).
 */

export const TASK_FIELDS = [
  'taskId',
  'boardId',
  'columnId',
  'columnName', // derived
  'columnSlug', // derived
  'position',
  'title',
  'description',
  'priority',
  'archived',
  'archiveNote',
  'tags',
  'assignedAgentId',
  'assigneeName', // derived
  'assigneeAvatarUrl', // derived
  'channelId',
  'running',
  // Cooperative stop protocol contract — runner MUST check stopRequested
  // at the start of every turn. Never filter it out of TASK_FIELDS.
  'stopRequested',
  'stopRequestedAt',
  'stopRequestedBy',
  'parentTaskId',
  'parentTaskTitle', // derived
  'projectId', // derived
  'projectName', // derived
  'dependencies',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

export const TASK_WITH_PROGRESS_FIELDS = [...TASK_FIELDS, 'progressNotes'] as const;

export const PROGRESS_NOTE_FIELDS = ['text', 'actor', 'timestamp'] as const;
