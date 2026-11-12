/**
 * MCA actions — named, validated backend actions for MCAs.
 *
 * Datastore-isolation (docs/specs/security/20261014_datastore-isolation.md, P1b):
 * MCAs never hold a datastore connection. Instead each capability exposes a
 * small set of named actions that the backend executes against Mongo/Qdrant on
 * the MCA's behalf. This is deliberately NOT a generic query passthrough — raw
 * passthrough is the hard-to-secure part (`$where`, cross-collection
 * `$lookup`, unbounded scans). Every action validates its own inputs and does
 * exactly one thing.
 *
 * Security properties:
 *   - Reached only through the authenticated /mca/callback router, so the
 *     caller identity (`McaActionCtx`) is derived from the verified per-MCA
 *     token — never from the request body.
 *   - A capability is BOUND to one mcaId: a valid token for a different MCA
 *     cannot invoke it (403). This is the per-capability authorization layer.
 *   - Capabilities add their own authorization on top (e.g. feedback-admin
 *     requires a system admin user).
 */

import type { Db } from 'mongodb';
import { HandlerError } from '../ws-framework/WsRouter';
import type { ActionBridgeManager } from '../services/workflow-action-bridge';
import type { AutomateModel } from '../models/automate';
import type { WorkspaceService } from '../services/workspace-service';
import type { VolumeService } from '../services/volume-service';
import type { SecretsManager } from '../secrets/secrets-manager';
import type { ClaudeCodeRunner } from '../services/terminal/claude-code-runner';
import type { TodoAutoplayService } from '../services/todo-autoplay-service';
import type { TodoSubscriptionService } from '../services/todo-subscription-service';
import { evaluatorCapability } from './evaluator';
import { feedbackAdminCapability } from './feedback-admin';
import { memoryCapability } from './memory';
import { subscriptionsCapability } from './subscriptions';
import { todoCapability } from './todo';
import { workflowsCapability } from './workflows';
// The class lives in ./errors to break the index → evaluator → index cycle;
// imported for the dispatcher below and re-exported for existing importers
// (memory.ts, todo.ts, workflows.ts…).
import { McaActionError } from './errors';
export { McaActionError };

/** Identity of the authenticated MCA caller, derived from the verified token. */
export interface McaActionCtx {
  mcaId: string;
  appId?: string;
  userId?: string;
  /**
   * Channel segment of the authenticated callback URL. The router has already
   * bound it to the authenticated user (a channel owned by someone else is
   * rejected before dispatch), so capabilities may use it for scope.
   */
  channelId?: string;
}

export type McaActionHandler = (
  ctx: McaActionCtx,
  db: Db,
  body: Record<string, unknown>,
) => Promise<unknown>;

/** A capability: a set of named actions callable ONLY by the MCA it is bound to. */
export interface McaActionCapability {
  /** The only mcaId whose (verified) token may invoke these actions. */
  mcaId: string;
  actions: Record<string, McaActionHandler>;
}

const CAPABILITIES: Record<string, McaActionCapability> = {
  evaluator: evaluatorCapability,
  'feedback-admin': feedbackAdminCapability,
  memory: memoryCapability,
  todo: todoCapability,
  workflows: workflowsCapability,
  // Unified subscription API (v1.4.4): SHARED — see the '*' note in the
  // dispatch below and mca-actions/subscriptions.ts.
  subscriptions: subscriptionsCapability,
};

// =============================================================================
// Dependency injection
// =============================================================================

/**
 * Backend services some actions need beyond the raw Db. They are constructed
 * AFTER the callback router (server-bootstrap creates the ActionBridgeManager
 * inside the `if (mcaManager)` block, well after createMcaCallbackRoutes), so
 * they are injected through a module-level holder rather than passed at
 * construction. An action whose dependency is missing fails with
 * `UNAVAILABLE` (503) instead of crashing.
 */
export interface McaActionDeps {
  actionBridgeManager?: ActionBridgeManager;
  /** Automate owns flow triggers (start-flow starters); used by the workflows capability's trigger sync. */
  automateModel?: AutomateModel;
  workspaceService?: WorkspaceService;
  /** Credentials source for capabilities that open a datastore lazily (memory). */
  secretsManager?: SecretsManager;
  /** To Do autoplay (docs/specs/todo/autoplay/spec.md): runners, scheduling, start, replies. */
  todoAutoplay?: TodoAutoplayService;
  /** To Do event subscriptions (docs/specs/todo/events.md): conversation wake + todo.* bus topics. */
  todoSubscriptions?: TodoSubscriptionService;
  /** Workspace volumes: set-input/set-output read a `path`-delivered file from the calling workspace's volume. */
  volumeService?: VolumeService;
  /** Claude Code runner (CCR): review sessions for tasks whose reviewer is a `claude-code` agent. */
  claudeCodeRunner?: ClaudeCodeRunner;
}

let actionDeps: McaActionDeps = {};

/** Merge-set the shared action dependencies (called from server-bootstrap). */
export function setMcaActionDeps(deps: Partial<McaActionDeps>): void {
  actionDeps = { ...actionDeps, ...deps };
}

export function getMcaActionDeps(): McaActionDeps {
  return actionDeps;
}

// McaActionError moved to ./errors (import cycle); re-exported above.

const STATUS_BY_CODE: Record<string, number> = {
  BAD_REQUEST: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  UNAVAILABLE: 503,
};

export interface McaActionResult {
  status: number;
  body: unknown;
}

const ACTION_PATH = /^([a-z0-9-]+)\/([a-z0-9-]+)$/;

/**
 * Dispatch `<capability>/<action>` for an authenticated MCA caller.
 * Returns an HTTP status + body; never throws for expected failures.
 */
export async function handleMcaAction(
  ctx: McaActionCtx,
  db: Db,
  actionPath: string,
  body: Record<string, unknown>,
): Promise<McaActionResult> {
  const match = actionPath.match(ACTION_PATH);
  if (!match) return { status: 404, body: { error: 'Invalid action path' } };
  const [, capabilityName, actionName] = match;

  const capability = CAPABILITIES[capabilityName];
  if (!capability) return { status: 404, body: { error: `Unknown capability: ${capabilityName}` } };

  // Capability binding: only the owning MCA's token may invoke it.
  // SHARED capabilities (mcaId '*') are callable by any authenticated MCA —
  // they enforce their own authorization (the subscriptions capability
  // allowlists on the caller's declared events).
  if (capability.mcaId !== '*' && ctx.mcaId !== capability.mcaId) {
    return { status: 403, body: { error: `Capability '${capabilityName}' is not available to ${ctx.mcaId}` } };
  }

  const handler = capability.actions[actionName];
  if (!handler) return { status: 404, body: { error: `Unknown action: ${capabilityName}/${actionName}` } };

  try {
    const result = await handler(ctx, db, body ?? {});
    return { status: 200, body: result };
  } catch (err) {
    if (err instanceof HandlerError) {
      const status = err instanceof McaActionError ? err.status : (STATUS_BY_CODE[err.code] ?? 500);
      // `code` (and `suggestion`, when present) ride along so a thin-client MCA
      // can rebuild the structured error its callers already parse.
      const body: Record<string, unknown> = { error: err.message, code: err.code };
      if (err instanceof McaActionError && err.suggestion) body.suggestion = err.suggestion;
      return { status, body };
    }
    throw err;
  }
}
