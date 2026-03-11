// ============================================================================
// BOARD UTILITIES
// ============================================================================

import type { Task } from '../../store/boardStore';

export const COLUMN_COLORS: Record<string, string> = {
  backlog: '#6B7280',
  todo: '#3B82F6',
  in_progress: '#F59E0B',
  review: '#8B5CF6',
  done: '#22C55E',
};

export function getColumnColor(slug: string): string {
  return COLUMN_COLORS[slug] || '#6B7280';
}

// ============================================================================
// BLOCK STATUS
// ============================================================================

export type BlockStatus = 'unblocked' | 'blocked' | 'circular';

export const BLOCK_STATUS_CONFIG: Record<BlockStatus, { color: string; bg: string; icon: string; label: string }> = {
  unblocked: { color: '#22C55E', bg: 'rgba(34,197,94,0.15)', icon: '●', label: 'Desbloqueada' },
  blocked:   { color: '#EF4444', bg: 'rgba(239,68,68,0.15)',  icon: '●', label: 'Bloqueada' },
  circular:  { color: '#F59E0B', bg: 'rgba(245,158,11,0.15)', icon: '⚠', label: 'Dependencia circular' },
};

/**
 * Determine the block status of a task given all tasks on the board.
 *
 * - 'circular'  → task has taskStatus === 'circular_dependency'
 * - 'blocked'   → task has at least one dependency whose taskStatus is not 'done'
 * - 'unblocked' → task has no dependencies, or all dependencies are completed
 */
export function getBlockStatus(task: Task, allTasks: Task[]): BlockStatus {
  if (task.taskStatus === 'circular_dependency') {
    return 'circular';
  }

  if (!task.dependencies || task.dependencies.length === 0) {
    return 'unblocked';
  }

  const taskMap = new Map<string, Task>(allTasks.map((t) => [t.taskId, t]));

  for (const depId of task.dependencies) {
    const dep = taskMap.get(depId);
    // If the dependency exists and is not done, the task is blocked
    if (dep && dep.taskStatus !== 'done') {
      return 'blocked';
    }
    // If the dependency doesn't exist in current view (e.g. filtered out),
    // we treat it as unblocked to avoid false positives
  }

  return 'unblocked';
}

// ============================================================================
// DEPENDENCY HIGHLIGHT
// ============================================================================

/**
 * The highlight state for a task when another task is hovered/selected.
 *
 * - 'will-unblock'   → this task depends on the hovered task AND completing
 *                      the hovered task would fully unblock it (no other pending deps).
 * - 'still-blocked'  → this task depends on the hovered task BUT has other
 *                      pending dependencies, so it would still be blocked.
 * - null             → no highlight (task does not depend on the hovered task).
 */
export type DependencyHighlight = 'will-unblock' | 'still-blocked' | null;

/**
 * Given a hovered/selected task and all tasks on the board, compute the
 * highlight state for every other task.
 *
 * Returns a Map<taskId, DependencyHighlight> — only tasks that should be
 * highlighted will have a non-null value.
 */
export function computeDependencyHighlights(
  hoveredTaskId: string,
  allTasks: Task[],
): Map<string, DependencyHighlight> {
  const result = new Map<string, DependencyHighlight>();
  const taskMap = new Map<string, Task>(allTasks.map((t) => [t.taskId, t]));

  for (const task of allTasks) {
    // Skip the hovered task itself
    if (task.taskId === hoveredTaskId) continue;
    // Only care about tasks that list the hovered task as a dependency
    if (!task.dependencies || !task.dependencies.includes(hoveredTaskId)) continue;

    // Count other pending dependencies (excluding the hovered task)
    const otherPendingDeps = task.dependencies.filter((depId) => {
      if (depId === hoveredTaskId) return false;
      const dep = taskMap.get(depId);
      // If the dep exists and is not done, it's still pending
      return dep ? dep.taskStatus !== 'done' : false;
    });

    if (otherPendingDeps.length === 0) {
      result.set(task.taskId, 'will-unblock');
    } else {
      result.set(task.taskId, 'still-blocked');
    }
  }

  return result;
}

export function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return 'ahora';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(months / 12);
  return `${years}y`;
}
