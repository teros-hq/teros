/**
 * Shared types for WebSocket command handlers
 */

import type { ServerMessage } from '@teros/shared';
import type { WebSocket } from 'ws';
import type { McaOAuth } from '../../auth/mca-oauth';
import type { McaService } from '../../services/mca-service';
import type { ModelService } from '../../services/model-service';

/**
 * Common dependencies for all command handlers
 */
export interface CommandDeps {
  mcaService: McaService;
  sendMessage: (ws: WebSocket, msg: ServerMessage) => void;
  sendError: (ws: WebSocket, code: string, message: string) => void;
}

/**
 * Dependencies for app-related commands
 */
export interface AppCommandsDeps extends CommandDeps {
  // No additional deps needed
}

/**
 * Dependencies for app auth commands
 */
export interface AppAuthCommandsDeps extends CommandDeps {
  mcaOAuth: McaOAuth | null | undefined;
}

/**
 * Dependencies for catalog/models commands
 */
export interface CatalogCommandsDeps extends CommandDeps {
  modelService: ModelService;
  buildAvatarUrl: (filename?: string) => string | undefined;
}

/**
 * Dependencies for permission commands
 */
export interface PermissionCommandsDeps extends CommandDeps {
  handlePermissionResponse: (requestId: string, granted: boolean) => Promise<void>;
  workspaceService?: import('../../services/workspace-service').WorkspaceService;
}
