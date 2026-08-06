/**
 * Shared helpers for Board handlers.
 *
 * Enrichment: adds derived fields (columnName, columnSlug, projectName, etc.)
 * that the MCA renderers need to paint without doing secondary fetches.
 *
 * Philosophy: handlers return data enriched at source, not MCA-computed.
 */

import type { Board, Project, Task } from '../../../types/database';
import type { BoardService } from '../../../services/board-service';

/**
 * Enriches a task with columnName + columnSlug resolved from board.columns.
 * Safe when board is missing: returns the task untouched.
 */
export function enrichTaskWithColumn<T extends { columnId: string }>(
  task: T,
  board: Board | null,
): T & { columnName?: string; columnSlug?: string } {
  if (!board) return task;
  const col = board.columns.find((c) => c.columnId === task.columnId);
  if (!col) return task;
  return { ...task, columnName: col.name, columnSlug: col.slug };
}

/**
 * Enriches a list of tasks sharing the same board with columnName + columnSlug.
 * Uses a single map built from board.columns.
 */
export function enrichTasksWithColumns<T extends { columnId: string }>(
  tasks: T[],
  board: Board | null,
): Array<T & { columnName?: string; columnSlug?: string }> {
  if (!board) return tasks;
  const colMap = new Map(board.columns.map((c) => [c.columnId, c]));
  return tasks.map((t) => {
    const col = colMap.get(t.columnId);
    return col ? { ...t, columnName: col.name, columnSlug: col.slug } : t;
  });
}

/**
 * Enriches tasks that span multiple boards. Fetches each board at most once.
 * Used by get-tasks-by-agent where tasks can come from any board in the workspace.
 */
export async function enrichTasksAcrossBoards<T extends { boardId: string; columnId: string }>(
  tasks: T[],
  boardService: BoardService,
): Promise<
  Array<T & { columnName?: string; columnSlug?: string; projectName?: string; projectId?: string }>
> {
  const boardIds = [...new Set(tasks.map((t) => t.boardId))];
  const boardCache = new Map<string, Board | null>();
  const projectCache = new Map<string, Project | null>();

  for (const boardId of boardIds) {
    const board = await boardService.getBoard(boardId);
    boardCache.set(boardId, board);
    if (board) {
      const project = await boardService.getProject(board.projectId);
      projectCache.set(boardId, project);
    }
  }

  return tasks.map((t) => {
    const board = boardCache.get(t.boardId);
    const project = projectCache.get(t.boardId);
    if (!board) return t;
    const col = board.columns.find((c) => c.columnId === t.columnId);
    return {
      ...t,
      ...(col ? { columnName: col.name, columnSlug: col.slug } : {}),
      ...(project ? { projectName: project.name, projectId: project.projectId } : {}),
    };
  });
}

/**
 * Computes per-project stats (taskCount, activeAgentCount).
 * activeAgentCount = distinct assignedAgentId across non-archived tasks.
 */
export async function computeProjectStats(
  projects: Project[],
  boardService: BoardService,
): Promise<Array<Project & { taskCount: number; activeAgentCount: number }>> {
  const results: Array<Project & { taskCount: number; activeAgentCount: number }> = [];
  for (const project of projects) {
    const allTasks = await boardService.listTasks(project.boardId, {});
    const active = allTasks.filter((t: Task) => !t.archived);
    const agents = new Set(
      active
        .map((t: Task) => t.assignedAgentId)
        .filter((id): id is string => typeof id === 'string'),
    );
    results.push({
      ...project,
      taskCount: active.length,
      activeAgentCount: agents.size,
    });
  }
  return results;
}
