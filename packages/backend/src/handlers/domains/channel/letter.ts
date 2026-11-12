/**
 * channel.letter — Generate the live welcome letter for a new conversation
 * with an agent. Returns segments (prose with links) + starter prompts in the
 * agent's own voice, assembled from real board facts by LetterService.
 *
 * Falls back to the deterministic template (generated:false) when the LLM
 * fails — the client renders either shape identically.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { LetterService } from '../../../services/letter-service'
import type { WorkspaceService } from '../../../services/workspace-service'

interface LetterChannelData {
  agentId: string
  workspaceId?: string
  /** i18n locale of the client (e.g. 'es-ES') — drives the letter language */
  locale?: string
}

export function createLetterChannelHandler(
  letterService: LetterService,
  workspaceService: WorkspaceService | null,
) {
  return async function letterChannel(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as LetterChannelData

    if (!data.agentId) {
      throw new HandlerError('VALIDATION_ERROR', 'agentId is required')
    }

    // Workspace access check (only when a workspace is provided)
    if (data.workspaceId && workspaceService) {
      const role = await workspaceService.getUserRole(data.workspaceId, ctx.userId)
      if (role === null || role === undefined) {
        throw new HandlerError('UNAUTHORIZED', 'Access denied')
      }
    }

    const facts = await letterService.assembleFacts(data.agentId, data.workspaceId)
    if (!facts) {
      throw new HandlerError('AGENT_NOT_FOUND', 'Agent not found')
    }

    // Try the agent's voice first; fall back to the deterministic template
    const locale = data.locale || 'en-US'
    const generated = await letterService.generateLetter(facts, locale)

    if (generated) {
      return {
        agentId: data.agentId,
        generated: true,
        segments: generated.segments,
        prompts: generated.prompts,
      }
    }

    const fallback = letterService.fallbackSegments(facts)
    return {
      agentId: data.agentId,
      generated: false,
      segments: fallback.segments,
      boardNames: fallback.boardNames,
    }
  }
}
