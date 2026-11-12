/**
 * Todo List MCA — Event Definitions
 *
 * Events are emitted by tool handlers to notify the host that the tree changed.
 * The host uses these to refresh UI resources (see refreshOnEvents).
 *
 * Each event has a human-readable description and a typed payload.
 */

export interface TodoEventPayloads {
  'node.added': { nodeId: string; parentId: string | null; text: string };
  'node.updated': { nodeId: string; text: string; fields: string[] };
  'node.completed': { nodeId: string; completed: boolean };
  'node.moved': { nodeId: string; newParentId: string | null; oldParentId: string | null; position: number };
  'node.deleted': { nodeId: string; text: string };
  'node.state': { nodeId: string; from: string; to: string; blockedReason: string | null };
  'node.progress': { nodeId: string; progress: number | null };
  'node.output': { nodeId: string; format: string | null };
}

export type TodoEventName = keyof TodoEventPayloads;

/**
 * Event definitions — static metadata the host uses for discovery.
 * Declared with `app.event(name, { description })` in the app entry point.
 */
export const TODO_EVENTS: Array<{
  name: TodoEventName;
  description: string;
}> = [
  { name: 'node.added', description: 'A new node was added to the tree' },
  { name: 'node.updated', description: 'A node was updated' },
  { name: 'node.completed', description: 'A node was toggled complete/incomplete' },
  { name: 'node.moved', description: 'A node was moved to a new parent or position' },
  { name: 'node.deleted', description: 'A node and its subtree were deleted' },
  { name: 'node.state', description: 'A task moved to another state (planning, pending, working, blocked, review, done, cancelled)' },
  { name: 'node.progress', description: 'A task reported (or cleared) its progress percentage' },
  { name: 'node.output', description: 'A task delivered (or cleared) its output' },
];
