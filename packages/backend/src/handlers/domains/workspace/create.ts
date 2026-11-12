/**
 * workspace.create — Create a new workspace for the current user
 *
 * Thin handler: validation + delegation to WorkspaceService.createWorkspace,
 * which enforces the billing gate and provisions system apps.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'
import type { Db } from 'mongodb'

interface CreateWorkspaceData {
  name: string
  description?: string
}

export function createCreateWorkspaceHandler(
  workspaceService: WorkspaceService,
  pubSubService?: PubSubService | null,
  db?: Db,
) {
  return async function createWorkspace(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as CreateWorkspaceData

    if (!data.name) {
      throw new HandlerError('MISSING_NAME', 'name is required')
    }

    // Billing gate is enforced inside workspaceService.createWorkspace —
    // no need to duplicate it here. UpgradeRequiredError propagates to the
    // WS error handler which formats it for the client.
    const workspace = await workspaceService.createWorkspace(ctx.userId, {
      name: data.name,
      description: data.description,
    })

    console.log(`[workspace.create] Created workspace ${workspace.workspaceId} for user ${ctx.userId}`)

    const workspacePayload = {
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      description: workspace.description,
      volumeId: workspace.volumeId,
      role: 'owner',
      status: workspace.status,
      createdAt: workspace.createdAt,
    }

    // NOTE: the `workspace.created` broadcast to the owner's sessions happens
    // inside WorkspaceService.createWorkspace (single entry point for all
    // creation paths: this handler, the legacy WS command, the MCA tool).
    // No need to re-broadcast here — the frontend upsert is idempotent anyway.

    return { workspace: workspacePayload }
  }
}
