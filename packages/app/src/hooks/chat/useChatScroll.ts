/**
 * useChatScroll
 *
 * Scroll handle for the chat thread. The thread is CHRONOLOGICAL from here
 * on; MessageList decides per platform how "the bottom" is reached.
 */

import { useCallback, useRef } from "react"
import type { MessageListHandle } from "../../components/chat/MessageList"

export interface ChatScrollState {
  listRef: React.RefObject<MessageListHandle | null>
  scrollToBottom: (animated?: boolean) => void
}

export function useChatScroll(): ChatScrollState {
  const listRef = useRef<MessageListHandle>(null)

  const scrollToBottom = useCallback((animated = true) => {
    listRef.current?.scrollToBottom(animated)
  }, [])

  return {
    listRef,
    scrollToBottom,
  }
}
