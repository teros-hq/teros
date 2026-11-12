/**
 * Authz for the flow trigger actions (flow.register-webhook / cancel-webhook /
 * get-webhook-url, flow.register-event / cancel-event / list-event-triggers).
 *
 * They take a client-supplied flowId (and projectId) and their services read and
 * rewrite `flows` by flowId alone, so any authenticated user could read another
 * workspace's webhook token (and run its flow through /webhooks/flow/<token>),
 * rotate it, or cancel its triggers. The caller now needs access to the flow's
 * own workspace — the write role for anything that changes or reveals a
 * trigger — and the target project must belong to that workspace.
 *
 * Unknown flows and denied ones give the same FLOW_NOT_FOUND, so ids can't be
 * probed.
 */

import type { Db } from 'mongodb'
import { canAccessWorkspace, canWriteWorkspace } from '../../../auth/workspace-access'
import { COLLECTIONS, collection } from '../../../db'
import { HandlerError } from '../../../ws-framework/WsRouter'

/** Returns the flow's workspaceId once the caller is allowed on it. */
export async function requireFlowAccess(
  db: Db,
  userId: string,
  flowId: string,
  mode: 'read' | 'write',
): Promise<string> {
  const flow = await collection(db, COLLECTIONS.flows).findOne(
    { flowId },
    { projection: { workspaceId: 1 } },
  )
  const workspaceId = typeof flow?.workspaceId === 'string' ? flow.workspaceId : ''
  const allowed =
    workspaceId !== '' &&
    (mode === 'write'
      ? await canWriteWorkspace(db, userId, workspaceId)
      : await canAccessWorkspace(db, userId, workspaceId))
  if (!allowed) throw new HandlerError('FLOW_NOT_FOUND', `Flow not found: ${flowId}`)
  return workspaceId
}

/** The project a trigger creates tasks in must be a live project of the flow's workspace. */
export async function requireFlowProject(db: Db, workspaceId: string, projectId: string): Promise<void> {
  const project = await collection(db, COLLECTIONS.projects).findOne(
    { projectId },
    { projection: { workspaceId: 1, status: 1 } },
  )
  if (!project || project.workspaceId !== workspaceId || project.status === 'archived') {
    throw new HandlerError('PROJECT_NOT_FOUND', `Project not found in the flow's workspace: ${projectId}`)
  }
}
