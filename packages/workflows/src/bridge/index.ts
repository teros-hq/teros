/**
 * Board Bridge — Public API
 *
 * Re-exports the bridge types and implementations.
 *
 * Usage:
 *   import {
 *     type BoardBridge,
 *     type CreateTaskParams,
 *     type TaskInfo,
 *     InMemoryBoardBridge,
 *     ActionBridge,
 *     type TaskCompletionEvent,
 *     type TaskCompletedResult,
 *     type BoardControl,
 *   } from '@teros/workflows/bridge';
 */

export type { BoardBridge, CreateTaskParams, TaskInfo } from './types';
export { InMemoryBoardBridge } from './in-memory-board';

// Action Bridge — connects board task completion to workflow engine advancement
export {
  ActionBridge,
  type TaskCompletionEvent,
  type TaskCompletedResult,
  type TaskCreatedResult,
  type BoardControl,
  type RejectionStrategy,
} from './action-bridge';
