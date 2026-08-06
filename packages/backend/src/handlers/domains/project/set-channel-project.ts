/**
 * project.set-channel-project — Associate or disassociate a channel with a project
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { ProjectService } from '../../../services/project-service'
import { canAccessWorkspace } from '../../../auth/workspace-access'

interface SetChannelProjectData {
  channelId: string
  projectId?: string | null
}

export function createSetChannelProjectHandler(db: Db, projectService: ProjectService) {
  return async function setChannelProject(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SetChannelProjectData
    const { channelId, projectId } = data

    if (!channelId) {
      throw new HandlerError('MISSING_CHANNEL_ID', 'channelId is required')
    }

    const channels = db.collection('channels')

    const channel = await channels.findOne({ channelId }, { projection: { userId: 1 } })
    if (!channel) {
      throw new HandlerError('CHANNEL_NOT_FOUND', 'Channel not found')
    }
    if (channel.userId !== ctx.userId) {
      throw new HandlerError('FORBIDDEN', 'Not your channel')
    }

    if (projectId) {
      const project = await projectService.get(projectId)
      if (!project) {
        throw new HandlerError('PROJECT_NOT_FOUND', 'Project not found')
      }
      if (!(await canAccessWorkspace(db, ctx.userId, project.workspaceId))) {
        throw new HandlerError('FORBIDDEN', 'No access to this project')
      }
    }

    if (projectId) {
      await channels.updateOne({ channelId }, { $set: { projectId } })
      console.log(`✅ Associated channel ${channelId} with project ${projectId}`)
    } else {
      await channels.updateOne({ channelId }, { $unset: { projectId: '' } })
      console.log(`✅ Disassociated channel ${channelId} from project`)
    }

    return { ok: true }
  }
}
