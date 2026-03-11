/**
 * Store exports
 *
 * Centralized state management with Zustand
 */

export { type User, useAuthStore } from './authStore';
export {
  type Board,
  type BoardColumn,
  type Project,
  type Task,
  getTasksByColumn,
  PRIORITY_CONFIG,
  useBoardStore,
} from './boardStore';
export { type Channel, type Message, useChatStore } from './chatStore';
export { useConnectionStore } from './connectionStore';

export {
  type ContainerNode,
  type Desktop,
  type LayoutNode,
  type SplitDirection,
  type SplitNode,
  type TilingWindow,
  useTilingStore,
} from './tilingStore';
