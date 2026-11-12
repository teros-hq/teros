/**
 * usePermissionGroups (TER-375).
 *
 * Reactive view over the channel's messages that detects runs of ≥2 pending
 * tool calls — the batches ChatView frames with a header before the first
 * pending card and a footer (Deny all / Allow all) after the last card
 * (PERMW-REQ-3).
 *
 * Two-step to stay cheap:
 *   1. The zustand selector returns a stable *string signature* (Object.is
 *      stable) that changes only when the grouping could actually differ. So
 *      unrelated message updates (text streaming, etc.) don't re-run the
 *      expensive grouping or re-render the consumer.
 *   2. `useMemo` keyed on that signature computes the real grouping from the
 *      current snapshot.
 */

import { useMemo } from 'react'
import { useChatStore } from '../../store/chatStore'
import {
  computeGroupingSignature,
  groupPendingPermissions,
  type PermissionGroupingResult,
} from './permission-grouping'

const EMPTY: PermissionGroupingResult = {
  groups: [],
  groupByAnchorId: new Map(),
  groupByFirstPendingId: new Map(),
}

/** @spec PERMW-REQ-3 */
export function usePermissionGroups(channelId: string | undefined): PermissionGroupingResult {
  const signature = useChatStore((state) => {
    if (!channelId) return ''
    const ids = state.channelMessages[channelId]
    if (!ids || ids.length === 0) return ''
    return computeGroupingSignature(ids, state.messages)
  })

  return useMemo(() => {
    if (!channelId || signature === '') return EMPTY
    const state = useChatStore.getState()
    const ids = state.channelMessages[channelId]
    if (!ids || ids.length === 0) return EMPTY
    return groupPendingPermissions(ids, state.messages)
  }, [channelId, signature])
}
