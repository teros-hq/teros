/**
 * workspace.create — Create a new workspace for the current user
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'
import { BillingGateService } from '../../../services/billing-gate.js'
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

    // Billing gate: enforce workspace creation limits
    if (db) {
      const billingGate = new BillingGateService(db)
      await billingGate.assertWorkspaceAllowed(ctx.userId, db)
    }

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

    if (pubSubService) {
      pubSubService.broadcastToUser(ctx.userId, {
        type: 'workspace.created',
        workspace: workspacePayload,
      })
    }

    return { workspace: workspacePayload }
  }
}
