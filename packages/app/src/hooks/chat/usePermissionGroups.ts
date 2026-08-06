/**
 * usePermissionGroups (TER-375).
 *
 * Reactive view over the channel's messages that detects runs of ≥2 consecutive
 * `pending_permission` tool calls — the parallel groups whose Allow/Deny is
 * owned by a single `GroupedPermissionPanel`.
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
  groupedRequestIds: new Set(),
  groupByAnchorId: new Map(),
}

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
