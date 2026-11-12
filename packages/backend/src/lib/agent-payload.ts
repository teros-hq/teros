import type { AgentInstance } from '../types/database'
import type { PubSubService } from '../services/pubsub-service'
import { buildAvatarUrl } from './avatar-url'

/**
 * Shape of the `agent` object carried by the `agent.created` websocket event.
 *
 * Single source of truth for both creation paths — the WsRouter handler
 * (handlers/domains/agent/create.ts) and the MCA resource callback
 * (routes/mca-resources-handlers.ts) — so the two cannot drift field-by-field.
 *
 * Deliberately narrower than the `agent.updated` payload below: `maxSteps`,
 * `context` and `appearance` are omitted here because the create event only
 * needs enough to render the new agent in the navbar; they are editable fields
 * carried by the `updated` event. Not an oversight — keep the two in sync only
 * for the fields they share.
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

/** Subset of an agent doc needed to build the `agent.updated` event payload. */
export interface AgentUpdatedInput {
  agentId: string
  coreId: string
  name: string
  fullName: string
  role: string
  intro: string
  avatarUrl?: string
  workspaceId?: string
  maxSteps?: number
  context?: string
  appearance?: { color?: string; icon?: string }
  /** System-capability toggles (v1.4.4) — echoed so the UI stays in sync. */
  disabledSystemApps?: string[]
  enabledSystemApps?: string[]
}

/**
 * Shape of the `agent` object carried by the `agent.updated` websocket event.
 *
 * Single source of truth for every path that mutates an agent — the WsRouter
 * handler (handlers/domains/agent/update.ts) and the REST avatar upload
 * (handlers/http-upload-handler.ts) — so the two cannot drift field-by-field.
 *
 * `coreAvatarUrl` is the fallback used when the instance has no own avatar
 * (mirrors the resolution order elsewhere: `agent.avatarUrl || core.avatarUrl`).
 */
export function buildAgentUpdatedPayload(agent: AgentUpdatedInput, coreAvatarUrl?: string) {
  return {
    agentId: agent.agentId,
    name: agent.name,
    fullName: agent.fullName,
    role: agent.role,
    intro: agent.intro,
    avatarUrl: buildAvatarUrl(agent.avatarUrl || coreAvatarUrl),
    coreId: agent.coreId,
    workspaceId: agent.workspaceId,
    maxSteps: agent.maxSteps,
    context: agent.context,
    appearance: agent.appearance,
    disabledSystemApps: agent.disabledSystemApps,
    enabledSystemApps: agent.enabledSystemApps,
  }
}

/** The `agent` object carried by the `agent.updated` event. */
export type AgentUpdatedPayload = ReturnType<typeof buildAgentUpdatedPayload>

/**
 * Broadcast an `agent.updated` event so realtime listeners (the navbar / agents
 * panel via `useNavbarRealtimeSync`) refresh without a reload. Workspace-scoped
 * agents fan out to the workspace; global agents go to the owning user only —
 * the same scope rule as every other agent mutation broadcast.
 *
 * Takes the payload prebuilt (via `buildAgentUpdatedPayload`) so callers that
 * also return it don't build it twice. Global agents with no `userId` recipient
 * are skipped — there's nobody to deliver to.
 */
export async function broadcastAgentUpdated(
  pubSubService: Pick<PubSubService, 'broadcastToWorkspace' | 'broadcastToUser'>,
  userId: string | undefined,
  payload: AgentUpdatedPayload,
): Promise<void> {
  const event = { type: 'agent.updated', agent: payload }
  if (payload.workspaceId) {
    await pubSubService.broadcastToWorkspace(payload.workspaceId, event)
  } else if (userId) {
    pubSubService.broadcastToUser(userId, event)
  }
}
