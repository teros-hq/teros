/**
 * Whitelists de campos expuestos por los tools de lectura/CRUD del MCA
 * board-manager.
 *
 * Los handlers aplican estos filtros al response del backend para:
 *  - Reducir tokens del contexto del LLM (campos irrelevantes no viajan).
 *  - Ocultar internos de Mongo (_id, __v) que el agente no debería ver.
 *  - Dar un contrato estable: la forma del retorno no depende de que el
 *    backend añada campos nuevos.
 *
 * Cuando el agente necesita el objeto completo, pasa `includeRaw: true`.
 *
 * **Nota sobre campos derivados**: los handlers backend de Board enriquecen
 * las responses con `columnName`, `columnSlug`, `projectName`, `assigneeName`,
 * etc. (ver `packages/backend/src/handlers/domains/board/_helpers.ts`).
 * Esas keys deben estar presentes aquí para que el renderer las pinte.
 */

// ============================================================================
// TASK FIELDS
// ============================================================================

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
  'originChannelId',
  'running',
  'stopRequested', // contract with runner stop protocol
  'parentTaskId',
  'parentTaskTitle', // derived (get-task only)
  'dependencies',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

export const TASK_WITH_PROGRESS_FIELDS = [...TASK_FIELDS, 'progressNotes'] as const;

export const TASK_DEPENDENCY_FIELDS = [
  'taskId',
  'title',
  'columnSlug',
  'priority',
  'archived',
] as const;

export const PROGRESS_NOTE_FIELDS = ['text', 'actor', 'timestamp'] as const;

// ============================================================================
// PROJECT FIELDS
// ============================================================================

export const PROJECT_FIELDS = [
  'projectId',
  'workspaceId',
  'name',
  'description',
  'context',
  'boardId',
  'status',
  'createdBy',
  'createdAt',
  'updatedAt',
  'taskCount', // derived (list-projects)
  'activeAgentCount', // derived (list-projects)
] as const;

export const PROJECT_WITH_BOARD_FIELDS = [...PROJECT_FIELDS, 'board'] as const;

// ============================================================================
// BOARD FIELDS
// ============================================================================

export const BOARD_COLUMN_FIELDS = ['columnId', 'name', 'slug', 'position'] as const;

// ============================================================================
// AGENT / RELATIONSHIP FIELDS
// ============================================================================

export const BOARD_AGENT_FIELDS = [
  'agentId',
  'name',
  'fullName',
  'role',
  'avatarUrl',
  'workspaceId',
  'capabilities',
] as const;

export const AGENT_PROJECT_RELATIONSHIP_FIELDS = [
  'agentId',
  'projectId',
  'slots',
  'playEnabled',
  'activeSlots',
] as const;

export const BOARD_STATUS_AGENT_FIELDS = [
  'agentId',
  'agentName',
  'agentFullName',
  'agentAvatarUrl',
  'slots',
  'playEnabled',
  'activeSlots',
  'tasksInReview',
  'tasksToDo',
  'tasksBlocked',
  'tasksInProgress',
] as const;

// ============================================================================
// SUBSCRIPTION FIELDS
// ============================================================================

export const BOARD_SUBSCRIPTION_FIELDS = [
  'subscriptionId',
  'boardId',
  'boardName',
  'channelId',
  'agentId',
  'filter',
  'createdAt',
  'updatedAt',
] as const;

export const EVENT_SUBSCRIPTION_FIELDS = [
  'id',
  'topic',
  'channelId',
  'rules',
  'mode',
  'createdAt',
  'lastActivityAt',
] as const;
