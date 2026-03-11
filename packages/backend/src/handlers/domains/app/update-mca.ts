/**
 * app.update-mca — Update MCA availability settings (admin)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { McaService } from '../../../services/mca-service'

interface UpdateMcaData {
  mcpId: string
  updates: Record<string, unknown>
}

export function createUpdateMcaHandler(mcaService: McaService) {
  return async function updateMca(_ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UpdateMcaData
    const { mcpId, updates } = data

    if (!mcpId) {
      throw new HandlerError('INVALID_REQUEST', 'mcpId is required')
    }

    const updatedMca = await mcaService.updateMcaAvailability(mcpId, updates)
    if (!updatedMca) {
      throw new HandlerError('MCA_NOT_FOUND', `MCA ${mcpId} not found`)
    }

    console.log(`✅ Updated MCA ${mcpId} availability`)

    return {
      mca: {
        mcaId: updatedMca.mcaId,
        name: updatedMca.name,
        description: updatedMca.description,
        icon: updatedMca.icon,
        color: updatedMca.color,
        category: updatedMca.category,
        tools: updatedMca.tools,
        status: updatedMca.status,
        availability: {
          enabled: updatedMca.availability?.enabled ?? true,
          multi: updatedMca.availability?.multi ?? false,
          system: updatedMca.availability?.system ?? false,
          hidden: updatedMca.availability?.hidden ?? false,
          role: updatedMca.availability?.role ?? 'user',
        },
        systemSecrets: updatedMca.systemSecrets || [],
        userSecrets: updatedMca.userSecrets || [],
        auth: updatedMca.auth,
      },
    }
  }
}
