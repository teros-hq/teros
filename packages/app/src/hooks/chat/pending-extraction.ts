/**
 * Pure helper for TER-340 rehydration — TER-351.
 *
 * Extracted from `useChatPermissions.ts` so it can be unit-tested with a static
 * fixture (no React, no zustand). Before extraction the logic lived inside a
 * `useEffect` and was untestable in isolation.
 *
 * Walks the channel's message list, identifies tool calls in `pending_permission`
 * status with the necessary metadata persisted (TER-340), and returns the entries
 * the hook needs to populate its in-memory ref.
 */

import { parsePermissionMarker } from '../../lib/permission-marker'
import type { Message } from '../../store/chatStore'

export interface PendingEntry {
  requestId: string
  messageId: string
  toolCallId: string
  appId: string
  toolName: string
}

/**
 * Iterate messages and extract any tool calls that should rehydrate into
 * `pendingPermissions.current`. Requires `permissionRequestId` + `toolCallId`
 * + `appId` persisted (TER-340 backend).
 *
 * Also rehydrates the fallback shape for rows written before PERMB 1.0.0: a
 * `completed` card whose `output` is the `permission_requested` marker, with
 * the request id and appId read from the marker. Without the entry,
 * `resolvePendingLocally` is a no-op for that row and a decided request would
 * stay in the grouped panel until the server's status update.
 *
 * Pure function: no side effects, no React, no chatStore — testable with a
 * static fixture.
 *
 * @spec PERMB-REQ-4
 */
export function extractPendingFromMessages(
  messageIds: ReadonlyArray<string>,
  messagesById: Record<string, Message>,
): PendingEntry[] {
  const out: PendingEntry[] = []
  for (const msgId of messageIds) {
    const m = messagesById[msgId]
    const content = m?.content as any
    if (content?.type !== 'tool_execution' || !content?.toolCallId) continue
    if (
      content.status === 'pending_permission' &&
      content.permissionRequestId &&
      content.appId
    ) {
      out.push({
        requestId: content.permissionRequestId,
        messageId: msgId,
        toolCallId: content.toolCallId,
        appId: content.appId,
        toolName: content.toolName ?? 'unknown',
      })
      continue
    }
    if (content.status === 'completed' && typeof content.output === 'string') {
      const marker = parsePermissionMarker(content.output)
      const appId = content.appId ?? marker?.appId
      if (marker && appId) {
        out.push({
          requestId: marker.permissionRequestId,
          messageId: msgId,
          toolCallId: content.toolCallId,
          appId,
          toolName: content.toolName ?? 'unknown',
        })
      }
    }
  }
  return out
}
