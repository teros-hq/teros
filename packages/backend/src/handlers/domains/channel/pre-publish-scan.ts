/**
 * channel.pre-publish-scan — Scan conversation history for personal app usage
 * before making a channel shared (REQ-8).
 *
 * Authorization: canToggleScope (only the channel creator).
 *
 * The scan examines all tool-execution messages in the channel, extracts the
 * appId from each (either directly from `content.appId` or by resolving
 * `content.mcaId`/`content.mcpId` against the workspace's installed apps),
 * and checks the **current** `scope` of each app — not the historical scope
 * at the time of use.
 *
 * Advisory only: does NOT block `set-scope`. The warning and "Make shared
 * anyway" confirmation are handled by the frontend.
 *
 * Acceptance criteria:
 * - AC-10: personal app used → appears in personalApps
 * - AC-11: app that was personal when used but is now shared → does NOT appear
 * - Edge case: app that was shared when used but is now personal → DOES appear
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { ChannelManager } from '../../../services/channel-manager'
import { canToggleScope } from '../../../auth/channel-permissions'

interface PrePublishScanData {
  channelId: string
}

interface PersonalAppInfo {
  appId: string
  name: string
}

interface PrePublishScanResult {
  hasWarning: boolean
  personalApps: PersonalAppInfo[]
}

export function createPrePublishScanHandler(
  channelManager: ChannelManager,
  db: Db,
) {
  return async function prePublishScan(ctx: WsHandlerContext, rawData: unknown): Promise<PrePublishScanResult> {
    const data = rawData as PrePublishScanData

    if (!data.channelId) {
      throw new HandlerError('MISSING_FIELDS', 'channelId is required')
    }

    const channel = await channelManager.getChannel(data.channelId)
    if (!channel) {
      throw new HandlerError('CHANNEL_NOT_FOUND', 'Channel not found')
    }

    // Authorization: only the channel creator can run a pre-publish scan (REQ-8, REQ-10)
    const allowed = await canToggleScope(db, ctx.userId, data.channelId)
    if (!allowed) {
      throw new HandlerError('ACCESS_DENIED', 'You do not have permission to perform this action')
    }

    // ── 1. Fetch all tool-execution messages in the channel ────────────────
    //
    // We query the channel_messages collection directly for messages where
    // content.type === 'tool_execution'. We only need the content field to
    // extract appId / mcaId / mcpId.
    const toolMessages = await db.collection('channel_messages').find(
      {
        channelId: data.channelId,
        'content.type': 'tool_execution',
      },
      {
        projection: {
          'content.appId': 1,
          'content.mcaId': 1,
          'content.mcpId': 1,
        },
      },
    ).toArray()

    if (toolMessages.length === 0) {
      return { hasWarning: false, personalApps: [] }
    }

    // ── 2. Collect all unique appIds and mcaIds referenced ─────────────────
    //
    // Some messages store appId directly (set during pending_permission status).
    // Most messages only store mcaId or mcpId (the MCA catalog ID), which we
    // must resolve to app instances via the workspace's installed apps.
    const directAppIds = new Set<string>()
    const mcaIdsToResolve = new Set<string>()

    for (const msg of toolMessages) {
      const content = msg.content as Record<string, unknown> | undefined
      if (!content) continue

      const appId = content.appId as string | undefined
      if (appId) {
        directAppIds.add(appId)
        continue
      }

      // Fall back to mcaId or mcpId (both store the MCA catalog ID)
      const mcaId = (content.mcaId as string | undefined) ?? (content.mcpId as string | undefined)
      if (mcaId) {
        mcaIdsToResolve.add(mcaId)
      }
    }

    // ── 3. Resolve mcaIds to app instances in the workspace ────────────────
    //
    // Each mcaId may correspond to one or more app instances in the workspace.
    // We query the apps collection for active apps owned by the channel's
    // workspace that match any of the mcaIds.
    const workspaceId = channel.workspaceId
    const resolvedAppIds = new Set<string>(directAppIds)

    if (mcaIdsToResolve.size > 0) {
      const workspaceApps = await db.collection('apps').find(
        {
          ownerId: workspaceId,
          status: 'active',
          mcaId: { $in: [...mcaIdsToResolve] },
        },
        {
          projection: { appId: 1 },
        },
      ).toArray()

      for (const app of workspaceApps) {
        resolvedAppIds.add(app.appId as string)
      }
    }

    if (resolvedAppIds.size === 0) {
      return { hasWarning: false, personalApps: [] }
    }

    // ── 4. Look up current scope for each resolved app ──────────────────
    //
    // CRITICAL: We check the CURRENT scope, not the historical scope at
    // the time of use. This satisfies:
    // - AC-11: app was personal when used but is now shared → not in result
    // - Edge case: app was shared when used but is now personal → in result
    const appsData = await db.collection('apps').find(
      {
        appId: { $in: [...resolvedAppIds] },
      },
      {
        projection: { appId: 1, name: 1, scope: 1 },
      },
    ).toArray()

    const personalApps: PersonalAppInfo[] = []
    for (const app of appsData) {
      // apps without scope field default to 'personal'
      const scope = app.scope
      if (scope === 'personal') {
        personalApps.push({
          appId: app.appId as string,
          name: (app.name as string) ?? app.appId,
        })
      }
    }

    return {
      hasWarning: personalApps.length > 0,
      personalApps,
    }
  }
}
