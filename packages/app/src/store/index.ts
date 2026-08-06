/**
 * Store exports
 *
 * Centralized state management with Zustand
 */

export { type User, useAuthStore } from './authStore';
export {
  type FloatingWindow,
  type OpenWindowMode,
  type OpenWindowOptions,
  useWorkspaceStore,
} from './workspaceStore';
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
export { type PendingAudio, useAudioStore, getPendingAudio } from './audioStore';

export {
  type ContainerNode,
  type Desktop,
  type LayoutNode,
  type SplitDirection,
  type SplitNode,
  type TilingWindow,
  useTilingStore,
} from './tilingStore';
export {
  type FeatureFlagsCache,
  type ResolvedFlag,
  getFlagDefault,
  getResolvedFlag,
  useFeatureFlagsStore,
} from './featureFlagsStore';
