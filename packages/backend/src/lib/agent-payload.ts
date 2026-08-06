import type { AgentInstance } from '../types/database'
import { buildAvatarUrl } from './avatar-url'

/**
 * Shape of the `agent` object carried by the `agent.created` websocket event.
 *
 * Single source of truth for both creation paths — the WsRouter handler
 * (handlers/domains/agent/create.ts) and the MCA resource callback
 * (routes/mca-resources-handlers.ts) — so the two cannot drift field-by-field.
 */
export function buildAgentCreatedPayload(agent: AgentInstance) {
  return {
    agentId: agent.agentId,
    name: agent.name,
    fullName: agent.fullName,
    role: agent.role,
    intro: agent.intro,
    avatarUrl: buildAvatarUrl(agent.avatarUrl),
    coreId: agent.coreId,
    workspaceId: agent.workspaceId,
  }
}
