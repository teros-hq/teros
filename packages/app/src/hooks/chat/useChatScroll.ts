/**
 * useChatScroll
 *
 * Manages scroll state for the inverted FlatList chat.
 * With inverted=true, "scroll to bottom" means scrollToOffset({ offset: 0 }).
 */

import { useCallback, useRef } from "react"
import type { FlatList } from "react-native"

export interface ChatScrollState {
  flatListRef: React.RefObject<FlatList | null>
  scrollToBottom: (animated?: boolean) => void
}

export function useChatScroll(): ChatScrollState {
  const flatListRef = useRef<FlatList>(null)

  const scrollToBottom = useCallback((animated = true) => {
    flatListRef.current?.scrollToOffset({ offset: 0, animated })
  }, [])

  return {
    flatListRef,
    scrollToBottom,
  }
}
