/**
 * useChatScroll
 *
 * Manages scroll state and behavior for the chat FlatList:
 * - isNearBottom tracking
 * - autoScrollEnabled flag
 * - scrollToBottom helper
 * - handleScroll event handler
 * - handleContentSizeChange for auto-scroll on new messages
 * - Reset on channel change
 */

import { useCallback, useEffect, useRef, useState } from "react"
import type { FlatList } from "react-native"

export interface ChatScrollState {
  flatListRef: React.RefObject<FlatList | null>
  isNearBottom: boolean
  autoScrollEnabled: boolean
  isInitialLoad: React.MutableRefObject<boolean>
  scrollToBottom: (animated?: boolean) => void
  handleScroll: (e: any) => void
  handleContentSizeChange: () => void
  enableAutoScroll: () => void
  setIsNearBottom: (v: boolean) => void
  setAutoScrollEnabled: (v: boolean) => void
}

export function useChatScroll(
  channelId: string | undefined,
  isTyping: boolean,
  isChatReady: boolean,
  setIsChatReady: (v: boolean | ((prev: boolean) => boolean)) => void,
  justSentMessage: React.MutableRefObject<boolean>,
  getHasCachedMessages: () => boolean,
  isNewChat: boolean,
): ChatScrollState {
  const flatListRef = useRef<FlatList>(null)
  const isInitialLoad = useRef(true)
  const lastAutoScrollTime = useRef<number>(0)
  const userScrolledAwayTime = useRef<number>(0)
  const initialScrollTimeout = useRef<NodeJS.Timeout | null>(null)

  const [isNearBottom, setIsNearBottom] = useState(true)
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true)

  // Refs for volatile values consumed inside stable callbacks — avoids
  // recreating the callbacks on every render while the agent is typing.
  const isNearBottomRef = useRef(true)
  const autoScrollEnabledRef = useRef(true)
  const isTypingRef = useRef(isTyping)

  // Keep refs in sync with state/props
  isNearBottomRef.current = isNearBottom
  autoScrollEnabledRef.current = autoScrollEnabled
  isTypingRef.current = isTyping

  // Fix #3: use scrollToEnd() instead of the fragile offset:999999 hack
  const scrollToBottom = useCallback((animated = true) => {
    lastAutoScrollTime.current = Date.now()
    flatListRef.current?.scrollToEnd({ animated })
  }, [])

  // Fix #2: stable callback — reads volatile values from refs, not from
  // the closure, so it never needs to be recreated while typing.
  const handleContentSizeChange = useCallback(() => {
    if (isInitialLoad.current) {
      if (initialScrollTimeout.current) {
        clearTimeout(initialScrollTimeout.current)
      }
      initialScrollTimeout.current = setTimeout(() => {
        scrollToBottom(false)
        isInitialLoad.current = false
        initialScrollTimeout.current = null
        setTimeout(() => setIsChatReady(true), 100)
      }, 200)
    } else if (autoScrollEnabledRef.current) {
      if (isTypingRef.current || isNearBottomRef.current || justSentMessage.current) {
        scrollToBottom(true)
      }
    }
  }, [justSentMessage, scrollToBottom, setIsChatReady])

  const handleScroll = useCallback(
    (e: any) => {
      const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent
      const now = Date.now()

      const paddingToBottom = 200
      const nearBottom =
        layoutMeasurement.height + contentOffset.y >= contentSize.height - paddingToBottom

      const isUserScroll = now - lastAutoScrollTime.current > 200

      if (isUserScroll) {
        if (!nearBottom && isNearBottomRef.current) {
          setAutoScrollEnabled(false)
          userScrolledAwayTime.current = now
        } else if (nearBottom && !isNearBottomRef.current) {
          setAutoScrollEnabled(true)
          userScrolledAwayTime.current = 0
        }
      }

      setIsNearBottom(nearBottom)
    },
    [],
  )

  const enableAutoScroll = useCallback(() => {
    setAutoScrollEnabled(true)
    userScrolledAwayTime.current = 0
    scrollToBottom(true)
  }, [scrollToBottom])

  // Reset on channel change
  useEffect(() => {
    const hasCached = getHasCachedMessages()

    isInitialLoad.current = !hasCached
    setIsNearBottom(true)
    setAutoScrollEnabled(true)
    userScrolledAwayTime.current = 0
    justSentMessage.current = false

    // If we have cached messages, scroll to bottom immediately
    if (hasCached) {
      requestAnimationFrame(() => {
        flatListRef.current?.scrollToEnd({ animated: false })
      })
    }
  }, [channelId, getHasCachedMessages])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (initialScrollTimeout.current) {
        clearTimeout(initialScrollTimeout.current)
        initialScrollTimeout.current = null
      }
    }
  }, [channelId])

  return {
    flatListRef,
    isNearBottom,
    autoScrollEnabled,
    isInitialLoad,
    scrollToBottom,
    handleScroll,
    handleContentSizeChange,
    enableAutoScroll,
    setIsNearBottom,
    setAutoScrollEnabled,
  }
}
