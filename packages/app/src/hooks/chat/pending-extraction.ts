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
 * Pure function: no side effects, no React, no chatStore — testable with a
 * static fixture.
 */
export function extractPendingFromMessages(
  messageIds: ReadonlyArray<string>,
  messagesById: Record<string, Message>,
): PendingEntry[] {
  const out: PendingEntry[] = []
  for (const msgId of messageIds) {
    const m = messagesById[msgId]
    const content = m?.content as any
    if (
      content?.type === 'tool_execution' &&
      content?.status === 'pending_permission' &&
      content?.permissionRequestId &&
      content?.toolCallId &&
      content?.appId
    ) {
      out.push({
        requestId: content.permissionRequestId,
        messageId: msgId,
        toolCallId: content.toolCallId,
        appId: content.appId,
        toolName: content.toolName ?? 'unknown',
      })
    }
  }
  return out
}
