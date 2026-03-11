/**
 * Board HTTP Routes
 *
 * REST endpoints for board/task dependency management.
 *
 * Endpoints:
 *   POST   /api/tasks/:id/blocked-by        — Add a dependency (taskId depends on depId)
 *   DELETE /api/tasks/:id/blocked-by/:depId — Remove a dependency
 *
 * Auth: Bearer <sessionToken> in Authorization header.
 * Both tasks must belong to the same board.
 * Cycle detection is performed before persisting.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { BoardService } from '../services/board-service';
import type { WorkspaceService } from '../services/workspace-service';
import type { SessionManager } from '../services/session-manager';

// ============================================================================
// HELPERS
// ============================================================================

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Resolve the authenticated userId from the Bearer token.
 * Uses SessionManager.getSession() which validates the token against the DB.
 */
async function resolveUserId(
  req: IncomingMessage,
  sessionManager: SessionManager,
): Promise<string | null> {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const session = await sessionManager.getSession(token);
  return session?.userId ?? null;
}

// ============================================================================
// ROUTE FACTORY
// ============================================================================

export interface BoardRoutesConfig {
  boardService: BoardService;
  workspaceService: WorkspaceService;
  sessionManager: SessionManager;
}

/**
 * Create the board HTTP routes handler.
 * Returns a function that returns `true` when it handled the request.
 */
export function createBoardRoutes(cfg: BoardRoutesConfig) {
  const { boardService, workspaceService, sessionManager } = cfg;

  // Regex patterns for the two endpoints
  const RE_ADD    = /^\/api\/tasks\/([^/]+)\/blocked-by$/;
  const RE_REMOVE = /^\/api\/tasks\/([^/]+)\/blocked-by\/([^/]+)$/;

  return async function handleBoardRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<boolean> {
    const basePath = url.indexOf('?') === -1 ? url : url.slice(0, url.indexOf('?'));
    const method = req.method ?? '';

    // -----------------------------------------------------------------------
    // POST /api/tasks/:id/blocked-by — Add dependency
    // -----------------------------------------------------------------------
    const addMatch = RE_ADD.exec(basePath);
    if (addMatch && method === 'POST') {
      const taskId = addMatch[1];

      const userId = await resolveUserId(req, sessionManager);
      if (!userId) {
        sendJson(res, 401, { error: 'Unauthorized', message: 'Valid session token required' });
        return true;
      }

      let body: any;
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 400, { error: 'BAD_REQUEST', message: 'Invalid JSON body' });
        return true;
      }

      const dependsOnTaskId: string | undefined = (body as any)?.dependsOnTaskId;
      if (!dependsOnTaskId) {
        sendJson(res, 400, {
          error: 'MISSING_FIELDS',
          message: 'dependsOnTaskId is required in the request body',
        });
        return true;
      }

      // Resolve task → board → project → workspace for permission check
      const task = await boardService.getTask(taskId);
      if (!task) {
        sendJson(res, 404, { error: 'NOT_FOUND', message: `Task ${taskId} not found` });
        return true;
      }

      const board = await boardService.getBoard(task.boardId);
      const project = board ? await boardService.getProject(board.projectId) : null;
      if (!project) {
        sendJson(res, 404, { error: 'NOT_FOUND', message: 'Project not found' });
        return true;
      }

      const role = await workspaceService.getUserRole(project.workspaceId, userId);
      if (role !== 'owner' && role !== 'admin' && role !== 'write') {
        sendJson(res, 403, { error: 'FORBIDDEN', message: 'Write access required' });
        return true;
      }

      // Delegate to service — handles same-board validation + DFS cycle detection
      try {
        const updatedTask = await boardService.addDependency(taskId, dependsOnTaskId, userId);
        sendJson(res, 200, { task: updatedTask });
      } catch (err: any) {
        if (err.message?.startsWith('CIRCULAR_DEPENDENCY:')) {
          sendJson(res, 409, { error: 'CIRCULAR_DEPENDENCY', message: err.message });
        } else if (
          err.message?.includes('not found') ||
          err.message?.includes('Cross-board')
        ) {
          sendJson(res, 422, { error: 'VALIDATION_ERROR', message: err.message });
        } else {
          console.error('[BoardRoutes] addDependency error:', err);
          sendJson(res, 500, { error: 'INTERNAL_ERROR', message: 'Internal server error' });
        }
      }
      return true;
    }

    // -----------------------------------------------------------------------
    // DELETE /api/tasks/:id/blocked-by/:depId — Remove dependency
    // -----------------------------------------------------------------------
    const removeMatch = RE_REMOVE.exec(basePath);
    if (removeMatch && method === 'DELETE') {
      const taskId = removeMatch[1];
      const dependsOnTaskId = removeMatch[2];

      const userId = await resolveUserId(req, sessionManager);
      if (!userId) {
        sendJson(res, 401, { error: 'Unauthorized', message: 'Valid session token required' });
        return true;
      }

      // Resolve task → board → project → workspace for permission check
      const task = await boardService.getTask(taskId);
      if (!task) {
        sendJson(res, 404, { error: 'NOT_FOUND', message: `Task ${taskId} not found` });
        return true;
      }

      const board = await boardService.getBoard(task.boardId);
      const project = board ? await boardService.getProject(board.projectId) : null;
      if (!project) {
        sendJson(res, 404, { error: 'NOT_FOUND', message: 'Project not found' });
        return true;
      }

      const role = await workspaceService.getUserRole(project.workspaceId, userId);
      if (role !== 'owner' && role !== 'admin' && role !== 'write') {
        sendJson(res, 403, { error: 'FORBIDDEN', message: 'Write access required' });
        return true;
      }

      // Delegate to service — idempotent (no-op if dependency does not exist)
      try {
        const updatedTask = await boardService.removeDependency(taskId, dependsOnTaskId, userId);
        sendJson(res, 200, { task: updatedTask });
      } catch (err: any) {
        if (err.message?.includes('not found')) {
          sendJson(res, 404, { error: 'NOT_FOUND', message: err.message });
        } else {
          console.error('[BoardRoutes] removeDependency error:', err);
          sendJson(res, 500, { error: 'INTERNAL_ERROR', message: 'Internal server error' });
        }
      }
      return true;
    }

    return false; // Not handled by this router
  };
}
